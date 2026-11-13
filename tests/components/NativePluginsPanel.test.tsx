import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativePluginsPanel } from "@/components/desktop/NativePluginsPanel";
const mock = vi.hoisted(() => ({
  status: vi.fn(),
  plan: vi.fn(),
  install: vi.fn(),
  action: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@/lib/api/native-plugins", () => ({ nativePluginsApi: mock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mock.open }));
vi.mock("@/components/desktop/desktopI18n", () => ({
  dt: (s: string, v?: Record<string, unknown>) =>
    s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(v?.[k] ?? "")),
}));
const row = {
  id: "digest",
  name: "test-plugin",
  description: "Synthetic",
  version: "1.0.0",
  installed: true,
  enabled: true,
  pending: false,
  changed: false,
};
const status = { targetId: "target-a", engine: "desktop", plugins: [] };
const plan = {
  token: "one-use",
  targetId: "target-a",
  info: {
    name: "test-plugin",
    version: "1.0.0",
    license: "MIT",
    fileCount: 2,
    bytes: 200,
    skills: 1,
    hasMcp: true,
    hasApps: true,
    hasHooks: true,
    executableFiles: 1,
    connections: ["https://example.com"],
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mock.status.mockResolvedValue(status);
  mock.plan.mockResolvedValue(plan);
  mock.install.mockResolvedValue(undefined);
  mock.action.mockResolvedValue({
    installed: true,
    enabled: true,
    discoveredSkills: 1,
    declaredMcp: 1,
    declaredApps: 1,
    executionVerified: false,
  });
  mock.open.mockResolvedValue("/synthetic/plugin");
});
async function connect() {
  fireEvent.click(screen.getByRole("button", { name: "连接原生引擎" }));
  await screen.findByRole("button", { name: "刷新插件" });
}
describe("native plugin management", () => {
  it("never starts native programs merely by opening capability center", () => {
    render(<NativePluginsPanel tool="chatgpt-desktop" />);
    expect(mock.status).not.toHaveBeenCalled();
    expect(mock.install).not.toHaveBeenCalled();
  });
  it("requires review of connections and executable effects before a single-use install", async () => {
    render(<NativePluginsPanel tool="chatgpt-desktop" />);
    await connect();
    fireEvent.click(screen.getByRole("button", { name: "导入插件" }));
    await screen.findByRole("dialog");
    expect(mock.plan).toHaveBeenCalledWith(
      "chatgpt-desktop",
      "target-a",
      "/synthetic/plugin",
      null,
    );
    expect(screen.getByText("https://example.com")).toBeVisible();
    expect(screen.getByText(/包含脚本或钩子/)).toBeVisible();
    expect(mock.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "安装此版本" }));
    await waitFor(() => expect(mock.install).toHaveBeenCalledTimes(1));
    expect(mock.install).toHaveBeenCalledWith(
      "chatgpt-desktop",
      "target-a",
      "one-use",
    );
    expect(await screen.findByText(/已安装。请在 Codex/)).toBeVisible();
  });
  it("does not install after cancelled review or folder selection", async () => {
    render(<NativePluginsPanel tool="codex" />);
    await connect();
    mock.open.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "导入插件" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "导入插件" })).toBeEnabled(),
    );
    expect(mock.plan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "检查 代码审查" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(mock.install).not.toHaveBeenCalled();
  });
  it("does not replay an unknown install result", async () => {
    render(<NativePluginsPanel tool="codex" />);
    await connect();
    fireEvent.click(screen.getByRole("button", { name: "检查 代码审查" }));
    await screen.findByRole("dialog");
    mock.install.mockRejectedValue(new Error("结果未知"));
    fireEvent.click(screen.getByRole("button", { name: "安装此版本" }));
    await screen.findByText("结果未知");
    expect(mock.install).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("separates loaded skills from tool execution and requires uninstall confirmation", async () => {
    mock.status.mockResolvedValue({ ...status, plugins: [row] });
    render(<NativePluginsPanel tool="codex" />);
    await connect();
    fireEvent.click(screen.getByRole("button", { name: "本机管理" }));
    fireEvent.click(screen.getByRole("button", { name: "检测 test-plugin" }));
    expect(await screen.findByText(/原生引擎发现 1 个技能/)).toBeVisible();
    expect(screen.getByText(/未执行模型或业务工具/)).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "卸载 test-plugin" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "卸载 test-plugin" }));
    expect(screen.getByText(/已授权的外部服务不会自动撤权/)).toBeVisible();
    expect(mock.action).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "确认卸载" }));
    await waitFor(() =>
      expect(mock.action).toHaveBeenCalledWith(
        "codex",
        "target-a",
        "digest",
        "remove",
      ),
    );
  });
  it("blocks changed or pending content from re-enabling", async () => {
    mock.status.mockResolvedValue({
      ...status,
      plugins: [{ ...row, pending: true, changed: true }],
    });
    render(<NativePluginsPanel tool="codex" />);
    await connect();
    fireEvent.click(screen.getByRole("button", { name: "本机管理" }));
    expect(
      screen.getByRole("button", { name: "切换 test-plugin" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "检测 test-plugin" }),
    ).toBeDisabled();
  });
  it("ignores old target responses after remount", async () => {
    let finish!: (s: unknown) => void;
    mock.status.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const view = render(
      <NativePluginsPanel key="desktop" tool="chatgpt-desktop" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "连接原生引擎" }));
    view.rerender(<NativePluginsPanel key="cli" tool="codex" />);
    await act(async () => finish({ ...status, plugins: [row] }));
    expect(screen.getByRole("button", { name: "连接原生引擎" })).toBeEnabled();
    expect(screen.queryByText("test-plugin")).not.toBeInTheDocument();
  });
});
