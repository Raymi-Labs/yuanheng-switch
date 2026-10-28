import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TraeInstallationActions } from "@/components/desktop/TraeInstallationActions";
import type { ToolVersionInfo } from "@/lib/api/settings";

const mocks = vi.hoisted(() => ({
  mac: true,
  rows: [] as ToolVersionInfo[],
  failed: false,
  fetching: false,
  refresh: vi.fn(),
  pick: vi.fn(),
  clear: vi.fn(),
  launch: vi.fn(),
  invalidate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  observe: vi.fn(),
  stop: vi.fn(),
  monitoring: new Set<string>(),
}));
vi.mock("@/lib/platform", () => ({ isMac: () => mocks.mac }));
vi.mock("@/lib/api", () => ({
  settingsApi: {
    pickDesktopAppPath: mocks.pick,
    clearDesktopAppPath: mocks.clear,
    launchTrae: mocks.launch,
  },
}));
vi.mock("@/lib/query/toolInventory", () => ({
  useToolInventory: () => ({
    data: mocks.rows,
    isError: mocks.failed,
    isFetching: mocks.fetching,
    refetch: mocks.refresh,
  }),
}));
vi.mock("@/components/desktop/toolInventoryCache", () => ({
  clearToolInventoryCache: mocks.invalidate,
}));
vi.mock("@/components/desktop/useDesktopInstallFlow", () => ({
  useDesktopInstallFlow: () => ({
    monitoringApps: mocks.monitoring,
    openAndMonitor: mocks.observe,
    stop: mocks.stop,
  }),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error, info: mocks.info },
}));
vi.mock("@/components/desktop/desktopI18n", () => ({
  dt: (text: string) => text,
}));

const installed = (): ToolVersionInfo => ({
  name: "trae",
  version: "3.6.4",
  latest_version: null,
  error: null,
  installed_but_broken: false,
  env_type: "macos",
  wsl_distro: null,
  detection_source: "automatic",
  custom_path: null,
  install_path: "/Applications/Trae.app",
  custom_path_valid: true,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mac = true;
  mocks.rows = [installed()];
  mocks.failed = false;
  mocks.fetching = false;
  mocks.monitoring = new Set();
  mocks.refresh.mockResolvedValue({});
  mocks.pick.mockResolvedValue(null);
  mocks.clear.mockResolvedValue(true);
  mocks.launch.mockResolvedValue(true);
});

