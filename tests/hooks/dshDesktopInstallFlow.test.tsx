import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDesktopInstallFlow,
  type DesktopInstallMonitorResult,
} from "@/components/desktop/useDesktopInstallFlow";
import { DSH_DESKTOP_DOWNLOADS } from "@/components/desktop/useDshDesktopDownload";
const state = vi.hoisted(() => ({
  mac: true,
  windows: false,
  openExternal: vi.fn(),
  getInstalledToolVersions: vi.fn(),
}));
vi.mock("@/lib/platform", () => ({
  isMac: () => state.mac,
  isWindows: () => state.windows,
}));
vi.mock("@/lib/api", () => ({ settingsApi: state }));
vi.mock("@/lib/toast", () => ({ toast: { info: vi.fn() } }));
const complete = vi.fn();
function Harness() {
  const flow = useDesktopInstallFlow();
  return (
    <>
      {flow.downloadDialog}
      <button
        onClick={() =>
          void flow
            .openAndMonitor("dsh", "dsh", "https://www.deepseek.com/harness/")
            .then(complete)
            .catch(complete)
        }
      >
        install
      </button>
      <button onClick={flow.stopAll}>stop</button>
    </>
  );
}
describe("official DSH desktop installation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.mac = true;
    state.windows = false;
    state.openExternal.mockResolvedValue(undefined);
    state.getInstalledToolVersions.mockResolvedValue([
      {
        name: "dsh",
        version: "0.2.1",
        install_path: "/Applications/DeepSeek Harness.app",
      },
    ]);
  });
  afterEach(async () => {
    cleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it.each([
    ["Apple 芯片版（M 系列）", "apple"],
    ["Intel 芯片版", "intel"],
  ] as const)(
    "downloads the selected %s package before detecting the application",
    async (label, target) => {
      render(<Harness />);
      fireEvent.click(screen.getByText("install"));
      expect(state.openExternal).not.toHaveBeenCalled();
      expect(state.getInstalledToolVersions).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: label }));
      });
      expect(state.openExternal).toHaveBeenCalledWith(
        DSH_DESKTOP_DOWNLOADS[target],
      );
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({ status: "detected" }),
      );
    },
  );
  it("opens the Windows installer without asking for a Mac version", async () => {
    state.mac = false;
    state.windows = true;
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByText("install"));
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.openExternal).toHaveBeenCalledWith(
      DSH_DESKTOP_DOWNLOADS.windows,
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ status: "detected" }),
    );
  });
  it.each(["cancel", "unmount", "stop"])(
    "%s during chip selection never opens a download or probes",
    async (how) => {
      const { unmount } = render(<Harness />);
      fireEvent.click(screen.getByText("install"));
      await act(async () => {
        if (how === "unmount") unmount();
        else
          fireEvent.click(screen.getByText(how === "stop" ? "stop" : "取消"));
      });
      expect(complete).toHaveBeenCalledWith({
        status: "cancelled",
      } satisfies DesktopInstallMonitorResult);
      expect(state.openExternal).not.toHaveBeenCalled();
      expect(state.getInstalledToolVersions).not.toHaveBeenCalled();
    },
  );
  it("reports an opening failure and permits a fresh choice", async () => {
    state.openExternal.mockRejectedValueOnce(new Error("download unavailable"));
    render(<Harness />);
    fireEvent.click(screen.getByText("install"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Intel 芯片版" }));
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ message: "download unavailable" }),
    );
    expect(state.getInstalledToolVersions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("install"));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Apple 芯片版（M 系列）" }),
      );
    });
    expect(complete).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "detected" }),
    );
  });
  it("does not silently install Web on an unsupported platform", async () => {
    state.mac = false;
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByText("install"));
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "DSH 官方桌面安装包目前支持 Windows 和 macOS。",
      }),
    );
    expect(state.openExternal).not.toHaveBeenCalled();
    expect(state.getInstalledToolVersions).not.toHaveBeenCalled();
  });
});
