// Keyless acceptance against an isolated official DSH installation and Rust test export.
// Usage: <installed-node> scripts/test-dsh-stream-policy.mjs <installation> <export-dir>
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";

const installation = resolve(process.argv[2]);
const exported = resolve(process.argv[3]);
const require = createRequire(
  join(installation, "package/node_modules/@deepseek-ai/dsh/package.json"),
);
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const { Context } = await load("@deepseek-ai/cordis");
const llm = await load("@deepseek-ai/dsh-llm");
const piAi = await load("@deepseek-ai/dsh-llm-pi-ai");
const { parse } = await load("yaml");
const configs = [];
for (const profile of ["desktop", "web"]) {
  const rows = parse(
    await readFile(
      join(exported, `profiles/${profile}/cordis.patch.yml`),
      "utf8",
    ),
  );
  const config = rows.filter((row) => row.id === "llm-pi-ai").at(-1).config;
  const provider = config.providers["yuanheng-messages"];
  assert.equal(provider.streamIdleTimeoutMs, 600_000);
  assert.deepEqual(provider.retryPolicy, { mode: "normal", maxRetries: 1 });
  for (const name of ["yuanheng-chat", "yuanheng-responses", "mine"]) {
    if (!config.providers[name]) continue;
    assert.equal(config.providers[name].streamIdleTimeoutMs, undefined);
    assert.equal(config.providers[name].retryPolicy, undefined);
  }
  configs.push(config);
}
console.log(
  "PASS: production desktop/Web exports agree; only Claude has the new policy.",
);

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const contexts = [];
const mounts = [];
const responses = new Set();
let active;
let mode = "warmup";
let requests = 0;
let upstreamError;
const upstream = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    upstreamError = error;
    res.destroy();
  });
});
async function handleRequest(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  assert.equal(new URL(req.url, "http://127.0.0.1").pathname, "/v1/messages");
  assert.equal(input.model, "claude-sonnet-4-6");
  assert.equal(req.headers["x-api-key"], "synthetic-local-only");
  requests++;
  const pending = active;
  responses.add(res);
  const timers = [];
  res.on("close", () => {
    responses.delete(res);
    for (const timer of timers) nativeClearTimeout(timer);
    pending?.closed();
  });
  const event = (type, data) => {
    if (!res.destroyed)
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
  };
  const later = (delay, action) => timers.push(nativeSetTimeout(action, delay));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  event("message_start", {
    message: {
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      model: input.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  pending?.started();
  const start = () =>
    event("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    });
  const delta = (text) =>
    event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text },
    });
  const finish = () => {
    event("content_block_stop", { index: 0 });
    event("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    });
    event("message_stop", {});
    res.end();
  };
  if (mode === "warmup") {
    start();
    delta("READY");
    finish();
  } else if (mode === "delayed") {
    later(600, () => {
      start();
      delta("LATE_REPLY");
      finish();
    });
  } else if (mode === "continuous") {
    later(350, () => {
      start();
      delta("A");
    });
    later(700, () => delta("B"));
    later(1_050, () => {
      delta("C");
      finish();
    });
  }
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = nativeSetTimeout(
          () => reject(new Error("Acceptance check exceeded its 3s bound")),
          3_000,
        );
      }),
    ]);
  } finally {
    nativeClearTimeout(timer);
  }
}

function begin(scenario) {
  mode = scenario;
  let started, closed;
  const opened = new Promise((resolve) => {
    started = resolve;
  });
  const ended = new Promise((resolve) => {
    closed = resolve;
  });
  active = { started, closed };
  return { opened, ended };
}

async function runtime(config, idleMs) {
  const patched = structuredClone(config);
  for (const provider of Object.values(patched.providers)) {
    // No fixture endpoint can leave this computer, including preserved user providers.
    provider.baseURL = `http://127.0.0.1:${upstream.address().port}`;
  }
  if (idleMs !== undefined)
    patched.providers["yuanheng-messages"].streamIdleTimeoutMs = idleMs;
  const ctx = new Context();
  contexts.push(ctx);
  const kernel = ctx.plugin(llm.default);
  mounts.push(kernel);
  await kernel;
  const adapter = ctx.plugin(piAi, patched);
  mounts.push(adapter);
  await adapter;
  return ctx;
}

