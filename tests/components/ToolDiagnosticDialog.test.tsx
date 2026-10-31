import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolDiagnosticDialog } from "@/components/desktop/ToolDiagnosticDialog";

const state = vi.hoisted(() => ({
  account: { baseUrl: "https://one.test", userId: "one", connected: true },
  refetch: vi.fn(),
}));
vi.mock("@/lib/query/yuanheng", () => ({
  useYuanhengConnection: () => ({ data: state.account }),
  useYuanhengDiagnostics: () => ({ data: undefined, refetch: state.refetch }),
  useRepairYuanheng: () => ({}),
  useRollbackYuanhengTools: () => ({}),
  useRotateYuanhengCredential: () => ({}),
}));

describe("nearby diagnostic dialog", () => {
  beforeEach(() => {
    state.account = {
      baseUrl: "https://one.test",
      userId: "one",
      connected: true,
    };
    state.refetch.mockReset().mockResolvedValue({ isError: false });
  });
  it("only starts the existing diagnostic operation after an explicit click", async () => {
    render(<ToolDiagnosticDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.refetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "诊断与报告" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(state.refetch).not.toHaveBeenCalled();
    expect(screen.getByText(/详细体检可能补齐 Codex/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始检查" }));
    await waitFor(() => expect(state.refetch).toHaveBeenCalledTimes(1));
  });
  it.each([
    { baseUrl: "https://two.test" },
    { userId: "two" },
    { connected: false },
  ])("closes the report across identity boundaries: %j", async (next) => {
    const view = render(<ToolDiagnosticDialog />);
    fireEvent.click(screen.getByRole("button", { name: "诊断与报告" }));
    state.account = { ...state.account, ...next };
    view.rerender(<ToolDiagnosticDialog />);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
