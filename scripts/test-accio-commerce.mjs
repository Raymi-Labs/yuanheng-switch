import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkCommerceDraft } from "./check-accio-commerce.mjs";

const source = JSON.parse(
  readFileSync(
    new URL("../docs/examples/accio-commerce/products.json", import.meta.url),
    "utf8",
  ),
);
function fixture() {
  const draft = {
    dataset: source.dataset,
    products: source.products.map((p) => ({
      sku: p.sku,
      price_cny: p.price_cny,
      material: p.material,
      dimensions_cm: p.dimensions_cm,
      title_zh: p.name_zh,
      title_en: p.name_en,
      bullets_zh: ["合成说明甲", "合成说明乙", "合成说明丙"],
      bullets_en: [
        "Synthetic point one",
        "Synthetic point two",
        "Synthetic point three",
      ],
      missing_information:
        p.sku === "DEMO-BAG-01"
          ? ["waterproof", "certifications"]
          : ["load_capacity_kg", "certifications"],
      review_status: "draft",
    })),
  };
  const markdown =
    "Draft\n" +
    draft.products
      .map((p) =>
        [
          p.sku,
          p.price_cny,
          p.title_zh,
          p.title_en,
          ...p.bullets_zh,
          ...p.bullets_en,
        ].join("\n"),
      )
      .join("\n");
  return { draft, markdown };
}
test("accepts structurally correct draft but always requires human review", () => {
  const { draft, markdown } = fixture();
  assert.deepEqual(checkCommerceDraft(source, draft, markdown), {
    passed: true,
    errors: [],
    requiresHumanReview: true,
  });
});
test("rejects wrong prices, missing facts, duplicates and false publication status", () => {
  for (const mutate of [
    (d) => (d.products[0].price_cny = 9.9),
    (d) => (d.products[0].missing_information = []),
    (d) => (d.products[1].sku = d.products[0].sku),
    (d) => (d.products[0].review_status = "published"),
    (d) => d.products.reverse(),
  ]) {
    const { draft, markdown } = fixture();
    mutate(draft);
    assert.equal(checkCommerceDraft(source, draft, markdown).passed, false);
  }
});
test("rejects divergent preview and malformed language fields without crashing", () => {
  const { draft, markdown } = fixture();
  assert.equal(checkCommerceDraft(source, draft, "Draft").passed, false);
  draft.products[0].bullets_en = { text: "not a list" };
  assert.equal(checkCommerceDraft(source, draft, markdown).passed, false);
  assert.equal(
    checkCommerceDraft(source, { products: [null] }, null).passed,
    false,
  );
});
