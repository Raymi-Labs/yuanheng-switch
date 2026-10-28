import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  canInstallTool,
  TOOL_COMMANDS,
  DESKTOP_DOWNLOAD_URLS,
  TOOL_VERSION_TARGETS,
} from "@/components/desktop/ToolSetupGrid";

describe("DSH install contract", () => {
  it("exposes a real installer in both desktop surfaces", () => {
    expect(TOOL_COMMANDS.dsh).toBeUndefined();
    expect(DESKTOP_DOWNLOAD_URLS.dsh).toBe("https://www.deepseek.com/harness/");
    expect(TOOL_VERSION_TARGETS.dsh).toBe("dsh");
    expect(canInstallTool("dsh")).toBe(true);
    expect(canInstallTool("claude-desktop")).toBe(true);
    expect(canInstallTool("codex")).toBe(true);
  });
  it.each(["sh", "ps1"])("isolates the official npm installer on %s", (ext) => {
    const script = readFileSync(`src-tauri/scripts/install-dsh.${ext}`, "utf8");
    expect(script).toContain("YUANHENG_DSH_VERSION");
    expect(script).not.toContain("@deepseek-ai/dsh@0.2.0-rc.2");
    expect(script).not.toContain("@deepseek-ai/dsh@latest");
    expect(script).toContain("--engine-strict");
    expect(script).toContain("--ignore-scripts");
    expect(script).toContain("--registry=https://registry.npmjs.org");
    expect(script).toContain("https://nodejs.org/dist/v24.14.0/");
    expect(script).toContain("DSH_TELEMETRY_DISABLED");
    expect(script).not.toMatch(/npm (?:i|install) -g|sudo |Invoke-Expression/);
  });
});
