import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexProjectRecovery } from "@/components/desktop/CodexProjectRecovery";
import { yuanhengApi } from "@/lib/api/yuanheng";
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
describe("Codex project recovery", () => {
  it("previews before explicit restoration, uses fingerprint and shows backup only after apply", async () => {
    const call = vi
      .spyOn(yuanhengApi, "repairCodexProjectMap")
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({
        ...preview,
        applied: true,
        backupPath: "/test/backup.bak",
      });
    render(<CodexProjectRecovery />);
    expect(screen.queryByRole("button", { name: "备份并恢复" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "检查本地项目" }));
    });
    expect(call).toHaveBeenNthCalledWith(1, undefined);
    expect(screen.getByText(/33 个项目、606/)).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "备份并恢复" }));
    });
    expect(call).toHaveBeenNthCalledWith(2, "hash");
    expect(screen.getByRole("status")).toHaveTextContent("/test/backup.bak");
  });
  it("blocks restoration while running and requires a fresh check", async () => {
    const call = vi
      .spyOn(yuanhengApi, "repairCodexProjectMap")
      .mockResolvedValue({ ...preview, blockedReason: "请先退出客户端" });
    render(<CodexProjectRecovery />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "检查本地项目" }));
    });
    expect(screen.getByRole("button", { name: "备份并恢复" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("请先退出客户端");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("clears stale preview on error without claiming recovery", async () => {
    vi.spyOn(yuanhengApi, "repairCodexProjectMap")
      .mockResolvedValueOnce(preview)
      .mockRejectedValueOnce("项目状态已变化");
    render(<CodexProjectRecovery />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "检查本地项目" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "备份并恢复" }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("项目状态已变化");
    expect(screen.queryByRole("button", { name: "备份并恢复" })).toBeNull();
  });
});
