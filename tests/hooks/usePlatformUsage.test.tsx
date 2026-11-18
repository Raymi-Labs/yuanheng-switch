import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlatformUsage } from "@/lib/query/platformUsage";
const { account, invoke } = vi.hoisted(() => ({
  account: {
    data: {
      userId: "one",
      connected: true,
      baseUrl: "https://example.test",
      lastSyncedAt: 1,
    },
    isError: false,
  },
  invoke: vi.fn(),
}));
vi.mock("@/lib/query/yuanheng", () => ({
  useYuanhengConnection: () => account,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const clients: QueryClient[] = [];
const mount = (range: any = { preset: "1d" }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => usePlatformUsage(range, 0), { wrapper });
};
describe("account settlement cache", () => {
  beforeEach(() => {
    account.data = {
      userId: "one",
      connected: true,
      baseUrl: "https://example.test",
      lastSyncedAt: 1,
    };
    account.isError = false;
    invoke.mockReset();
    invoke.mockResolvedValue({
      accountId: "one",
      amount: "18",
      requests: 2,
      tokens: 3,
    });
  });
  afterEach(() => {
    for (const c of clients.splice(0)) c.clear();
  });
  it("passes only period and current identity to the native command", async () => {
    const view = mount();
    await waitFor(() => expect(view.result.current.data?.amount).toBe("18"));
    expect(invoke).toHaveBeenCalledWith("get_yuanheng_platform_usage", {
      startDate: expect.any(Number),
      endDate: expect.any(Number),
      expectedUserId: "one",
    });
    view.unmount();
  });
  it.each(["logout", "switch", "origin"])(
    "does not show previous account totals on %s",
    async (change) => {
      const view = mount();
      await waitFor(() => expect(view.result.current.data).toBeDefined());
      invoke.mockImplementation(() => new Promise(() => {}));
      if (change === "logout") account.data.connected = false;
      if (change === "switch") account.data.userId = "two";
      if (change === "origin") account.data.baseUrl = "https://other.test";
      view.rerender();
      expect(view.result.current.data).toBeUndefined();
      view.unmount();
    },
  );
  it("retains last successful data as stale after a transient refresh failure", async () => {
    const view = mount();
    await waitFor(() => expect(view.result.current.data).toBeDefined());
    invoke.mockRejectedValue("platform_usage_unavailable");
    await act(async () => {
      await view.result.current.refetch();
    });
    await waitFor(() =>
      expect(view.result.current.errorCode).toBe("unavailable"),
    );
    expect(view.result.current.data?.amount).toBe("18");
    expect(view.result.current.stale).toBe(true);
    expect(view.result.current.errorCode).toBe("unavailable");
    view.unmount();
  });
  it("rejects responses for another account", async () => {
    invoke.mockResolvedValue({ accountId: "two", amount: "999" });
    const view = mount();
    await waitFor(() => expect(view.result.current.errorCode).toBe("login"));
    expect(view.result.current.data).toBeUndefined();
    invoke.mockRejectedValue("platform_usage_unavailable");
    await act(async () => {
      await view.result.current.refetch();
    });
    await waitFor(() =>
      expect(view.result.current.errorCode).toBe("unavailable"),
    );
    expect(view.result.current.data).toBeUndefined();
    view.unmount();
  });
  it("keeps the last real total with a stale marker when offline", async () => {
    const view = mount();
    await waitFor(() => expect(view.result.current.data).toBeDefined());
    try {
      onlineManager.setOnline(false);
      invoke.mockRejectedValue("platform_usage_unavailable");
      act(() => {
        void view.result.current.refetch();
      });
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(view.result.current.errorCode).toBe("unavailable"),
      );
      expect(view.result.current.data?.amount).toBe("18");
      expect(view.result.current.stale).toBe(true);
    } finally {
      view.unmount();
      onlineManager.setOnline(true);
    }
  });
  it("preserves a successful total when the same account refreshes metadata", async () => {
    const view = mount();
    await waitFor(() => expect(view.result.current.data).toBeDefined());
    invoke.mockImplementation(() => new Promise(() => {}));
    account.data.lastSyncedAt++;
    view.rerender();
    expect(view.result.current.data?.amount).toBe("18");
    view.unmount();
  });
  it("hides cached totals when credentials are rejected", async () => {
    const view = mount();
    await waitFor(() => expect(view.result.current.data).toBeDefined());
    const otherRange = [
      "yuanheng",
      "platform-usage",
      "https://example.test",
      "one",
      null,
      { preset: "7d" },
    ];
    const otherUser = [
      "yuanheng",
      "platform-usage",
      "https://example.test",
      "two",
      null,
      { preset: "1d" },
    ];
    clients[0].setQueryData(otherRange, { accountId: "one", amount: "81" });
    clients[0].setQueryData(otherUser, { accountId: "two", amount: "92" });
    invoke.mockRejectedValue("platform_usage_login");
    await act(async () => {
      await view.result.current.refetch();
    });
    await waitFor(() => expect(view.result.current.errorCode).toBe("login"));
    expect(view.result.current.data).toBeUndefined();
    expect(clients[0].getQueryData(otherRange)).toBeNull();
    expect(clients[0].getQueryData(otherUser)).toEqual({
      accountId: "two",
      amount: "92",
    });
    invoke.mockRejectedValue("platform_usage_unavailable");
    await act(async () => {
      await view.result.current.refetch();
    });
    await waitFor(() =>
      expect(view.result.current.errorCode).toBe("unavailable"),
    );
    expect(view.result.current.data).toBeUndefined();
    view.unmount();
  });
  it("does not request a truncated range over 30 days", () => {
    const view = mount({
      preset: "custom",
      customStartDate: 100,
      customEndDate: 101 + 30 * 86400,
    });
    expect(view.result.current.errorCode).toBe("range");
    expect(invoke).not.toHaveBeenCalled();
    view.unmount();
  });
});
