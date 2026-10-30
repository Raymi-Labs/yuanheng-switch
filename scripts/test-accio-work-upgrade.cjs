// Offline diagnostic for one inspected official bundle. Passing these checks
// does NOT enable this version in the application launcher or validate its UI.
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const { z } = require("zod");

const file = process.argv[2];
if (!file)
  throw Error(
    "Usage: node scripts/test-accio-work-upgrade.cjs <inspected official gateway-worker.js>",
  );
const source = fs.readFileSync(file, "utf8");
const inspectedBundles = {
  "23f247a2135233570b73f9dd8c11b958bcaba934bcedf49f32c48316858a3980": {
    version: "0.37.1",
    sdkOffset: 622795,
    aliases: {
      V8e: "kve",
      og: "au",
      ag: "iu",
      U8e: "jve",
      h$t: "z8r",
      cw: "OW",
      S$t: "W8r",
      sw: "D8r",
      a1t: "C5r",
      o1t: "w5r",
      H$t: "IW",
      s1t: "T5r",
      Sg: "vu",
      u$t: "F8r",
      fg: "cu",
      U$t: "s5r",
      n$t: "E8r",
      i1t: "S5r",
      o$t: "j8r",
      l1t: "E5r",
      q$t: "d5r",
      Tm: "ud",
      X$t: "m5r",
      $$t: "_5r",
      oga: "M5r",
      p$t: "L8r",
      m$t: "R8r",
      _$t: "B8r",
      v$t: "V8r",
      b$t: "H8r",
      x$t: "U8r",
      Bi: "Pa",
      K: "W",
      q: "G",
      U: "V",
      H: "B",
      W: "H",
      G: "U",
      eo: "So",
    },
    protocolAliases: {
      F: "ee",
      I: "te",
      ee: "F",
      te: "ne",
      L: "I",
      ne: "re",
      re: "ie",
      ie: "ae",
      ae: "oe",
      oe: "L",
      se: "R",
      ce: "se",
      le: "ce",
      ue: "le",
      de: "ue",
      fe: "de",
      pe: "fe",
      me: "pe",
      he: "me",
      ge: "he",
      _e: "ge",
      ve: "_e",
      ye: "ve",
      be: "ye",
      xe: "be",
      Se: "xe",
      Ce: "Se",
      we: "Ce",
      Te: "we",
      Ee: "Te",
      De: "Ee",
      Oe: "De",
      ke: "Oe",
      Ae: "ke",
      je: "Ae",
      Me: "je",
      Ne: "Me",
      Pe: "Ne",
      Fe: "Pe",
      Ie: "Fe",
      Le: "Ie",
      Re: "Le",
      ze: "Re",
      Be: "ze",
      Ve: "Be",
      He: "Ve",
      Ue: "He",
      We: "Ue",
      Ge: "We",
      Ke: "Ge",
      qe: "Ke",
      Je: "qe",
      R: "Je",
      nt: "z",
      rt: "nt",
      it: "rt",
      at: "it",
      ot: "at",
      st: "ot",
      ct: "st",
      lt: "ct",
      z: "lt",
      oi: "eee",
      si: "oi",
      ci: "si",
      li: "ci",
    },
  },
  "5bb09d8401ab6a407c84acc620d90fac5a8fb7bdeb1868028c3032ce7aca2f05": {
    version: "0.35.2",
    sdkOffset: 0,
    aliases: {},
  },
  "8effbddb576d5ae6feea2a8512e33f6d0c8700e707221db1f4027d2e9475ea9f": {
    version: "0.35.3",
    sdkOffset: 15,
    // Only inspected catalogue declarations are renamed inside the isolated
    // test context. No vendor file is changed, and SDK definitions stay intact.
    aliases: {
      jve: "kve",
      ru: "au",
      nu: "iu",
      Nve: "jve",
      i5r: "z8r",
      lW: "OW",
      l5r: "W8r",
      K8r: "D8r",
      H5r: "C5r",
      U5r: "w5r",
      _W: "IW",
      W5r: "T5r",
      hu: "vu",
      e5r: "F8r",
      ou: "cu",
      E5r: "s5r",
      G8r: "E8r",
      V5r: "S5r",
      X8r: "j8r",
      G5r: "E5r",
      A5r: "d5r",
      cd: "ud",
      N5r: "m5r",
      I5r: "_5r",
      Z5r: "M5r",
      n5r: "L8r",
      r5r: "R8r",
      a5r: "B8r",
      o5r: "V8r",
      s5r: "H8r",
      c5r: "U8r",
      Fa: "Pa",
    },
  },
};
const inspected =
  inspectedBundles[createHash("sha256").update(source).digest("hex")];
