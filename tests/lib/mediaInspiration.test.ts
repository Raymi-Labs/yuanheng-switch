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
    expect(MEDIA_INSPIRATION).toHaveLength(3);
    let total = 0;
    for (const idea of MEDIA_INSPIRATION) {
      const image = readFileSync(
        `src/assets/media-inspiration/${idea.id}.webp`,
      );
      expect(image.toString("ascii", 0, 4)).toBe("RIFF");
      expect(image.toString("ascii", 8, 12)).toBe("WEBP");
      expect(idea.kind).toBe("image");
      expect(idea.width).toBeGreaterThan(0);
      expect(idea.height).toBeGreaterThan(0);
      total += image.length;
    }
    expect(total).toBeLessThan(2 * 1024 * 1024);
  });
  it.each([MEDIA_EN, MEDIA_JA, MEDIA_KO, MEDIA_ZH_TW])(
    "translates every template and provenance disclosure",
    (locale) => {
      for (const idea of MEDIA_INSPIRATION) {
        expect(locale[idea.title]).toBeTruthy();
        expect(locale[idea.description]).toBeTruthy();
        expect(locale[idea.prompt]).toBeTruthy();
      }
      expect(locale["灵感配图 · 非模型实测结果"]).toBeTruthy();
      expect(locale["使用 {{model}} 灵感"]).toContain("{{model}}");
    },
  );
});
