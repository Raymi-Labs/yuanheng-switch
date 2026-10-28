// Actual experimental Core process regression. Only synthetic credentials and
// loopback catalog/status requests; no official app, login or model generation.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { randomBytes, createHash } = require("node:crypto");

const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary))
  throw Error(
    "Usage: node scripts/test-accio-core-lifecycle.cjs <absolute experimental Core binary>",
  );
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "yuanheng-accio-lifecycle-"),
);
const config = path.join(root, "config");
const env = { ...process.env, YUANHENG_SWITCH_TEST_HOME: root };
for (const key of [
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_DB",
  "XDG_DATA_HOME",
])
  delete env[key];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let core,
  port,
  stopping = false;
const results = [];
const database = () =>
  new DatabaseSync(path.join(config, "yuanheng-switch.db"));
const record = (name, detail) => {
  results.push({ name, ...detail });
  console.log(JSON.stringify(results.at(-1)));
};
async function stop(signal = "SIGTERM") {
  if (!core || core.exitCode !== null || core.signalCode !== null) return;
  core.kill(signal);
  const deadline = Date.now() + 4000;
  while (
    core.exitCode === null &&
    core.signalCode === null &&
    Date.now() < deadline
  )
    await delay(50);
  if (core.exitCode === null && core.signalCode === null) {
    core.kill("SIGKILL");
    await new Promise((resolve) => core.once("exit", resolve));
  }
}
async function start() {
  const fd = fs.openSync(path.join(root, "core.log"), "a", 0o600);
  core = spawn(binary, ["run", "--config-dir", config], {
    env,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  for (let n = 0; n < 100; n++) {
    if (core.exitCode !== null)
      throw Error("isolated Core exited before ready");
    try {
      const runtime = JSON.parse(
        fs.readFileSync(path.join(config, "core/runtime.json"), "utf8"),
      );
      if (runtime.pid === core.pid) {
        const response = await fetch(
          `http://127.0.0.1:${runtime.port}/health`,
          { signal: AbortSignal.timeout(500) },
        );
        if (response.ok) {
          port = runtime.port;
          return;
        }
      }
    } catch {}
    await delay(100);
  }
  throw Error("isolated Core did not become ready");
}
async function request(capability, endpoint = "llm/config/v2", headers = {}) {
  const response = await fetch(
    `http://127.0.0.1:${port}/accio-work/${capability}/api/${endpoint}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
      signal: AbortSignal.timeout(8000),
    },
  );
  await response.arrayBuffer();
  return response;
}
async function cleanup() {
  if (stopping) return;
  stopping = true;
  await stop();
  try {
    const db = database();
    db.exec("DELETE FROM accio_work_runtime; PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  } catch {}
  record("cleanup", {
    coreExited: !core || core.exitCode !== null || core.signalCode !== null,
    port,
  });
  fs.writeFileSync(
    path.join(root, "results.json"),
    JSON.stringify(results, null, 2),
    { mode: 0o600 },
  );
}
process.on("SIGINT", () => cleanup().then(() => process.exit(1)));
process.on("SIGTERM", () => cleanup().then(() => process.exit(1)));
(async () => {
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  spawnSync(binary, ["status", "--config-dir", config], {
    env,
    stdio: "ignore",
    timeout: 10000,
  });
  const capability = randomBytes(32).toString("hex");
  const profile = {
    owner: "synthetic-orphan",
    model: "synthetic-model",
    group: "synthetic-group",
    reasoning: "auto",
    models: ["synthetic-model"],
    provider: {
      id: "yuanheng-managed",
      name: "Synthetic lifecycle",
      category: "managed",
      notes: "group=synthetic-group",
      inFailoverQueue: false,
      settingsConfig: {
        auth: { OPENAI_API_KEY: "synthetic-key-never-sent" },
        config:
          'model_provider = "custom"\nmodel = "synthetic-model"\n[model_providers.custom]\nbase_url = "https://meta-api.vip/v1"\nwire_api = "responses"\n',
        modelCatalog: {
          models: [{ model: "synthetic-model", apiFormat: "openai_responses" }],
        },
      },
    },
    capability,
    active: true,
  };
  let db = database();
  db.prepare(
    "UPDATE proxy_config SET listen_address='127.0.0.1',listen_port=0",
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO accio_work_runtime(id,payload) VALUES(1,?)",
  ).run(JSON.stringify(profile));
  db.close();
  record("artifact", {
    sha256: createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
  });
  try {
    await start();
    assert.equal((await request(capability)).status, 401);
    db = database();
    let raw = db
      .prepare("SELECT payload FROM accio_work_runtime WHERE id=1")
      .get().payload;
    db.close();
    assert.equal(JSON.parse(raw).active, false);
    record("orphaned active marker is rejected", { status: 401 });
    const duplicate = spawnSync(binary, ["run", "--config-dir", config], {
      env,
      stdio: "ignore",
      timeout: 5000,
    });
    assert.notEqual(duplicate.status, 0);
    assert.equal(duplicate.error, undefined);
    db = database();
    assert.equal(
      db.prepare("SELECT payload FROM accio_work_runtime WHERE id=1").get()
        .payload,
      raw,
    );
    db.close();
    assert.equal(core.exitCode, null);
    record("duplicate Core has no configuration side effects", {
      passed: true,
    });
    assert.equal(
      (
        await request(capability, "llm/config/v2", {
          Origin: "https://example.invalid",
        })
      ).status,
      403,
    );
    record("external Origin remains rejected", { status: 403 });
    await stop("SIGKILL");
    await start();
    assert.equal((await request(capability)).status, 401);
    record("Core crash restart never revives old lease", { status: 401 });
    const began = Date.now();
    const denied = await request(capability, "channel/authorization/status");
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("retry-after"), "5");
    assert.ok(Date.now() - began >= 4900);
    record("revoked connector pacing survives restart", {
      status: 401,
      elapsedMs: Date.now() - began,
    });
    db = database();
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM proxy_request_logs WHERE app_type='accio-work'",
        )
        .get().n,
      0,
    );
    db.close();
    record("model forwarding", { requests: 0 });
  } finally {
    await cleanup();
  }
})().catch(async (error) => {
  console.error(error.message);
  await cleanup();
  process.exitCode = 1;
});
