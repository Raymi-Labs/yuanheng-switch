import { describe, expect, it } from "vitest";
import { getCodexCustomTemplate } from "./codexTemplates";
import {
  codexProviderPresets,
  generateThirdPartyConfig,
} from "./codexProviderPresets";

describe("Codex configuration compatibility", () => {
  it("does not reintroduce the ignored response-storage option in any preset", () => {
    const configs = [
      getCodexCustomTemplate().config,
      generateThirdPartyConfig("example", "https://example.invalid/v1"),
      ...codexProviderPresets.map((preset) => preset.config),
    ];
    for (const config of configs) {
      expect(config).not.toMatch(/^\s*disable_response_storage\s*=/m);
    }
  });
});
