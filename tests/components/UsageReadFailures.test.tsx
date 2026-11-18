import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageHero } from "@/components/usage/UsageHero";
import { UsageTrendChart } from "@/components/usage/UsageTrendChart";
import { ProviderStatsTable } from "@/components/usage/ProviderStatsTable";
import { ModelStatsTable } from "@/components/usage/ModelStatsTable";
import { RequestLogTable } from "@/components/usage/RequestLogTable";

const { result } = vi.hoisted(() => ({
  result: {
    data: undefined as any,
    isLoading: false,
    isError: true,
    isFetching: false,
    dataUpdatedAt: 1789171200000,
    refetch: vi.fn(),
  },
}));
vi.mock("@/lib/query/usage", () => ({
  useUsageSummaryByApp: () => result,
  useUsageTrends: () => result,
  useProviderStats: () => result,
  useModelStats: () => result,
  useRequestLogs: () => result,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, p?: any) => (p?.time ? `${k} ${p.time}` : k),
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));
vi.mock("framer-motion", () => ({
  motion: { div: ({ children }: any) => <div>{children}</div> },
}));
const props = {
  range: { preset: "1d" as const },
  rangeLabel: "24h",
  refreshIntervalMs: 0,
};
describe("local read failures", () => {
  beforeEach(() => {
    result.data = undefined;
    result.isError = true;
    result.refetch.mockClear();
  });
  it.each([
    UsageHero,
    UsageTrendChart,
    ProviderStatsTable,
    ModelStatsTable,
    RequestLogTable,
  ])(
    "a failed first read is not shown as zero or an empty table: %s",
    (Component) => {
      render(<Component {...props} />);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "usage.localStatus.failed",
      );
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByText("usage.noData")).not.toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "usage.localStatus.retry" }),
      );
      expect(result.refetch).toHaveBeenCalledOnce();
    },
  );
  it("keeps previously loaded provider rows on refresh failure", () => {
    result.data = [
      {
        providerId: "p",
        providerName: "last-real-provider",
        appType: "codex",
        requestCount: 12,
        totalTokens: 1234,
        totalCost: null,
        successRate: 1,
        avgLatencyMs: 20,
      },
    ];
    render(<ProviderStatsTable {...props} />);
    expect(screen.getByText("last-real-provider")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "usage.localStatus.stale",
    );
    expect(screen.getByRole("status")).toHaveTextContent("2026");
  });
  it("an actual empty result remains an empty result", () => {
    result.data = [];
    result.isError = false;
    render(<ModelStatsTable {...props} />);
    expect(screen.getByText("usage.noData")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
