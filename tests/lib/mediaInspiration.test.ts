import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MEDIA_INSPIRATION } from "@/lib/mediaInspiration";
import {
  MEDIA_EN,
  MEDIA_JA,
  MEDIA_KO,
  MEDIA_ZH_TW,
} from "@/components/desktop/mediaStudioTranslations";

describe("bundled inspiration catalog", () => {
  it("has unique ideas and uses local original illustrations, not remote images", () => {
    expect(new Set(MEDIA_INSPIRATION.map((i) => i.id)).size).toBe(
      MEDIA_INSPIRATION.length,
    );
    for (const idea of MEDIA_INSPIRATION) {
      expect(idea.art).not.toMatch(/^https?:/);
      expect(idea.prompt.length).toBeLessThan(4000);
    }
    for (const name of ["sunlit-arch", "moonlake", "botanical", "dunes"]) {
      const svg = readFileSync(
        `src/assets/media-inspiration/${name}.svg`,
        "utf8",
      );
      expect(svg).toContain('viewBox="0 0 1200 900"');
      expect(svg).not.toMatch(/<script|<foreignObject|href=|<animate/);
    }
  });
  it.each([MEDIA_EN, MEDIA_JA, MEDIA_KO, MEDIA_ZH_TW])(
    "translates every template and provenance disclosure",
    (locale) => {
      for (const idea of MEDIA_INSPIRATION) {
        expect(locale[idea.title]).toBeTruthy();
        expect(locale[idea.description]).toBeTruthy();
        expect(locale[idea.prompt]).toBeTruthy();
      }
      expect(locale["原创灵感插画 · 非模型实测结果"]).toBeTruthy();
      expect(locale["使用 {{model}} 灵感"]).toContain("{{model}}");
    },
  );
});
