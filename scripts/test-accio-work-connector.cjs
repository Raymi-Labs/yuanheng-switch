// Offline regression using exact methods extracted from the verified official
// bundle. No app is launched, no network is opened, and no user data is read.
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const ts = require("typescript");

const [workerFile, asarFile] = process.argv.slice(2);
if (!workerFile || !asarFile) {
  throw Error(
    "Usage: node scripts/test-accio-work-connector.cjs <verified v0.34.5 gateway-worker.js> <verified v0.34.5 app.asar>",
  );
}

function verifiedText(bytes, hash, label) {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, label);
  return bytes.toString("utf8");
}

const worker = verifiedText(
  fs.readFileSync(workerFile),
  "b42bb8d4c524600d78592a1cdf1c4472e961fa1ae3144f23f3f41bf14db8853d",
  "only the inspected official worker is accepted",
);
function readRenderer() {
  const descriptor = fs.openSync(asarFile, "r");
  try {
    const prefix = Buffer.alloc(16);
    assert.equal(fs.readSync(descriptor, prefix, 0, 16, 0), 16);
    const size = prefix.readUInt32LE(12);
    assert(size > 0 && size < 32 * 1024 * 1024);
    const header = Buffer.alloc(size);
    assert.equal(fs.readSync(descriptor, header, 0, size, 16), size);
    const tree = JSON.parse(header.toString("utf8"));
    const node = "out/renderer/assets/connector-store-H1hocn1r.js"
      .split("/")
      .reduce((value, key) => value.files[key], tree);
    assert(!node.unpacked && node.size > 0 && node.size < 1024 * 1024);
    const bytes = Buffer.alloc(node.size);
    assert.equal(
      fs.readSync(
        descriptor,
        bytes,
        0,
        node.size,
        8 + prefix.readUInt32LE(4) + Number(node.offset),
      ),
      node.size,
    );
    return verifiedText(
      bytes,
      "a90adaeb2eebb07c74aa8af13b3bc38f60d5a48cb73cb55ae54c09b474225f9a",
      "only the inspected official renderer is accepted",
    );
  } finally {
    fs.closeSync(descriptor);
  }
}
const renderer = readRenderer();
function extract(source, wanted, kind) {
  const tree = ts.createSourceFile(
    "verified-official.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found = new Map();
  function visit(node) {
    if (kind(node) && wanted.has(node.name?.getText(tree))) {
      const name = node.name.getText(tree);
      // Minified classes can reuse method names, so select the inspected
      // connector manager rather than another class with a similar API.
      if (
        source === worker &&
        !(node.pos >= 12463641 && node.end <= 12551881)
      ) {
        ts.forEachChild(node, visit);
        return;
      }
      assert(!found.has(name), `unique official definition: ${name}`);
      if (name === "handleGatewayEvent") {
        const arrow = node.initializer;
        assert(ts.isArrowFunction(arrow) && ts.isBlock(arrow.body));
        const [bindings, snapshot] = arrow.body.statements;
        assert(ts.isIfStatement(snapshot));
        assert.equal(
          snapshot.expression.getText(tree),
          'n.type==="connector.authorization.snapshot"&&i',
        );
        // Keep the exact snapshot branch. Unrelated later branches contain
        // import.meta and dynamic imports; neither is executed by this test.
        found.set(
          name,
          `(n)=>{${bindings.getText(tree)}${snapshot.getText(tree)}}`,
        );
        return;
      }
      found.set(
        name,
        ts.isPropertyAssignment(node)
          ? node.initializer.getText(tree)
          : node.getText(tree),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.deepEqual([...found.keys()].sort(), [...wanted].sort());
  return found;
}
const managerMethods = extract(
  worker,
  new Set([
    "getAgentAuthorizationState",
    "getAgentAuthorizationSnapshot",
    "readAgentAuthorizationSnapshot",
    "readAgentAuthorizationSnapshotSync",
    "publishAgentAuthorizationSnapshot",
    "applyRemoteAuthorizations",
  ]),
  ts.isMethodDeclaration,
);
const rendererMethods = extract(
  renderer,
  new Set(["fetchConnector", "handleGatewayEvent"]),
  ts.isPropertyAssignment,
);

function setup(query) {
  let now = 1000;
  let enabled = true;
  let connected = [{ accountId: "synthetic-account", status: "connected" }];
  const eventQueue = [];
  let deliveredEvents = 0;
  const noop = () => {};
  const state = { gatewayData: new Map() };
  const rendererContext = vm.createContext({
    Date: { now: () => now },
    E: 0,
    q: 0,
    re: new Map(),
    j: new Map(),
    q0: 5000,
    ja: () => enabled,
    a: () => state,
    e: noop,
    k: { info: noop, debug: noop },
    W4: (event) => event.data,
  });
  const context = vm.createContext({
    Date: { now: () => now },
    Bca: () => 5000,
    xi: () => false,
    y7: { info: noop, warn: noop },
    XP: { record: noop },
  });
  vm.runInContext(
    `globalThis.Manager=class {${[...managerMethods.values()].join("\n")}}`,
    context,
    { timeout: 1000 },
  );
  const manager = new context.Manager();
  const adapter = {
    authType: "mcp-oauth2",
    updateState: (value) => {
      connected = value.accounts;
    },
  };
  Object.assign(manager, {
    agentAuthorizationGeneration: 0,
    agentAuthorizationByConnector: new Map(),
    adapters: new Map([["alibaba", adapter]]),
    resolvedAccioId: "synthetic-owner",
    isAgentAuthorizationMutating: () => false,
    resolveAccioId: async () => "synthetic-owner",
    queryRemoteAuthorizations: query,
    isAgentAuthorizationOwnerUnchanged: async () => true,
    isAgentAuthorizationScopeValid: () => true,
    persistAgentAuthorizationVerification: async () => {},
    getAccounts: () => connected,
    getPendingAccountLabel: () => "synthetic-label",
    syncAccountsToStore: async () => {},
    events: {
      fire: (event) => {
        eventQueue.push(event);
      },
    },
  });
  rendererContext.xe = () => manager.getAgentAuthorizationSnapshot("alibaba");
  vm.runInContext(
    `globalThis.fetchConnector=${rendererMethods.get("fetchConnector")};` +
      `globalThis.handleGatewayEvent=${rendererMethods.get("handleGatewayEvent")};`,
    rendererContext,
    { timeout: 1000 },
  );
  state.fetchConnector = rendererContext.fetchConnector;
  state.handleGatewayEvent = rendererContext.handleGatewayEvent;
  return {
    manager,
    state,
    eventQueue,
    dispatchEvents: () => {
      // The real worker and renderer are separate processes. Deliver the
      // event after its request settles, as an IPC/WebSocket message would.
      while (deliveredEvents < eventQueue.length) {
        const event = eventQueue[deliveredEvents++];
        if (event.type === "connector.authorization.snapshot") {
          state.handleGatewayEvent?.(event);
        }
      }
    },
    cachedAccounts: () => connected,
    setTime: (value) => {
      now = value;
    },
    stop: () => {
      enabled = false;
      delete state.handleGatewayEvent;
      state.gatewayData.clear();
      rendererContext.j.clear();
    },
  };
}

async function flushUntil(check) {
  for (let turn = 0; turn < 100; turn++) {
    if (check()) return;
    await Promise.resolve();
  }
  assert(check(), "official consumer reached the next bounded request");
}

// Responses are driven by a bounded virtual clock. The timer/serialization
// implementation is separately exercised by accio_compat.rs Rust tests.
async function runFeedbackLoop(responseDelayMs, status = 501) {
  const pending = [];
  let requests = 0;
  let time = 1000;
  const system = setup(
    () =>
      new Promise((_resolve, reject) => {
        requests++;
        pending.push(reject);
      }),
  );
  const first = system.state.fetchConnector("alibaba");
  for (let index = 0; index < 6; index++) {
    await flushUntil(() => pending.length === 1);
    // A genuine HTTP Retry-After becomes retryAfterMs on the official error;
    // the snapshot-event feedback path ignores it.
    const error = new Error("YUANHENG_ACCIO_CONNECTORS_UNAVAILABLE");
    error.status = status;
    error.retryAfterMs = 5000;
    time += responseDelayMs;
    system.setTime(time);
    if (index === 5) system.stop();
    pending.shift()(error);
    await flushUntil(
      () => !system.manager.getAgentAuthorizationState("alibaba").inFlight,
    );
    system.dispatchEvents();
  }
  await first;
  await flushUntil(
    () => !system.manager.getAgentAuthorizationState("alibaba").inFlight,
  );
  assert.equal(requests, 6);
  assert.equal(pending.length, 0);
  assert.equal(
    system.cachedAccounts().length,
    1,
    "denial preserves cached authorization",
  );
  assert.equal(
    system.manager.getAgentAuthorizationState("alibaba").state,
    "error",
  );
  assert(
    system.eventQueue.every(
      (event) => event.type === "connector.authorization.snapshot",
    ),
  );
  return time - 1000;
}

(async () => {
  assert.equal(await runFeedbackLoop(0), 0);
  console.log(
    "PASS official failure event bypasses its renderer retry cooldown",
  );
  assert.equal(await runFeedbackLoop(5000), 30000);
  console.log(
    "PASS paced rejection bounds the same feedback loop without authorizing connectors",
  );
  assert.equal(await runFeedbackLoop(0, 401), 0);
  assert.equal(await runFeedbackLoop(5000, 401), 30000);
  console.log(
    "PASS revoked-capability denial also needs pacing and preserves cached accounts",
  );
  const system = setup(async () => ({ remoteByConnector: new Map() }));
  // An empty success list is not a safe alternative: the actual official
  // applyRemoteAuthorizations clears a previously connected cache.
  system.stop();
  const snapshot =
    await system.manager.getAgentAuthorizationSnapshot("alibaba");
  assert.equal(snapshot.state, "ready");
  assert.equal(system.cachedAccounts().length, 0);
  assert(
    system.eventQueue.some((event) => event.type === "connector.disconnected"),
  );
  console.log(
    "PASS empty successful authorization list would clear existing connector state",
  );
  console.log(
    "4 official-consumer regressions passed; network, timers and test processes: 0",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
