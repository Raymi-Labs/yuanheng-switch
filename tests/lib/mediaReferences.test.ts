import { describe, expect, it } from "vitest";
import {
  mediaReferencePolicy,
  referencesFit,
  referenceBytes,
} from "@/lib/mediaReferences";
import {
  MEDIA_EN,
  MEDIA_JA,
  MEDIA_KO,
  MEDIA_ZH_TW,
} from "@/components/desktop/mediaStudioTranslations";

describe("reference model boundaries", () => {
  it.each(["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"])(
    "applies official GPT input count and size for %s",
    (model) => {
      const p = mediaReferencePolicy(model);
      expect(p).toMatchObject({
        maxCount: 16,
        maxBytes: 50 * 1024 * 1024,
        exclusiveBytes: true,
        maxTotalBytes: Infinity,
      });
      expect(p.mimeTypes).toContain("image/webp");
      const image = "data:image/webp;base64,eA==";
      expect(referencesFit(model, Array(16).fill(image))).toBe(true);
      expect(referencesFit(model, Array(17).fill(image))).toBe(false);
      expect(referencesFit(model, ["data:image/gif;base64,eA=="])).toBe(false);
    },
  );
  it("keeps per-model limits separate and counts padding correctly", () => {
    expect(mediaReferencePolicy("muse-video")).toMatchObject({
      maxCount: 16,
      maxBytes: 10 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
    });
    expect(
      referencesFit("muse-video", Array(17).fill("data:image/png;base64,eA==")),
    ).toBe(false);
    expect(
      referencesFit("gemini-3.1-flash-image-preview", [
        "data:image/webp;base64,eA==",
      ]),
    ).toBe(false);
    expect(referenceBytes("data:image/png;base64,eA==")).toBe(1);
    expect(referenceBytes("data:image/png;base64,eHg=")).toBe(2);
  });
  it.each([MEDIA_EN, MEDIA_JA, MEDIA_KO, MEDIA_ZH_TW])(
    "translates count and preservation feedback",
    (locale) => {
      for (const key of [
        "当前模型最多支持 {{count}} 张参考图。",
        "GPT Image最多16张PNG、JPEG或WebP参考图，每张须小于50MB。",
        "参考图不符合当前模型的数量、格式或大小要求，请调整后再生成；原图已保留。",
      ])
        expect(locale[key]).toBeTruthy();
      expect(locale["当前模型最多支持 {{count}} 张参考图。"]).toContain(
        "{{count}}",
      );
    },
  );
});
