import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { yuanhengApi } from "@/lib/api/yuanheng";
import { useCodexLaunchSpeed } from "@/components/desktop/useCodexLaunchSpeed";

describe("本次CLI启动速度", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("启动后保留选择并记录最近启动档位，修改选择不篡改启动记录", async () => {
    vi.spyOn(yuanhengApi, "getCodexLaunchTiers").mockResolvedValue([
      { id: "ultrafast", name: "UltraFast ×6", description: "" },
    ]);
    const { result } = renderHook(() =>
      useCodexLaunchSpeed(true, "7", "m", "g"),
    );
    expect(result.current.request).toBeUndefined();
    expect(result.current.visible).toBe(false);
    await waitFor(() => expect(result.current.tiers).toEqual(["ultrafast"]));
    expect(result.current.visible).toBe(true);
    act(() => result.current.select("ultrafast"));
    expect(result.current.request).toEqual({
      tier: "ultrafast",
      owner: "7",
      model: "m",
      group: "g",
    });
    act(() => result.current.markLaunched());
    expect(result.current.tier).toBe("ultrafast");
    expect(result.current.lastLaunchedTier).toBe("ultrafast");
    const guard = result.current.isCurrent;
    act(() => result.current.select("default"));
    expect(guard()).toBe(false);
    expect(result.current.lastLaunchedTier).toBe("ultrafast");
  });
  it("鹈鹕王切企业及切模型，确认支持才保留原付费档位", async () => {
    let finish!: (
      value: Array<{ id: string; name: string; description: string }>,
    ) => void;
    const rows = [{ id: "ultrafast", name: "UltraFast ×6", description: "" }];
    const query = vi
      .spyOn(yuanhengApi, "getCodexLaunchTiers")
      .mockResolvedValueOnce(rows)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      )
      .mockResolvedValue(rows);
    const { result, rerender } = renderHook(
      ({ model, group }) => useCodexLaunchSpeed(true, "7", model, group),
      { initialProps: { model: "m", group: "鹈鹕王" } },
    );
    await waitFor(() => expect(result.current.tiers).toEqual(["ultrafast"]));
    act(() => result.current.select("ultrafast"));
    rerender({ model: "m", group: "企业" });
    expect(result.current.tier).toBe("ultrafast");
    expect(result.current.valid).toBe(false);
    expect(result.current.request).toBeUndefined();
    await act(async () => finish(rows));
    expect(result.current.request?.group).toBe("企业");
    expect(result.current.tier).toBe("ultrafast");
    rerender({ model: "m2", group: "企业" });
    await waitFor(() => expect(result.current.request?.model).toBe("m2"));
    expect(result.current.tier).toBe("ultrafast");
    expect(query).toHaveBeenLastCalledWith("m2", "企业", "7");
  });
  it("查询成功证实不支持才回标准，网络失败不擅自降档", async () => {
    const query = vi
      .spyOn(yuanhengApi, "getCodexLaunchTiers")
      .mockResolvedValueOnce([
        { id: "ultrafast", name: "UltraFast ×6", description: "" },
      ])
      .mockRejectedValueOnce(Error("offline"))
      .mockResolvedValue([]);
    const { result, rerender } = renderHook(
      ({ group }) => useCodexLaunchSpeed(true, "7", "m", group),
      { initialProps: { group: "a" } },
    );
    await waitFor(() => expect(result.current.tiers).toEqual(["ultrafast"]));
    act(() => result.current.select("ultrafast"));
    rerender({ group: "b" });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.tier).toBe("ultrafast");
    expect(result.current.valid).toBe(false);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.tier).toBe("default"));
    expect(result.current.visible).toBe(false);
    expect(result.current.valid).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
  });
  it("窗口重新聚焦自动发现新能力，卸载后移除监听", async () => {
    const query = vi
      .spyOn(yuanhengApi, "getCodexLaunchTiers")
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { id: "priority", name: "Fast ×2", description: "" },
      ]);
    const { result, unmount } = renderHook(() =>
      useCodexLaunchSpeed(true, "7", "m", "企业"),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.visible).toBe(false);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(result.current.visible).toBe(true));
    expect(query).toHaveBeenCalledTimes(2);
    unmount();
    window.dispatchEvent(new Event("focus"));
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("换账号自动回标准，迟到结果不能恢复旧付费选择", async () => {
    let finish!: (
      value: Array<{ id: string; name: string; description: string }>,
    ) => void;
    vi.spyOn(yuanhengApi, "getCodexLaunchTiers")
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      )
      .mockResolvedValue([]);
    const { result, rerender } = renderHook(
      ({ owner }) => useCodexLaunchSpeed(true, owner, "m", "g"),
      { initialProps: { owner: "7" } },
    );
    act(() => result.current.select("ultrafast"));
    const staleGuard = result.current.isCurrent;
    rerender({ owner: "8" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() =>
      finish([{ id: "ultrafast", name: "UltraFast ×6", description: "" }]),
    );
    expect(result.current.tier).toBe("default");
    expect(result.current.valid).toBe(true);
    expect(result.current.visible).toBe(false);
    expect(result.current.request).toBeUndefined();
    expect(result.current.tiers).toEqual([]);
    expect(staleGuard()).toBe(false);
    act(() => result.current.select("default"));
    expect(result.current.valid).toBe(true);
    expect(result.current.visible).toBe(false);
  });
  it("查询失败不开放付费档位，重试后才可选", async () => {
    const query = vi
      .spyOn(yuanhengApi, "getCodexLaunchTiers")
      .mockRejectedValueOnce(Error("offline"))
      .mockResolvedValue([
        { id: "priority", name: "Fast ×2", description: "" },
      ]);
    const { result } = renderHook(() =>
      useCodexLaunchSpeed(true, "7", "m", "g"),
    );
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.visible).toBe(false);
    act(() => result.current.select("priority"));
    expect(result.current.valid).toBe(false);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.valid).toBe(true));
    expect(query).toHaveBeenCalledTimes(2);
  });
});
