import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeWorkspacePreparation } from "@/components/desktop/ClaudeWorkspacePreparation";
import {
  claudeWorkspaceSetup,
  refreshClaudeWorkspace,
  type WorkspacePhase,
} from "@/lib/claudeWorkspaceSetup";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/platform", () => ({ isWindows: () => true }));

describe("Claude preparation reminders", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    claudeWorkspaceSetup.setSuppressStartupReminder(false);
    claudeWorkspaceSetup.dismiss();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({
      phase: "failed",
      message: "组件准备失败，请稍后重试。",
    });
    localStorage.setItem("yuanheng.claudeWorkspacePreparation.v1", "pending");
  });

  it.each<WorkspacePhase>([
    "failed",
    "unknown",
    "cancelled",
    "firmware_required",
    "needs_preparation",
    "restart_required",
  ])("offers persistent opt-out below %s status", async (phase) => {
    mocks.invoke.mockResolvedValue({ phase, message: "组件准备尚未完成。" });
    const view = render(<ClaudeWorkspacePreparation onContinue={vi.fn()} />);
    await screen.findByText("组件准备尚未完成。");
    fireEvent.click(screen.getByRole("checkbox", { name: "不再提醒" }));
    expect(screen.getByRole("checkbox", { name: "不再提醒" })).toBeChecked();
    if (phase === "restart_required") {
      expect(
        screen.queryByText(/重新打开元衡会恢复检查/),
      ).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "继续准备 Claude" }),
    ).not.toBeInTheDocument();
    view.unmount();
    mocks.invoke.mockClear();
    render(<ClaudeWorkspacePreparation onContinue={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("keeps normal later/remount recovery unless the user opts out", async () => {
    const view = render(<ClaudeWorkspacePreparation onContinue={vi.fn()} />);
    await screen.findByText("组件准备失败，请稍后重试。");
    fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
    expect(
      screen.getByRole("button", { name: "继续准备 Claude" }),
    ).toBeInTheDocument();
    view.unmount();
    render(<ClaudeWorkspacePreparation onContinue={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
  });

  it("manual retry still checks and allows reminders to be restored", async () => {
    claudeWorkspaceSetup.setSuppressStartupReminder(true);
    render(<ClaudeWorkspacePreparation onContinue={vi.fn()} />);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await act(async () => {
      claudeWorkspaceSetup.show();
      await refreshClaudeWorkspace();
    });
    fireEvent.click(screen.getByRole("button", { name: "准备必要组件" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "准备必要组件" }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("checkbox", { name: "不再提醒" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "不再提醒" }));
    fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
    expect(
      screen.getByRole("button", { name: "继续准备 Claude" }),
    ).toBeInTheDocument();
  });

  it("shows a save failure and leaves the checkbox unchecked", async () => {
    render(<ClaudeWorkspacePreparation onContinue={vi.fn()} />);
    await screen.findByText("组件准备失败，请稍后重试。");
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage full");
      });
    fireEvent.click(screen.getByRole("checkbox", { name: "不再提醒" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "无法保存提醒偏好，请重试。",
    );
    expect(
      screen.getByRole("checkbox", { name: "不再提醒" }),
    ).not.toBeChecked();
    write.mockRestore();
    fireEvent.click(screen.getByRole("checkbox", { name: "不再提醒" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "不再提醒" })).toBeChecked();
  });
});
