import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImagegenToolStatus } from "@/lib/api/skills";
import type { YuanhengToolId } from "@/lib/api/yuanheng";
import { createTestQueryClient } from "../utils/testQueryClient";

const api = vi.hoisted(() => ({
  getStatus: vi.fn(),
  install: vi.fn(),
  setEnabled: vi.fn(),
  exportSkill: vi.fn(),
}));
const account = vi.hoisted(() => ({
  current: {
    connected: true,
    userId: "account-a",
    baseUrl: "https://example.test",
  },
}));
vi.mock("@/lib/api/skills", () => ({ imagegenApi: api }));
vi.mock("@/lib/query/yuanheng", () => ({
  useYuanhengConnection: () => ({ data: account.current }),
}));
import { imagegenKeys, useImagegen } from "@/hooks/useImagegen";
const status = (tool: YuanhengToolId): ImagegenToolStatus => ({
  tool,
  target: tool,
  supported: true,
  configured: true,
  enabled: true,
  ready: true,
  scope: "local-skill",
});
function setup(tool: YuanhengToolId) {
  const client = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    client,
    ...renderHook(({ tool }) => useImagegen(tool), {
      initialProps: { tool },
      wrapper,
    }),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  account.current = {
    connected: true,
    userId: "account-a",
    baseUrl: "https://example.test",
  };
  api.getStatus.mockImplementation(async (tool: YuanhengToolId) =>
    status(tool),
  );
});

describe("image capability cache boundaries", () => {
  it("does not retain a different tool's status when its new query fails", async () => {
    const view = setup("codex");
    await waitFor(() =>
      expect(view.result.current.query.data?.ready).toBe(true),
    );
    api.getStatus.mockRejectedValue(new Error("DSH query failed"));
    view.rerender({ tool: "dsh" });
    await waitFor(() => expect(view.result.current.query.isError).toBe(true));
    expect(view.result.current.query.data).toBeUndefined();
    view.unmount();
    view.client.clear();
  });
  it("does not reuse readiness after an account change", async () => {
    const view = setup("workbuddy");
    await waitFor(() =>
      expect(view.result.current.query.data?.ready).toBe(true),
    );
    api.getStatus.mockRejectedValue(new Error("New account has no route"));
    account.current = { ...account.current, userId: "account-b" };
    view.rerender({ tool: "workbuddy" });
    await waitFor(() => expect(view.result.current.query.isError).toBe(true));
    expect(view.result.current.query.data).toBeUndefined();
    view.unmount();
    view.client.clear();
  });
  it("a late installation result writes only to its original tool/account key", async () => {
    let finish!: (value: ImagegenToolStatus) => void;
    api.install.mockImplementation(
      () =>
        new Promise<ImagegenToolStatus>((done) => {
          finish = done;
        }),
    );
    const view = setup("dsh");
    await waitFor(() => expect(view.result.current.query.isSuccess).toBe(true));
    let pending!: Promise<ImagegenToolStatus>;
    act(() => {
      pending = view.result.current.install();
    });
    await waitFor(() => expect(api.install).toHaveBeenCalledWith("dsh"));
    account.current = { ...account.current, userId: "account-b" };
    view.rerender({ tool: "workbuddy" });
    await waitFor(() =>
      expect(view.result.current.query.data?.tool).toBe("workbuddy"),
    );
    await act(async () => {
      finish(status("dsh"));
      await pending;
    });
    expect(view.result.current.query.data?.tool).toBe("workbuddy");
    expect(
      view.client.getQueryData([
        ...imagegenKeys,
        "workbuddy",
        account.current.baseUrl,
        "account-b",
        true,
      ]),
    ).toMatchObject({ tool: "workbuddy" });
    view.unmount();
    view.client.clear();
  });
  it("rejects mismatched command responses instead of caching another tool", async () => {
    api.getStatus.mockResolvedValue(status("codex"));
    const view = setup("dsh");
    await waitFor(() => expect(view.result.current.query.isError).toBe(true));
    expect(view.result.current.query.data).toBeUndefined();
    view.unmount();
    view.client.clear();
  });
});