describe("TRAE installation and safe launch", () => {
  it("does not use an installed international app as the China edition", () => {
    render(<TraeInstallationActions edition="china" />);
    expect(screen.getByRole("button", { name: "打开 TRAE" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "下载并检测 TRAE" }),
    ).toBeEnabled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("uses the China target for launch and custom paths", async () => {
    mocks.rows = [
      {
        ...installed(),
        name: "trae-cn",
        install_path: "/Applications/Trae CN.app",
        custom_path: "/Applications/Trae CN.app",
      },
    ];
    render(<TraeInstallationActions edition="china" />);
    fireEvent.click(screen.getByRole("button", { name: "打开 TRAE" }));
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledWith("trae-cn"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "选择 TRAE 路径" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "选择 TRAE 路径" }));
    await waitFor(() => expect(mocks.pick).toHaveBeenCalledWith("trae-cn"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "清除 TRAE 自选路径" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "清除 TRAE 自选路径" }));
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledWith("trae-cn"));
  });
  it("drops late installation results after switching editions", async () => {
    mocks.rows = [];
    let resolve!: (result: { status: string; tool: ToolVersionInfo }) => void;
    mocks.observe.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(<TraeInstallationActions edition="china" />);
    fireEvent.click(screen.getByRole("button", { name: "下载并检测 TRAE" }));
    expect(mocks.observe).toHaveBeenCalledWith(
      "trae-cn",
      "trae-cn",
      "https://www.trae.cn/download",
    );
    view.rerender(<TraeInstallationActions edition="international" />);
    await act(async () =>
      resolve({
        status: "detected",
        tool: { ...installed(), name: "trae-cn" },
      }),
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("does not broaden platform support or launch during rendering", () => {
    mocks.mac = false;
    render(<TraeInstallationActions />);
    expect(screen.getByText(/自动启动仍待验证/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "打开 TRAE" }),
    ).not.toBeInTheDocument();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("opens the app without claiming model setup", async () => {
    render(<TraeInstallationActions />);
    fireEvent.click(screen.getByRole("button", { name: "打开 TRAE" }));
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "已请求打开 TRAE，请在官方应用中登录并配置模型。",
      ),
    );
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });
  it.each(["stale", "broken", "failed", "fetching", "absent"])(
    "cannot launch with %s inventory",
    (scenario) => {
      if (scenario === "stale")
        mocks.rows = [
          {
            ...installed(),
            custom_path: "/missing/Trae.app",
            custom_path_valid: false,
          },
        ];
      if (scenario === "broken")
        mocks.rows = [{ ...installed(), installed_but_broken: true }];
      if (scenario === "failed") mocks.failed = true;
      if (scenario === "fetching") mocks.fetching = true;
      if (scenario === "absent") mocks.rows = [];
      render(<TraeInstallationActions />);
      const button = screen.getByRole("button", { name: "打开 TRAE" });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(mocks.launch).not.toHaveBeenCalled();
    },
  );
  it("does not change cached paths when the picker is cancelled", async () => {
    render(<TraeInstallationActions />);
    fireEvent.click(screen.getByRole("button", { name: "选择 TRAE 路径" }));
    await waitFor(() => expect(mocks.pick).toHaveBeenCalledWith("trae"));
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("invalidates cache after a selected path, even if the guide closed meanwhile", async () => {
    let resolve!: (path: string) => void;
    mocks.pick.mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const view = render(<TraeInstallationActions />);
    fireEvent.click(screen.getByRole("button", { name: "选择 TRAE 路径" }));
    view.unmount();
    await act(async () => {
      resolve("/synthetic/Trae.app");
    });
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("clears only the chosen path and refreshes detection", async () => {
    mocks.rows = [{ ...installed(), custom_path: "/synthetic/Trae.app" }];
    render(<TraeInstallationActions />);
    fireEvent.click(screen.getByRole("button", { name: "清除 TRAE 自选路径" }));
    await waitFor(() =>
      expect(mocks.refresh).toHaveBeenCalledWith({ throwOnError: true }),
    );
    expect(mocks.clear).toHaveBeenCalledWith("trae");
    expect(mocks.invalidate).toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("only observes installation after download and never auto-launches or configures", async () => {
    mocks.rows = [];
    mocks.observe.mockResolvedValue({ status: "detected", tool: installed() });
    render(<TraeInstallationActions />);
    fireEvent.click(screen.getByRole("button", { name: "下载并检测 TRAE" }));
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "已检测到 TRAE，请打开后登录官方账号并完成模型配置。",
      ),
    );
    expect(mocks.observe).toHaveBeenCalledWith(
      "trae",
      "trae",
      "https://www.trae.ai/download",
    );
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "timeout"])(
    "does not imply installation success after %s",
    async (status) => {
      mocks.rows = [];
      mocks.observe.mockResolvedValue({ status });
      render(<TraeInstallationActions />);
      fireEvent.click(screen.getByRole("button", { name: "下载并检测 TRAE" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "下载并检测 TRAE" }),
        ).toBeEnabled(),
      );
      expect(mocks.success).not.toHaveBeenCalled();
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(mocks.launch).not.toHaveBeenCalled();
      if (status === "timeout") expect(mocks.info).toHaveBeenCalled();
    },
  );
  it("does not echo sensitive native launch errors and blocks double clicks", async () => {
    let reject!: (reason: Error) => void;
    mocks.launch.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    render(<TraeInstallationActions />);
    const button = screen.getByRole("button", { name: "打开 TRAE" });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {
      reject(new Error("secret and personal path"));
    });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      "TRAE 操作未完成，请确认官方安装与应用路径后重试。",
    );
  });
});
