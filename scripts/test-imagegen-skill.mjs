#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  cp,
  symlink,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL(
    "../src-tauri/src/resources/builtin_skills/meta-api-imagegen/scripts/meta_api_imagegen.mjs",
    import.meta.url,
  ),
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KcYAAAAASUVORK5CYII=",
  "base64",
);
const image = { data: [{ b64_json: png.toString("base64") }] };
const finalItem = {
  type: "image_generation_call",
  status: "completed",
  result: png.toString("base64"),
};
const finalEvent = {
  type: "response.completed",
  response: { status: "completed", output: [finalItem] },
};
const sse = (...events) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function scenario(options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "yuanheng-image-skill-"));
  const home = resolve(directory, "codex-home");
  await mkdir(home);
  const out = resolve(directory, "out", "image.png");
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const call = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body,
    };
    calls.push(call);
    try {
      if (
        options.handler &&
        (await options.handler(call, res, { directory, home, out }))
      )
        return;
      if (req.method === "GET")
        json(res, 200, {
          data: (
            options.models || [
              "gpt-image-2.5-flare",
              "gpt-5.5",
              "gpt-image-2",
              "gpt-image-2.5-sunburst",
            ]
          ).map((id) => ({ id })),
        });
      else json(res, 200, image);
    } catch (error) {
      json(res, 500, { error: { message: error.message } });
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime =
    options.runtime === undefined
      ? {
          owner: "yuanheng-imagegen",
          version: 1,
          enabled: true,
          baseUrl: `${origin}/chatgpt-desktop/v1`,
          terminalBaseUrl: `${origin}/codex/v1`,
          desktopBaseUrl: `${origin}/chatgpt-desktop/v1`,
        }
      : options.runtime;
  if (runtime !== false)
    await writeFile(
      resolve(home, "yuanheng-imagegen.json"),
      JSON.stringify(runtime),
    );
  if (options.auth)
    await writeFile(resolve(home, "auth.json"), JSON.stringify(options.auth));
  const context = { directory, home, out, origin, calls };
  if (options.projectedTarget) {
    const target = options.projectedTarget;
    context.projection = resolve(directory, "imported-skill");
    context.runtimePath = resolve(
      directory,
      "stable-runtime",
      `${target}.json`,
    );
    context.entry = resolve(context.projection, "scripts", "run_imagegen.mjs");
    await cp(resolve(dirname(script), ".."), context.projection, {
      recursive: true,
    });
    await mkdir(dirname(context.runtimePath));
    const routes =
      target === "codex"
        ? {
            codex: `${origin}/codex/v1`,
            "chatgpt-desktop": `${origin}/chatgpt-desktop/v1`,
          }
        : { [target]: `${origin}/${target}/v1` };
    const v2 = {
      owner: "yuanheng-imagegen",
      version: 2,
      target,
      enabled: true,
      defaultSurface: target === "codex" ? "chatgpt-desktop" : target,
      routes,
      directOnly: target !== "codex",
    };
    await writeFile(context.runtimePath, JSON.stringify(v2));
    await writeFile(
      resolve(context.projection, "yuanheng-binding.json"),
      JSON.stringify({
        owner: "yuanheng-imagegen",
        version: 1,
        target,
        runtimePath: context.runtimePath,
      }),
    );
  }
  if (options.setup) await options.setup(context);
  const env = { ...process.env, CODEX_HOME: home };
  delete env.NAN_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.YUANHENG_IMAGEGEN_SURFACE;
  delete env.OPENCODE;
  delete env.OPENCODE_CLIENT;
  Object.assign(env, options.env);
  const extra =
    typeof options.args === "function"
      ? options.args(context)
      : options.args || [];
  const result = await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        context.entry || script,
        "--prompt",
        "Generate a small local test image",
        "--out",
        out,
        ...extra,
      ],
      { cwd: directory, env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      done({ code, stdout, stderr });
    });
  });
  try {
    if (options.check) await options.check({ ...context, ...result });
    return { ...context, ...result };
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
}

function successful(result) {
  assert.equal(result.code, 0, result.stderr);
}
function failed(result) {
  assert.notEqual(result.code, 0, result.stdout);
}
const posts = (calls) => calls.filter((call) => call.method === "POST");

