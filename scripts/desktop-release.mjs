// Build jobs only stage signed files. One finalize job owns the Release and
// latest.json, after validating every target against this run and commit.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyReleaseNotes, validateReleaseNotes } from "./release-notes.mjs";

export const TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function emptyDirectory(path) {
  mkdirSync(path, { recursive: true });
  check(readdirSync(path).length === 0, `输出目录必须为空：${path}`);
}
function fileInfo(path) {
  const stat = lstatSync(path);
  check(stat.isFile() && stat.size > 0, `产物为空或不是普通文件：${path}`);
  return {
    name: basename(path),
    size: stat.size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

export function releaseContext(env, version) {
  check(/^\d+\.\d+\.\d+$/.test(version), "应用版本不是稳定语义版本");
  check(/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? ""), "缺少有效提交 SHA");
  check(/^\d+$/.test(env.GITHUB_RUN_ID ?? ""), "缺少工作流 run ID");
  check(/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? ""), "无效发布仓库");
  const stable = (env.GITHUB_REF ?? "").startsWith("refs/tags/");
  let tag;
  if (stable) {
    tag = env.GITHUB_REF.slice("refs/tags/".length);
    check(tag === `v${version}`, "发布标签与应用版本不一致");
  } else {
    check((env.GITHUB_REF ?? "").startsWith("refs/heads/"), "无效工作流 ref");
    check(/^\d+$/.test(env.GITHUB_RUN_NUMBER ?? ""), "缺少手动构建编号");
    tag = `v${version}-build.${env.GITHUB_RUN_NUMBER}`;
  }
  return {
    version,
    tag,
    stable,
    sha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    repo: env.GITHUB_REPOSITORY,
  };
}

function layout(target, version, productName) {
  check(TARGETS.includes(target), `未知发布目标：${target}`);
  const stem = productName.replace(/ /g, ".");
  check(/^[\w.-]+$/.test(stem), "产品名不能生成安全的附件名称");
  if (target.endsWith("apple-darwin")) {
    const arch = target.startsWith("aarch64") ? "aarch64" : "x64";
    const archive = `${stem}_${version}_${arch}.app.tar.gz`;
    return {
      updater: archive,
      platforms: target.startsWith("aarch64")
        ? ["darwin-aarch64", "darwin-aarch64-app"]
        : ["darwin-x86_64", "darwin-x86_64-app"],
      files: [
        [`macos/${productName}.app.tar.gz`, archive],
        [`macos/${productName}.app.tar.gz.sig`, `${archive}.sig`],
        [
          `dmg/${productName}_${version}_${arch}.dmg`,
          `${stem}_${version}_${arch}.dmg`,
        ],
      ],
    };
  }
  const installer = `${stem}_${version}_x64-setup.exe`;
  return {
    updater: installer,
    platforms: ["windows-x86_64", "windows-x86_64-nsis"],
    files: [
      [`nsis/${productName}_${version}_x64-setup.exe`, installer],
      [`nsis/${productName}_${version}_x64-setup.exe.sig`, `${installer}.sig`],
    ],
  };
}

export function collectTarget({
  repoRoot,
  outputDir,
  target,
  artifactPaths,
  appVersion,
  context,
  productName,
}) {
  check(
    appVersion === context.version,
    "tauri-action 输出的版本与本次发布不一致",
  );
  check(
    Array.isArray(artifactPaths) &&
      artifactPaths.every((p) => typeof p === "string"),
    "无效产物路径列表",
  );
  const spec = layout(target, context.version, productName);
  const bundleRoot = realpathSync(
    join(repoRoot, "src-tauri", "target", target, "release", "bundle"),
  );
  check(
    bundleRoot ===
      join(
        realpathSync(repoRoot),
        "src-tauri",
        "target",
        target,
        "release",
        "bundle",
      ),
    "产物根目录被重定向",
  );
  const listed = new Set(
    artifactPaths.map((p) => realpathSync(resolve(repoRoot, p))),
  );
  const inputs = spec.files.map(([relative, name]) => {
    const path = join(bundleRoot, relative);
    check(listed.has(path), `tauri-action 未报告必需产物：${relative}`);
    check(realpathSync(path) === path, `拒绝重定向的产物路径：${path}`);
    const info = fileInfo(path);
    return { path, name, size: info.size, sha256: info.sha256 };
  });
  emptyDirectory(outputDir);
  for (const input of inputs)
    copyFileSync(input.path, join(outputDir, input.name));
  const receipt = {
    schemaVersion: 1,
    version: context.version,
    sha: context.sha,
    runId: context.runId,
    target,
    files: inputs.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
  };
  writeJson(join(outputDir, "receipt.json"), receipt);
  return receipt;
}

