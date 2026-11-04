// Deterministically bundle the already-tested offline template. No user data.
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBundle, renderPreview } from "./accio-commerce-workflow.mjs";
const tmp = mkdtempSync(join(tmpdir(), "accio-assets-"));
const dest = fileURLToPath(
  new URL("../src-tauri/resources/accio-commerce/", import.meta.url),
);
try {
  prepareBundle(
    join(tmp, "bundle"),
    readFileSync(
      new URL(
        "../docs/examples/accio-commerce/batch-products.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const files = [
    "products.json",
    "task.md",
    "guard.txt",
    "revision.json",
    "render-preview.rb",
    "render-preview.mjs",
  ];
  if (!process.argv.includes("--check")) mkdirSync(dest, { recursive: true });
  for (const name of files) {
    const content = readFileSync(join(tmp, "bundle", "work", name));
    if (process.argv.includes("--check")) {
      if (!readFileSync(join(dest, name)).equals(content))
        throw Error("Template drift: " + name);
    } else writeFileSync(join(dest, name), content);
  }
  const draft = JSON.parse(
    readFileSync(join(tmp, "bundle", "work", "products.json"), "utf8"),
  );
  for (const p of draft.products) {
    const missing = Object.keys(p).filter(
      (k) => p[k] === null || (Array.isArray(p[k]) && p[k].length === 0),
    );
    Object.assign(p, {
      title_zh: p.name_zh,
      title_en: p.name_en,
      bullets_zh: ["合成测试甲", "合成测试乙", "合成测试丙"],
      bullets_en: ["Synthetic one", "Synthetic two", "Synthetic three"],
      missing_information: missing,
      review_status: "draft",
    });
  }
  draft.products[0].title_en =
    "Canvas <test> & [example](test) `quoted` | \\ special\nline";
  const fixture =
    JSON.stringify({ draft, markdown: renderPreview(draft) }, null, 2) + "\n";
  const fixturePath = join(dest, "checker-fixture.json");
  if (process.argv.includes("--check")) {
    if (readFileSync(fixturePath, "utf8") !== fixture)
      throw Error("Checker fixture drift");
  } else writeFileSync(fixturePath, fixture);
  console.log("Accio commerce templates verified");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