test("runtime directory chooses newest quality model without exposing environment or auth credentials", async () => {
  await scenario({
    env: { OPENAI_API_KEY: "sk-environment-secret" },
    auth: { OPENAI_API_KEY: "sk-file-secret" },
    check: async (result) => {
      successful(result);
      assert.equal(result.calls[0].path, "/chatgpt-desktop/v1/images/models");
      assert(result.calls.every((call) => !call.headers.authorization));
      assert.equal(
        JSON.parse(posts(result.calls)[0].body).model,
        "gpt-image-2.5-sunburst",
      );
      assert.equal(JSON.parse(posts(result.calls)[0].body).quality, "auto");
      assert.deepEqual(await readFile(result.out), png);
      assert(!`${result.stdout}${result.stderr}`.includes("secret"));
    },
  });
});

test("numeric version selection handles future minor and major versions", async (t) => {
  for (const [models, expected] of [
    [
      ["gpt-image-2.5-sunburst", "gpt-image-2.10-flare"],
      "gpt-image-2.10-flare",
    ],
    [
      ["gpt-image-2.10-sunburst", "gpt-image-3", "gpt-image-3-mini"],
      "gpt-image-3",
    ],
    [
      ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"],
      "gpt-image-2.5-sunburst",
    ],
  ])
    await t.test(expected, () =>
      scenario({
        models,
        check: (result) => {
          successful(result);
          assert.equal(JSON.parse(posts(result.calls)[0].body).model, expected);
        },
      }),
    );
});

test("explicit model bypasses catalog and preserves requested image settings", async () => {
  await scenario({
    args: [
      "--image-model",
      "custom-image-9",
      "--quality",
      "high",
      "--size",
      "1536x1024",
    ],
    check: (result) => {
      successful(result);
      assert.equal(result.calls.length, 1);
      assert.deepEqual(JSON.parse(result.calls[0].body), {
        model: "custom-image-9",
        prompt: "Generate a small local test image",
        size: "1536x1024",
        quality: "high",
        n: 1,
        output_format: "png",
      });
    },
  });
});

test("missing, invalid, or unauthorized catalog never guesses a model or sends an image request", async (t) => {
  for (const [label, status, body] of [
    ["empty", 200, { data: [] }],
    ["chat only", 200, { data: [{ id: "gpt-5.5" }] }],
    ["malformed", 200, {}],
    ["unavailable", 503, {}],
    ["unauthorized", 401, { error: { code: "unauthorized" } }],
  ]) {
    await t.test(label, () =>
      scenario({
        handler: (call, res) => {
          json(res, status, body);
          return true;
        },
        check: (result) => {
          failed(result);
          assert.equal(result.calls.length, 1);
          assert.equal(posts(result.calls).length, 0);
        },
      }),
    );
  }
});

test("explicit direct configuration overrides a disabled runtime and uses /models with the supplied key", async () => {
  await scenario({
    runtime: { owner: "yuanheng-imagegen", version: 1, enabled: false },
    args: ({ origin }) => [
      "--base-url",
      origin,
      "--api-key",
      "sk-explicit-secret",
    ],
    check: (result) => {
      successful(result);
      assert.equal(result.calls[0].path, "/v1/models");
      assert.equal(
        result.calls[0].headers.authorization,
        "Bearer sk-explicit-secret",
      );
      assert.equal(result.calls[1].path, "/v1/images/generations");
      assert(
        !`${result.stdout}${result.stderr}`.includes("sk-explicit-secret"),
      );
    },
  });
});

test("Codex home is respected for direct API credentials", async () => {
  await scenario({
    runtime: false,
    auth: { auth_mode: "apikey", OPENAI_API_KEY: "sk-file-secret" },
    args: ({ origin }) => ["--base-url", `${origin}/v1`],
    check: (result) => {
      successful(result);
      assert.equal(
        result.calls[0].headers.authorization,
        "Bearer sk-file-secret",
      );
    },
  });
});

test("OAuth and placeholder credentials never leave the process", async (t) => {
  for (const auth of [
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "sk-never-send",
      tokens: { access_token: "oauth" },
    },
    { OPENAI_API_KEY: "PROXY_MANAGED" },
    { OPENAI_API_KEY: "eyJhbGciOiJIUzI1NiJ9.payload.signature" },
  ]) {
    await t.test(JSON.stringify(Object.keys(auth)), () =>
      scenario({
        runtime: false,
        auth,
        args: ({ origin }) => ["--base-url", origin],
        check: (result) => {
          failed(result);
          assert.equal(result.calls.length, 0);
          assert(!result.stderr.includes("sk-never-send"));
        },
      }),
    );
  }
});

