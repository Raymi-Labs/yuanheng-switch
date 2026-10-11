import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import type { YuanhengConnectionStatus } from "@/lib/api";
import { useInstallContinuation } from "@/components/desktop/useInstallContinuation";

const connection = (userId = "synthetic-one", connected = true) =>
  ({
    userId,
    connected,
    baseUrl: "https://example.invalid",
  }) as YuanhengConnectionStatus;

describe("post-install account boundary", () => {
  it("invalidates old intent on account change, including switching back", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useInstallContinuation(value),
      {
        initialProps: { value: connection() },
      },
    );
    const first = result.current();
    expect(first()).toBe(true);
    rerender({ value: connection("synthetic-two") });
    expect(first()).toBe(false);
    rerender({ value: connection() });
    expect(first()).toBe(false);
    expect(result.current()()).toBe(true);
  });
  it("does not continue after logout or unmount", () => {
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useInstallContinuation(value),
      {
        initialProps: { value: connection() },
      },
    );
    const pending = result.current();
    rerender({ value: connection("synthetic-one", false) });
    expect(pending()).toBe(false);
    const next = result.current();
    unmount();
    expect(next()).toBe(false);
  });
});
