import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSyncDialog } from "@/components/sessions/SessionSyncDialog";
import { getSessionSyncState, setSessionSyncFixtures } from "../msw/state";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("@/lib/toast", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

const renderDialog = (props: { projectDir?: string | null } = {}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const onFinished = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SessionSyncDialog
        open
        onOpenChange={onOpenChange}
        targetProvider="claude"
        projectDir={props.projectDir}
        onFinished={onFinished}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange, onFinished };
};

describe("SessionSyncDialog", () => {
  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("lists each source per project and syncs with one click", async () => {
    setSessionSyncFixtures({
      pending: {
        claude: {
          targetProvider: "claude",
          total: 3,
          directories: [
            {
              projectDir: "/Users/me/yuanheng",
              label: "yuanheng",
              total: 3,
              sources: [
                { sourceProvider: "codex", pending: 2, diverged: 0 },
                { sourceProvider: "gemini", pending: 1, diverged: 0 },
              ],
            },
          ],
        },
      },
    });
    const { onOpenChange, onFinished } = renderDialog({
      projectDir: "/Users/me/yuanheng",
    });

    expect(await screen.findByText("「yuanheng」项目")).toBeInTheDocument();
    expect(screen.getByText(/有 2 次/)).toBeInTheDocument();
    expect(screen.getByText(/有 1 次/)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "全部带过来（3 次）" }),
    );

    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(getSessionSyncState().runCalls).toEqual([
      {
        targetProvider: "claude",
        scope: { projectDir: "/Users/me/yuanheng" },
      },
    ]);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringContaining("已把 3 次聊天带到"),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables the action when nothing is pending", async () => {
    renderDialog();
    expect(
      await screen.findByText("已经是最新的，没有需要带过来的聊天。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "全部带过来（0 次）" }),
    ).toBeDisabled();
  });
});