test("disabled and malformed runtime descriptions block implicit environment credentials", async (t) => {
  for (const runtime of [
    null,
    {},
    { owner: "yuanheng-imagegen", version: 1, enabled: false },
    {
      owner: "yuanheng-imagegen",
      version: 1,
      enabled: true,
      baseUrl: "https://example.com/v1",
    },
    {
      owner: "yuanheng-imagegen",
      version: 1,
      enabled: true,
      baseUrl: "http://127.0.0.1:9000/unknown/v1",
    },
  ]) {
    await t.test(JSON.stringify(runtime), () =>
      scenario({
        runtime,
        env: { OPENAI_API_KEY: "sk-implicit-secret" },
        check: (result) => {
          failed(result);
          assert.equal(result.calls.length, 0);
          assert(!result.stderr.includes("sk-implicit-secret"));
        },
      }),
    );
  }
});

test("terminal surface uses its own route and refuses a missing terminal route", async () => {
  await scenario({
    env: { YUANHENG_IMAGEGEN_SURFACE: "codex" },
    check: (result) => {
      successful(result);
      assert.equal(result.calls[0].path, "/codex/v1/images/models");
      assert.equal(result.calls[1].path, "/codex/v1/images/generations");
    },
  });
  await scenario({
    env: { YUANHENG_IMAGEGEN_SURFACE: "codex" },
    setup: async ({ home }) => {
      const path = resolve(home, "yuanheng-imagegen.json");
      const runtime = JSON.parse(await readFile(path));
      delete runtime.terminalBaseUrl;
      await writeFile(path, JSON.stringify(runtime));
    },
    check: (result) => {
      failed(result);
      assert.equal(result.calls.length, 0);
      assert.match(result.stderr, /surface/);
    },
  });
});

test("dry-run sends no request and marks automatic model selection as unresolved", async () => {
  await scenario({
    args: ["--dry-run"],
    check: async (result) => {
      successful(result);
      assert.equal(result.calls.length, 0);
      assert.match(result.stdout, /unresolved/);
      assert.match(result.stdout, /"imageModel":"auto"/);
      assert.deepEqual((await readdir(result.directory)).sort(), [
        "codex-home",
      ]);
    },
  });
});

test("editing sends all reference images and mask in multipart with selected model", async () => {
  await scenario({
    setup: async ({ directory }) => {
      for (const name of ["ref.png", "ref2.png", "mask.png"])
        await writeFile(resolve(directory, name), png);
    },
    args: ({ directory }) => [
      "--image",
      resolve(directory, "ref.png"),
      "--image",
      resolve(directory, "ref2.png"),
      "--mask",
      resolve(directory, "mask.png"),
    ],
    check: (result) => {
      successful(result);
      const call = posts(result.calls)[0];
      assert.equal(call.path, "/chatgpt-desktop/v1/images/edits");
      assert.match(call.headers["content-type"], /^multipart\/form-data/);
      assert.equal((call.body.match(/name="image\[\]"/g) || []).length, 2);
      assert.match(call.body, /name="mask"/);
      assert.match(call.body, /gpt-image-2\.5-sunburst/);
    },
  });
});

test("invalid input or output is rejected before any catalog or paid request", async (t) => {
  const variants = [
    { label: "missing input", args: ["--image", "missing.png"] },
    {
      label: "existing output",
      setup: async ({ out }) => {
        await mkdir(dirname(out));
        await writeFile(out, png);
      },
    },
    {
      label: "output directory",
      args: ["--force"],
      setup: async ({ out }) => {
        await mkdir(out, { recursive: true });
      },
    },
    {
      label: "same input output",
      args: ({ out }) => ["--force", "--image", out],
      setup: async ({ out }) => {
        await mkdir(dirname(out));
        await writeFile(out, png);
      },
    },
    { label: "mask without image", args: ["--mask", "missing.png"] },
  ];
  for (const { label, ...options } of variants)
    await t.test(label, () =>
      scenario({
        ...options,
        check: (result) => {
          failed(result);
          assert.equal(result.calls.length, 0);
        },
      }),
    );
});

