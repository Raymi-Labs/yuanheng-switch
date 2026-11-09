import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repair } from "./repair-codex-provider-identity.mjs";
function fixture(t) {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "identity-test-")),
  );
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.copyFileSync(
    new URL("../tests/fixtures/codex-history/relay.toml", import.meta.url),
    path.join(home, "config.toml"),
  );
  const dir = path.join(home, "sessions");
  fs.mkdirSync(dir);
  const file = path.join(dir, "test.jsonl");
  const body =
    '{"type":"response_item","payload":{"text":"keep original bytes"}}\n';
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "one", model_provider: "yuanheng" },
    }) +
      "\n" +
      body,
  );
  const dbPath = path.join(home, "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT);",
  );
  db.prepare("INSERT INTO threads VALUES(?,?,?)").run("one", "yuanheng", file);
  db.close();
  return { home, file, body, dbPath };
}
const stopped = () => {};
test("preview leaves files and DB intact; apply backs up and changes both, then is idempotent", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  assert.equal((await repair(f.home)).files, 1);
  assert.deepEqual(fs.readFileSync(f.file), before);
  const result = await repair(f.home, { apply: true, checkStopped: stopped });
  assert.equal(result.rows, 1);
  assert.equal(result.applied, true);
  assert.deepEqual(
    fs.readFileSync(path.join(result.backupRoot, "sessions/test.jsonl")),
    before,
  );
  const db = new DatabaseSync(f.dbPath);
  assert.equal(
    db.prepare("SELECT model_provider FROM threads").get().model_provider,
    "custom",
  );
  db.close();
  assert.ok(fs.readFileSync(f.file, "utf8").endsWith(f.body));
  assert.equal(
    (await repair(f.home, { apply: true, checkStopped: stopped })).files,
    0,
  );
});
test("process guard rejects writes", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  await assert.rejects(
    repair(f.home, {
      apply: true,
      checkStopped: () => {
        throw Error("running");
      },
    }),
    /running/,
  );
  assert.deepEqual(fs.readFileSync(f.file), before);
});
test("failure after first write rolls back both history and index", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  let checks = 0;
  await assert.rejects(
    repair(f.home, {
      apply: true,
      checkStopped: () => {
        if (++checks === 4) throw Error("running");
      },
    }),
    /running/,
  );
  assert.deepEqual(fs.readFileSync(f.file), before);
  const db = new DatabaseSync(f.dbPath);
  assert.equal(
    db.prepare("SELECT model_provider FROM threads").get().model_provider,
    "yuanheng",
  );
  db.close();
});
test("foreign provider with same display name is not migrated", async (t) => {
  const f = fixture(t);
  const config = path.join(f.home, "config.toml");
  fs.writeFileSync(
    config,
    fs
      .readFileSync(config, "utf8")
      .replace(
        '[model_providers.yuanheng]\nname = "YuanHeng"\nbase_url = "http://127.0.0.1:1/chatgpt-desktop/v1"',
        '[model_providers.yuanheng]\nname = "YuanHeng"\nbase_url = "https://example.com/v1"',
      ),
  );
  assert.equal((await repair(f.home)).files, 0);
});
test("missing candidate file is reported and left untouched", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.file);
  assert.equal((await repair(f.home)).skippedRows, 1);
});

test("compressed rollout is repaired without changing message bytes", async (t) => {
  const { zstdCompressSync, zstdDecompressSync } = await import("node:zlib");
  const f = fixture(t);
  const compressed = f.file + ".zst";
  fs.writeFileSync(compressed, zstdCompressSync(fs.readFileSync(f.file)));
  fs.unlinkSync(f.file);
  const db = new DatabaseSync(f.dbPath);
  db.prepare("UPDATE threads SET rollout_path = ?").run(compressed);
  db.close();
  assert.equal(
    (await repair(f.home, { apply: true, checkStopped: stopped })).rows,
    1,
  );
  const text = zstdDecompressSync(fs.readFileSync(compressed)).toString();
  assert.equal(
    JSON.parse(text.split("\n")[0]).payload.model_provider,
    "custom",
  );
  assert.ok(text.endsWith(f.body));
});
