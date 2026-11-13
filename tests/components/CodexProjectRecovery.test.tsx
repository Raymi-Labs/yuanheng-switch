import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexProjectRecovery } from "@/components/desktop/CodexProjectRecovery";
import { yuanhengApi } from "@/lib/api/yuanheng";
import { captureCodexProjectCheck } from "@/lib/codexProjectCheck";
const preview = {
  projectsFound: 33,
  projectsRestored: 33,
  assignmentsRestored: 606,
  backupPath: null,
  blockedReason: null,
  fingerprint: "hash",
  applied: false,
};
afterEach(() => vi.restoreAllMocks());
describe("Codex automatic project check", () => {
  it("is invisible until an automatic check finds missing projects, then restores with its fingerprint", async () => {
    const call = vi
      .spyOn(yuanhengApi, "repairCodexProjectMap")
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({
        ...preview,
        applied: true,
        backupPath: "/test/backup.bak",
      });
    render(<CodexProjectRecovery />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "检查本地项目" })).toBeNull();
    await act(() => captureCodexProjectCheck()());
    expect(call).toHaveBeenNthCalledWith(1, undefined);
    expect(screen.getByText(/33 个项目、606/)).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "备份并恢复" }));
    });
    expect(call).toHaveBeenNthCalledWith(2, "hash");
    expect(screen.getByRole("status")).toHaveTextContent("/test/backup.bak");
  });
  it("rechecks on focus after a running client blocked recovery", async () => {
    vi.spyOn(yuanhengApi, "repairCodexProjectMap")
      .mockResolvedValueOnce({ ...preview, blockedReason: "请先退出客户端" })
      .mockResolvedValueOnce({ ...preview, fingerprint: "new-hash" });
    render(<CodexProjectRecovery />);
    await act(() => captureCodexProjectCheck()());
    expect(screen.getByRole("button", { name: "备份并恢复" })).toBeDisabled();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByRole("button", { name: "备份并恢复" })).toBeEnabled();
  });
  it("keeps absent history and no missing projects silent", async () => {
    vi.spyOn(yuanhengApi, "repairCodexProjectMap")
      .mockRejectedValueOnce("没有历史登录")
      .mockResolvedValueOnce({
        ...preview,
        projectsRestored: 0,
        assignmentsRestored: 0,
      });
    render(<CodexProjectRecovery />);
    await act(() => captureCodexProjectCheck()());
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(() => captureCodexProjectCheck()());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("coalesces checks and drops results after account unmount", async () => {
    let resolve!: (value: typeof preview) => void;
    const call = vi.spyOn(yuanhengApi, "repairCodexProjectMap").mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const view = render(<CodexProjectRecovery />);
    const check = captureCodexProjectCheck();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = check();
      second = check();
    });
    expect(call).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<CodexProjectRecovery />);
    await act(async () => {
      resolve(preview);
      await Promise.all([first, second]);
      await check();
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("clears stale restoration on failure without reporting success", async () => {
    vi.spyOn(yuanhengApi, "repairCodexProjectMap")
      .mockResolvedValueOnce(preview)
      .mockRejectedValueOnce("项目状态已变化");
    render(<CodexProjectRecovery />);
    await act(() => captureCodexProjectCheck()());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "备份并恢复" }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("项目状态已变化");
    expect(screen.queryByRole("button", { name: "备份并恢复" })).toBeNull();
  });
});