test("only explicit unsupported endpoint responses permit a single Responses fallback", async (t) => {
  for (const status of [404, 405, 501])
    await t.test(String(status), () =>
      scenario({
        handler: (call, res) => {
          if (call.path.endsWith("/generations")) {
            json(res, status, {
              error: {
                code: "unsupported_endpoint",
                message: "Endpoint is unsupported",
              },
            });
            return true;
          }
          if (call.path.endsWith("/responses")) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end(sse(finalEvent));
            return true;
          }
        },
        check: (result) => {
          successful(result);
          assert.equal(posts(result.calls).length, 2);
          const payload = JSON.parse(posts(result.calls)[1].body);
          assert.equal(payload.model, "gpt-5.5");
          assert.equal(payload.tools[0].model, "gpt-image-2.5-sunburst");
          assert.equal(payload.tools[0].quality, "auto");
          assert.match(
            result.stdout,
            /REQUESTED_IMAGE_MODEL=gpt-image-2\.5-sunburst OUTER_MODEL=gpt-5\.5/,
          );
        },
      }),
    );
});

test("business errors, service errors, network failures, malformed success and no-image success never replay", async (t) => {
  const variants = [
    [404, { error: { code: "model_not_found", message: "Model unavailable" } }],
    [404, { error: { message: "No available channel for model" } }],
    [400, { error: { code: "content_policy_violation", message: "Rejected" } }],
    [402, { error: { message: "Insufficient balance" } }],
    [429, {}],
    [500, {}],
    [502, {}],
    [200, { data: [] }],
    [200, { error: { message: "Secret sk-never-print" } }],
  ];
  for (const [status, body] of variants)
    await t.test(`${status} ${JSON.stringify(body)}`, () =>
      scenario({
        handler: (call, res) => {
          if (call.method === "POST") {
            json(res, status, body);
            return true;
          }
        },
        check: (result) => {
          failed(result);
          assert.equal(posts(result.calls).length, 1);
          assert(!result.stderr.includes("sk-never-print"));
        },
      }),
    );
  await t.test("network reset", () =>
    scenario({
      handler: (call, res) => {
        if (call.method === "POST") {
          res.destroy();
          return true;
        }
      },
      check: (result) => {
        failed(result);
        assert.equal(posts(result.calls).length, 1);
      },
    }),
  );
});

test("masked edit never falls back or silently discards mask", async () => {
  await scenario({
    setup: async ({ directory }) => {
      await writeFile(resolve(directory, "ref.png"), png);
    },
    args: ({ directory }) => [
      "--image",
      resolve(directory, "ref.png"),
      "--mask",
      resolve(directory, "ref.png"),
    ],
    handler: (call, res) => {
      if (call.method === "POST") {
        json(res, 404, { error: { code: "unsupported_endpoint" } });
        return true;
      }
    },
    check: (result) => {
      failed(result);
      assert.equal(posts(result.calls).length, 1);
    },
  });
});

test("Responses stream requires a final image plus successful completed event", async (t) => {
  const partial = {
    type: "response.image_generation_call.partial_image",
    partial_image_b64: png.toString("base64"),
  };
  for (const [label, body, success] of [
    ["partial only", sse(partial), false],
    [
      "partial and completed with no final image",
      sse(partial, {
        ...finalEvent,
        response: { status: "completed", output: [] },
      }),
      false,
    ],
    [
      "image item without completed",
      sse({ type: "response.output_item.done", item: finalItem }),
      false,
    ],
    ["truncated completed", `data: ${JSON.stringify(finalEvent)}`, false],
    [
      "failed after final",
      sse(finalEvent, {
        type: "response.failed",
        response: { status: "failed" },
      }),
      false,
    ],
    [
      "incomplete",
      sse({
        type: "response.incomplete",
        response: { status: "incomplete", output: [finalItem] },
      }),
      false,
    ],
    ["malformed", "data: {bad json}\n\n", false],
    ["small final image", sse(partial, finalEvent), true],
    ["CRLF stream", sse(finalEvent).replaceAll("\n", "\r\n"), true],
    [
      "final item then completed",
      sse(
        { type: "response.output_item.done", item: finalItem },
        { ...finalEvent, response: { status: "completed", output: [] } },
      ),
      true,
    ],
  ])
    await t.test(label, () =>
      scenario({
        args: ["--responses-only"],
        handler: (call, res) => {
          if (call.method === "POST") {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end(body);
            return true;
          }
        },
        check: (result) => {
          (success ? successful : failed)(result);
          assert.equal(posts(result.calls).length, 1);
        },
      }),
    );
});

