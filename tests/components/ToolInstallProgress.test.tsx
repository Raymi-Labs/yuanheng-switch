import { act, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolInstallProgress } from "@/components/desktop/ToolInstallProgress";
import {
  cancelToolInstall,
  runToolLifecycleJob,
  type ToolInstallProgress as Progress,
} from "@/lib/toolLifecycleState";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function begin(tool = "dsh", action: "install" | "update" = "install") {
  let report!: (value: Progress) => void;
  let finish!: () => void;
  let task!: Promise<void>;
  act(() => {
    task = runToolLifecycleJob([tool], action, (setCancel, update) => {
      report = update;
      setCancel(async () => true);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
  });
  return {
    report: (value: Progress) => act(() => report(value)),
    finish: () =>
      act(async () => {
        finish();
        await task;
      }),
  };
}
describe("installation progress", () => {
  it("shares real download bytes across views without inventing percentages for stages", async () => {
    render(
      <>
        <ToolInstallProgress tool="dsh" />
        <ToolInstallProgress tool="dsh" onDark />
      </>,
    );
    const job = begin();
    job.report({
      stage: "download",
      downloadedBytes: 1048576,
      totalBytes: 4194304,
      activity: true,
    });
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    screen
      .getAllByRole("progressbar")
      .forEach((bar) => expect(bar).toHaveAttribute("aria-valuenow", "25"));
    expect(screen.getAllByText("已下载 1.0 MB / 4.0 MB")).toHaveLength(2);
    expect(screen.getAllByText("下载进度 25%")).toHaveLength(2);
    job.report({ stage: "package", activity: true });
    screen
      .getAllByRole("progressbar")
      .forEach((bar) => expect(bar).not.toHaveAttribute("aria-valuenow"));
    expect(screen.getAllByText("正在下载并安装 DSH…")).toHaveLength(2);
    await job.finish();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    job.report({ stage: "download", totalBytes: 4, downloadedBytes: 3 });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
  it.each(["install", "update"] as const)(
    "shows real component progress during %s and drops it for verification",
    async (action) => {
      render(<ToolInstallProgress tool="dsh" />);
      const job = begin("dsh", action);
      job.report({ stage: "package", activity: true });
      expect(screen.getByText(/正在解析组件清单/)).toBeInTheDocument();
      job.report({ stage: "package", completedItems: 70, totalItems: 200 });
      expect(screen.getByText("组件进度 35%")).toBeInTheDocument();
      expect(screen.getByText("已处理 70 / 200 个组件")).toBeInTheDocument();
      expect(
        screen.getByRole("progressbar", { name: "组件进度" }),
      ).toHaveAttribute("aria-valuenow", "35");
      expect(screen.queryByText(/正在解析组件清单/)).not.toBeInTheDocument();
      job.report({ stage: "verify", completedItems: 200, totalItems: 200 });
      expect(screen.getByRole("progressbar")).not.toHaveAttribute(
        "aria-valuenow",
      );
      expect(screen.queryByText(/组件进度 100%/)).not.toBeInTheDocument();
      await job.finish();
    },
  );
  it.each([0, -1, 2, NaN, Infinity, 3.5])(
    "ignores invalid component total %s",
    async (totalItems) => {
      render(<ToolInstallProgress tool="dsh" />);
      const job = begin();
      job.report({ stage: "package", completedItems: 3, totalItems });
      expect(screen.getByRole("progressbar")).not.toHaveAttribute(
        "aria-valuenow",
      );
      await job.finish();
    },
  );
  it("keeps elapsed time across remounts, warns on silence and clears the warning on real activity", async () => {
    vi.useFakeTimers();
    const job = begin("codex");
    job.report({ stage: "executing", activity: true });
    let view = render(<ToolInstallProgress tool="codex" />);
    act(() => vi.advanceTimersByTime(61_000));
    expect(screen.getByText(/暂未收到新的进度/)).toBeInTheDocument();
    view.unmount();
    view = render(<ToolInstallProgress tool="codex" />);
    expect(screen.getByText("已用时 1:01")).toBeInTheDocument();
    job.report({ stage: "executing", activity: true });
    expect(screen.queryByText(/暂未收到新的进度/)).not.toBeInTheDocument();
    await act(async () => {
      await cancelToolInstall("codex");
    });
    job.report({ stage: "download", totalBytes: 100, downloadedBytes: 50 });
    expect(screen.getByText("正在停止安装…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).not.toHaveAttribute(
      "aria-valuenow",
    );
    await job.finish();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([undefined, 0, -1, 1, NaN, Infinity])(
    "does not show a false percentage for invalid total %s",
    async (totalBytes) => {
      render(<ToolInstallProgress tool="dsh" />);
      const job = begin();
      job.report({ stage: "download", downloadedBytes: 10, totalBytes });
      expect(screen.getByRole("progressbar")).not.toHaveAttribute(
        "aria-valuenow",
      );
      expect(
        screen.getByText("正在下载，文件总大小暂不可用。"),
      ).toBeInTheDocument();
      await job.finish();
    },
  );
  it("describes external installation as observation, without a fake download percentage", () => {
    const view = render(
      <ToolInstallProgress tool="chatgpt-desktop" waitingForDesktop />,
    );
    expect(screen.getByText(/请在官网下载并运行安装包/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).not.toHaveAttribute(
      "aria-valuenow",
    );
    view.rerender(
      <ToolInstallProgress tool="chatgpt-desktop" waitingForDesktop={false} />,
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
