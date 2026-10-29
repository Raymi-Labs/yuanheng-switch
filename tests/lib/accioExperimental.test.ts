import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  invoke.mockClear();
});

describe("Accio experimental boundary", () => {
  it.each(["", "0", "1"])(
    "shows the tool and inventory by default regardless of legacy flag: %s",
    async (flag) => {
      vi.stubEnv("VITE_ENABLE_ACCIO_WORK", flag);
      const tools = await import("@/config/desktopTools");
      const inventory = await import("@/lib/query/toolInventory");
      expect(tools.DESKTOP_TOOLS).toContain("accio-work");
      expect(inventory.DESKTOP_INVENTORY_TARGETS).toContain("accio-work");
      expect(tools.isCoreApp("accio-work")).toBe(false);
    },
  );

  it("enables both entry points without granting CLI/MCP/Skills projection", async () => {
    vi.stubEnv("VITE_ENABLE_ACCIO_WORK", "1");
    const tools = await import("@/config/desktopTools");
    const inventory = await import("@/lib/query/toolInventory");
    const api = await import("@/lib/api/yuanheng");
    expect(tools.DESKTOP_TOOLS).toContain("accio-work");
    expect(inventory.DESKTOP_INVENTORY_TARGETS).toContain("accio-work");
    expect(tools.isDesktopApp("accio-work")).toBe(true);
    expect(api.isYuanhengCliTool("accio-work")).toBe(false);
  });

  it("does not launch after declining the network/privacy notice", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { yuanhengApi } = await import("@/lib/api/yuanheng");
    await expect(yuanhengApi.launchTool("accio-work")).rejects.toThrow(
      "已取消",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends only the tool identifier to native launch after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { yuanhengApi } = await import("@/lib/api/yuanheng");
    await yuanhengApi.launchTool("accio-work");
    expect(invoke).toHaveBeenCalledWith("launch_tool", {
      tool: "accio-work",
      restart: false,
    });
  });

  it.each([true, false])(
    "waits for Tauri's async launch decision: %s",
    async (accepted) => {
      let decide!: (value: boolean) => void;
      const decision = new Promise<boolean>((resolve) => {
        decide = resolve;
      });
      // The native plugin replaces the DOM boolean API with Promise<boolean>.
      vi.spyOn(window, "confirm").mockReturnValue(
        decision as unknown as boolean,
      );
      const { yuanhengApi } = await import("@/lib/api/yuanheng");
      const outcome = yuanhengApi.launchTool("accio-work").then(
        () => "launched",
        () => "cancelled",
      );
      await Promise.resolve();
      expect(invoke).not.toHaveBeenCalled();
      decide(accepted);
      expect(await outcome).toBe(accepted ? "launched" : "cancelled");
      expect(invoke).toHaveBeenCalledTimes(accepted ? 1 : 0);
    },
  );

  it("does not launch when the native confirmation fails", async () => {
    vi.spyOn(window, "confirm").mockImplementation(
      () =>
        Promise.reject(new Error("dialog unavailable")) as unknown as boolean,
    );
    const { yuanhengApi } = await import("@/lib/api/yuanheng");
    await expect(yuanhengApi.launchTool("accio-work")).rejects.toThrow(
      "dialog unavailable",
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