export function assembleRelease({
  inputDir,
  outputDir,
  context,
  productName,
  feed,
}) {
  const notes = validateReleaseNotes(feed, context.version);
  const expectedDirs = TARGETS.map((t) => `desktop-${t}`).sort();
  check(
    JSON.stringify(readdirSync(inputDir).sort()) ===
      JSON.stringify(expectedDirs),
    "必须收到且只收到本次三平台产物",
  );
  const staged = [];
  const platforms = {};
  const names = new Set();
  for (const target of TARGETS) {
    const dir = join(inputDir, `desktop-${target}`);
    check(
      lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(),
      "产物目录不是普通目录",
    );
    const receipt = json(join(dir, "receipt.json"));
    check(
      receipt.schemaVersion === 1 &&
        receipt.target === target &&
        receipt.version === context.version &&
        receipt.sha === context.sha &&
        receipt.runId === context.runId,
      `产物提交、版本或 run 不一致：${target}`,
    );
    const spec = layout(target, context.version, productName);
    const expected = spec.files.map(([, name]) => name).sort();
    check(
      Array.isArray(receipt.files) &&
        JSON.stringify(receipt.files.map((f) => f.name).sort()) ===
          JSON.stringify(expected),
      `目标产物缺失或重复：${target}`,
    );
    check(
      JSON.stringify(readdirSync(dir).sort()) ===
        JSON.stringify([...expected, "receipt.json"].sort()),
      `目标目录混入额外文件：${target}`,
    );
    for (const file of receipt.files) {
      check(!names.has(file.name), `附件名称冲突：${file.name}`);
      names.add(file.name);
      const path = join(dir, file.name);
      const actual = fileInfo(path);
      check(
        actual.size === file.size && actual.sha256 === file.sha256,
        `产物摘要不一致：${file.name}`,
      );
      staged.push({ path, ...actual });
    }
    const signature = readFileSync(
      join(dir, `${spec.updater}.sig`),
      "utf8",
    ).trim();
    check(
      signature.length > 0 &&
        signature.length < 16384 &&
        signature.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(signature),
      `更新签名无效：${target}`,
    );
    for (const platform of spec.platforms) {
      check(!platforms[platform], `平台键冲突：${platform}`);
      platforms[platform] = {
        signature,
        url: `https://github.com/${context.repo}/releases/download/${encodeURIComponent(context.tag)}/${encodeURIComponent(spec.updater)}`,
      };
    }
  }
  // Only after every receipt and byte digest passes do we create the one manifest.
  emptyDirectory(outputDir);
  for (const file of staged)
    copyFileSync(file.path, join(outputDir, file.name));
  const manifest = applyReleaseNotes(
    { version: context.version, pub_date: notes[0].publishedAt, platforms },
    feed,
  );
  writeJson(join(outputDir, "latest.json"), manifest);
  writeFileSync(join(outputDir, "notes.txt"), `${manifest.notes}\n`);
  const plan = {
    ...context,
    productName,
    assets: [
      ...staged.map(({ path: _path, ...info }) => info),
      fileInfo(join(outputDir, "latest.json")),
    ],
  };
  writeJson(join(outputDir, "release-plan.json"), plan);
  return plan;
}

