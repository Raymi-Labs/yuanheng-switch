import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageCostSummary } from "@/components/usage/UsageCostSummary";
import settlement from "../fixtures/platform-usage-settlement.json";
const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/query/platformUsage", () => ({
  usePlatformUsage: (...args: unknown[]) => query(...args),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));
vi.mock("@/components/usage/UsageDateRangePicker", () => ({
  UsageDateRangePicker: ({ onApply }: any) => (
    <button
      onClick={() =>
        onApply({ preset: "custom", customStartDate: 100, customEndDate: 200 })
      }
    >
      custom-date
    </button>
  ),
}));
const data = {
  accountId: "one",
  amount: "12.34",
  symbol: "⚡",
  requests: 3545,
  tokens: 18000000,
  periodStart: 1789084800,
  periodEnd: 1789171200,
  fetchedAt: 1789171200,
};
const props = () => ({
  range: { preset: "1d" as const },
  rangeLabel: "24 hours",
  refreshIntervalMs: 0,
  onRangeChange: vi.fn(),
});
describe("platform period summary", () => {
  beforeEach(() =>
    query.mockReset().mockReturnValue({
      data,
      isLoading: false,
      errorCode: null,
      canRefresh: true,
      refetch: vi.fn(),
    }),
  );
  it.each(settlement.cases)(
    "shows the verified settlement contract: $name",
    (item) => {
      query.mockReturnValue({
        data: {
          accountId: settlement.accountId,
          amount: item.amount,
          symbol: settlement.status.data.custom_currency_symbol,
          requests: item.response.summary.requests,
          tokens: item.response.summary.tokens,
          periodStart: item.response.summary.start_timestamp,
          periodEnd: item.response.summary.end_timestamp,
          fetchedAt: item.response.summary.end_timestamp,
        },
        errorCode: null,
      });
      render(<UsageCostSummary {...props()} />);
      expect(screen.getByText(item.display)).toBeInTheDocument();
      expect(
        screen.getByText("usage.platformSummary.charged"),
      ).toBeInTheDocument();
    },
  );
  it("does not present a local quote as platform settlement", () => {
    render(<UsageCostSummary {...props()} />);
    expect(screen.queryByText(/^≈/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "usage.platformSummary.title" }),
    ).toBeInTheDocument();
    expect(screen.getByText("⚡12.34")).toBeInTheDocument();
    expect(screen.getByText("3,545")).toBeInTheDocument();
    expect(screen.getByText("18,000,000")).toBeInTheDocument();
    expect(query).toHaveBeenCalledWith({ preset: "1d" }, 0);
    expect(screen.queryByText(/unpriced|estimate/)).not.toBeInTheDocument();
  });
  it("keeps period selection and explicit refresh", () => {
    const p = props();
    render(<UsageCostSummary {...p} />);
    fireEvent.click(
      screen.getByRole("button", { name: "usage.periodSummary.7d" }),
    );
    expect(p.onRangeChange).toHaveBeenCalledWith({ preset: "7d" });
    fireEvent.click(screen.getByText("custom-date"));
    expect(p.onRangeChange).toHaveBeenCalledWith({
      preset: "custom",
      customStartDate: 100,
      customEndDate: 200,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "usage.platformSummary.refresh" }),
    );
    expect(query.mock.results[0].value.refetch).toHaveBeenCalledOnce();
  });
  it("retains real counts when the amount or currency is unavailable", () => {
    query.mockReturnValue({
      data: { ...data, amount: null, symbol: null },
      partial: true,
      errorCode: null,
    });
    render(<UsageCostSummary {...props()} />);
    expect(screen.getByText("3,545")).toBeInTheDocument();
    expect(screen.getByText("18,000,000")).toBeInTheDocument();
    expect(
      screen.getByText("usage.platformSummary.notSynced"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "usage.platformSummary.partial",
    );
    expect(screen.queryByText("⚡0.00")).not.toBeInTheDocument();
  });
  it("keeps last successful numbers with an explicit stale status", () => {
    query.mockReturnValue({ data, stale: true, errorCode: "unavailable" });
    render(<UsageCostSummary {...props()} />);
    expect(screen.getByText("⚡12.34")).toBeInTheDocument();
    expect(screen.getByText("3,545")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "usage.platformSummary.stale",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it.each(["unavailable", "login", "invalid", "range"])(
    "does not display a fabricated zero when %s",
    (errorCode) => {
      query.mockReturnValue({
        data: undefined,
        errorCode,
        isLoading: false,
        canRefresh: false,
      });
      render(<UsageCostSummary {...props()} />);
      expect(screen.getByRole("alert")).toHaveTextContent(
        `usage.platformSummary.${errorCode}`,
      );
      expect(screen.queryByText(/⚡/)).not.toBeInTheDocument();
      expect(
        screen.getByText("usage.platformSummary.notSynced"),
      ).toBeInTheDocument();
    },
  );
  it.each([
    ["0", "⚡0.00"],
    ["-7", "⚡-7.00"],
    ["1.005", "⚡1.005"],
    ["-1.005", "⚡-1.005"],
    ["0.00001", "⚡0.00001"],
    ["-0.00001", "⚡-0.00001"],
    ["123456789012345678.123456789", "⚡123,456,789,012,345,678.123456789"],
    ["0.0000000000000000000000000001", "⚡0.0000000000000000000000000001"],
  ])(
    "preserves settlement precision and net refunds: %s",
    (amount, expected) => {
      query.mockReturnValue({ data: { ...data, amount }, errorCode: null });
      render(<UsageCostSummary {...props()} />);
      expect(screen.getByText(expected)).toBeInTheDocument();
    },
  );
  it("does not format quota units as currency", () => {
    query.mockReturnValue({
      data: { ...data, amount: "9223372036854775807", symbol: "" },
      errorCode: null,
    });
    render(<UsageCostSummary {...props()} />);
    expect(screen.getByText("9,223,372,036,854,775,807")).toBeInTheDocument();
  });
});
