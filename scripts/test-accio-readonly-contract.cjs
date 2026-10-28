// Execute only extracted official read-only methods, with synthetic stubs.
// No application startup, credentials, sockets, package imports or telemetry.
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const path = require("node:path");

const file = process.argv[2];
if (!file) throw Error("Supply the verified Accio 0.35.3 gateway-worker.js");
const source = fs.readFileSync(file, "utf8");
assert.equal(
  createHash("sha256").update(source).digest("hex"),
  "8effbddb576d5ae6feea2a8512e33f6d0c8700e707221db1f4027d2e9475ea9f",
);
const ast = ts.createSourceFile(
  "official.js",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
let catalog, channels;
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(ast) === "HXr" &&
    node.initializer &&
    ts.isClassExpression(node.initializer)
  )
    catalog = node.initializer.getText(ast);
  if (
    ts.isMethodDeclaration(node) &&
    node.name.getText(ast) === "queryAuthorizations"
  ) {
    assert.equal(channels, undefined);
    channels = node.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(catalog && channels);
const calls = [];
const context = vm.createContext({
  g: { join: path.join },
  ud: async () => "official-synthetic",
  YH: { withSpan: async (_, f) => f({ end() {} }) },
  RXr: (value) => (Array.isArray(value) ? value : (value?.plugins ?? [])),
  BXr: async () => ({}),
  VXr: async () => {},
  qf: async (route, query) => {
    calls.push({
      method: "GET",
      route,
      query: JSON.parse(JSON.stringify(query)),
    });
    return route.endsWith("/list")
      ? [{ pluginCode: "synthetic" }]
      : { pluginCode: "synthetic", components: [] };
  },
  YA() {},
  xf: () => "global",
  Hkn: async () => "US",
  cj: { debug() {}, error() {} },
  tj: { record() {} },
  pj: (value) => value,
  mj: () => ({}),
  Akn: (value) => value,
  jkn: { parse: (value) => value },
  Tkn: () => ({}),
  COn() {},
  QA: () => ({}),
  performance: { now: () => 1 },
});
vm.runInContext(
  `globalThis.Catalog=${catalog}; globalThis.query=({${channels}}).queryAuthorizations;`,
  context,
  { timeout: 1000 },
);
(async () => {
  const store = new context.Catalog("/synthetic");
  store.setLanguage("en-US");
  await store.listCatalog();
  await store.getDetail("synthetic");
  const receiver = {
    getAccessToken: async () => "official-synthetic",
    httpClient: {
      post: async (route, body) => {
        calls.push({
          method: "POST",
          route,
          query: JSON.parse(JSON.stringify(body)),
        });
        return { authorizations: [{ provider: "synthetic" }] };
      },
    },
  };
  await context.query.call(receiver, "/api/channel/query", undefined);
  await context.query.call(
    receiver,
    "/api/channel/authorization/status",
    "synthetic",
  );
  assert.deepEqual(
    calls.map(({ method, route }) => ({ method, route })),
    [
      { method: "GET", route: "/api/plugin/list" },
      { method: "GET", route: "/api/plugin/detail" },
      { method: "POST", route: "/api/channel/query" },
      { method: "POST", route: "/api/channel/authorization/status" },
    ],
  );
  assert.deepEqual(
    calls.map((call) => Object.keys(call.query).sort()),
    [
      ["accessToken", "lang"],
      ["accessToken", "lang", "pluginCode"],
      ["accessToken", "ipRegion", "packageRegion"],
      ["accessToken", "ipRegion", "packageRegion", "provider"],
    ],
  );
  for (const call of calls)
    assert.equal(call.query.accessToken, "official-synthetic");
  console.log(
    JSON.stringify({
      officialVersion: "0.35.3",
      exactContractsVerified: 4,
      networkCalls: 0,
      applicationProcessesStarted: 0,
      realCredentialsRead: false,
    }),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