function defaultGh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
}
function optionalRelease(gh, path) {
  try {
    return JSON.parse(gh(["api", path]));
  } catch (error) {
    if (/HTTP 404/.test(String(error.stderr ?? error.message))) return null;
    throw error;
  }
}
function findRelease(gh, context) {
  // REST /releases/tags/:tag excludes drafts. gh resolves a pending draft tag
  // through GraphQL; read the full REST asset/digest metadata by that ID.
  let id;
  try {
    id = JSON.parse(
      gh([
        "release",
        "view",
        context.tag,
        "--repo",
        context.repo,
        "--json",
        "databaseId",
      ]),
    ).databaseId;
  } catch (error) {
    if (
      /^release not found$/i.test(String(error.stderr ?? error.message).trim())
    )
      return null;
    throw error;
  }
  check(Number.isSafeInteger(id) && id > 0, "GitHub 未返回有效 Release ID");
  return JSON.parse(gh(["api", `repos/${context.repo}/releases/${id}`]));
}
function verifyTagCommit(gh, context) {
  const ref = optionalRelease(
    gh,
    `repos/${context.repo}/git/ref/tags/${encodeURIComponent(context.tag)}`,
  );
  if (!ref) {
    check(!context.stable, "正式发布标签不存在");
    return false;
  }
  let object = ref.object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
    check(/^[0-9a-f]{40}$/.test(object.sha), "无效标签对象");
    object = JSON.parse(
      gh(["api", `repos/${context.repo}/git/tags/${object.sha}`]),
    ).object;
  }
  check(
    object?.type === "commit" && object.sha === context.sha,
    "远端标签与构建提交不一致",
  );
  return true;
}

export function verifyReleaseAssets(release, assets, notes) {
  check(release.body?.trim() === notes.trim(), "Release 中文说明不一致");
  check(
    Array.isArray(release.assets) && release.assets.length === assets.length,
    "Release 附件不完整或包含多余文件",
  );
  for (const file of assets) {
    const remote = release.assets.filter((a) => a.name === file.name);
    check(
      remote.length === 1 &&
        remote[0].state === "uploaded" &&
        remote[0].size === file.size &&
        remote[0].digest === `sha256:${file.sha256}`,
      `GitHub 附件摘要校验失败：${file.name}`,
    );
  }
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number),
    b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function prepareRecoveryContext({ runId, repo, gh = defaultGh }) {
  check(/^\d+$/.test(runId) && /^[\w.-]+\/[\w.-]+$/.test(repo), "无效恢复来源");
  const run = JSON.parse(gh(["api", `repos/${repo}/actions/runs/${runId}`]));
  check(
    String(run.id) === runId &&
      run.repository?.full_name === repo &&
      run.path === ".github/workflows/release.yml" &&
      run.event === "push" &&
      run.status === "completed",
    "来源必须是本仓库已结束的正式发布任务",
  );
  const latestJobs = new Map();
  let exhausted = false;
  for (let page = 1; page <= 20; page++) {
    const result = JSON.parse(
      gh([
        "api",
        `repos/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`,
      ]),
    );
    check(Array.isArray(result.jobs), "无法读取构建任务状态");
    for (const job of result.jobs) {
      const previous = latestJobs.get(job.name);
      if (
        !previous ||
        (job.run_attempt ?? 0) > (previous.run_attempt ?? 0) ||
        ((job.run_attempt ?? 0) === (previous.run_attempt ?? 0) &&
          job.id > previous.id)
      )
        latestJobs.set(job.name, job);
    }
    if (result.jobs.length < 100) {
      exhausted = true;
      break;
    }
  }
  check(exhausted, "来源任务记录过多，无法确认完整状态");
  for (const name of ["validate", ...TARGETS.map((t) => `Build ${t}`)]) {
    const job = latestJobs.get(name);
    check(
      job?.status === "completed" && job.conclusion === "success",
      `来源构建未全部通过：${name}`,
    );
  }
  check(/^[0-9a-f]{40}$/.test(run.head_sha), "无效来源提交");
  function sourceJson(path) {
    const file = JSON.parse(
      gh(["api", `repos/${repo}/contents/${path}?ref=${run.head_sha}`]),
    );
    check(
      file.encoding === "base64" && typeof file.content === "string",
      "无法读取来源版本文件",
    );
    return JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  }
  const config = sourceJson("src-tauri/tauri.conf.json");
  const context = releaseContext(
    {
      GITHUB_SHA: run.head_sha,
      GITHUB_RUN_ID: runId,
      GITHUB_REPOSITORY: repo,
      GITHUB_REF: `refs/tags/${run.head_branch}`,
    },
    config.version,
  );
  verifyTagCommit(gh, context);
  const feed = sourceJson("src/data/desktop-release-notes.json");
  validateReleaseNotes(feed, context.version);
  return { context, config, feed };
}

