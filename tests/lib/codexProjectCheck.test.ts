import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { yuanhengApi } from "@/lib/api/yuanheng";
import { registerCodexProjectCheck } from "@/lib/codexProjectCheck";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/sessionSyncLaunch", () => ({
  offerSessionSyncBeforeLaunch: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
describe("automatic project check triggers", () => {
  it("checks after successful mode and Codex directory switches, and before both Codex launches", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const unregister = registerCodexProjectCheck(check);
    vi.mocked(invoke).mockResolvedValue({ mode: "official" });
    try {
      await yuanhengApi.switchCodexAccountMode("official", "yuanheng");
      expect(check).toHaveBeenCalledTimes(1);
      await yuanhengApi.setLaunchDirectory("codex", "/project");
      expect(check).toHaveBeenCalledTimes(2);
      await yuanhengApi.setLaunchDirectory("claude", "/project");
      expect(check).toHaveBeenCalledTimes(2);
      await yuanhengApi.launchTool("codex");
      await yuanhengApi.launchTool("chatgpt-desktop");
      expect(check).toHaveBeenCalledTimes(4);
    } finally {
      unregister();
    }
  });
  it("does not inspect projects after a failed switch", async () => {
    const check = vi.fn();
    const unregister = registerCodexProjectCheck(check);
    vi.mocked(invoke).mockRejectedValue(new Error("switch failed"));
    try {
      await expect(
        yuanhengApi.switchCodexAccountMode("official"),
      ).rejects.toThrow("switch failed");
      await expect(
        yuanhengApi.setLaunchDirectory("codex", "/project"),
      ).rejects.toThrow("switch failed");
      expect(check).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});
