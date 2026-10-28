const fs = require("fs");
const vm = require("vm");
const http = require("http");
const assert = require("assert/strict");
const ts = require("typescript");
const { createHash } = require("node:crypto");
const bundle = process.argv[2];
if (!bundle)
  throw new Error(
    "Usage: node scripts/test-accio-work-protocol.cjs <verified v0.34.5 gateway-worker.js>",
  );
const source = fs.readFileSync(bundle, "utf8");
assert.equal(
  createHash("sha256").update(source).digest("hex"),
  "b42bb8d4c524600d78592a1cdf1c4472e961fa1ae3144f23f3f41bf14db8853d",
  "Only the inspected official v0.34.5 bundle is accepted",
);
const ast = ts.createSourceFile(
  "gateway-worker.js",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const starts = {
  transport: source.indexOf("var Tr=class"),
  model: source.indexOf("var aee="),
  catalog: source.indexOf("async function li("),
};
let transport, model, catalog, desktopCatalog, desktopModelBase;
let incompleteToolCondition;
const protocolDefinitions = [];
const protocolFunctions = [];
function visit(node) {
  const start = node.getStart(ast);
  if (
    ts.isIfStatement(node) &&
    node.expression.getText(ast) ===
      "e.turnComplete===!1&&e.content?.parts?.some(e=>e.functionCall)"
  ) {
    assert.equal(
      incompleteToolCondition,
      undefined,
      "unique official consumer condition",
    );
    incompleteToolCondition = node.expression.getText(ast);
  }
  if (ts.isFunctionDeclaration(node) && start > 8260000 && start < 8267000) {
    if (node.name?.text === "xVr") desktopCatalog = node.getText(ast);
    if (node.name?.text === "DVr") desktopModelBase = node.getText(ast);
  }
  if (
    start > 2724500 &&
    start < 2779000 &&
    ts.isVariableDeclaration(node) &&
    node.initializer &&
    ts.isObjectLiteralExpression(node.initializer) &&
    node.initializer.properties.some((p) => p.name?.getText(ast) === "fromJSON")
  ) {
    protocolDefinitions.push(
      `var ${node.name.getText(ast)}=${node.initializer.getText(ast)};`,
    );
  }
  if (
    ts.isFunctionDeclaration(node) &&
    ((start > 2730000 &&
      start < 2779000 &&
      ["pt", "mt", "gt", "ht"].includes(node.name?.text)) ||
      (start > 2780000 &&
        start < 2830000 &&
        ["Vr", "Vn", "Bn"].includes(node.name?.text)))
  ) {
    protocolFunctions.push(node.getText(ast));
  }
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(ast) === "Tr" &&
    start > starts.transport &&
    start < starts.transport + 20
  )
    transport = node.initializer.getText(ast);
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(ast) === "oee" &&
    start > starts.model &&
    start < starts.model + 160
  )
    model = node.initializer.getText(ast);
  if (ts.isFunctionDeclaration(node) && start === starts.catalog)
    catalog = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(
  transport &&
    model &&
    catalog &&
    desktopCatalog &&
    desktopModelBase &&
    incompleteToolCondition,
  "exact official bundled definitions found",
);
const received = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  received.push({
    path: req.url,
    method: req.method,
    headers: req.headers,
    body: JSON.parse(body || "{}"),
  });
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/standard/v1/llm/config/v2") {
    res.writeHead(404);
    res.end('{"error":"unknown route"}');
  } else if (req.url === "/vendor/api/llm/config/v2")
    res.end(
      JSON.stringify([
        { provider: "synthetic", modelList: [{ model: "mock-model" }] },
      ]),
    );
  else if (req.url === "/denied/llm/config/v2")
    res.end(
      '{"success":false,"code":"LOGIN_REQUIRED","message":"synthetic login required"}',
    );
  else {
    res.writeHead(404);
    res.end("{}");
  }
});
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = {
    OPENAI_API_KEY: "dummy-api-key",
    OPENAI_BASE_URL: origin + "/standard/v1",
  };
  let blocked = 0;
  const sandbox = {
    process: { env },
    setTimeout,
    clearTimeout,
    AbortController,
    URL,
    Buffer,
    console,
    m: () => "dummy-accio-session",
    cee: "https://phoenix-gw.alibaba.com/api",
    lee: "/llm/config/v2",
    fetch: (url, options) => {
      if (new URL(url).origin !== origin) {
        blocked++;
        throw Error("external network denied");
      }
      return fetch(url, options);
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(catalog + ";globalThis.catalog=li;", context, {
    timeout: 1000,
  });
  let passed = 0;
  async function check(label, fn) {
    await fn();
    passed++;
    console.log("PASS " + label);
  }
  try {
    await check(
      "catalog does not use OPENAI_BASE_URL or OPENAI_API_KEY",
      async () => {
        await assert.rejects(
          () => sandbox.catalog(),
          /external network denied/,
        );
        assert.equal(blocked, 1);
        assert.equal(received.length, 0);
      },
    );
    await check(
      "pointing vendor gateway at a standard v1 API returns route 404",
      async () => {
        await assert.rejects(
          () => sandbox.catalog({ gatewayBaseUrl: origin + "/standard/v1" }),
          /404/,
        );
        assert.equal(received.at(-1).path, "/standard/v1/llm/config/v2");
        assert.equal(received.at(-1).method, "POST");
        assert.equal(received.at(-1).headers.authorization, undefined);
        assert.equal(received.at(-1).body.token, "dummy-accio-session");
      },
    );
    await check(
      "vendor model-catalog endpoint is accepted as positive control",
      async () => {
        const response = await sandbox.catalog({
          gatewayBaseUrl: origin + "/vendor/api",
          packageRegion: "synthetic",
        });
        assert.equal(JSON.parse(response)[0].modelList[0].model, "mock-model");
        assert.equal(received.at(-1).headers["x-package-region"], "synthetic");
      },
    );
    await check(
      "HTTP 200 business authentication failure is rejected",
      async () => {
        await assert.rejects(
          () => sandbox.catalog({ gatewayBaseUrl: origin + "/denied" }),
          /LOGIN_REQUIRED/,
        );
      },
    );
    await check(
      "packaged model constructor uses gateway option, not OpenAI API environment",
      () => {
        sandbox.Tr = class {
          constructor(options) {
            this.options = options;
          }
        };
        sandbox.aee = "https://phoenix-gw.alibaba.com/api/adk/llm";
        sandbox.y = (x) => x;
        vm.runInContext("globalThis.Model=" + model, context, {
          timeout: 1000,
        });
        const client = new sandbox.Model({ model: "mock-model" });
        assert.equal(client.gatewayBaseUrl, sandbox.aee);
        const configured = new sandbox.Model({
          model: "mock-model",
          gatewayBaseUrl: origin + "/vendor/api/adk/llm",
        });
        const request = configured.prepareRequest({
          contents: [{ role: "user", parts: [{ text: "synthetic hello" }] }],
        });
        assert.equal(request.model, "mock-model");
        assert.ok(request.contents);
        assert.equal(request.messages, undefined);
      },
    );
    await check(
      "official transport constructs generateContent, not OpenAI responses/chat route",
      async () => {
        let captured;
        Object.assign(sandbox, {
          Hn: 500,
          Un: 500,
          Wr: () => {},
          Qr: () => {},
          Ur: () => Error("aborted"),
          Vn: (x) => x,
          qe: { toJSON: (x) => x },
          Kt: () => "synthetic-signature",
          _: () => undefined,
          Gr: async (p) => p,
          Tt: () => {},
          Et: () => {},
          wt: () => {},
          yt: () => {},
        });
        vm.runInContext("globalThis.Transport=" + transport, context, {
          timeout: 1000,
        });
        const client = new sandbox.Transport({
          baseUrl: origin + "/vendor/api/adk/llm",
          transportInterceptor: {
            beforeRequest: async (request) => {
              captured = request;
              throw Error("STOP_AFTER_REQUEST_CAPTURE");
            },
          },
        });
        try {
          for await (const ignored of client.streamGenerateContent({
            requestId: "synthetic-request",
            model: "mock-model",
            contents: [],
          })) {
          }
        } catch {}
        assert.ok(captured, "request captured before networking");
        assert.equal(
          new URL(captured.url).pathname,
          "/vendor/api/adk/llm/generateContent",
        );
        assert.equal(captured.headers.Accept, "text/event-stream");
        assert.equal(captured.headers.Authorization, undefined);
        assert.ok(JSON.parse(captured.body).contents);
        assert.equal(client.activeControllers.size, 0);
      },
    );
    await check(
      "actual protobuf serialization preserves JSON-encoded tool argument keys",
      () => {
        vm.runInContext(
          protocolDefinitions.join("\n") + protocolFunctions.join("\n"),
          context,
          { timeout: 1000 },
        );
        const request = sandbox.qe.fromJSON({
          model: "mock-model",
          systemInstruction: "synthetic system",
          maxOutputTokens: 512,
          contents: [
            {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "call-a",
                    name: "read",
                    argsJson: '{"filePath":"synthetic.txt"}',
                  },
                },
              ],
            },
          ],
          tools: [
            {
              name: "read",
              parametersJson:
                '{"type":"object","properties":{"filePath":{"type":"string"}}}',
            },
          ],
          properties: {
            normalized_response: "true",
            toolConfig:
              '{"functionCallingConfig":{"streamFunctionCallArguments":true}}',
          },
        });
        const wire = sandbox.Vn(sandbox.qe.toJSON(request));
        assert.equal(wire.max_output_tokens, 512);
        assert.equal(wire.system_instruction, "synthetic system");
        assert.equal(
          wire.contents[0].parts[0].function_call.args_json,
          '{"filePath":"synthetic.txt"}',
        );
        assert.ok(wire.properties.tool_config);
        assert.equal(wire.tools[0].name, "read");
        assert.equal(
          JSON.parse(wire.tools[0].parameters_json).properties.filePath.type,
          "string",
        );
      },
    );
    await check(
      "actual official response parser accepts bridge envelopes and tool IDs",
      () => {
        for (const frame of [
          {
            content: { role: "model", parts: [{ text: "synthetic reply" }] },
            partial: true,
            turnComplete: false,
          },
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "call-a",
                    name: "read",
                    argsJson: '{"filePath":"x"}',
                  },
                },
              ],
            },
            partial: true,
            turnComplete: false,
          },
          {
            content: { role: "model", parts: [] },
            turnComplete: true,
            finishReason: "STOP",
            usageMetadata: {
              promptTokenCount: 3,
              candidatesTokenCount: 1,
              totalTokenCount: 4,
            },
          },
          {
            content: { role: "model", parts: [] },
            turnComplete: true,
            errorCode: "YUANHENG_STREAM_INCOMPLETE",
            errorMessage: "synthetic error",
          },
        ]) {
          assert.equal(sandbox.Vr(frame), true);
          const parsed = sandbox.et.fromJSON(frame);
          assert.equal(parsed.turnComplete, frame.turnComplete);
          if (frame.content.parts[0]?.functionCall)
            assert.equal(parsed.content.parts[0].functionCall.id, "call-a");
        }
        assert.equal(
          sandbox.Vr({
            content: { role: "model", parts: [] },
            turn_complete: true,
            partial: false,
          }),
          false,
        );
      },
    );
    await check(
      "actual desktop factories append /api once to the gateway root",
      async () => {
        Object.assign(sandbox, {
          Zl: () => origin + "/vendor",
          uVr: () => "synthetic",
          lVr: () => "en-US",
          hVr: async () => null,
          GBr: new Set(),
          RBr: () => false,
          WBr: async () => "dummy-accio-session",
          Ni: () => ({ appVersion: "0.34.5" }),
          Vt: { string: () => undefined },
          Headers,
          Lu: { push: () => {} },
          QBr: (providers) => ({ providers }),
          gVr: async () => {},
        });
        vm.runInContext(
          desktopCatalog +
            ";" +
            desktopModelBase +
            ";globalThis.desktopCatalog=xVr;globalThis.desktopModelBase=DVr;",
          context,
          { timeout: 1000 },
        );
        await sandbox.desktopCatalog("synthetic", "en-US");
        assert.equal(received.at(-1).path, "/vendor/api/llm/config/v2");
        assert.equal(
          sandbox.desktopModelBase(),
          origin + "/vendor/api/adk/llm",
        );
      },
    );
    await check(
      "official agent accepts tool calls only in a completed frame",
      () => {
        vm.runInContext(
          "globalThis.skipsTool=e=>(" + incompleteToolCondition + ")",
          context,
          { timeout: 1000 },
        );
        const content = {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call-a",
                name: "read",
                args: { filePath: "test.txt" },
              },
            },
          ],
        };
        assert.equal(sandbox.skipsTool({ content, turnComplete: false }), true);
        assert.equal(sandbox.skipsTool({ content, turnComplete: true }), false);
      },
    );
    console.log(
      `RESULT ${passed} passed; no official service requests, real credentials, or paid inference.`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    console.log("Local mock server closed.");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  server.closeAllConnections();
  server.close();
});