assert.ok(
  inspected,
  "Uninspected official bundle; keep the production version gate unchanged",
);
const ast = ts.createSourceFile(
  file,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const functions = new Map(),
  schemas = new Map();
const canonicalName = (name) => inspected.aliases[name] ?? name;
const printer = ts.createPrinter();
function renamedText(node, aliases = inspected.aliases) {
  if (Object.keys(aliases).length === 0) return node.getText(ast);
  const transformed = ts.transform(node, [
    (context) => {
      const visit = (child) =>
        ts.isIdentifier(child) && Object.hasOwn(aliases, child.text)
          ? ts.factory.createIdentifier(aliases[child.text])
          : ts.visitEachChild(child, visit, context);
      return (root) => ts.visitNode(root, visit);
    },
  ]);
  try {
    return printer.printNode(
      ts.EmitHint.Unspecified,
      transformed.transformed[0],
      ast,
    );
  } finally {
    transformed.dispose();
  }
}
const catalogueText = (node) => renamedText(node);
const protocolName = (name) => inspected.protocolAliases?.[name] ?? name;
// Names and spans belong only to the hash-pinned bundle above. Extract the
// inspected implementation at runtime; do not copy vendor code into the bridge.
const protocolDefinitions = new Map(),
  protocolFunctions = new Map();
const protocolDefinitionNames = new Set([
  "Me",
  "Pe",
  "Ie",
  "Re",
  "Be",
  "He",
  "We",
  "Ke",
  "Je",
  "Xe",
  "Qe",
  "et",
  "k",
  "si",
  "Kt",
  "Jn",
  "$t",
  "en",
  "tn",
  "nn",
  "rn",
  "an",
  "cn",
  "ln",
  "Wt",
  "wr",
  "ci",
  "Vn",
  "Hn",
]);
const protocolFunctionNames = new Set([
  "y",
  "A",
  "j",
  "M",
  "N",
  "P",
  "ee",
  "te",
  "F",
  "ne",
  "I",
  "re",
  "ie",
  "ae",
  "oe",
  "L",
  "R",
  "ft",
  "pt",
  "mt",
  "ht",
  "Gt",
  "Xt",
  "Zt",
  "qt",
  "Jt",
  "Bn",
  "zn",
  "yr",
  "dn",
  "fn",
  "un",
  "Pn",
  "sn",
  "on",
  "Rn",
  "In",
  "Fn",
  "gn",
  "hn",
  "mn",
  "pn",
  "_n",
  "Nn",
  "Rr",
  "Lr",
  "Ir",
  "zr",
  "Br",
  "Ur",
  "Hr",
  "Wr",
  "hr",
  "gr",
  "_r",
  "vr",
  "Ln",
]);
const names = new Set([
  "kve",
  "au",
  "z8r",
  "OW",
  "W8r",
  "C5r",
  "w5r",
  "T5r",
  "E5r",
  "M5r",
]);
const schemaNames = new Set(["L8r", "R8r", "B8r", "V8r", "H8r", "U8r"]);
const sourceName = (name) =>
  Object.entries(inspected.aliases).find(
    ([, canonical]) => canonical === name,
  )?.[0] ?? name;
const selectedFunctions = new Set([...names].map(sourceName));
const selectedSchemas = new Set([...schemaNames].map(sourceName));
let consumerCondition;
function visit(node) {
  const start = node.getStart(ast);
  if (
    start > 2807200 + inspected.sdkOffset &&
    start < 2936200 + inspected.sdkOffset
  ) {
    if (
      ts.isFunctionDeclaration(node) &&
      protocolFunctionNames.has(protocolName(node.name?.text))
    ) {
      const name = protocolName(node.name.text);
      assert.ok(!protocolFunctions.has(name), name);
      protocolFunctions.set(
        name,
        renamedText(node, inspected.protocolAliases ?? {}),
      );
    }
    if (
      ts.isVariableDeclaration(node) &&
      protocolDefinitionNames.has(protocolName(node.name.getText(ast))) &&
      // All inspected SDK definitions belong to this exact bundled module;
      // exclude same-named locals inside their functions and class methods.
      ts.isVariableDeclarationList(node.parent) &&
      ts.isVariableStatement(node.parent.parent) &&
      ts.isBlock(node.parent.parent.parent) &&
      node.parent.parent.parent.getStart(ast) === 2805360 + inspected.sdkOffset
    ) {
      const name = protocolName(node.name.getText(ast));
      assert.ok(!protocolDefinitions.has(name), name);
      protocolDefinitions.set(
        name,
        `var ${renamedText(node, inspected.protocolAliases ?? {})};`,
      );
    }
  }
  if (
    ts.isFunctionDeclaration(node) &&
    selectedFunctions.has(node.name?.text)
  ) {
    const name = canonicalName(node.name.text);
    assert.ok(!functions.has(name));
    functions.set(name, catalogueText(node));
  }
  if (
    ts.isVariableDeclaration(node) &&
    selectedSchemas.has(node.name.getText(ast))
  ) {
    const name = canonicalName(node.name.getText(ast));
    assert.ok(!schemas.has(name));
    schemas.set(name, `var ${catalogueText(node)};`);
  }
  if (
    ts.isIfStatement(node) &&
    node.expression.getText(ast) ===
      "e.turnComplete===!1&&e.content?.parts?.some(e=>e.functionCall)"
  ) {
    assert.equal(consumerCondition, undefined);
    consumerCondition = node.expression.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(functions.size, names.size);
assert.equal(schemas.size, schemaNames.size);
assert.ok(consumerCondition);
assert.deepEqual(
  [...protocolDefinitions.keys()].sort(),
  [...protocolDefinitionNames].sort(),
  "all inspected SDK/protobuf definitions found",
);
assert.deepEqual(
  [...protocolFunctions.keys()].sort(),
  [...protocolFunctionNames].sort(),
  "all inspected SDK/protobuf functions found",
);

const root = "http://127.0.0.1:54321/accio-work/synthetic-capability";
const requests = [],
  timers = new Set();
let cached = null,
  saved = null,
  responseStatus = 200,
  token = "synthetic-session",
  account = "synthetic-account-a";
const rawCatalog = [
  {
    provider: "yuanheng",
    providerDisplayName: "YuanHeng",
    modelList: [
      {
        modelCode: "synthetic-gpt",
        modelName: "synthetic-gpt",
        modelDisplayName: "synthetic-gpt",
        visible: true,
        isDefault: true,
      },
      {
        modelCode: "synthetic-deepseek",
        modelName: "synthetic-deepseek",
        modelDisplayName: "synthetic-deepseek",
        visible: true,
        isDefault: false,
      },
    ],
  },
];
const sandbox = {
  process: { env: {} },
  // Execute the inspected schema declarations with this repository's Zod 4;
  // internal hidden-model classification is outside this isolated check.
  W: z.object,
  G: z.enum,
  V: z.number,
  B: z.string,
  H: z.boolean,
  U: z.array,
  So: z.union,
  D8r: () => false,
  // 0.37.1 retains hidden-model metadata separately. These in-memory sinks do
  // not bypass schema parsing, request authentication or stream conversion.
  f$t: new WeakMap(),
  g$t: () => false,
  r$t: (model) => model === "auto" || model.startsWith("auto:"),
  // The automatic legacy-disk persistence decision is outside this fixture.
  c1t: () => false,
  Headers,
  AbortController,
  URL,
  JSON,
  Date,
  Error,
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timers.add(timer);
    return timer;
  },
  clearTimeout: (timer) => {
    clearTimeout(timer);
    timers.delete(timer);
  },
  iu: {
    prod: {
      environment: "prod",
      gatewayBaseUrl: "https://phoenix-gw.alibaba.com",
    },
  },
  jve: () => {
    throw Error("pre environment not under test");
  },
  cu: () => root,
  F8r: async () => token,
  s5r: () => "synthetic-region",
  IW: (value) => value || "en",
  E8r: () => true,
  S5r: () => inspected.version,
  j8r: async () => account,
  h: { createHash },
  d5r: async () => cached,
  m5r: async (...args) => {
    saved = args;
  },
  _5r: async () => {
    throw Error("legacy persistence is outside this test");
  },
  ud: { push: () => {} },
  Pa: () => ({ appVersion: inspected.version }),
  fetch: async (url, options) => {
    assert.equal(
      url,
      root + "/api/llm/config/v2",
      "no official or external request permitted",
    );
    requests.push({
      url,
      headers: Object.fromEntries(options.headers),
      body: JSON.parse(options.body),
      method: options.method,
    });
    if (responseStatus === 304)
      return new Response(null, {
        status: 304,
        headers: { etag: "synthetic-etag" },
      });
    return new Response(
      JSON.stringify(
        responseStatus === 200 ? rawCatalog : { error: "synthetic rejected" },
      ),
      { status: responseStatus },
    );
  },
};
// Fixed synthetic request identity for rejection tests, with no local account data.
const awaitIdentity = {
  adkUrl: root + "/api/llm/config/v2",
  effectiveRegion: "synthetic-region",
  normalizedLanguage: "en",
  token: "synthetic-session",
  supportAutoModel: true,
  appVersion: inspected.version,
  cacheKey: "synthetic-cache",
};
const context = vm.createContext(sandbox);
vm.runInContext(
  [...schemas.values(), ...functions.values()].join("\n"),
  context,
  { timeout: 1000 },
);
const modelRequests = [];
let nextModelBody;
const syntheticDeviceHeaders = {
  utdid: "synthetic-device-id",
  version: inspected.version,
  appKey: "synthetic-app-key",
};
const protocolSandbox = {
  process: { env: {} },
  Buffer,
  URL,
  Headers,
  Response,
  ReadableStream,
  TextDecoder,
  TextEncoder,
  AbortController,
  DOMException,
  Error,
  Date,
  JSON,
  atob,
  btoa,
  setTimeout: sandbox.setTimeout,
  clearTimeout: sandbox.clearTimeout,
  Se: { createHash },
  m: () => "synthetic-official-session",
  _: (key) => syntheticDeviceHeaders[key],
  // Only telemetry sinks are replaced. Request conversion, framing, parsing,
  // abort handling and stream summaries all execute the official definitions.
  bt: () => false,
  Ct: () => {},
  wt: () => {},
  Tt: () => {},
  fetch: async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, new URL(root).origin);
    assert.equal(
      parsed.pathname,
      new URL(root).pathname + "/api/adk/llm/generateContent",
      "only the synthetic model endpoint is accepted",
    );
    assert.ok(nextModelBody, "no unplanned transport request allowed");
    modelRequests.push({
      url,
      method: options.method,
      headers: options.headers,
      body: JSON.parse(options.body),
    });
    const body = nextModelBody;
    nextModelBody = undefined;
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  },
};
const protocolContext = vm.createContext(protocolSandbox);
vm.runInContext(
  [...protocolDefinitions.values(), ...protocolFunctions.values()].join("\n"),
  protocolContext,
  { timeout: 1000 },
);
const plain = (value) => JSON.parse(JSON.stringify(value));
function newTransport(options = {}) {
  return new protocolSandbox.wr({
    baseUrl: root + "/api/adk/llm/",
    connectTimeoutMs: 1000,
    streamIdleTimeoutMs: 1000,
    ...options,
  });
}
function syntheticSdkRequest() {
  const model = new protocolSandbox.ci({
    model: "synthetic-gpt",
    gatewayBaseUrl: root + "/api/adk/llm",
  });
  return model.prepareRequest({
    requestId: "synthetic-request",
    systemInstruction: "synthetic system",
    maxOutputTokens: 512,
    contents: [
      { role: "user", parts: [{ text: "synthetic hello" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "call-synthetic",
              name: "read",
              args: {
                filePath: "synthetic.txt",
                nestedKey: { keepCase: true },
              },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call-synthetic",
              name: "read",
              response: {
                fileContents: "合成文本",
                nestedKey: { keepCase: true },
              },
            },
          },
        ],
      },
    ],
    tools: [
      {
        name: "read",
        description: "Read a synthetic file",
        parametersJson: JSON.stringify({
          type: "object",
          properties: { filePath: { type: "string" } },
          required: ["filePath"],
        }),
      },
    ],
    properties: {
      toolConfig: JSON.stringify({
        functionCallingConfig: { streamFunctionCallArguments: true },
      }),
    },
  });
}
function fragmentedBody(text) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      // Split UTF-8 code points, JSON tokens and SSE delimiters deliberately.
      const end = Math.min(offset + (offset % 7) + 1, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("PASS " + name);
}
(async () => {
  try {
    await check(
      "explicit gateway environment wins; absent environment selects official gateway",
      () => {
        sandbox.process.env.GATEWAY_BASE_URL = root;
        assert.equal(sandbox.au("prod").gatewayBaseUrl, root);
        delete sandbox.process.env.GATEWAY_BASE_URL;
        assert.equal(
          sandbox.au("prod").gatewayBaseUrl,
          "https://phoenix-gw.alibaba.com",
        );
      },
    );
    await check("desktop model and catalog URLs append api once", async () => {
      const identity = await sandbox.T5r("synthetic-region", "en", {});
      assert.equal(identity.adkUrl, root + "/api/llm/config/v2");
      assert.equal(sandbox.M5r(), root + "/api/adk/llm");
    });
    await check(
      "new catalog schema accepts the current YuanHeng array and default model",
      () => {
        const snapshot = sandbox.OW(rawCatalog);
        assert.equal(snapshot.providers[0].modelList.length, 2);
        assert.equal(snapshot.providers[0].modelList[0].isDefault, true);
        assert.equal(
          sandbox.W8r(snapshot).providers[0].modelList[1].modelCode,
          "synthetic-deepseek",
        );
      },
    );
    await check(
      "actual new catalog loader accepts a 200 response without etag",
      async () => {
        const identity = await sandbox.T5r("synthetic-region", "en", {});
        const snapshot = await sandbox.E5r(identity);
        assert.equal(snapshot.providers[0].modelList.length, 2);
        assert.equal(requests.at(-1).method, "POST");
        assert.equal(
          requests.at(-1).headers["x-app-version"],
          inspected.version,
        );
        assert.deepEqual(requests.at(-1).body, {
          token: "synthetic-session",
          supportAutoModel: true,
        });
        assert.ok(saved);
      },
    );
    await check(
      "catalog cache identity changes across accounts, languages and gateways",
      async () => {
        const a = await sandbox.T5r("synthetic-region", "en", {});
        account = "synthetic-account-b";
        const b = await sandbox.T5r("synthetic-region", "en", {});
        const c = await sandbox.T5r("synthetic-region", "zh", {});
        assert.notEqual(a.cacheKey, b.cacheKey);
        assert.notEqual(b.cacheKey, c.cacheKey);
        sandbox.cu = () => root + "-rotated";
        const d = await sandbox.T5r("synthetic-region", "zh", {});
        assert.notEqual(c.cacheKey, d.cacheKey);
        sandbox.cu = () => root;
      },
    );
    await check(
      "conditional 304 is rejected without a scoped snapshot",
      async () => {
        responseStatus = 304;
        await assert.rejects(
          () => sandbox.E5r(awaitIdentity),
          /without a scoped/,
        );
      },
    );
    await check(
      "HTTP authentication errors fail instead of reporting an empty success",
      async () => {
        responseStatus = 401;
        await assert.rejects(() => sandbox.E5r(awaitIdentity), /401/);
        responseStatus = 200;
      },
    );
    await check(
      "missing official identity prevents catalog requests",
      async () => {
        const before = requests.length;
        token = "";
        await assert.rejects(
          () => sandbox.T5r("synthetic-region", "en", {}),
          /No auth token/,
        );
        assert.equal(requests.length, before);
      },
    );
    await check("new consumer still ignores incomplete function calls", () => {
      sandbox.e = {
        turnComplete: false,
        content: { parts: [{ functionCall: { name: "read" } }] },
      };
      assert.equal(
        vm.runInContext(consumerCondition, context, { timeout: 1000 }),
        true,
      );
      sandbox.e.turnComplete = true;
      assert.equal(
        vm.runInContext(consumerCondition, context, { timeout: 1000 }),
        false,
      );
    });
    await check(
      "actual SDK model constructor selects the explicit gateway and model override",
      () => {
        protocolSandbox.process.env.OPENAI_BASE_URL = root + "/unused/v1";
        protocolSandbox.process.env.OPENAI_API_KEY = "synthetic-unused-key";
        const defaultModel = new protocolSandbox.ci({ model: "synthetic-gpt" });
        assert.equal(defaultModel.gatewayBaseUrl, protocolSandbox.si);
        protocolSandbox.process.env.ACCIO_GATEWAY_URL = root + "/sdk-override";
        const environmentModel = new protocolSandbox.ci({
          model: "synthetic-gpt",
        });
        assert.equal(environmentModel.gatewayBaseUrl, root + "/sdk-override");
        const model = new protocolSandbox.ci({
          model: "synthetic-gpt",
          gatewayBaseUrl: sandbox.M5r(),
        });
        assert.equal(model.gatewayBaseUrl, root + "/api/adk/llm");
        assert.equal(
          model.prepareRequest({ contents: [] }).model,
          "synthetic-gpt",
        );
        assert.equal(
          model.prepareRequest({ model: "synthetic-deepseek", contents: [] })
            .model,
          "synthetic-deepseek",
        );
        assert.equal(model.fallbackInstances.length, 0);
        assert.equal(modelRequests.length, 0);
        defaultModel.close();
        environmentModel.close();
        model.close();
        delete protocolSandbox.process.env.ACCIO_GATEWAY_URL;
      },
    );
    await check(
      "actual protobuf request serialization preserves flat tools and JSON argument keys",
      () => {
        const prepared = syntheticSdkRequest();
        const proto = protocolSandbox.R(prepared);
        const wire = protocolSandbox.Bn(protocolSandbox.Ke.toJSON(proto));
        assert.equal(wire.model, "synthetic-gpt");
        assert.equal(wire.request_id, "synthetic-request");
        assert.equal(wire.system_instruction, "synthetic system");
        assert.equal(wire.max_output_tokens, 512);
        assert.equal(wire.token, "synthetic-official-session");
        assert.equal(wire.tools[0].name, "read");
        assert.equal(wire.tools[0].function_declarations, undefined);
        assert.deepEqual(JSON.parse(wire.tools[0].parameters_json), {
          type: "object",
          properties: { filePath: { type: "string" } },
          required: ["filePath"],
        });
        assert.deepEqual(
          JSON.parse(wire.contents[1].parts[0].function_call.args_json),
          { filePath: "synthetic.txt", nestedKey: { keepCase: true } },
        );
        assert.deepEqual(
          JSON.parse(wire.contents[2].parts[0].function_response.response_json),
          { fileContents: "合成文本", nestedKey: { keepCase: true } },
        );
        assert.equal(wire.properties.normalized_response, "true");
        assert.equal(
          JSON.parse(wire.properties.tool_config).functionCallingConfig
            .streamFunctionCallArguments,
          true,
        );
        const parsed = protocolSandbox.Ke.fromJSON(wire);
        assert.equal(
          parsed.tools[0].parametersJson,
          wire.tools[0].parameters_json,
        );
        assert.equal(
          parsed.contents[1].parts[0].functionCall.argsJson,
          wire.contents[1].parts[0].function_call.args_json,
        );
      },
    );
    await check(
      "actual transport builds generateContent with the inspected headers and payload",
      async () => {
        let captured;
        const transport = newTransport({
          transportInterceptor: {
            beforeRequest: async (request) => {
              captured = request;
              throw Error("SYNTHETIC_CAPTURE_COMPLETE");
            },
          },
        });
        try {
          await assert.rejects(async () => {
            for await (const frame of transport.streamGenerateContent(
              protocolSandbox.R(syntheticSdkRequest()),
            )) {
              assert.fail("capture must stop before response parsing");
            }
          }, /SYNTHETIC_CAPTURE_COMPLETE/);
          const url = new URL(captured.url);
          assert.equal(
            url.pathname,
            new URL(root).pathname + "/api/adk/llm/generateContent",
          );
          assert.equal(
            url.searchParams.get("sg_k"),
            createHash("md5").update("synthetic-request").digest("hex"),
          );
          assert.equal(captured.method, "POST");
          assert.deepEqual(plain(captured.headers), {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...syntheticDeviceHeaders,
          });
          assert.equal(captured.headers.Authorization, undefined);
          assert.equal(JSON.parse(captured.body).tools[0].name, "read");
          assert.equal(modelRequests.length, 0, "capture never invokes fetch");
          assert.equal(transport.activeControllers.size, 0);
          assert.equal(timers.size, 0);
        } finally {
          transport.close();
        }
      },
    );
    await check(
      "actual transport parses fragmented UTF-8 SSE text, terminal tools and usage",
      async () => {
        const frames = [
          {
            content: { role: "model", parts: [{ text: "合成回复🙂" }] },
            partial: true,
            turnComplete: false,
          },
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "call-synthetic",
                    name: "read",
                    argsJson: '{"filePath":"synthetic.txt","keepCase":true}',
                  },
                },
              ],
            },
            turnComplete: true,
            partial: false,
            finishReason: "STOP",
            usageMetadata: {
              promptTokenCount: 7,
              candidatesTokenCount: 3,
              totalTokenCount: 10,
            },
          },
        ];
        // Include a heartbeat, ignored malformed frame, CRLF and [DONE].
        nextModelBody = fragmentedBody(
          ": synthetic heartbeat\n\n" +
            "data: {not-json}\n\n" +
            frames
              .map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`)
              .join("") +
            "data: [DONE]\n\n",
        );
        let summary;
        const transport = newTransport({
          transportInterceptor: {
            afterStream: (value) => {
              summary = value;
            },
          },
        });
        const parsed = [];
        try {
          for await (const frame of transport.streamGenerateContent(
            protocolSandbox.R(syntheticSdkRequest()),
          ))
            parsed.push(frame);
          assert.equal(parsed.length, 2);
          assert.equal(parsed[0].content.parts[0].text, "合成回复🙂");
          assert.equal(parsed[0].turnComplete, false);
          assert.equal(parsed[1].turnComplete, true);
          const call = protocolSandbox.ee(
            parsed[1].content.parts[0].functionCall,
          );
          assert.deepEqual(plain(call), {
            id: "call-synthetic",
            name: "read",
            args: { filePath: "synthetic.txt", keepCase: true },
          });
          assert.equal(parsed[1].usageMetadata.totalTokenCount, 10);
          assert.equal(parsed[1].finishReason, "STOP");
          assert.equal(summary.endReason, "completed");
          assert.equal(summary.protoFrameCount, 2);
          assert.equal(summary.passthroughFrameCount, 0);
          assert.equal(summary.heartbeatEventsReceived, 1);
          assert.equal(summary.sseParseErrorCount, 1);
          assert.equal(summary.doneEventsReceived, 1);
          assert.equal(summary.cleanEof, true);
          assert.equal(modelRequests.length, 1);
          assert.equal(transport.activeControllers.size, 0);
          assert.equal(timers.size, 0);
        } finally {
          transport.close();
        }
      },
    );
    await check(
      "actual response parser retains bridge terminal errors and rejects snake-only envelopes",
      () => {
        const frame = {
          content: {
            role: "model",
            parts: [
              { text: "请求未完成：synthetic upstream stream interrupted" },
            ],
          },
          turnComplete: true,
          errorCode: "YUANHENG_STREAM_INCOMPLETE",
          errorMessage: "synthetic upstream stream interrupted",
        };
        assert.equal(protocolSandbox.Br(frame), true);
        const parsed = protocolSandbox.et.fromJSON(frame);
        assert.equal(parsed.turnComplete, true);
        assert.equal(parsed.errorCode, frame.errorCode);
        assert.equal(parsed.errorMessage, frame.errorMessage);
        assert.equal(parsed.content.parts[0].text, frame.content.parts[0].text);
        assert.equal(
          protocolSandbox.Br({
            content: { role: "model", parts: [] },
            turn_complete: true,
            partial: false,
          }),
          false,
        );
      },
    );
    await check(
      "actual transport cancellation releases the reader, controller and timers",
      async () => {
        let cancelled = false;
        nextModelBody = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"content":{"role":"model","parts":[{"text":"synthetic"}]},"turnComplete":false}\n\n',
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        });
        const abort = new AbortController();
        const transport = newTransport();
        try {
          await assert.rejects(
            async () => {
              for await (const frame of transport.streamGenerateContent(
                protocolSandbox.R(syntheticSdkRequest()),
                { signal: abort.signal },
              )) {
                assert.equal(frame.content.parts[0].text, "synthetic");
                abort.abort();
              }
            },
            (error) => error.name === "AbortError",
          );
          assert.equal(cancelled, true);
          assert.equal(transport.activeControllers.size, 0);
          assert.equal(timers.size, 0);
          assert.equal(modelRequests.length, 2);
        } finally {
          transport.close();
        }
      },
    );
    assert.equal(timers.size, 0);
    console.log(
      JSON.stringify({
        version: inspected.version,
        passed,
        timersRemaining: timers.size,
        syntheticModelRequests: modelRequests.length,
        externalRequests: 0,
        productionVersionGateChanged: false,
      }),
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
