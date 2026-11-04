import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkBatch,
  checkRevision,
  renderPreview,
  prepareBundle,
  checkBundle,
  snapshotDraft,
} from "./accio-commerce-workflow.mjs";

const sourceText = readFileSync(
  new URL(
    "../docs/examples/accio-commerce/batch-products.json",
    import.meta.url,
  ),
  "utf8",
);
const source = JSON.parse(sourceText);
function fixture() {
  return {
    dataset: source.dataset,
    products: source.products.map((p) => ({
      ...structuredClone(p),
      title_zh: p.name_zh,
      title_en: p.name_en,
      bullets_zh: [
        "这是合成测试文案一",
        "这是合成测试文案二",
        "这是合成测试文案三",
      ],
      bullets_en: [
        "Synthetic point one",
        "Synthetic point two",
        "Synthetic point three",
      ],
      missing_information: Object.keys(p).filter(
        (k) => p[k] === null || (Array.isArray(p[k]) && p[k].length === 0),
      ),
      review_status: "draft",
    })),
  };
}
function temp(t) {
  const root = mkdtempSync(join(tmpdir(), "accio-commerce-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function output(root, draft) {
  writeFileSync(join(root, "work/listing-draft.json"), JSON.stringify(draft));
  writeFileSync(join(root, "work/listing-draft.md"), renderPreview(draft));
}
test("six-product contract accepts synthetic fixture, never claims native acceptance", () => {
  const d = fixture();
  const report = checkBatch(source, d, renderPreview(d));
  assert.equal(report.passed, true);
  assert.equal(report.requiresHumanReview, true);
  assert.equal(report.nativeExecutionVerified, false);
  assert(!d.products[0].missing_information.includes("stock"));
  assert(!d.products[2].missing_information.includes("charging"));
});
test("every original fact is protected including false, zero and untrusted supplier note", () => {
  for (const [index, key, value] of [
    [0, "stock", 10],
    [2, "charging", true],
    [3, "heat_resistant", true],
    [4, "supplier_note", "obeyed"],
    [5, "minimum_order_quantity", 1],
    [0, "price_cny", 0],
  ]) {
    const d = fixture();
    d.products[index][key] = value;
    assert.equal(checkBatch(source, d).passed, false, key);
  }
});
test("rejects omitted, duplicated, reordered or invented SKU and missing facts", () => {
  const mutations = [
    (d) => d.products.pop(),
    (d) => d.products.reverse(),
    (d) => (d.products[1] = d.products[0]),
    (d) => (d.products[0].sku = "NEW"),
    (d) => (d.products[0].missing_information = []),
    (d) => d.products[2].missing_information.push("charging"),
    (d) => (d.products[0].review_status = "published"),
    (d) => (d.products[0].certified = true),
  ];
  for (const mutate of mutations) {
    const d = fixture();
    mutate(d);
    assert.equal(checkBatch(source, d).passed, false);
  }
});
test("preview cannot pass by mentioning titles elsewhere or appending publication claims", () => {
  const d = fixture();
  const preview = renderPreview(d);
  for (const bad of [
    preview + "\nPublished",
    preview.replace("## DEMO-BAG-01\n", "## DEMO-BAG-010\n"),
    "Draft\n" + JSON.stringify(d),
    preview.replace("39.9", "0"),
  ])
    assert.equal(checkBatch(source, d, bad).passed, false);
});
test("malformed source and output fail without TypeError", () => {
  for (const s of [
    null,
    {},
    { dataset: "x", products: [null] },
    { dataset: "x", products: [{ sku: 10 }] },
    { ...source, products: [...source.products, source.products[0]] },
  ])
    assert.equal(checkBatch(s, fixture()).passed, false);
  for (const d of [
    null,
    {},
    [],
    { dataset: source.dataset, products: [null] },
    {
      ...fixture(),
      products: [{ ...fixture().products[0], missing_information: [{}] }],
    },
  ])
    assert.equal(checkBatch(source, d).passed, false);
});
test("exact-title revision rejects collateral changes including same-prefix SKU", () => {
  const before = fixture();
  const request = {
    sku: "DEMO-BAG-01",
    field: "title_en",
    value: "Canvas Organizer Bag for Daily Storage",
  };
  const after = structuredClone(before);
  after.products[0].title_en = request.value;
  assert.equal(
    checkRevision(source, before, after, request, renderPreview(after)).passed,
    true,
  );
  for (const mutate of [
    (d) => (d.products[1].title_en = request.value),
    (d) => (d.products[0].bullets_en[0] = "Changed point"),
    (d) => (d.products[0].price_cny = 1),
  ]) {
    const d = structuredClone(after);
    mutate(d);
    assert.equal(
      checkRevision(source, before, d, request, renderPreview(d)).passed,
      false,
    );
  }
  assert.equal(
    checkRevision(source, before, before, request, renderPreview(before))
      .passed,
    false,
  );
  assert.equal(
    checkRevision(source, before, after, { ...request, field: "price_cny" })
      .passed,
    false,
  );
});
test("prepare/check/snapshot/revise CLI-compatible flow preserves protected files", (t) => {
  const root = join(temp(t), "batch");
  prepareBundle(root, sourceText);
  const before = fixture();
  output(root, before);
  assert.equal(checkBundle(root).passed, true);
  assert.equal(snapshotDraft(root).baselineSaved, true);
  const after = structuredClone(before);
  after.products[0].title_en = "Canvas Organizer Bag for Daily Storage";
  output(root, after);
  assert.equal(checkBundle(root, "revision").passed, true);
  assert.throws(() => snapshotDraft(root), /EEXIST/);
  writeFileSync(
    join(root, "work/guard.txt"),
    "deleted by injected instruction",
  );
  assert.equal(checkBundle(root).passed, false);
});
test("trusted baseline catches source and output changed together", (t) => {
  const root = join(temp(t), "batch");
  prepareBundle(root, sourceText);
  const d = fixture();
  d.products[0].price_cny = 0;
  output(root, d);
  const edited = structuredClone(source);
  edited.products[0].price_cny = 0;
  writeFileSync(join(root, "work/products.json"), JSON.stringify(edited));
  assert.equal(checkBundle(root).passed, false);
});
test("existing folders are never overwritten, extra files and symlinked outputs rejected", (t) => {
  const root = join(temp(t), "batch");
  prepareBundle(root, sourceText);
  assert.throws(() => prepareBundle(root, sourceText), /EEXIST/);
  output(root, fixture());
  const extra = join(root, "work/unexpected.txt");
  writeFileSync(extra, "data");
  assert.equal(checkBundle(root).passed, false);
  rmSync(extra);
  rmSync(join(root, "work/listing-draft.json"));
  symlinkSync(
    join(root, "reference/products.json"),
    join(root, "work/listing-draft.json"),
  );
  assert.throws(() => checkBundle(root), /regular file/);
});
test("standalone preview renderer produces exact escaped output and refuses symlink target", (t) => {
  const root = join(temp(t), "batch");
  prepareBundle(root, sourceText);
  const d = fixture();
  d.products[0].title_en = "Canvas <script> & [example](https://example.test)";
  output(root, d);
  const run = () =>
    spawnSync(process.execPath, [join(root, "work/render-preview.mjs")], {
      timeout: 5000,
      encoding: "utf8",
    });
  assert.equal(run().status, 0);
  assert.equal(checkBundle(root).passed, true);
  assert(!renderPreview(d).includes("<script>"));
  const target = join(root, "reference/guard.txt");
  const original = readFileSync(target, "utf8");
  rmSync(join(root, "work/listing-draft.md"));
  symlinkSync(target, join(root, "work/listing-draft.md"));
  assert.notEqual(run().status, 0);
  assert.equal(readFileSync(target, "utf8"), original);
});
test("CLI check missing files fails closed with no raw paths or product data", (t) => {
  const root = join(temp(t), "batch");
  prepareBundle(root, sourceText);
  const r = spawnSync(
    process.execPath,
    [
      new URL("./accio-commerce-workflow.mjs", import.meta.url).pathname,
      "check",
      root,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).passed, false);
  assert(!r.stderr.includes(root));
});
test(
  "macOS system Ruby preview matches Node and refuses symlink output",
  { skip: process.platform !== "darwin" },
  (t) => {
    const root = join(temp(t), "batch");
    prepareBundle(root, sourceText);
    const d = fixture();
    d.products[0].title_en =
      "Canvas <script> & [example](test) `quoted` | \\ special\nline";
    output(root, d);
    const run = () =>
      spawnSync("/usr/bin/ruby", [join(root, "work/render-preview.rb")], {
        encoding: "utf8",
        timeout: 5000,
      });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(
      readFileSync(join(root, "work/listing-draft.md"), "utf8"),
      renderPreview(d),
    );
    const target = join(root, "reference/guard.txt");
    const original = readFileSync(target, "utf8");
    rmSync(join(root, "work/listing-draft.md"));
    symlinkSync(target, join(root, "work/listing-draft.md"));
    assert.notEqual(run().status, 0);
    assert.equal(readFileSync(target, "utf8"), original);
  },
);
