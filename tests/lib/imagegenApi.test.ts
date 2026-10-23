import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { imagegenApi } from "@/lib/api/skills";
beforeEach(() => invoke.mockReset());
describe("image capability IPC", () => {
  it("preserves the actual tool for all dedicated commands", async () => {
    await imagegenApi.getStatus("dsh");
    expect(invoke).toHaveBeenLastCalledWith("get_imagegen_tool_status", {
      tool: "dsh",
    });
    await imagegenApi.install("workbuddy");
    expect(invoke).toHaveBeenLastCalledWith("install_imagegen_for_tool", {
      tool: "workbuddy",
    });
    await imagegenApi.setEnabled("chatgpt-desktop", false);
    expect(invoke).toHaveBeenLastCalledWith("set_imagegen_tool_enabled", {
      tool: "chatgpt-desktop",
      enabled: false,
    });
    await imagegenApi.exportSkill("workbuddy", "/tmp/office.zip");
    expect(invoke).toHaveBeenLastCalledWith("export_imagegen_skill", {
      tool: "workbuddy",
      filePath: "/tmp/office.zip",
    });
  });
});
