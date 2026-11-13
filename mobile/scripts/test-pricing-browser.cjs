// Production renderer with synthetic IPC; no account, model or external calls.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../dist");
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const file = path.resolve(
    root,
    "." + (url.pathname === "/" ? "/index.html" : url.pathname),
  );
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file))
    return res.writeHead(404).end();
  res.setHeader(
    "Content-Type",
    {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
    }[path.extname(file)] || "application/octet-stream",
  );
  res.end(fs.readFileSync(file));
});
let browser;
(async () => {
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
        : {}),
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    let external = 0;
    await ctx.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin)
        return route.continue();
      external++;
      return route.abort();
    });
    await ctx.addInitScript(() => {
      const account = {
        id: 7,
        username: "synthetic",
        quota: 100,
        used_quota: 0,
        group: "test",
      };
      const data = Array.from({ length: 236 }, (_, i) => ({
        model_name: `test-${i}`,
        display_name: `测试模型 ${i}`,
        description: i === 235 ? "目录末尾关键词" : "合成目录",
        model_ratio: 1,
        completion_ratio: 2,
        enable_groups: ["test"],
        vendor_id: 1,
        quota_type: 0,
      }));
      window.__pricingUnexpected = [];
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args) => {
          if (cmd === "mobile_restore") return account;
          if (cmd === "mobile_capabilities")
            return { purchases: false, version: "synthetic" };
          if (cmd === "mobile_ai_consent") return;
          if (cmd === "mobile_gallery_list") return [];
          if (cmd === "mobile_api") {
            if (args.operation === "pricing")
              return {
                success: true,
                data,
                vendors: [{ id: 1, name: "测试厂商" }],
                group_ratio: { test: 1 },
                usable_group: { test: "测试组" },
              };
            const value = {
              status: { quota_per_unit: 500000, price: 1 },
              account,
              models: ["test-0"],
              groups: { test: { ratio: 1 } },
              log_stat: { quota: 0, rpm: 0, tpm: 0 },
              health_groups: { enabled: true, groups: [] },
            }[args.operation];
            if (value !== undefined) return { success: true, data: value };
          }
          window.__pricingUnexpected.push(cmd + ":" + args?.operation);
          throw Error("Unexpected synthetic command");
        },
      };
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(origin);
    await page.locator("nav").getByText("广场", { exact: true }).click();
    const more = page.getByRole("button", { name: /加载更多/ });
    await more.waitFor();
    assert.equal(await page.locator(".model-card").count(), 24);
    await more.click();
    assert.equal(await page.locator(".model-card").count(), 48);
    await page.getByLabel("搜索模型").fill("目录末尾关键词");
    await page.getByText("测试模型 235", { exact: true }).click();
    await page.getByRole("dialog", { name: "测试模型 235 详情" }).waitFor();
    await page.getByRole("button", { name: "关闭详情" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByLabel("搜索模型").fill("");
    await more.waitFor();
    assert.equal(await page.locator(".model-card").count(), 24);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await more.scrollIntoViewIfNeeded();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      const box = await more.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width + 1);
      if (process.env.PRICING_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.PRICING_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(
            process.env.PRICING_SCREENSHOT_DIR,
            `pricing-${width}.png`,
          ),
        });
      }
    }
    assert.deepEqual(await page.evaluate(() => window.__pricingUnexpected), []);
    assert.equal(external, 0);
    console.log(
      "236-model catalogue: 24/48 cards, tail search/details, reset and 320/390 layout passed; external requests 0.",
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
