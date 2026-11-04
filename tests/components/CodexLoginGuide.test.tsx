import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexLoginGuide } from "@/components/desktop/CodexLoginGuide";
import { yuanhengApi } from "@/lib/api/yuanheng";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  copy: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copy }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));

const guide = { apiKey: "sk-synthetic-desktop", group: "premium" };
const success = [{ app: "chatgpt-desktop", configured: true, warnings: [] }];
const configure = () => yuanhengApi.configureTools(["chatgpt-desktop"]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.copy.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "configure_yuanheng_tools" ? success : guide,
  );
});

describe("Codex first login guide", () => {
  it("shows the configured token, copies on click, and continues after closing", async () => {
    render(<CodexLoginGuide userId="42" />);
    let completed = false;
    const operation = configure().then(() => {
      completed = true;
    });
    expect(await screen.findByText(guide.apiKey)).toBeInTheDocument();
    expect(screen.getByText(/Sign in with an API key/)).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("get_codex_login_guide", {
      userId: "42",
    });
    expect(completed).toBe(false);
    expect(mocks.copy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "复制令牌" }));
    expect(mocks.copy).toHaveBeenCalledWith(guide.apiKey);
    await userEvent.click(screen.getByRole("button", { name: "已复制，继续" }));
    await operation;
    expect(screen.queryByText(guide.apiKey)).not.toBeInTheDocument();
    expect(JSON.stringify(localStorage)).not.toContain(guide.apiKey);
  });

  it.each([
    [{ app: "chatgpt-desktop", configured: false }],
    [{ app: "codex", configured: true }],
  ])("skips failed and terminal-only configurations", async (...results) => {
    render(<CodexLoginGuide userId="42" />);
    mocks.invoke.mockResolvedValue(results);
    await configure();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not show the guide when native detection finds an existing login", async () => {
    render(<CodexLoginGuide userId="42" />);
    mocks.invoke.mockResolvedValueOnce(success).mockResolvedValueOnce(null);
    await configure();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps configuration successful and hides raw errors if guide loading fails", async () => {
    render(<CodexLoginGuide userId="42" />);
    mocks.invoke
      .mockResolvedValueOnce(success)
      .mockRejectedValueOnce(new Error(guide.apiKey));
    await expect(configure()).resolves.toEqual(success);
    expect(mocks.error).toHaveBeenCalledWith(
      "配置已保存，登录指引读取失败，请重新应用配置查看。",
    );
  });

  it("keeps the token selectable when copying fails", async () => {
    render(<CodexLoginGuide userId="42" />);
    const operation = configure();
    mocks.copy.mockRejectedValueOnce(new Error(guide.apiKey));
    await userEvent.click(
      await screen.findByRole("button", { name: "复制令牌" }),
    );
    expect(mocks.error).toHaveBeenCalledWith("复制失败，请手动选中复制。");
    expect(screen.getByText(guide.apiKey)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "稍后登录" }));
    await operation;
  });

  it("discards a late credential response after switching accounts", async () => {
    let resolve!: (value: typeof guide) => void;
    const response = new Promise<typeof guide>((done) => {
      resolve = done;
    });
    mocks.invoke.mockResolvedValueOnce(success).mockReturnValueOnce(response);
    const view = render(<CodexLoginGuide key="42" userId="42" />);
    const operation = configure();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    view.rerender(<CodexLoginGuide key="43" userId="43" />);
    await act(async () => {
      resolve(guide);
      await operation;
    });
    expect(screen.queryByText(guide.apiKey)).not.toBeInTheDocument();
  });

  it("does not read a new account's credentials for a late configuration", async () => {
    let resolve!: (value: typeof success) => void;
    mocks.invoke.mockReturnValueOnce(
      new Promise<typeof success>((done) => {
        resolve = done;
      }),
    );
    const view = render(<CodexLoginGuide key="42" userId="42" />);
    const operation = configure();
    view.rerender(<CodexLoginGuide key="43" userId="43" />);
    await act(async () => {
      resolve(success);
      await operation;
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("clears an open guide on logout and releases the waiting flow", async () => {
    const view = render(<CodexLoginGuide userId="42" />);
    const operation = configure();
    await screen.findByText(guide.apiKey);
    view.unmount();
    await operation;
    expect(screen.queryByText(guide.apiKey)).not.toBeInTheDocument();
  });
});
