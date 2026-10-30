import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccioReleaseNotice } from "@/components/desktop/AccioReleaseNotice";
import { yuanhengApi } from "@/lib/api/yuanheng";
import { accioConfigurationBlocked } from "@/lib/api/yuanheng";
import type { YuanhengToolStatus } from "@/lib/api/yuanheng";

const clients: QueryClient[] = [];
afterEach(() => {
  clients.forEach((c) => c.clear());
  clients.length = 0;
  vi.restoreAllMocks();
});
function mount(children = <AccioReleaseNotice />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}
describe("Accio release readiness", () => {
  it("shares a background query between two surfaces", async () => {
    const spy = vi
      .spyOn(yuanhengApi, "getAccioReleaseStatus")
      .mockResolvedValue({
        latestVersion: "0.38.0",
        latestVerified: false,
        checkedAt: 1,
        stale: false,
        error: null,
      });
    mount(
      <>
        <AccioReleaseNotice />
        <AccioReleaseNotice />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByText(/官方已有尚未验证/)).toHaveLength(2),
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("labels stale values instead of claiming latest or compatible", async () => {
    vi.spyOn(yuanhengApi, "getAccioReleaseStatus").mockResolvedValue({
      latestVersion: "0.37.1",
      latestVerified: true,
      checkedAt: 1,
      stale: true,
      error: "private backend detail",
    });
    mount();
    await screen.findByText(/信息已过期/);
    expect(screen.getByText(/查询失败/)).toBeVisible();
    expect(screen.queryByText(/private backend/)).not.toBeInTheDocument();
    expect(screen.queryByText(/官方发布版本/)).not.toBeInTheDocument();
  });
  it("fails safely when the command is unavailable", async () => {
    vi.spyOn(yuanhengApi, "getAccioReleaseStatus").mockRejectedValue(
      new Error("private"),
    );
    mount();
    expect(await screen.findByText(/不影响本机兼容检查/)).toBeVisible();
  });
  it("only blocks local Accio incompatibility, not a newer remote release or other tools", () => {
    const s = {
      app: "accio-work",
      accioCompatibility: {
        installedVersion: "0.37.1",
        supportedVersions: ["0.37.1"],
        state: "verified_version",
      },
    } as YuanhengToolStatus;
    expect(accioConfigurationBlocked(s)).toBe(false);
    for (const state of ["unverified_version", "unavailable"] as const)
      expect(
        accioConfigurationBlocked({
          ...s,
          accioCompatibility: { ...s.accioCompatibility!, state },
        }),
      ).toBe(true);
    expect(accioConfigurationBlocked({ ...s, app: "codex" })).toBe(false);
    expect(accioConfigurationBlocked(undefined)).toBe(false);
  });
});
