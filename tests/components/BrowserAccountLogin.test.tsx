import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserAccountLogin } from "@/components/desktop/BrowserAccountLogin";
const api = vi.hoisted(() => ({
  providers: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/lib/api/browser-login", () => ({ browserLoginApi: api }));
const renderLogin = (fn = vi.fn()) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    fn,
    ...render(
      <QueryClientProvider client={client}>
        <BrowserAccountLogin onConnected={fn} />
      </QueryClientProvider>,
    ),
  };
};
const start = async () => {
  fireEvent.click(screen.getByRole("button", { name: "通过 GitHub 登录" }));
  await act(async () => {});
};
describe("browser account login", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    api.providers.mockResolvedValue(["github", "google"]);
    api.start.mockResolvedValue({
      attemptId: "attempt",
      displayCode: "abcd1234",
      expiresIn: 300,
    });
    api.poll.mockResolvedValue({ status: "pending", connection: null });
    api.cancel.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("shows code, polls every three seconds and completes only on authenticated response", async () => {
    const { fn } = renderLogin();
    await start();
    expect(screen.getByText("abcd1234")).toBeVisible();
    expect(api.poll).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(api.poll).toHaveBeenCalledTimes(1);
    api.poll.mockResolvedValue({
      status: "complete",
      connection: { connected: true },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fn).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(api.poll).toHaveBeenCalledTimes(2);
  });
  it("server not deployed or provider disabled never starts authorization", async () => {
    api.providers.mockResolvedValue([]);
    renderLogin();
    await start();
    expect(api.start).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeVisible();
  });
  it("cancel discards delayed poll result without login", async () => {
    let finish!: (x: any) => void;
    api.poll.mockReturnValue(new Promise((r) => (finish = r)));
    const { fn } = renderLogin();
    await start();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    fireEvent.click(screen.getByRole("button", { name: "取消浏览器登录" }));
    await act(async () => {
      finish({ status: "complete", connection: { connected: true } });
    });
    expect(fn).not.toHaveBeenCalled();
    expect(api.cancel).toHaveBeenCalledWith("attempt");
  });
  it("unmount cancels native attempt and clears polling", async () => {
    const { unmount } = renderLogin();
    await start();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(api.cancel).toHaveBeenCalledWith("attempt");
    expect(api.poll).not.toHaveBeenCalled();
  });
  it("rapid clicks are single flight, expiry stops waiting", async () => {
    api.start.mockResolvedValue({
      attemptId: "attempt",
      displayCode: "abcd1234",
      expiresIn: 3,
    });
    renderLogin();
    const b = screen.getByRole("button", { name: "通过 GitHub 登录" });
    fireEvent.click(b);
    fireEvent.click(b);
    await act(async () => {});
    expect(api.start).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(api.poll).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("过期");
  });
});
