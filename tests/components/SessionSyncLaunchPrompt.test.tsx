import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSyncLaunchPrompt } from "@/components/sessions/SessionSyncLaunchPrompt";
import { yuanhengApi } from "@/lib/api/yuanheng";
import {
  getLaunchedToolRequests,
  getSessionSyncState,
  setSessionSyncFixtures,
} from "../msw/state";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("@/lib/toast", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

const pendingForClaude = {
  claude: {
    targetProvider: "claude",
    total: 54,
    directories: [
      {
        projectDir: "/Users/me/yuanheng",
        label: "yuanheng",
        total: 54,
        sources: [{ sourceProvider: "codex", pending: 54, diverged: 0 }],
      },
    ],
  },
};

const mountPrompt = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionSyncLaunchPrompt />
    </QueryClientProvider>,
  );
};

const launchCount = () =>
  getLaunchedToolRequests().filter((r) => r.app === "claude").length;

describe("launch-time session sync prompt", () => {
  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("pauses launch, syncs the shown project, then launches", async () => {
    setSessionSyncFixtures({ pending: pendingForClaude });
    mountPrompt();

    const launch = yuanhengApi.launchTool(
      "claude",
      false,
      "/Users/me/yuanheng",
    );
    expect(
      await screen.findByText(/要把之前的聊天带到 .+ 吗？/),
    ).toBeInTheDocument();
    expect(screen.getByText(/^codex 有 54 次$/i)).toBeInTheDocument();
    expect(launchCount()).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: "带过来并启动" }));
    await launch;

    expect(getSessionSyncState().launchChecks).toEqual([
      { targetProvider: "claude", projectDir: "/Users/me/yuanheng" },
    ]);
    expect(getSessionSyncState().runCalls).toEqual([
      {
        targetProvider: "claude",
        scope: { projectDirs: ["/Users/me/yuanheng"] },
      },
    ]);
    expect(launchCount()).toBe(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("launches without syncing on 直接启动", async () => {
    setSessionSyncFixtures({ pending: pendingForClaude });
    mountPrompt();
    const launch = yuanhengApi.launchTool(
      "claude",
      false,
      "/Users/me/yuanheng",
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "直接启动" }),
    );
    await launch;
    expect(getSessionSyncState().runCalls).toEqual([]);
    expect(launchCount()).toBe(1);
  });

  it("mutes the project and still launches", async () => {
    setSessionSyncFixtures({ pending: pendingForClaude });
    mountPrompt();
    const launch = yuanhengApi.launchTool(
      "claude",
      false,
      "/Users/me/yuanheng",
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "这个项目不再提醒" }),
    );
    await launch;
    expect(getSessionSyncState().muteCalls).toEqual([
      { targetProvider: "claude", projectDirs: ["/Users/me/yuanheng"] },
    ]);
    expect(getSessionSyncState().runCalls).toEqual([]);
    expect(launchCount()).toBe(1);
  });

  it("still launches when the sync itself fails", async () => {
    setSessionSyncFixtures({ pending: pendingForClaude, failRun: true });
    mountPrompt();
    const launch = yuanhengApi.launchTool(
      "claude",
      false,
      "/Users/me/yuanheng",
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "带过来并启动" }),
    );
    await launch;
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("同步没有完成，先为你直接启动"),
    );
    expect(launchCount()).toBe(1);
  });

  it("never blocks launch when the check fails or nothing is pending", async () => {
    setSessionSyncFixtures({ failLaunchCheck: true });
    mountPrompt();
    await yuanhengApi.launchTool("claude", false, "/Users/me/yuanheng");
    setSessionSyncFixtures({ failLaunchCheck: false });
    await yuanhengApi.launchTool("claude", false, "/Users/me/other");
    expect(launchCount()).toBe(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("skips the check for restarts and for tools without a sync target", async () => {
    setSessionSyncFixtures({ pending: pendingForClaude });
    mountPrompt();
    await yuanhengApi.launchTool("claude", true, "/Users/me/yuanheng");
    await yuanhengApi.launchTool("openclaw", false, "/Users/me/yuanheng");
    await waitFor(() => expect(launchCount()).toBe(1));
    expect(getSessionSyncState().launchChecks).toEqual([]);
  });

  it("asks before Gemini CLI, Grok Build, OpenCode and DSH launches too", async () => {
    mountPrompt();
    await yuanhengApi.launchTool("gemini", false, "/Users/me/a");
    await yuanhengApi.launchTool("grokbuild", false, "/Users/me/b");
    await yuanhengApi.launchTool("opencode", false, "/Users/me/c");
    await yuanhengApi.launchTool("dsh", false, "/Users/me/d");
    expect(getSessionSyncState().launchChecks).toEqual([
      { targetProvider: "gemini", projectDir: "/Users/me/a" },
      { targetProvider: "grokbuild", projectDir: "/Users/me/b" },
      { targetProvider: "opencode", projectDir: "/Users/me/c" },
      { targetProvider: "dsh", projectDir: "/Users/me/d" },
    ]);
  });

  it("maps Codex Desktop launches to the shared Codex history", async () => {
    mountPrompt();
    await yuanhengApi.launchTool("chatgpt-desktop", false);
    expect(getSessionSyncState().launchChecks).toEqual([
      { targetProvider: "codex", projectDir: null },
    ]);
  });
});
