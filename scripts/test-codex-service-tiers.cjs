// Official Codex app-server, isolated HOME and loopback fake model. No account or paid traffic.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  cp = require("node:child_process"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary))
  throw Error("Supply an absolute Codex binary");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "yh-native-tiers-"));
const template = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "../src-tauri/src/resources/codex_native_responses_template.json",
    ),
    "utf8",
  ),
);
const model = {
  ...template,
  slug: "synthetic-model",
  display_name: "synthetic-model",
  additional_speed_tiers: [],
  service_tiers: [
    { id: "priority", name: "Fast ×2", description: "synthetic cost" },
    { id: "ultrafast", name: "UltraFast ×6", description: "synthetic cost" },
  ],
  default_service_tier: null,
};
const requests = [];
let failNext = false;
let child,
  buffer = "",
  nextId = 0;
const pending = new Map(),
  completed = new Set();
const server = http.createServer(async (req, res) => {
  let bytes = "";
  for await (const c of req) {
    bytes += c;
    if (bytes.length > 1024 * 1024) {
      res.writeHead(413).end();
      return;
    }
  }
  requests.push(JSON.parse(bytes));
  if (failNext) {
    failNext = false;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic unavailable" } }));
    return;
  }
  const id = "resp_synthetic_" + requests.length;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [{ id: "msg_" + id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "synthetic OK", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
  );
});
const pause = () => new Promise((r) => setTimeout(r, 20));
async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw Error("bounded native wait timed out");
    await pause();
  }
}
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
async function main() {
  let deadline;
  try {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    fs.writeFileSync(
      path.join(root, "catalog.json"),
      JSON.stringify({ models: [model] }),
    );
    fs.writeFileSync(
      path.join(root, "config.toml"),
      `model_provider="synthetic"\nmodel="synthetic-model"\nmodel_catalog_json=${JSON.stringify(path.join(root, "catalog.json"))}\nservice_tier="default"\n[model_providers.synthetic]\nname="synthetic"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nexperimental_bearer_token="synthetic"\nrequest_max_retries=0\nstream_max_retries=0\n`,
    );
    child = cp.spawn(binary, ["app-server"], {
      env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    deadline = setTimeout(() => {
      for (const p of pending.values()) p.reject(Error("native deadline"));
      child.kill("SIGKILL");
    }, 30000);
    child.on("error", () => {
      for (const p of pending.values())
        p.reject(Error("native startup failed"));
    });
    child.on("exit", () => {
      for (const p of pending.values()) p.reject(Error("native exited"));
    });
    child.stdout.on("data", (c) => {
      buffer += c;
      while (buffer.includes("\n")) {
        const n = buffer.indexOf("\n"),
          l = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        try {
          const r = JSON.parse(l);
          if (pending.has(r.id)) {
            const p = pending.get(r.id);
            pending.delete(r.id);
            r.error
              ? p.reject(Error("native RPC failed: " + r.error.code))
              : p.resolve(r.result);
          }
          if (r.method === "turn/completed") completed.add(r.params.threadId);
        } catch {}
      }
    });
    child.stderr.on("data", () => {});
    await rpc("initialize", {
      clientInfo: { name: "synthetic_tier_test", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write('{"method":"initialized"}\n');
    const catalog = await rpc("model/list", {});
    const row = catalog.data.find((x) => x.model === "synthetic-model");
    assert.deepEqual(
      row.serviceTiers.map((t) => t.id),
      ["priority", "ultrafast"],
    );
    assert.equal(row.defaultServiceTier, null);
    const start = async () => {
      const r = await rpc("thread/start", {
        model: "synthetic-model",
        modelProvider: "synthetic",
        cwd: root,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
      });
      return r.thread.id;
    };
    async function turn(threadId, options, expected) {
      completed.delete(threadId);
      const before = requests.length;
      await rpc("turn/start", {
        threadId,
        input: [
          { type: "text", text: "Reply synthetic OK", text_elements: [] },
        ],
        ...options,
      });
      await until(() => completed.has(threadId));
      assert.equal(requests.length, before + 1, "no hidden model retries");
      assert.equal(requests.at(-1).service_tier, expected);
    }
    const thread = await start();
    await turn(thread, {}, undefined);
    await turn(thread, { serviceTier: "priority" }, "priority");
    await turn(thread, { serviceTierForTurn: "ultrafast" }, "ultrafast");
    await turn(thread, {}, "priority");
    await turn(thread, { serviceTier: "default" }, undefined);
    await turn(await start(), {}, undefined);
    failNext = true;
    await turn(thread, { serviceTier: "priority" }, "priority");
    console.log(
      JSON.stringify({
        nativeCatalog: true,
        standardOmitted: true,
        fast: "priority",
        ultrafast: "ultrafast",
        oneTurnOverrideDoesNotChangeThread: true,
        newThreadStandard: true,
        noNativeRetryOn503: true,
        syntheticRequests: requests.length,
        paidRequests: 0,
      }),
    );
  } finally {
    clearTimeout(deadline);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise((r) => child.once("exit", r));
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exit;
      clearTimeout(timer);
    }
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
    console.log(
      "Native process, loopback server and temporary profile cleaned.",
    );
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
