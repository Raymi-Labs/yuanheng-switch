import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), windows: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/platform", () => ({ isWindows: () => mocks.windows }));

describe("Claude Windows preparation intent", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    mocks.windows = true;
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(async () => {
    // jsdom schedules zero-delay storage events for localStorage writes.
    // Do not flush future preparation polls: a leaked poll must still fail.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("does nothing on other systems; readonly recheck never elevates", async () => {
    const flow = await import("@/lib/claudeWorkspaceSetup");
    mocks.windows = false;
    await flow.ensureClaudeWorkspaceReady();
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.windows = true;
    mocks.invoke.mockResolvedValue({
      phase: "needs_preparation",
      message: "needs preparation",
    });
    await flow.refreshClaudeWorkspace();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_claude_workspace_preparation",
    );
    expect(window.confirm).not.toHaveBeenCalled();
  });
  it("shares duplicate clicks and persists restart intent without account data", async () => {
    const flow = await import("@/lib/claudeWorkspaceSetup");
    mocks.invoke
      .mockResolvedValueOnce({ phase: "needs_preparation", message: "needed" })
      .mockResolvedValueOnce({ phase: "preparing", message: "pending" })
      .mockResolvedValueOnce({
        phase: "restart_required",
        message: "save and restart",
      });
    const first = flow.ensureClaudeWorkspaceReady();
    expect(flow.ensureClaudeWorkspaceReady()).toBe(first);
    const assertion = expect(first).rejects.toThrow("save and restart");
    await vi.advanceTimersByTimeAsync(2100);
    await assertion;
    expect(
      mocks.invoke.mock.calls.filter(
        ([cmd]) => cmd === "prepare_claude_workspace",
      ),
    ).toHaveLength(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(flow.claudeWorkspaceSetup.getSnapshot().busy).toBe(false);
    expect(localStorage.getItem("yuanheng.claudeWorkspacePreparation.v1")).toBe(
      "pending",
    );
  });
  it("refusing consent never calls a system-changing command", async () => {
    const flow = await import("@/lib/claudeWorkspaceSetup");
    mocks.invoke.mockResolvedValue({
      phase: "needs_preparation",
      message: "needed",
    });
    vi.mocked(window.confirm).mockReturnValue(false);
    await expect(flow.ensureClaudeWorkspaceReady()).rejects.toThrow("已取消");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(flow.claudeWorkspaceSetup.getSnapshot().state?.phase).toBe(
      "cancelled",
    );
  });
  it("reboot check only observes; ready clears intent on continuing", async () => {
    localStorage.setItem("yuanheng.claudeWorkspacePreparation.v1", "pending");
    const flow = await import("@/lib/claudeWorkspaceSetup");
    mocks.invoke.mockResolvedValue({
      phase: "ready",
      message: "base ready, inference not tested",
    });
    expect(flow.claudeWorkspaceSetup.resumePending()).toBe(true);
    await flow.refreshClaudeWorkspace();
    expect(window.confirm).not.toHaveBeenCalled();
    flow.claudeWorkspaceSetup.requestContinue();
    expect(flow.claudeWorkspaceSetup.consumeContinue()).toBe(true);
    expect(flow.claudeWorkspaceSetup.consumeContinue()).toBe(false);
    await flow.ensureClaudeWorkspaceReady();
    expect(flow.claudeWorkspaceSetup.resumePending()).toBe(false);
    expect(
      mocks.invoke.mock.calls.every(
        ([cmd]) => cmd === "get_claude_workspace_preparation",
      ),
    ).toBe(true);
  });
  it("a long servicing operation stops UI waiting without cancelling DISM", async () => {
    const flow = await import("@/lib/claudeWorkspaceSetup");
    mocks.invoke.mockResolvedValue({
      phase: "preparing",
      message: "Windows servicing",
    });
    const task = flow.ensureClaudeWorkspaceReady();
    const assertion = expect(task).rejects.toThrow("没有终止系统安装");
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 2000);
    await assertion;
    expect(flow.claudeWorkspaceSetup.getSnapshot().busy).toBe(false);
    expect(
      mocks.invoke.mock.calls.every(
        ([cmd]) => cmd === "get_claude_workspace_preparation",
      ),
    ).toBe(true);
  });
  it("unknown response and UAC cancellation never turn into ready or automatic retries", async () => {
    const flow = await import("@/lib/claudeWorkspaceSetup");
    mocks.invoke
      .mockResolvedValueOnce({ phase: "needs_preparation", message: "needed" })
      .mockResolvedValueOnce({ phase: "cancelled", message: "UAC refused" });
    await expect(flow.ensureClaudeWorkspaceReady()).rejects.toThrow(
      "UAC refused",
    );
    expect(flow.claudeWorkspaceSetup.getSnapshot().state?.phase).toBe(
      "cancelled",
    );
    mocks.invoke.mockResolvedValue({ phase: "made_up", message: "secret" });
    await expect(flow.ensureClaudeWorkspaceReady()).rejects.toThrow("未能完成");
    expect(flow.claudeWorkspaceSetup.getSnapshot().state?.phase).toBe(
      "unknown",
    );
  });
  it("minimizing the dialog does not abort or reopen while status changes", async () => {
    const flow = await import("@/lib/claudeWorkspaceSetup");
    mocks.invoke
      .mockResolvedValueOnce({ phase: "preparing", message: "pending" })
      .mockResolvedValueOnce({ phase: "restart_required", message: "restart" });
    const task = flow.ensureClaudeWorkspaceReady();
    const assertion = expect(task).rejects.toThrow("restart");
    await vi.advanceTimersByTimeAsync(1);
    flow.claudeWorkspaceSetup.dismiss();
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(flow.claudeWorkspaceSetup.getSnapshot().visible).toBe(false);
    expect(flow.claudeWorkspaceSetup.resumePending()).toBe(true);
  });

  it("keeps reminder opt-out across restarts and explicit failed or successful retries", async () => {
    let flow = await import("@/lib/claudeWorkspaceSetup");
    mocks.invoke.mockResolvedValue({
      phase: "failed",
      message: "failed setup",
    });
    await expect(flow.ensureClaudeWorkspaceReady()).rejects.toThrow(
      "failed setup",
    );
    expect(flow.claudeWorkspaceSetup.setSuppressStartupReminder(true)).toBe(
      true,
    );
    flow.claudeWorkspaceSetup.dismiss();
    expect(flow.claudeWorkspaceSetup.resumePending()).toBe(false);
    expect(localStorage.getItem("yuanheng.claudeWorkspacePreparation.v1")).toBe(
      "pending",
    );

    vi.resetModules();
    flow = await import("@/lib/claudeWorkspaceSetup");
    expect(flow.claudeWorkspaceSetup.resumePending()).toBe(false);
    expect(flow.claudeWorkspaceSetup.getSnapshot().visible).toBe(false);
    await expect(flow.ensureClaudeWorkspaceReady()).rejects.toThrow(
      "failed setup",
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(flow.claudeWorkspaceSetup.getSnapshot()).toMatchObject({
      visible: true,
      suppressStartupReminder: true,
      state: { phase: "failed" },
    });

    mocks.invoke.mockResolvedValue({ phase: "ready", message: "ready" });
    await flow.ensureClaudeWorkspaceReady();
    expect(
      flow.claudeWorkspaceSetup.getSnapshot().suppressStartupReminder,
    ).toBe(true);
    expect(
      localStorage.getItem("yuanheng.claudeWorkspacePreparation.v1"),
    ).toBeNull();
  });

  it("can restore reminders without losing the pending preparation", async () => {
    const flow = await import("@/lib/claudeWorkspaceSetup");
    localStorage.setItem("yuanheng.claudeWorkspacePreparation.v1", "pending");
    flow.claudeWorkspaceSetup.setSuppressStartupReminder(true);
    expect(flow.claudeWorkspaceSetup.setSuppressStartupReminder(false)).toBe(
      true,
    );
    expect(flow.claudeWorkspaceSetup.resumePending()).toBe(true);
    vi.resetModules();
    expect(
      (
        await import("@/lib/claudeWorkspaceSetup")
      ).claudeWorkspaceSetup.resumePending(),
    ).toBe(true);
  });

  it("falls back to reminders for malformed or unreadable preferences", async () => {
    localStorage.setItem("yuanheng.claudeWorkspacePreparation.v1", "pending");
    localStorage.setItem(
      "yuanheng.claudeWorkspacePreparation.suppressReminder.v1",
      "invalid",
    );
    let flow = await import("@/lib/claudeWorkspaceSetup");
    expect(flow.claudeWorkspaceSetup.resumePending()).toBe(true);
    vi.resetModules();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    flow = await import("@/lib/claudeWorkspaceSetup");
    expect(
      flow.claudeWorkspaceSetup.getSnapshot().suppressStartupReminder,
    ).toBe(false);
    expect(flow.claudeWorkspaceSetup.resumePending()).toBe(false);
  });

  it("does not report an unsaved preference as persisted", async () => {
    const flow = await import("@/lib/claudeWorkspaceSetup");
    localStorage.setItem("yuanheng.claudeWorkspacePreparation.v1", "pending");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage full");
    });
    expect(flow.claudeWorkspaceSetup.setSuppressStartupReminder(true)).toBe(
      false,
    );
    expect(flow.claudeWorkspaceSetup.resumePending()).toBe(true);
    vi.restoreAllMocks();
    flow.claudeWorkspaceSetup.setSuppressStartupReminder(true);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    expect(flow.claudeWorkspaceSetup.setSuppressStartupReminder(false)).toBe(
      false,
    );
    expect(
      flow.claudeWorkspaceSetup.getSnapshot().suppressStartupReminder,
    ).toBe(true);
  });
});
