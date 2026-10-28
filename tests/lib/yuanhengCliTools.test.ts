import { describe, expect, it } from "vitest";
import {
  isYuanhengCliTool,
  YUANHENG_CLI_TOOLS,
  type YuanhengToolId,
} from "@/lib/api";
import {
  DESKTOP_TOOLS,
  isDesktopApp,
  isCoreApp,
} from "@/components/desktop/ToolSetupGrid";

describe("Yuanheng CLI launch directory support", () => {
  it("covers every CLI and excludes desktop applications", () => {
    expect(YUANHENG_CLI_TOOLS).toEqual([
      "claude",
      "codex",
      "gemini",
      "grokbuild",
      "opencode",
      "openclaw",
      "hermes",
    ]);

    for (const app of YUANHENG_CLI_TOOLS) {
      expect(isYuanhengCliTool(app)).toBe(true);
    }

    for (const app of [
      "claude-desktop",
      "chatgpt-desktop",
      "workbuddy",
      "accio-work",
    ] satisfies YuanhengToolId[]) {
      expect(isYuanhengCliTool(app)).toBe(false);
    }

    expect(DESKTOP_TOOLS.filter((app) => !isDesktopApp(app))).toEqual([
      ...YUANHENG_CLI_TOOLS,
    ]);
    expect(isCoreApp("accio-work")).toBe(false);
    expect(isDesktopApp("accio-work")).toBe(true);
  });
});
