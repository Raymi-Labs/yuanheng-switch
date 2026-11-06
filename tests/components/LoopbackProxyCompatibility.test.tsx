import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { LoopbackProxyCompatibility } from "@/components/desktop/LoopbackProxyCompatibility";
const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), invoke: vi.fn() }));
vi.mock("@/lib/api", () => ({
  yuanhengApi: {
    getLoopbackProxyCompatibility: api.get,
    setLoopbackProxyCompatibility: api.set,
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
const status = {
  supported: true,
  installed: false,
  loginEnvironmentProtected: false,
  desktopProcesses: 1,
  backendProcesses: 1,
  protectedProcesses: 0,
  unverifiedProcesses: 2,
};
beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(status);
  api.set.mockResolvedValue({
    ...status,
    installed: true,
    loginEnvironmentProtected: true,
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
it("checks on demand, preserves explicit repair and restart boundaries", async () => {
  render(<LoopbackProxyCompatibility />);
  expect(api.get).not.toHaveBeenCalled();
  expect(api.set).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "检查兼容状态" }));
  await screen.findByRole("button", { name: "启用兼容修复" });
  fireEvent.click(screen.getByRole("button", { name: "启用兼容修复" }));
  await waitFor(() => expect(api.set).toHaveBeenCalledWith(true));
  expect(api.invoke).not.toHaveBeenCalled();
  await screen.findByRole("button", { name: "撤销兼容修复" });
  expect(screen.getByText(/后端未启动时无法验证/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重启 Codex 并复验" }));
  await waitFor(() =>
    expect(api.invoke).toHaveBeenCalledWith("launch_tool", {
      tool: "chatgpt-desktop",
      restart: true,
    }),
  );
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
});
it("canceling does not change the login environment or stop a tool", async () => {
  vi.mocked(window.confirm).mockReturnValue(false);
  render(<LoopbackProxyCompatibility />);
  fireEvent.click(screen.getByRole("button", { name: "检查兼容状态" }));
  fireEvent.click(await screen.findByRole("button", { name: "启用兼容修复" }));
  fireEvent.click(screen.getByRole("button", { name: "重启 Codex 并复验" }));
  expect(api.set).not.toHaveBeenCalled();
  expect(api.invoke).not.toHaveBeenCalled();
});
it("revokes only through the explicit action", async () => {
  api.get.mockResolvedValue({ ...status, installed: true });
  render(<LoopbackProxyCompatibility />);
  fireEvent.click(screen.getByRole("button", { name: "检查兼容状态" }));
  fireEvent.click(await screen.findByRole("button", { name: "撤销兼容修复" }));
  await waitFor(() => expect(api.set).toHaveBeenCalledWith(false));
});
it("does not offer login mutation on other platforms", async () => {
  api.get.mockResolvedValue({ ...status, supported: false });
  render(<LoopbackProxyCompatibility />);
  fireEvent.click(screen.getByRole("button", { name: "检查兼容状态" }));
  await screen.findByText(/用户登录环境修复仅适用于 macOS/);
  expect(
    screen.queryByRole("button", { name: "启用兼容修复" }),
  ).not.toBeInTheDocument();
});
