#!/usr/bin/env node
// Offline maintenance only. Node >=24 and repository dependencies required.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync, backup } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parse } from "smol-toml";
import { zstdDecompressSync, zstdCompressSync } from "node:zlib";

const ids = [
  "custom",
  "yuanheng",
  "yuanheng-switch",
  "yuanheng-switch-official",
];
const fields = [
  "name",
  "base_url",
  "wire_api",
  "requires_openai_auth",
  "supports_websockets",
  "experimental_bearer_token",
  "request_max_retries",
  "stream_max_retries",
];
function owned(v) {
  if (
    !v ||
    Object.keys(v).some((k) => !fields.includes(k)) ||
    v.wire_api !== "responses" ||
    v.requires_openai_auth !== true
  )
    return false;
  if (
    ["request_max_retries", "stream_max_retries"].some(
      (k) => k in v && v[k] !== 0,
    )
  )
    return false;
  let local = false;
  try {
    const u = new URL(v.base_url);
    local =
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      ["/v1", "/codex/v1", "/chatgpt-desktop/v1"].includes(
        u.pathname.replace(/\/$/, ""),
      );
  } catch {
    /* Native OpenAI routes have no URL. */
  }
  return v.name === "YuanHeng"
    ? local && v.experimental_bearer_token === "PROXY_MANAGED"
    : v.name === "OpenAI" &&
        !("experimental_bearer_token" in v) &&
        typeof v.supports_websockets === "boolean" &&
        (!("base_url" in v) || local);
}
const digest = (b) => crypto.createHash("sha256").update(b).digest("hex");
function assertStopped() {
  if (process.platform === "win32")
    throw new Error("此离线维护脚本目前仅支持 macOS/Linux。");
  const names = execFileSync("ps", ["-axo", "comm="], {
    encoding: "utf8",
  }).split("\n");
  if (
    names.some((s) =>
      /(?:^|\/)(?:codex(?: .*)?|ChatGPT|Meta API|yuanheng-switch|yuanheng-core)$/i.test(
        s.trim(),
      ),
    )
  ) {
    throw new Error(
      "请先完全退出 ChatGPT/Codex、Codex CLI 和 Meta API/Core，再执行 --apply。预览无需退出。",
    );
  }
}
function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isSymbolicLink()
        ? []
        : e.isDirectory()
          ? files(path.join(dir, e.name))
          : /\.jsonl(?:\.zst)?$/.test(e.name)
            ? [path.join(dir, e.name)]
            : [],
    );
}
function content(file) {
  if (fs.statSync(file).size > 256 * 1024 * 1024)
    throw new Error("会话文件超过维护工具资源上限，未修改。");
  const bytes = fs.readFileSync(file);
  return file.endsWith(".zst")
    ? zstdDecompressSync(bytes, { maxOutputLength: 256 * 1024 * 1024 })
    : bytes;
}
function header(file) {
  const bytes = content(file);
  const end = bytes.indexOf(10);
  if (end < 0 || end > 1024 * 1024)
    throw new Error(`会话头缺失或超过 1 MiB：${path.basename(file)}`);
  const row = JSON.parse(bytes.subarray(0, end).toString("utf8"));
  if (row.type !== "session_meta" || !row.payload?.id)
    throw new Error(`无法验证会话头：${path.basename(file)}`);
  return { row, end, bytes };
}
function atomic(file, bytes) {
  const temp = `${file}.identity-${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export async function repair(
  home,
  { apply = false, checkStopped = assertStopped } = {},
) {
  home = fs.realpathSync(home);
  const configPath = path.join(home, "config.toml");
  const configBytes = fs.readFileSync(configPath);
  const config = parse(configBytes.toString());
  const target = config.model_provider;
  const table = config.model_providers || {};
  if (!ids.includes(target) || !owned(table[target]))
    throw new Error("当前提供商不是可验证的托管路由，未修改。");
  const same = (a, b) => fields.every((k) => a[k] === b[k]);
  const sources = ids.filter(
    (id) => id !== target && owned(table[id]) && same(table[id], table[target]),
  );
  const dbs = fs.readdirSync(home).filter((n) => /^state_\d+\.sqlite$/.test(n));
  if (dbs.length !== 1)
    throw new Error("需要恰好一个 Codex state 数据库，无法确定时拒绝修改。");
  const dbPath = path.join(home, dbs[0]);
  if (apply) checkStopped();
  if (fs.lstatSync(dbPath).isSymbolicLink())
    throw new Error("不修改符号链接数据库。");
  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  let transaction = false;
  const changed = [];
  let backupRoot;
  try {
    if (apply) {
      db.exec("BEGIN IMMEDIATE");
      transaction = true;
    }
    const rows = db
      .prepare("SELECT id, model_provider, rollout_path FROM threads")
      .all();
    const index = new Map(rows.map((r) => [r.id, r]));
    const plans = [];
    let skippedFiles = 0;
    const seen = new Set();
    for (const file of [
      ...files(path.join(home, "sessions")),
      ...files(path.join(home, "archived_sessions")),
    ]) {
      let row;
      try {
        ({ row } = header(file));
      } catch {
        skippedFiles++;
        continue;
      }
      const source = row.payload.model_provider;
      if (!sources.includes(source)) continue;
      const indexed = index.get(row.payload.id);
      if (
        indexed &&
        (indexed.model_provider !== source ||
          !fs.existsSync(indexed.rollout_path) ||
          fs.realpathSync(indexed.rollout_path) !== file)
      )
        continue;
      if (seen.has(row.payload.id))
        throw new Error("同一会话存在多个文件，未修改。");
      seen.add(row.payload.id);
      if (fs.statSync(file).size > 256 * 1024 * 1024)
        throw new Error("会话文件超过维护工具的 256 MiB 资源上限，未修改。");
      plans.push({
        file,
        id: row.payload.id,
        source,
        hash: digest(fs.readFileSync(file)),
        indexed: !!indexed,
      });
    }
    const skippedRows = rows.filter(
      (r) => sources.includes(r.model_provider) && !seen.has(r.id),
    ).length;
    const result = {
      target,
      sources,
      skippedRows,
      skippedFiles,
      files: plans.length,
      rows: plans.filter((p) => p.indexed).length,
      applied: false,
    };
    if (!apply || !plans.length) return result;
    const backups = path.join(home, "provider-identity-backups");
    if (fs.existsSync(backups)) {
      for (const entry of fs.readdirSync(backups)) {
        const manifest = path.join(backups, entry, "manifest.json");
        if (
          !fs.existsSync(manifest) ||
          !["completed", "rolled_back"].includes(
            JSON.parse(fs.readFileSync(manifest, "utf8")).status,
          )
        )
          throw new Error(
            "发现未完成的历史修复备份，请先核对并恢复，未继续写入。",
          );
      }
    }
    checkStopped();
    if (!fs.readFileSync(configPath).equals(configBytes))
      throw new Error("配置已变化，请重新预览。");
    backupRoot = path.join(
      home,
      "provider-identity-backups",
      `${Date.now()}-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    // Read connection includes WAL; an ordinary file copy would lose committed rows.
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      await backup(reader, path.join(backupRoot, dbs[0]));
    } finally {
      reader.close();
    }
    fs.copyFileSync(configPath, path.join(backupRoot, "config.toml"));
    fs.chmodSync(path.join(backupRoot, "config.toml"), 0o600);
    for (const p of plans) {
      const dest = path.join(backupRoot, path.relative(home, p.file));
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.copyFileSync(p.file, dest);
      if (digest(fs.readFileSync(dest)) !== p.hash)
        throw new Error("备份期间文件变化，未修改历史。");
    }
    const manifest = {
      ...result,
      status: "prepared",
      files: plans.map((p) => ({ ...p, file: path.relative(home, p.file) })),
    };
    const manifestPath = path.join(backupRoot, "manifest.json");
    atomic(manifestPath, JSON.stringify(manifest, null, 2));
    for (const p of plans) {
      checkStopped();
      const bytes = fs.readFileSync(p.file);
      if (
        digest(bytes) !== p.hash ||
        !fs.readFileSync(configPath).equals(configBytes)
      )
        throw new Error("文件已变化，回滚本次修改。");
      const { row, end, bytes: decoded } = header(p.file);
      row.payload.model_provider = target;
      changed.push(p.file);
      const updated = Buffer.concat([
        Buffer.from(JSON.stringify(row)),
        decoded.subarray(end),
      ]);
      atomic(
        p.file,
        p.file.endsWith(".zst") ? zstdCompressSync(updated) : updated,
      );
      if (p.indexed) {
        const update = db
          .prepare(
            "UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?",
          )
          .run(target, p.id, p.source);
        if (update.changes !== 1) throw new Error("会话索引发生变化，回滚。");
      }
    }
    checkStopped();
    db.exec("COMMIT");
    transaction = false;
    // A post-commit journal error must not roll files back against committed DB rows.
    changed.length = 0;
    atomic(
      manifestPath,
      JSON.stringify({ ...manifest, status: "completed" }, null, 2),
    );
    return { ...result, applied: true, backupRoot };
  } catch (error) {
    if (transaction) {
      db.exec("ROLLBACK");
      transaction = false;
    }
    for (const file of changed.reverse())
      atomic(
        file,
        fs.readFileSync(path.join(backupRoot, path.relative(home, file))),
      );
    if (backupRoot && changed.length) {
      const manifest = path.join(backupRoot, "manifest.json");
      atomic(
        manifest,
        JSON.stringify(
          {
            ...JSON.parse(fs.readFileSync(manifest, "utf8")),
            status: "rolled_back",
          },
          null,
          2,
        ),
      );
    }
    throw error;
  } finally {
    if (transaction) db.exec("ROLLBACK");
    db.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const homeIndex = args.indexOf("--home");
  const home =
    homeIndex < 0 ? path.join(os.homedir(), ".codex") : args[homeIndex + 1];
  if (
    !home ||
    args.some(
      (a, i) => a !== "--apply" && a !== "--home" && i !== homeIndex + 1,
    )
  )
    throw new Error(
      "用法：node scripts/repair-codex-provider-identity.mjs [--home PATH] [--apply]",
    );
  try {
    console.log(JSON.stringify(await repair(home, { apply }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
