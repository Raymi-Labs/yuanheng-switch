import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopInstallFlow } from "@/components/desktop/useDesktopInstallFlow";
const api = vi.hoisted(() => ({
  openExternal: vi.fn(),
  getInstalledToolVersions: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ settingsApi: api }));
const url = "https://claude.ai/download";
describe("desktop download observation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.openExternal.mockResolvedValue(undefined);
    api.getInstalledToolVersions.mockResolvedValue([]);
  });
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("observes the official TRAE installation and leaves no timer", async () => {
    api.getInstalledToolVersions.mockResolvedValue([
      {
        name: "trae",
        version: "3.6.4",
        install_path: "/Applications/Trae.app",
      },
    ]);
    const { result, unmount } = renderHook(useDesktopInstallFlow);
    await act(async () => {
      expect(
        (
          await result.current.openAndMonitor(
            "trae",
            "trae",
            "https://www.trae.ai/download",
          )
        ).status,
      ).toBe("detected");
    });
    expect(api.openExternal).toHaveBeenCalledWith(
      "https://www.trae.ai/download",
    );
    expect(result.current.monitoringApps.size).toBe(0);
    unmount();
  });
  it.each([
    "https://www.trae.ai.evil.test/download",
    "https://user:secret@www.trae.ai/download",
    "https://www.trae.ai:8443/download",
    "https://www.trae.cn.evil.test/download",
    "https://user:secret@www.trae.cn/download",
    "https://www.trae.cn:8443/download",
  ])("refuses a spoofed official download: %s", async (invalid) => {
    api.openExternal.mockClear();
    const { result, unmount } = renderHook(useDesktopInstallFlow);
    await act(async () => {
      await expect(
        result.current.openAndMonitor("trae", "trae", invalid),
      ).rejects.toThrow("官方 HTTPS");
    });
    expect(api.openExternal).not.toHaveBeenCalled();
    unmount();
  });
  it("cancels China installation observation on unmount and ignores late discovery", async () => {
    let resolve!: (tools: unknown[]) => void;
    api.getInstalledToolVersions.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result, unmount } = renderHook(useDesktopInstallFlow);
    let task!: ReturnType<typeof result.current.openAndMonitor>;
    await act(async () => {
      task = result.current.openAndMonitor(
        "trae-cn",
        "trae-cn",
        "https://www.trae.cn/download",
      );
    });
    expect(api.getInstalledToolVersions).toHaveBeenCalledWith(["trae-cn"]);
    unmount();
    await expect(task).resolves.toEqual({ status: "cancelled" });
    await act(async () => resolve([{ name: "trae-cn", version: "3.4.9" }]));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not open Accio download or poll after declining the privacy notice", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result, unmount } = renderHook(useDesktopInstallFlow);
    api.openExternal.mockClear();
    api.getInstalledToolVersions.mockClear();
    await act(async () => {
      expect(
        await result.current.openAndMonitor(
          "accio-work",
          "accio-work",
          "https://www.accio.com/work",
        ),
      ).toEqual({ status: "cancelled" });
    });
    expect(api.openExternal).not.toHaveBeenCalled();
    expect(api.getInstalledToolVersions).not.toHaveBeenCalled();
    unmount();
  });
  it.each([true, false])(
    "waits for the async Accio download decision: %s",
    async (accepted) => {
      let decide!: (value: boolean) => void;
      const decision = new Promise<boolean>((resolve) => {
        decide = resolve;
      });
      vi.spyOn(window, "confirm").mockReturnValue(
        decision as unknown as boolean,
      );
      api.openExternal.mockClear();
      api.getInstalledToolVersions.mockClear();
      api.getInstalledToolVersions.mockResolvedValue([{ version: "0.34.5" }]);
      const { result, unmount } = renderHook(useDesktopInstallFlow);
      let task!: ReturnType<typeof result.current.openAndMonitor>;
      await act(async () => {
        task = result.current.openAndMonitor(
          "accio-work",
          "accio-work",
          "https://www.accio.com/work",
        );
      });
      expect(api.openExternal).not.toHaveBeenCalled();
      expect(api.getInstalledToolVersions).not.toHaveBeenCalled();
      await act(async () => {
        decide(accepted);
        expect((await task).status).toBe(accepted ? "detected" : "cancelled");
      });
      expect(api.openExternal).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(result.current.monitoringApps.size).toBe(0);
      unmount();
    },
  );
  it("ignores late approval after the Accio download observer unmounts", async () => {
    let decide!: (value: boolean) => void;
    const decision = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    vi.spyOn(window, "confirm").mockReturnValue(decision as unknown as boolean);
    api.openExternal.mockClear();
    api.getInstalledToolVersions.mockClear();
    const { result, unmount } = renderHook(useDesktopInstallFlow);
    let task!: ReturnType<typeof result.current.openAndMonitor>;
    await act(async () => {
      task = result.current.openAndMonitor(
        "accio-work",
        "accio-work",
        "https://www.accio.com/work",
      );
    });
    await act(async () => {
      unmount();
      expect(await task).toEqual({ status: "cancelled" });
      decide(true);
    });
    expect(api.openExternal).not.toHaveBeenCalled();
    expect(api.getInstalledToolVersions).not.toHaveBeenCalled();
  });
  it("cleans the Accio observer when the native dialog fails", async () => {
    vi.spyOn(window, "confirm").mockImplementation(
      () =>
        Promise.reject(new Error("dialog unavailable")) as unknown as boolean,
    );
    api.openExternal.mockClear();
    const { result, unmount } = renderHook(useDesktopInstallFlow);
    await act(async () => {
      await expect(
        result.current.openAndMonitor(
          "accio-work",
          "accio-work",
          "https://www.accio.com/work",
        ),
      ).rejects.toThrow("dialog unavailable");
    });
    expect(api.openExternal).not.toHaveBeenCalled();
    expect(result.current.monitoringApps.size).toBe(0);
    unmount();
  });
  it("cleans up when opening the browser fails", async () => {
    api.openExternal.mockRejectedValue(new Error("offline"));
    const { result, unmount } = renderHook(useDesktopInstallFlow);
    await act(async () => {
      await expect(
        result.current.openAndMonitor("claude-desktop", "claude-desktop", url),
      ).rejects.toThrow("offline");
    });
    expect(result.current.monitoringApps.size).toBe(0);
    unmount();
  });
  it("manual re-detection cancels waiting and ignores a late installed result", async () => {
    let resolve!: (v: unknown[]) => void;
    api.getInstalledToolVersions.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { result, unmount } = renderHook(useDesktopInstallFlow);
    let task!: ReturnType<typeof result.current.openAndMonitor>;
    await act(async () => {
      task = result.current.openAndMonitor(
        "claude-desktop",
        "claude-desktop",
        url,
      );
    });
    await act(async () => {
      result.current.stopAll();
      expect(await task).toEqual({ status: "cancelled" });
    });
    await act(async () => {
      resolve([{ version: "1.0" }]);
    });
    expect(result.current.monitoringApps.size).toBe(0);
    unmount();
  });
  it("times out even when opening the browser never settles", async () => {
    api.openExternal.mockImplementation(() => new Promise(() => {}));
    const { result, unmount } = renderHook(useDesktopInstallFlow);
    let task!: ReturnType<typeof result.current.openAndMonitor>;
    await act(async () => {
      task = result.current.openAndMonitor(
        "claude-desktop",
        "claude-desktop",
        url,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300000);
      expect(await task).toEqual({ status: "timeout" });
    });
    expect(result.current.monitoringApps.size).toBe(0);
    unmount();
  });
  it("old cleanup does not erase a restarted monitor, and unmount clears polling", async () => {
    const { result, unmount } = renderHook(useDesktopInstallFlow);
    let first!: ReturnType<typeof result.current.openAndMonitor>;
    let second!: typeof first;
    await act(async () => {
      first = result.current.openAndMonitor(
        "claude-desktop",
        "claude-desktop",
        url,
      );
    });
    await act(async () => {
      second = result.current.openAndMonitor(
        "claude-desktop",
        "claude-desktop",
        url,
      );
      expect(await first).toEqual({ status: "cancelled" });
    });
    expect(result.current.monitoringApps.has("claude-desktop")).toBe(true);
    await act(async () => {
      unmount();
      expect(await second).toEqual({ status: "cancelled" });
    });
  });
  it("clears timers after normal detection", async () => {
    api.getInstalledToolVersions.mockResolvedValue([{ version: "1.0" }]);
    const { result, unmount } = renderHook(useDesktopInstallFlow);
    await act(async () => {
      expect(
        (
          await result.current.openAndMonitor(
            "claude-desktop",
            "claude-desktop",
            url,
          )
        ).status,
      ).toBe("detected");
    });
    expect(result.current.monitoringApps.size).toBe(0);
    unmount();
  });
});
