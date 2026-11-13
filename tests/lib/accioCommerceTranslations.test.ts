import { readFileSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import i18n from "@/i18n";
import { commerceError } from "@/components/desktop/AccioCommerceGuide";
import {
  COMMERCE_EN,
  COMMERCE_JA,
  COMMERCE_KO,
  COMMERCE_ZH_TW,
} from "@/components/desktop/accioCommerceTranslations";

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
});
describe("Accio native diagnostic localization", () => {
  it("covers every fixed native failure and SKU message template", () => {
    const source = readFileSync(
      "src-tauri/src/commands/accio_commerce.rs",
      "utf8",
    ).split("#[cfg(test)]")[0];
    const messages = [...source.matchAll(/"([^"\n]*[\u3400-\u9fff][^"\n]*)"/g)]
      .map((m) => m[1])
      .filter((s) => !s.includes(" / ") && !s.startsWith("Accio商品示例-"))
      .map((s) => s.replace("{sku}：", "").replace("{lang}", "{{lang}}"));
    expect(messages.length).toBeGreaterThan(30);
    for (const message of messages) {
      for (const translations of [
        COMMERCE_EN,
        COMMERCE_JA,
        COMMERCE_KO,
        COMMERCE_ZH_TW,
      ]) {
        expect(translations[message], message).toBeTruthy();
      }
    }
  });
  it("translates native failures while preserving exact SKU and language", async () => {
    await i18n.changeLanguage("en");
    expect(commerceError("无法读取任务目录")).toBe(
      "Cannot read the task folder",
    );
    expect(commerceError("DEMO-BAG-010：en 标题缺失或语言不符")).toBe(
      "DEMO-BAG-010：en title is missing or in the wrong language",
    );
    expect(commerceError("DEMO-BAG-01：必须保留草稿状态")).toBe(
      "DEMO-BAG-01：Draft status must be retained",
    );
    expect(commerceError("unknown error")).toBe("unknown error");
  });
});
