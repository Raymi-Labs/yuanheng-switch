import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformPricingPanel } from "@/components/usage/PlatformPricingPanel";

const state = vi.hoisted(() => ({
  data: {} as any,
  refresh: vi.fn(),
  group: vi.fn(),
}));
vi.mock("@/lib/query/platformPricing", () => ({
  usePlatformPricing: () => ({ data: state.data, isFetching: false }),
  useRefreshPlatformPricing: () => ({
    mutate: state.refresh,
    isPending: false,
  }),
  usePlatformQuoteGroup: () => ({ mutate: state.group, isPending: false }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("platform price catalog", () => {
  beforeEach(() => {
    state.refresh.mockReset();
    state.group.mockReset();
    state.data = {
      fetchedAt: 100,
      symbol: "⚡️",
      displayRate: "3",
      groups: { standard: "0.5", premium: "2" },
      selectedGroup: null,
      models: {
        "text-test": {
          model_name: "text-test",
          quota_type: 0,
          model_ratio: 2,
          completion_ratio: 5,
          enable_groups: ["standard"],
        },
        "dynamic-test": {
          model_name: "dynamic-test",
          quota_type: 0,
          billing_mode: "tiered_expr",
          billing_expr: 'len < 100 ? tier("a", p * 10) : tier("b", p * 20)',
          enable_groups: ["standard"],
        },
      },
    };
  });
  it("uses platform display conversion and eligible group ratios and supports search", () => {
    render(<PlatformPricingPanel catalog />);
    expect(screen.getByText(/⚡️6.*⚡️30/)).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("usage.platformPricing.search"), {
      target: { value: "dynamic" },
    });
    expect(screen.queryByText("text-test")).not.toBeInTheDocument();
    expect(screen.getByText("dynamic-test")).toBeInTheDocument();
    expect(
      screen.getByText("usage.platformPricing.rawRule"),
    ).toBeInTheDocument();
  });
  it("allows explicit sync/group selection and warns about cached prices", () => {
    state.data.stale = true;
    render(<PlatformPricingPanel catalog />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "usage.platformPricing.stale",
    );
    fireEvent.click(screen.getByText("usage.platformPricing.sync"));
    expect(state.refresh).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("usage.platformPricing.group"), {
      target: { value: "premium" },
    });
    expect(state.group).toHaveBeenCalledWith("premium", expect.any(Object));
  });
  it("does not offer a global group override on request usage", () => {
    render(<PlatformPricingPanel />);
    expect(
      screen.queryByLabelText("usage.platformPricing.group"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("usage.platformPricing.help")).toBeInTheDocument();
  });
  it("does not silently fall back when the selected group cannot price a model", () => {
    state.data.selectedGroup = "premium";
    render(<PlatformPricingPanel catalog />);
    expect(
      screen.getByText("usage.platformPricing.reason.group_missing"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/⚡️6.*⚡️30/)).not.toBeInTheDocument();
  });
});
