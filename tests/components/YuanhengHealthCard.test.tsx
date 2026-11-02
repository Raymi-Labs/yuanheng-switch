import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { YuanhengHealthCard } from "@/components/desktop/YuanhengHealthCard";
const { diagnostics, api, clipboard, toast, account, rotate, repair } =
  vi.hoisted(() => ({
    rotate: vi.fn(),
    repair: vi.fn(),
    diagnostics: {
      data: undefined as any,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    },
    api: {
      getDiagnosticSnapshot: vi.fn(),
      exportDiagnostics: vi.fn(),
      saveFileDialog: vi.fn(),
      refresh: vi.fn(),
    },
    clipboard: vi.fn(),
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    },
    account: { userId: "user-one", lastSyncedAt: 1, connected: true },
  }));
vi.mock("@/lib/query/yuanheng", () => ({
  useYuanhengConnection: () => ({ data: account }),
  useYuanhengDiagnostics: () => diagnostics,
  useRepairYuanheng: () => ({ isPending: false, mutateAsync: repair }),
  useRollbackYuanhengTools: () => ({ isPending: false }),
  useRotateYuanhengCredential: () => ({
    isPending: false,
    mutateAsync: rotate,
  }),
}));
vi.mock("@/lib/api", () => ({ yuanhengApi: api, settingsApi: api }));
vi.mock("@/lib/clipboard", () => ({ copyText: clipboard }));
vi.mock("sonner", () => ({ toast }));
const safe = JSON.stringify({
  schemaVersion: 3,
  snapshotId: "one",
  proxy: { running: true, port: 15721 },
  core: {
    version: "0.1.61",
    pendingWrites: 3,
    droppedEvents: 2,
    writeFailures: 0,
    writerRunning: true,
    events: [{ stage: "upstream_send", outcome: "panic", status: 500 }],
  },
  recentRequests: [{ status: 401, latencyMs: 99 }],
});
describe("diagnostic snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    account.userId = "user-one";
    diagnostics.isError = false;
    diagnostics.data = {
      status: "ok",
      readyTools: 1,
      checkedAt: 10,
      checks: [],
      snapshotId: "one",
      supportJson: safe,
    };
    diagnostics.refetch.mockResolvedValue({
      isError: false,
      data: { status: "warning" },
    });
    api.getDiagnosticSnapshot.mockResolvedValue(safe);
    api.exportDiagnostics.mockResolvedValue("/tmp/report.json");
    api.saveFileDialog.mockResolvedValue("/tmp/report.json");
    api.refresh.mockResolvedValue({
      userId: "user-one",
      groups: [{ id: "premium", description: "优质" }],
    });
    rotate.mockResolvedValue({ connection: account });
  });
  it("the nearby diagnostic entry never presents repair/rotation/rollback actions", async () => {
    diagnostics.data.status = "error";
    diagnostics.data.checks = [
      {
        id: "credentials",
        status: "error",
        title: "凭据",
        message: "需修复",
        action: "repair_credentials",
      },
    ];
    render(<YuanhengHealthCard initiallyExpanded checkOnly />);
    expect(screen.getAllByText("需修复")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "一键修复" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "配置或修复通用凭据" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "恢复接管前配置" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    await waitFor(() => expect(diagnostics.refetch).toHaveBeenCalledTimes(1));
  });
  it("does not retain an all-clear heading after a failed refresh", () => {
    diagnostics.isError = true;
    render(<YuanhengHealthCard initiallyExpanded />);
    expect(screen.queryByText("检查通过")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("上次结果");
  });
  it("preview, copy and export refer to the identical snapshot, without another health check", async () => {
    render(<YuanhengHealthCard />);
    fireEvent.click(screen.getByRole("button", { name: "检查详情" }));
    expect(screen.getByText(/默认体检不调用模型/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "预览脱敏报告" }));
    expect(screen.getByText(safe)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^关闭$/ }));
    fireEvent.click(screen.getByRole("button", { name: "复制脱敏诊断" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(safe));
    fireEvent.click(screen.getByRole("button", { name: "导出脱敏诊断" }));
    await waitFor(() =>
      expect(api.exportDiagnostics).toHaveBeenCalledWith(
        "/tmp/report.json",
        "one",
      ),
    );
    expect(diagnostics.refetch).not.toHaveBeenCalled();
  });
  it("expired or account-changed snapshots are not copied", async () => {
    api.getDiagnosticSnapshot.mockRejectedValue(new Error("诊断快照已过期"));
    render(<YuanhengHealthCard />);
    fireEvent.click(screen.getByRole("button", { name: "检查详情" }));
    fireEvent.click(screen.getByRole("button", { name: "复制脱敏诊断" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(clipboard).not.toHaveBeenCalled();
  });
  it("a prior healthy report cannot produce a success toast after a failing check", async () => {
    render(<YuanhengHealthCard />);
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("requires explicit live group choice and never reports success for a failed recheck", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<YuanhengHealthCard initiallyExpanded />);
    fireEvent.click(screen.getByRole("button", { name: "配置或修复通用凭据" }));
    const select = await screen.findByRole("combobox", {
      name: "通用凭据分组",
    });
    expect(
      screen.getByRole("button", { name: "验证并保存通用凭据" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("option", { name: /default/ }),
    ).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "premium" } });
    fireEvent.click(screen.getByRole("button", { name: "验证并保存通用凭据" }));
    await waitFor(() =>
      expect(rotate).toHaveBeenCalledWith({
        group: "premium",
        userId: "user-one",
      }),
    );
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it("failed group refresh does not use cached groups or create a credential", async () => {
    api.refresh.mockRejectedValue(new Error("网络暂不可用"));
    render(<YuanhengHealthCard initiallyExpanded />);
    fireEvent.click(screen.getByRole("button", { name: "配置或修复通用凭据" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("discard group choices when the account changes while loading", async () => {
    let resolve!: (value: unknown) => void;
    api.refresh.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<YuanhengHealthCard initiallyExpanded />);
    fireEvent.click(screen.getByRole("button", { name: "配置或修复通用凭据" }));
    account.userId = "user-two";
    view.rerender(<YuanhengHealthCard initiallyExpanded />);
    resolve({ userId: "user-one", groups: [{ id: "premium" }] });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "配置或修复通用凭据" }),
      ).not.toBeDisabled(),
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(rotate).not.toHaveBeenCalled();
  });
});
