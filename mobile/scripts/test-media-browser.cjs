// Real Chromium + production renderer, synthetic IPC only. Build mobile/dist first.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const csp = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
).app.security.csp;
const wav = Buffer.alloc(8044);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(8000, 40);
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost"),
    file = path.resolve(
      root,
      "dist",
      "." + (u.pathname === "/" ? "/index.html" : u.pathname),
    );
  if (
    !file.startsWith(path.join(root, "dist") + path.sep) ||
    !fs.existsSync(file)
  ) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader(
    "Content-Type",
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    }[path.extname(file)] || "application/octet-stream",
  );
  res.setHeader(
    "Content-Security-Policy",
    u.searchParams.has("oldCsp") ? csp.replace(/media-src[^;]+;\s*/, "") : csp,
  );
  res.end(fs.readFileSync(file));
});
let browser;
async function run() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
        : {}),
    });
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let external = 0;
    await ctx.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin)
        return route.continue();
      external++;
      return route.abort();
    });
    await ctx.addInitScript(
      ({ audio }) => {
        window.__mediaTest = { calls: [], violations: [], unexpected: [] };
        addEventListener("securitypolicyviolation", (e) =>
          window.__mediaTest.violations.push(e.violatedDirective),
        );
        const account = {
          id: 7,
          username: "synthetic",
          quota: 100,
          used_quota: 0,
          group: "test",
        };
        window.__TAURI_INTERNALS__ = {
          invoke: async (cmd, args) => {
            window.__mediaTest.calls.push({ cmd, args });
            if (cmd === "mobile_restore") return account;
            if (cmd === "mobile_capabilities")
              return { purchases: false, version: "synthetic" };
            if (cmd === "mobile_ai_consent") return;
            if (cmd === "mobile_gallery_list") return [];
            if (cmd === "mobile_tts") return { data: audio, mime: "audio/wav" };
            if (cmd === "mobile_api") {
              if (args.operation === "pricing")
                return {
                  data: [],
                  group_ratio: { test: 1 },
                  usable_group: { test: "Test" },
                };
              const data = {
                status: { quota_per_unit: 500000, price: 1 },
                account,
                models: ["gpt-image-2"],
                groups: { test: { ratio: 1 } },
                log_stat: { quota: 0, rpm: 0, tpm: 0 },
              }[args.operation];
              if (data !== undefined) return { success: true, data };
            }
            window.__mediaTest.unexpected.push({
              cmd,
              operation: args?.operation,
            });
            throw Error(`Unexpected synthetic command: ${cmd}`);
          },
        };
      },
      { audio: wav.toString("base64") },
    );
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(origin + "/?oldCsp=1");
    await page.evaluate((audio) => {
      const a = document.createElement("audio");
      a.src = "data:audio/wav;base64," + audio;
      a.preload = "auto";
      document.body.append(a);
      a.load();
    }, wav.toString("base64"));
    await page.waitForFunction(() =>
      window.__mediaTest.violations.includes("media-src"),
    );
    await page.goto(origin);
    await page
      .locator(".main > .panel:not([hidden])")
      .getByText("同意数据处理并继续")
      .click();
    await page.locator("nav").getByText("声音", { exact: true }).click();
    await page
      .getByLabel("上传声音样本")
      .setInputFiles({
        name: "synthetic.wav",
        mimeType: "audio/wav",
        buffer: wav,
      });
    await page.waitForFunction(
      () =>
        document.querySelector('audio[aria-label="声音样本试听"]')
          ?.readyState >= 2,
    );
    await page
      .getByPlaceholder("输入要让克隆声音朗读的文本…")
      .fill("synthetic only");
    await page.getByRole("checkbox").check();
    await page.getByText("生成语音", { exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('audio[aria-label="合成的语音"]')?.readyState >=
        2,
    );
    await page.getByLabel("合成的语音").evaluate(async (a) => {
      await a.play();
      a.pause();
    });
    assert.equal(
      await page.evaluate(
        () =>
          window.__mediaTest.calls.filter((c) => c.cmd === "mobile_tts").length,
      ),
      1,
    );
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const tab of ["聊天", "生图", "声音", "广场", "控制台", "我的"]) {
        await page.locator("nav").getByText(tab, { exact: true }).click();
        await page.evaluate(async () => {
          await Promise.all(
            document.getAnimations().map((a) => a.finished.catch(() => {})),
          );
        });
        if (
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          )
        )
          console.log(
            await page.evaluate(() =>
              [...document.querySelectorAll(".main > .panel:not([hidden]) *")]
                .filter((e) => e.getBoundingClientRect().right > innerWidth)
                .map((e) => ({
                  tag: e.tagName,
                  class: e.className,
                  width: e.getBoundingClientRect().width,
                }))
                .slice(0, 15),
            ),
          );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          `${tab}: overflow at ${width}`,
        );
      }
    }
    await page.locator("nav").getByText("生图", { exact: true }).click();
    const png = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 200;
      c.height = 100;
      const x = c.getContext("2d");
      x.fillStyle = "white";
      x.fillRect(0, 0, 200, 100);
      return c.toDataURL().split(",")[1];
    });
    await page
      .getByLabel("上传参考图")
      .setInputFiles({
        name: "synthetic.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      });
    await page.getByText("局部重绘", { exact: true }).click();
    const canvas = page.locator('[role="dialog"] canvas');
    await page.waitForFunction(
      () => document.querySelector('[role="dialog"] canvas')?.width === 200,
    );
    await canvas.click();
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        const r = original.apply(this, args);
        window.__mediaTest.mask = r;
        return r;
      };
    });
    await page.getByText("应用遮罩", { exact: true }).click();
    const alpha = await page.evaluate(async () => {
      const img = new Image();
      img.src = window.__mediaTest.mask;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      return {
        width: c.width,
        height: c.height,
        center: x.getImageData(100, 50, 1, 1).data[3],
        corner: x.getImageData(0, 0, 1, 1).data[3],
      };
    });
    assert.deepEqual(alpha, {
      width: 200,
      height: 100,
      center: 0,
      corner: 255,
    });
    assert.deepEqual(
      await page.evaluate(() => window.__mediaTest.violations),
      [],
    );
    assert.deepEqual(
      await page.evaluate(() => window.__mediaTest.unexpected),
      [],
    );
    assert.equal(external, 0);
    console.log(
      JSON.stringify({
        oldCspBlockedAudio: true,
        sampleAndResultPlayable: true,
        maskPixels: alpha,
        viewports: [320, 390],
        externalRequests: 0,
        nativeDeviceTested: false,
      }),
    );
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    console.log("Browser and local test server closed.");
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
