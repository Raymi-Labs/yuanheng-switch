// Acceptance against a real isolated official npm installation, never a user's DSH_HOME.
// Usage: node scripts/test-dsh-web.mjs <installation> <playwright-module>
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const installation = resolve(process.argv[2]);
const { chromium } = await import(pathToFileURL(resolve(process.argv[3])));
const temporary = await mkdtemp(join(tmpdir(), "yuanheng-dsh-web-test-"));
const dshHome = join(temporary, "synthetic home '$");
let requests = 0;
let upstreamError;
const upstream = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!req.url.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  const input = JSON.parse(body);
  if (
    input.model !== "yuanheng-test-model" ||
    req.headers.authorization !== "Bearer synthetic-local-only"
  ) {
    upstreamError = "Model or credential did not match the synthetic fixture";
    res.writeHead(400).end();
    return;
  }
  requests++;
  const base = {
    id: "synthetic",
    object: "chat.completion.chunk",
    created: 1,
    model: input.model,
  };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "LOCAL_DSH_REPLY_OK" }, finish_reason: null }] })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
await mkdir(join(dshHome, "profiles/web"), { recursive: true });
await writeFile(
  join(dshHome, ".credentials.yaml"),
  "YUANHENG_DSH_API_KEY: synthetic-local-only\n",
  { mode: 0o600 },
);
// Same public profile contract as yuanheng/dsh.rs; no real account or inference.
await writeFile(
  join(dshHome, "profiles/web/cordis.patch.yml"),
  JSON.stringify([
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          "yuanheng-chat": {
            displayName: "YuanHeng synthetic",
            apiKeyEnv: "YUANHENG_DSH_API_KEY",
            api: "openai-completions",
            baseURL: `http://127.0.0.1:${upstream.address().port}/v1`,
            models: [
              {
                id: "yuanheng-test-model",
                name: "yuanheng-test-model",
                input: ["text"],
              },
            ],
          },
        },
      },
    },
    {
      id: "agent-default-model",
      config: { provider: "yuanheng-chat", model: "yuanheng-test-model" },
    },
  ]),
);
const node = join(
  installation,
  process.platform === "win32" ? "runtime/node.exe" : "runtime/bin/node",
);
const child = spawn(
  node,
  [
    join(installation, "package/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    "--profile",
    "web",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--no-open",
  ],
  {
    cwd: temporary,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: "1",
      NODE_OPTIONS: "",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
child.stdout.on("data", (data) => {
  logs += data;
});
child.stderr.on("data", (data) => {
  logs += data;
});
let browser;
try {
  let url;
  for (let i = 0; i < 150; i++) {
    url = logs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+[^\s\u001b]*)/)?.[1];
    if (url) break;
    if (child.exitCode !== null)
      throw new Error(`DSH exited: ${logs.slice(-3500)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(url, `Web did not become ready: ${logs.slice(-2500)}`);
  browser = await chromium.launch({
    executablePath:
      process.env.TEST_CHROME ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage();
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === "127.0.0.1" ? route.continue() : route.abort();
  });
  await page.goto(url);
  await page.waitForTimeout(1500);
  const welcome = page.getByRole("button", { name: "继续", exact: true });
  if (await welcome.isVisible()) await welcome.click();
  assert.ok(
    (await page.locator("body").innerText()).includes("yuanheng-test-model"),
  );
  console.log("WEB_READY: configured model is visible.");
  const composer = page.locator('textarea, [contenteditable="true"]').first();
  await composer.waitFor({ timeout: 15000 });
  await composer.click();
  await page.keyboard.type("Reply with LOCAL_DSH_REPLY_OK");
  await page.keyboard.press("Enter");
  try {
    await page
      .getByText("LOCAL_DSH_REPLY_OK", { exact: true })
      .last()
      .waitFor({ timeout: 20000 });
  } catch (error) {
    console.error(
      "SYNTHETIC_TEST_UI",
      (await page.locator("body").innerText()).slice(-3000),
      "mock requests:",
      requests,
    );
    throw error;
  }
  assert.ok(requests > 0, "The mock provider did not receive a model request");
  assert.equal(upstreamError, undefined);
  console.log(
    "PASS: official DSH Web loaded, configured model sent a request and displayed the synthetic reply.",
  );
} finally {
  await browser?.close();
  const exit =
    child.exitCode === null ? once(child, "exit") : Promise.resolve();
  try {
    process.kill(
      process.platform === "win32" ? child.pid : -child.pid,
      "SIGTERM",
    );
  } catch {}
  const timer = setTimeout(() => {
    try {
      process.kill(
        process.platform === "win32" ? child.pid : -child.pid,
        "SIGKILL",
      );
    } catch {}
  }, 3000);
  await exit;
  clearTimeout(timer);
  // Reap any process-group descendants even if the parent exited first.
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  await new Promise((resolve) => upstream.close(resolve));
  await rm(temporary, { recursive: true, force: true });
  console.log("CLEANUP: DSH child exited; browser and mock upstream closed.");
}
