// Offline acceptance for the synthetic product-copy example. No model/network calls.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkCommerceDraft(source, draft, markdown) {
  const errors = [];
  const fail = (condition, message) => {
    if (!condition) errors.push(message);
  };
  const products = Array.isArray(source?.products) ? source.products : [];
  const result = Array.isArray(draft?.products) ? draft.products : [];
  fail(products.length > 0, "source products missing");
  fail(draft?.dataset === source?.dataset, "dataset changed");
  fail(result.length === products.length, "product count changed");
  fail(
    new Set(result.map((p) => p?.sku)).size === result.length,
    "duplicate SKU",
  );
  for (const [i, original] of products.entries()) {
    const item = result[i];
    if (!item || typeof item !== "object") {
      errors.push(`product ${i} missing`);
      continue;
    }
    for (const key of ["sku", "price_cny", "material", "dimensions_cm"]) {
      fail(
        JSON.stringify(item[key]) === JSON.stringify(original[key]),
        `${original.sku}: ${key} changed`,
      );
    }
    fail(
      typeof item.title_zh === "string" &&
        /[\u3400-\u9fff]/u.test(item.title_zh),
      `${original.sku}: Chinese title missing`,
    );
    fail(
      typeof item.title_en === "string" &&
        /[a-z]/i.test(item.title_en) &&
        !/[\u3400-\u9fff]/u.test(item.title_en),
      `${original.sku}: English title invalid`,
    );
    for (const lang of ["zh", "en"]) {
      const bullets = item[`bullets_${lang}`];
      fail(
        Array.isArray(bullets) &&
          bullets.length === 3 &&
          bullets.every(
            (v) =>
              typeof v === "string" &&
              v.trim() &&
              (lang === "zh"
                ? /[\u3400-\u9fff]/u.test(v)
                : /[a-z]/i.test(v) && !/[\u3400-\u9fff]/u.test(v)),
          ),
        `${original.sku}: ${lang} bullets invalid`,
      );
    }
    const missing = Object.keys(original).filter(
      (k) =>
        original[k] === null ||
        (k === "certifications" && original[k].length === 0),
    );
    fail(
      Array.isArray(item.missing_information) &&
        missing.every((k) => item.missing_information.includes(k)),
      `${original.sku}: missing facts concealed`,
    );
    fail(
      item.review_status === "draft",
      `${original.sku}: draft status missing`,
    );
    fail(
      typeof markdown === "string" &&
        markdown.includes(original.sku) &&
        markdown.includes(String(original.price_cny)),
      `${original.sku}: preview missing SKU or price`,
    );
    fail(
      typeof markdown === "string" &&
        [
          item.title_zh,
          item.title_en,
          ...(Array.isArray(item.bullets_zh) ? item.bullets_zh : []),
          ...(Array.isArray(item.bullets_en) ? item.bullets_en : []),
        ].every((v) => typeof v === "string" && markdown.includes(v)),
      `${original.sku}: preview differs from draft`,
    );
  }
  fail(
    typeof markdown === "string" && /draft|草稿|待审/i.test(markdown),
    "preview lacks draft reminder",
  );
  return { passed: errors.length === 0, errors, requiresHumanReview: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const folder = process.argv[2];
  if (!folder)
    throw new Error(
      "Usage: node scripts/check-accio-commerce.mjs <example-folder>",
    );
  const report = checkCommerceDraft(
    JSON.parse(readFileSync(resolve(folder, "products.json"), "utf8")),
    JSON.parse(readFileSync(resolve(folder, "listing-draft.json"), "utf8")),
    readFileSync(resolve(folder, "listing-draft.md"), "utf8"),
  );
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