test("fallback failure is reported without another attempt", async () => {
  await scenario({
    handler: (call, res) => {
      if (call.method === "POST") {
        json(res, 404, { error: { code: "unsupported_endpoint" } });
        return true;
      }
    },
    check: (result) => {
      failed(result);
      assert.equal(posts(result.calls).length, 2);
    },
  });
});

test("direct-only never falls back", async () => {
  await scenario({
    args: ["--direct-only"],
    handler: (call, res) => {
      if (call.method === "POST") {
        json(res, 405, { error: { code: "method_not_allowed" } });
        return true;
      }
    },
    check: (result) => {
      failed(result);
      assert.equal(posts(result.calls).length, 1);
    },
  });
});

test("output created during generation is preserved and local write failure never replays", async () => {
  await scenario({
    handler: async (call, res, { out }) => {
      if (call.method === "POST") {
        await writeFile(out, "other work");
        json(res, 200, image);
        return true;
      }
    },
    check: async (result) => {
      failed(result);
      assert.equal(posts(result.calls).length, 1);
      assert.equal(await readFile(result.out, "utf8"), "other work");
      assert.deepEqual(await readdir(dirname(result.out)), ["image.png"]);
    },
  });
});

test("force preserves old file on request failure and atomically replaces after success", async () => {
  for (const failure of [true, false])
    await scenario({
      args: ["--force"],
      setup: async ({ out }) => {
        await mkdir(dirname(out));
        await writeFile(out, "old work");
      },
      handler: (call, res) => {
        if (failure && call.method === "POST") {
          json(res, 503, {});
          return true;
        }
      },
      check: async (result) => {
        (failure ? failed : successful)(result);
        assert.deepEqual(
          await readFile(result.out),
          failure ? Buffer.from("old work") : png,
        );
        assert.equal(posts(result.calls).length, 1);
      },
    });
});

test("plain unsupported route permits compatibility fallback and JSON Responses completion is accepted", async () => {
  await scenario({
    handler: (call, res) => {
      if (call.path.endsWith("/generations")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 page not found\n");
        return true;
      }
      if (call.path.endsWith("/responses")) {
        json(res, 200, finalEvent.response);
        return true;
      }
    },
    check: (result) => {
      successful(result);
      assert.equal(posts(result.calls).length, 2);
    },
  });
});

test("image URL download failures do not initiate another generation", async () => {
  await scenario({
    handler: (call, res, context) => {
      if (call.method === "POST") {
        json(res, 200, {
          data: [
            {
              url: `http://127.0.0.1:${call.headers.host.split(":")[1]}/download.png`,
            },
          ],
        });
        return true;
      }
      if (call.path === "/download.png") {
        json(res, 503, {});
        return true;
      }
    },
    check: (result) => {
      failed(result);
      assert.equal(posts(result.calls).length, 1);
      assert.equal(result.calls.at(-1).path, "/download.png");
      assert(!result.calls.at(-1).headers.authorization);
    },
  });
});

test("redirects never replay image POSTs at another path", async () => {
  await scenario({
    handler: (call, res) => {
      if (call.method === "POST") {
        res.writeHead(307, { Location: "/another-generation" });
        res.end();
        return true;
      }
    },
    check: (result) => {
      failed(result);
      assert.equal(posts(result.calls).length, 1);
    },
  });
});

test("bound applications independently use their own image catalog and route", async (t) => {
  for (const target of [
    "claude",
    "codex",
    "gemini",
    "grokbuild",
    "opencode",
    "hermes",
    "dsh",
    "workbuddy",
  ])
    await t.test(target, () =>
      scenario({
        projectedTarget: target,
        env: { OPENAI_API_KEY: "sk-do-not-borrow" },
        check: (result) => {
          successful(result);
          const surface = target === "codex" ? "chatgpt-desktop" : target;
          assert.equal(result.calls[0].path, `/${surface}/v1/images/models`);
          assert.equal(
            result.calls[1].path,
            `/${surface}/v1/images/generations`,
          );
          assert(result.calls.every((call) => !call.headers.authorization));
        },
      }),
    );
});

