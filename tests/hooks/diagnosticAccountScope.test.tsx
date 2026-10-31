import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  useYuanhengDiagnostics,
  useYuanhengToolStatuses,
  useYuanhengToolActivationStatuses,
  yuanhengKeys,
} from "@/lib/query/yuanheng";
import { createTestQueryClient } from "../utils/testQueryClient";

describe("account-scoped diagnostic and tool cache", () => {
  it.each([
    { userId: "two", connected: true, baseUrl: "https://example.test" },
    { userId: "one", connected: false, baseUrl: "https://example.test" },
    { userId: "one", connected: true, baseUrl: "https://other.test" },
  ])(
    "does not retain tool models across identity boundaries: %j",
    async (next) => {
      const client = createTestQueryClient();
      const connection = {
        baseUrl: "https://example.test",
        userId: "one",
        connected: true,
        lastSyncedAt: 1,
      };
      client.setQueryData(yuanhengKeys.connection, connection);
      client.setQueryData(
        [...yuanhengKeys.activation, connection.baseUrl, "one", true, 1],
        [{ app: "codex", lastModel: "old-account-model" }],
      );
      client.setQueryData(
        [...yuanhengKeys.diagnostics, connection.baseUrl, "one", true, 1],
        {
          status: "ok",
          snapshotId: "private-one",
        },
      );
      client.setQueryData(
        [...yuanhengKeys.tools, connection.baseUrl, "one", true],
        [{ app: "codex", model: "old-account-model" }],
      );
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const view = renderHook(
        () => ({
          report: useYuanhengDiagnostics(false),
          tools: useYuanhengToolStatuses(),
          activation: useYuanhengToolActivationStatuses(),
        }),
        { wrapper },
      );
      expect(view.result.current.report.data?.snapshotId).toBe("private-one");
      expect(view.result.current.tools.data?.[0].model).toBe(
        "old-account-model",
      );
      expect(view.result.current.activation.data?.[0].lastModel).toBe(
        "old-account-model",
      );
      await act(async () => {
        client.setQueryData(yuanhengKeys.connection, {
          ...connection,
          ...next,
          lastSyncedAt: 1,
        });
      });
      await waitFor(() =>
        expect(view.result.current.report.data).toBeUndefined(),
      );
      await waitFor(() =>
        expect(
          view.result.current.activation.data?.some(
            (row) => row.lastModel === "old-account-model",
          ) ?? false,
        ).toBe(false),
      );
      await waitFor(() =>
        expect(
          view.result.current.tools.data?.some(
            (row) => row.model === "old-account-model",
          ) ?? false,
        ).toBe(false),
      );
      view.unmount();
      client.clear();
    },
  );
});
