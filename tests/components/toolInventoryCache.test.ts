import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearToolInventoryCache,
  readToolInventoryCache,
  TOOL_INVENTORY_CACHE_TTL_MS,
  writeToolInventoryCache,
} from "@/components/desktop/toolInventoryCache";

const inventory = [
  {
    name: "codex",
    version: "1.0.0",
    latest_version: null,
    error: null,
    installed_but_broken: false,
    env_type: "macos" as const,
    wsl_distro: null,
    install_path: "/Applications/Codex.app",
    detection_source: "automatic" as const,
    custom_path: null,
    custom_path_valid: true,
  },
];

describe("toolInventoryCache", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("does not reuse a pre-desktop DSH inventory after upgrade", () => {
    window.localStorage.setItem(
      "yuanheng.desktop.tool-inventory.v1",
      JSON.stringify({
        savedAt: Date.now(),
        targets: ["dsh"],
        data: [{ ...inventory[0], name: "dsh", detection_source: "managed" }],
      }),
    );
    expect(readToolInventoryCache(["dsh"])).toBeUndefined();
  });

  it("reuses a fresh cache only for the same target set", () => {
    writeToolInventoryCache(["codex"], inventory);

    expect(readToolInventoryCache(["codex"])?.data).toEqual(inventory);
    expect(readToolInventoryCache(["claude"])).toBeUndefined();
  });

  it("retains stale inventory for display while live detection refreshes it", () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    writeToolInventoryCache(["codex"], inventory);
    nowSpy.mockReturnValue(now + TOOL_INVENTORY_CACHE_TTL_MS + 1);

    expect(readToolInventoryCache(["codex"])?.data).toEqual(inventory);
    clearToolInventoryCache();
    expect(window.localStorage.length).toBe(0);
  });

  it("rejects corrupt rows and future timestamps instead of crashing the workspace", () => {
    writeToolInventoryCache(["codex"], inventory);
    const key = window.localStorage.key(0)!;
    const original = JSON.parse(window.localStorage.getItem(key)!);
    for (const patch of [
      { data: [null] },
      { data: [{ version: 123 }] },
      { targets: [null] },
      { savedAt: Date.now() + 60_000 },
      { savedAt: Date.now() - 8 * 24 * 60 * 60_000 },
    ]) {
      window.localStorage.setItem(
        key,
        JSON.stringify({ ...original, ...patch }),
      );
      expect(readToolInventoryCache(["codex"])).toBeUndefined();
    }
  });

  it("does not persist raw probe output or unexpected credential fields", () => {
    writeToolInventoryCache(
      ["codex"],
      [
        {
          ...inventory[0],
          error: "Bearer sk-secret-account-token",
          apiKey: "must-not-persist",
        } as any,
      ],
    );
    const cached = window.localStorage.getItem(window.localStorage.key(0)!)!;
    expect(cached).not.toContain("sk-secret");
    expect(cached).not.toContain("must-not-persist");
  });
});