test("non-Codex bound tools ignore inherited Codex surface environment", async () => {
  await scenario({
    projectedTarget: "dsh",
    env: { YUANHENG_IMAGEGEN_SURFACE: "codex" },
    check: (result) => {
      successful(result);
      assert.equal(result.calls[0].path, "/dsh/v1/images/models");
    },
  });
  await scenario({
    projectedTarget: "codex",
    env: { YUANHENG_IMAGEGEN_SURFACE: "codex" },
    check: (result) => {
      successful(result);
      assert.equal(result.calls[0].path, "/codex/v1/images/models");
    },
  });
});

test("OpenCode rejects discovered skills bound to other tools before any request", async (t) => {
  for (const target of [
    "claude",
    "codex",
    "gemini",
    "grokbuild",
    "hermes",
    "dsh",
    "workbuddy",
  ])
    await t.test(target, () =>
      scenario({
        projectedTarget: target,
        env: { OPENCODE: "1" },
        check: (result) => {
          failed(result);
          assert.match(result.stderr, /another tool.*OpenCode/);
          assert.equal(result.calls.length, 0);
        },
      }),
    );
});

test("OpenCode uses its own binding despite inherited Codex surface", async () => {
  await scenario({
    projectedTarget: "opencode",
    env: { OPENCODE: "1", YUANHENG_IMAGEGEN_SURFACE: "codex" },
    check: (result) => {
      successful(result);
      assert.equal(result.calls[0].path, "/opencode/v1/images/models");
      assert.equal(result.calls[1].path, "/opencode/v1/images/generations");
    },
  });
});

test("explicit direct credentials cannot bypass the wrong OpenCode skill binding", async () => {
  await scenario({
    projectedTarget: "claude",
    env: { OPENCODE: "1" },
    args: ({ origin }) => [
      "--base-url",
      `${origin}/v1`,
      "--api-key",
      "sk-must-not-be-used",
    ],
    check: (result) => {
      failed(result);
      assert.match(result.stderr, /another tool.*OpenCode/);
      assert.equal(result.calls.length, 0);
      assert(!result.stderr.includes("sk-must-not-be-used"));
    },
  });
});

test("an unverified OpenCode client name does not guess or change the host", async () => {
  await scenario({
    projectedTarget: "codex",
    env: {
      OPENCODE_CLIENT: "unknown-client",
      YUANHENG_IMAGEGEN_SURFACE: "codex",
    },
    check: (result) => {
      successful(result);
      assert.equal(result.calls[0].path, "/codex/v1/images/models");
      assert.equal(result.calls[1].path, "/codex/v1/images/generations");
    },
  });
});

test("missing or altered binding fails without borrowing legacy Codex runtime", async (t) => {
  for (const mutation of [
    "missing",
    "symlink",
    "oversized",
    "relative",
    "foreign target",
    "extra credential",
  ])
    await t.test(mutation, () =>
      scenario({
        projectedTarget: "dsh",
        setup: async ({ projection }) => {
          const path = resolve(projection, "yuanheng-binding.json");
          const binding = JSON.parse(await readFile(path));
          if (mutation === "missing") await rm(path);
          if (mutation === "symlink") {
            await renameFixture(path);
          }
          if (mutation === "oversized")
            await writeFile(path, " ".repeat(17000));
          if (mutation === "relative") {
            binding.runtimePath = "../runtime.json";
            await writeFile(path, JSON.stringify(binding));
          }
          if (mutation === "foreign target") {
            binding.target = "unknown";
            await writeFile(path, JSON.stringify(binding));
          }
          if (mutation === "extra credential") {
            binding.apiKey = "sk-never-output";
            await writeFile(path, JSON.stringify(binding));
          }
        },
        check: (result) => {
          failed(result);
          assert.equal(result.calls.length, 0);
          assert(!result.stderr.includes("sk-never-output"));
        },
      }),
    );
});

async function renameFixture(path) {
  const copy = `${path}.copy`;
  await writeFile(copy, await readFile(path));
  await rm(path);
  await symlink(copy, path);
}