export function publishRelease({
  outputDir,
  context,
  productName = "YuanHeng Desktop",
  gh = defaultGh,
}) {
  const plan = json(join(outputDir, "release-plan.json"));
  for (const key of ["version", "tag", "stable", "sha", "runId", "repo"])
    check(plan[key] === context[key], `发布计划与当前上下文不一致：${key}`);
  check(
    Array.isArray(plan.assets) && plan.assets.length === 9,
    "发布计划缺少必需附件",
  );
  check(plan.productName === productName, "发布计划的产品名称不一致");
  const expectedNames = [
    ...TARGETS.flatMap((t) =>
      layout(t, context.version, productName).files.map(([, name]) => name),
    ),
    "latest.json",
  ].sort();
  check(
    JSON.stringify(plan.assets.map((f) => f.name).sort()) ===
      JSON.stringify(expectedNames),
    "发布计划包含无效附件名称",
  );
  for (const file of plan.assets) {
    const actual = fileInfo(join(outputDir, file.name));
    check(
      actual.size === file.size && actual.sha256 === file.sha256,
      `发布前文件发生变化：${file.name}`,
    );
  }
  const notesFile = join(outputDir, "notes.txt");
  const notes = readFileSync(notesFile, "utf8");
  check(
    json(join(outputDir, "latest.json")).notes === notes.trim(),
    "发布说明与清单不一致",
  );
  const tagVerified = verifyTagCommit(gh, context);
  let release = findRelease(gh, context);
  if (release) {
    check(
      release.tag_name === context.tag &&
        (tagVerified || release.target_commitish === context.sha),
      "同名 Release 的提交不一致，拒绝覆盖",
    );
    if (!release.draft) {
      check(
        context.stable && !release.prerelease,
        "拒绝修改已公开的不同发布类型",
      );
      verifyReleaseAssets(release, plan.assets, notes);
      return release; // Successful retries are read-only for a published release.
    }
    gh([
      "release",
      "edit",
      context.tag,
      "--repo",
      context.repo,
      "--notes-file",
      notesFile,
      `--prerelease=${!context.stable}`,
    ]);
  } else {
    const args = [
      "release",
      "create",
      context.tag,
      "--repo",
      context.repo,
      "--draft",
      "--title",
      `YuanHeng Desktop ${context.tag}`,
      "--notes-file",
      notesFile,
    ];
    // Stable tags are already verified against the build SHA. A redundant old
    // target can require Workflows:write when main advances during the build.
    if (context.stable) args.push("--verify-tag");
    else args.push("--target", context.sha, "--prerelease");
    gh(args);
  }
  const binaries = plan.assets
    .filter((f) => f.name !== "latest.json")
    .map((f) => join(outputDir, f.name));
  gh([
    "release",
    "upload",
    context.tag,
    "--repo",
    context.repo,
    "--clobber",
    ...binaries,
  ]);
  gh([
    "release",
    "upload",
    context.tag,
    "--repo",
    context.repo,
    "--clobber",
    join(outputDir, "latest.json"),
  ]);
  release = findRelease(gh, context);
  check(
    release?.draft &&
      release.tag_name === context.tag &&
      (tagVerified || release.target_commitish === context.sha),
    "发布过程中的 Release 状态不一致",
  );
  verifyReleaseAssets(release, plan.assets, notes);
  if (context.stable) {
    verifyTagCommit(gh, context);
    const latest = optionalRelease(gh, `repos/${context.repo}/releases/latest`);
    const latestVersion = latest?.tag_name?.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
    const makeLatest =
      !latest ||
      (latestVersion && compareVersions(context.version, latestVersion) >= 0);
    gh([
      "release",
      "edit",
      context.tag,
      "--repo",
      context.repo,
      "--draft=false",
      "--prerelease=false",
      `--latest=${Boolean(makeLatest)}`,
    ]);
    release = findRelease(gh, context);
    check(
      release && !release.draft && !release.prerelease,
      "正式 Release 尚未公开",
    );
    verifyReleaseAssets(release, plan.assets, notes);
  }
  return release;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [command, input, output] = process.argv.slice(2);
    if (command === "recover-context") {
      const source = prepareRecoveryContext({
        runId: input,
        repo: process.env.GITHUB_REPOSITORY,
      });
      mkdirSync(dirname(resolve(output)), { recursive: true });
      writeJson(resolve(output), source);
      if (process.env.GITHUB_OUTPUT)
        writeFileSync(
          process.env.GITHUB_OUTPUT,
          `version=${source.context.version}\n`,
          { flag: "a" },
        );
      console.log(
        `已验证来源 ${source.context.tag} / ${source.context.sha} / run ${source.context.runId}`,
      );
    } else {
      let recovery;
      if (process.env.DESKTOP_RELEASE_CONTEXT) {
        const saved = json(resolve(process.env.DESKTOP_RELEASE_CONTEXT));
        check(
          saved.context.repo === process.env.GITHUB_REPOSITORY,
          "恢复上下文仓库不一致",
        );
        recovery = prepareRecoveryContext({
          runId: saved.context.runId,
          repo: process.env.GITHUB_REPOSITORY,
        });
        for (const key of ["version", "tag", "stable", "sha", "runId", "repo"])
          check(
            saved.context[key] === recovery.context[key],
            "恢复来源发生变化",
          );
      }
      const config =
        recovery?.config ?? json(join(root, "src-tauri/tauri.conf.json"));
      const context =
        recovery?.context ?? releaseContext(process.env, config.version);
      if (command === "collect") {
        check(!recovery, "恢复发布只能复用已验证产物");
        const receipt = collectTarget({
          repoRoot: root,
          target: input,
          outputDir: resolve(output),
          artifactPaths: JSON.parse(process.env.ARTIFACT_PATHS ?? "null"),
          appVersion: process.env.BUILT_APP_VERSION,
          context,
          productName: config.productName,
        });
        console.log(
          `已收集 ${receipt.target}：${receipt.files.length} 个发布文件（含更新签名）`,
        );
      } else if (command === "assemble") {
        const plan = assembleRelease({
          inputDir: resolve(input),
          outputDir: resolve(output),
          context,
          productName: config.productName,
          feed:
            recovery?.feed ??
            json(join(root, "src/data/desktop-release-notes.json")),
        });
        console.log(`三平台校验通过，已统一生成 ${plan.tag} 的 latest.json`);
      } else if (command === "publish") {
        const release = publishRelease({
          outputDir: resolve(input),
          context,
          productName: config.productName,
        });
        console.log(
          `${release.draft ? "已准备完整草稿" : "已发布正式版本"}：${release.html_url}`,
        );
      } else
        throw new Error(
          "用法：desktop-release.mjs collect <target> <out> | assemble <in> <out> | publish <out>",
        );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