async function generate(ctx, signal, onChunk) {
  const assembler = new llm.BlockAssembler();
  for await (const chunk of ctx.llm.stream({
    provider: "yuanheng-messages",
    model: "claude-sonnet-4-6",
    messages: [],
    signal,
  })) {
    assembler.push(chunk);
    onChunk?.(chunk);
  }
  return {
    finish: assembler.finish,
    message: assembler.message({
      kind: "model",
      provider: "yuanheng-messages",
      model: "claude-sonnet-4-6",
    }),
  };
}

// Only these two watchdog durations are accelerated, retaining their 1:2 relation.
// This is a local timing/abort check, not a ten-minute live-provider acceptance.
globalThis.setTimeout = (action, delay, ...args) =>
  nativeSetTimeout(
    action,
    delay === 300_000 ? 400 : delay === 600_000 ? 800 : delay,
    ...args,
  );
process.env.YUANHENG_DSH_API_KEY = "synthetic-local-only";
try {
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const current = await runtime(configs[1]);
  const policy = current.llm.providerRetryPolicy("yuanheng-messages");
  assert.equal(policy.mode, "normal");
  assert.equal(policy.maxRetries, 1);
  for (const name of ["yuanheng-chat", "yuanheng-responses"]) {
    assert.equal(current.llm.providerRetryPolicy(name).maxRetries, 5);
  }
  assert.equal((await bounded(generate(current))).finish.kind, "stop");
  console.log(
    "PASS: official SDK accepts the production profile and resolves bounded retries.",
  );

  const legacy = await runtime(configs[1], 300_000);
  let request = begin("delayed");
  const oldResult = await bounded(generate(legacy));
  assert.equal(oldResult.finish.failure.code, "TIMEOUT");
  await bounded(request.ended);
  request = begin("delayed");
  const newResult = await bounded(generate(current));
  assert.equal(newResult.finish.kind, "stop");
  assert.equal(newResult.message.content[0].text, "LATE_REPLY");
  await bounded(request.ended);
  console.log(
    "PASS: a delayed reply that times out at the old threshold completes at the new one.",
  );

  request = begin("continuous");
  const continued = await bounded(generate(current));
  assert.equal(continued.finish.kind, "stop");
  assert.equal(continued.message.content[0].text, "ABC");
  await bounded(request.ended);
  console.log(
    "PASS: continuing output survives longer than the single idle interval.",
  );

  request = begin("idle");
  const timedOut = await bounded(generate(current));
  assert.equal(timedOut.finish.failure.code, "TIMEOUT");
  await bounded(request.ended);
  console.log(
    "PASS: a genuinely idle request still times out and closes its upstream connection.",
  );

  request = begin("idle");
  const controller = new AbortController();
  const stopped = generate(current, controller.signal);
  await bounded(request.opened);
  controller.abort("synthetic user stop");
  const cancelled = await bounded(stopped);
  assert.equal(cancelled.finish.kind, "aborted");
  await bounded(request.ended);

  request = begin("continuous");
  const partialStop = new AbortController();
  const partial = await bounded(
    generate(current, partialStop.signal, (chunk) => {
      if (chunk.type === "text-delta")
        partialStop.abort("synthetic stop after output");
    }),
  );
  assert.equal(partial.finish.kind, "aborted");
  assert.equal(partial.message.content[0].text, "A");
  await bounded(request.ended);
  assert.equal(responses.size, 0);
  assert.equal(requests, 7, "SDK-level hidden retries must remain disabled");
  console.log(
    "PASS: user stop before and after output closes the request without waiting for the longer watchdog.",
  );
} finally {
  globalThis.setTimeout = nativeSetTimeout;
  for (const response of responses) response.destroy();
  upstream.closeAllConnections();
  if (upstream.listening)
    await new Promise((resolve) => upstream.close(resolve));
  for (const mount of mounts.reverse()) await mount.dispose();
  for (const ctx of contexts) assert.equal(ctx.registry.size, 0);
  assert.equal(responses.size, 0);
  console.log(
    "CLEANUP: all contexts, timers and mock connections closed; no child processes started.",
  );
  if (upstreamError) throw upstreamError;
}