test("bound runtime missing, disabled, cross-target or wrong namespace stops before requests", async (t) => {
  for (const mutation of [
    "missing",
    "symlink",
    "disabled",
    "target",
    "namespace",
    "remote",
    "credentials",
  ])
    await t.test(mutation, () =>
      scenario({
        projectedTarget: "workbuddy",
        setup: async ({ runtimePath, origin }) => {
          const runtime = JSON.parse(await readFile(runtimePath));
          if (mutation === "missing") {
            await rm(runtimePath);
            return;
          }
          if (mutation === "symlink") {
            await renameFixture(runtimePath);
            return;
          }
          if (mutation === "disabled") {
            runtime.enabled = false;
            runtime.routes = {};
          }
          if (mutation === "target") {
            runtime.target = "dsh";
            runtime.defaultSurface = "dsh";
            runtime.routes = { dsh: `${origin}/dsh/v1` };
          }
          if (mutation === "namespace")
            runtime.routes.workbuddy = `${origin}/codex/v1`;
          if (mutation === "remote")
            runtime.routes.workbuddy = "https://example.com/workbuddy/v1";
          if (mutation === "credentials") runtime.apiKey = "sk-never-output";
          await writeFile(runtimePath, JSON.stringify(runtime));
        },
        check: (result) => {
          failed(result);
          assert.equal(result.calls.length, 0);
          assert(!result.stderr.includes("sk-never-output"));
        },
      }),
    );
});

test("imported ZIP copy follows a changed Core port through its stable runtime", async () => {
  await scenario({
    projectedTarget: "workbuddy",
    setup: async (context) => {
      const imported = resolve(
        context.directory,
        "office import",
        "skills",
        "meta-api-imagegen",
      );
      await cp(context.projection, imported, { recursive: true });
      await rm(context.projection, { recursive: true });
      context.entry = resolve(imported, "scripts", "run_imagegen.mjs");
      context.restartedCalls = [];
      context.restarted = createServer(async (req, res) => {
        for await (const _chunk of req) {
          /* consume request */
        }
        context.restartedCalls.push(req.url);
        json(
          res,
          200,
          req.method === "GET" ? { data: [{ id: "gpt-image-3" }] } : image,
        );
      });
      await new Promise((done) =>
        context.restarted.listen(0, "127.0.0.1", done),
      );
      const runtime = JSON.parse(await readFile(context.runtimePath));
      runtime.routes.workbuddy = `http://127.0.0.1:${context.restarted.address().port}/workbuddy/v1`;
      await writeFile(context.runtimePath, JSON.stringify(runtime));
    },
    check: async (result) => {
      try {
        successful(result);
        assert.equal(result.calls.length, 0);
        assert.deepEqual(result.restartedCalls, [
          "/workbuddy/v1/images/models",
          "/workbuddy/v1/images/generations",
        ]);
        assert.match(result.stdout, /SELECTED_IMAGE_MODEL=gpt-image-3/);
      } finally {
        result.restarted.closeAllConnections();
        await new Promise((done) => result.restarted.close(done));
      }
    },
  });
});

test("non-Codex runtimes never use compatibility Responses even when endpoint unsupported", async () => {
  await scenario({
    projectedTarget: "dsh",
    handler: (call, res) => {
      if (call.method === "POST") {
        json(res, 404, { error: { code: "unsupported_endpoint" } });
        return true;
      }
    },
    check: (result) => {
      failed(result);
      assert.equal(posts(result.calls).length, 1);
      assert(!result.calls.some((call) => call.path.endsWith("/responses")));
    },
  });
  await scenario({
    projectedTarget: "workbuddy",
    args: ["--responses-only"],
    check: (result) => {
      failed(result);
      assert.equal(result.calls.length, 0);
      assert.match(result.stderr, /only the direct Images API/);
    },
  });
});

test("explicit direct override remains available despite disabled bound runtime", async () => {
  await scenario({
    projectedTarget: "dsh",
    setup: async ({ runtimePath }) => {
      await writeFile(
        runtimePath,
        JSON.stringify({
          owner: "yuanheng-imagegen",
          version: 2,
          target: "dsh",
          enabled: false,
          routes: {},
          defaultSurface: "dsh",
        }),
      );
    },
    args: ({ origin }) => ["--base-url", origin, "--api-key", "sk-explicit"],
    check: (result) => {
      successful(result);
      assert.equal(result.calls[0].path, "/v1/models");
      assert.equal(result.calls[0].headers.authorization, "Bearer sk-explicit");
    },
  });
});
