import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { yuanhengApi } from "@/lib/api";
import { useClaudeDesktopMode } from "@/components/desktop/useClaudeDesktopMode";
import { createTestQueryClient } from "../utils/testQueryClient";
import {
  clearRestartRequired,
  getRestartRequiredApps,
} from "@/components/desktop/desktopRestartState";
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={createTestQueryClient()}>
      {children}
    </QueryClientProvider>
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  clearRestartRequired("claude-desktop");
});
describe("Claude mode controller", () => {
  it("opens first relay setup without falsely claiming a mode switch", async () => {
    vi.spyOn(yuanhengApi, "getClaudeDesktopAccountMode").mockResolvedValue({
      mode: "official",
      yuanhengAvailable: false,
      restartRequired: false,
    });
    const change = vi.spyOn(yuanhengApi, "switchClaudeDesktopAccountMode");
    const { result } = renderHook(() => useClaudeDesktopMode(), { wrapper });
    await waitFor(() => expect(result.current.data?.mode).toBe("official"));
    await act(async () => {
      await result.current.switchMode("yuanheng");
    });
    expect(result.current.setupRequested).toBe(true);
    expect(result.current.data?.mode).toBe("official");
    expect(change).not.toHaveBeenCalled();
  });
  it("marks a successful saved mode switch for restart", async () => {
    vi.spyOn(yuanhengApi, "getClaudeDesktopAccountMode").mockResolvedValue({
      mode: "yuanheng",
      yuanhengAvailable: true,
      restartRequired: false,
    });
    const change = vi
      .spyOn(yuanhengApi, "switchClaudeDesktopAccountMode")
      .mockResolvedValue({
        mode: "official",
        yuanhengAvailable: true,
        restartRequired: true,
      });
    const { result } = renderHook(() => useClaudeDesktopMode(), { wrapper });
    await waitFor(() => expect(result.current.data?.mode).toBe("yuanheng"));
    await act(async () => {
      await result.current.switchMode("official");
    });
    expect(change).toHaveBeenCalledWith("official", "yuanheng");
    expect(getRestartRequiredApps().has("claude-desktop")).toBe(true);
  });
});
