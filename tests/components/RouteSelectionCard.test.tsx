import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import zh from "@/i18n/locales/zh.json";
import { RouteSelectionCard } from "@/components/settings/RouteSelectionCard";
import { routeSelectionApi, type RouteStatus } from "@/lib/api/routeSelection";

vi.mock("@/lib/api/routeSelection", () => ({
  routeSelectionApi: {
    status: vi.fn(),
    setPolicy: vi.fn(),
    probe: vi.fn(),
    cancel: vi.fn(),
  },
}));
const initial = (): RouteStatus => ({
  revision: 7,
  networkGeneration: 1,
  policy: { mode: "auto", fixedRouteId: "relay" },
  selectedRouteId: "relay",
  status: "healthy",
  operationId: null,
  lastCheckedAt: null,
  reason: "stable",
  coreRunning: true,
  routes: [
    {
      routeId: "relay",
      origin: "https://meta-api.vip",
      successes: 3,
      samples: 3,
      coldOk: true,
      latencyMs: 120,
      jitterMs: 10,
      error: null,
      streamStatus: null,
    },
  ],
});
const t = (key: string) => i18n.t(`routeSelection.${key}`);
function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <RouteSelectionCard />
    </QueryClientProvider>,
  );
}
describe("route selection controls", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    i18n.addResourceBundle("zh", "translation", zh, true, true);
    vi.mocked(routeSelectionApi.status).mockResolvedValue(initial());
  });
  it("saves with revision and retains the applied choice on failure", async () => {
    vi.mocked(routeSelectionApi.setPolicy).mockRejectedValue("save_failed");
    mount();
    const choice = await screen.findByRole("radio", {
      name: t("mode_cloudflare"),
    });
    fireEvent.click(choice);
    await screen.findByRole("alert");
    expect(routeSelectionApi.setPolicy).toHaveBeenCalledWith(
      { mode: "fixed", fixedRouteId: "cloudflare" },
      7,
    );
    expect(screen.getByRole("radio", { name: t("mode_auto") })).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent(
      t("errors.save_failed"),
    );
  });
  it("checks without changing fixed preference and displays the confirmed result", async () => {
    const fixed = {
      ...initial(),
      policy: { mode: "fixed" as const, fixedRouteId: "cloudflare" as const },
      selectedRouteId: "cloudflare" as const,
      status: "degraded" as const,
    };
    vi.mocked(routeSelectionApi.status).mockResolvedValue(fixed);
    vi.mocked(routeSelectionApi.probe).mockResolvedValue(fixed);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: t("probe") }));
    await waitFor(() =>
      expect(routeSelectionApi.probe).toHaveBeenCalledWith(false),
    );
    expect(routeSelectionApi.setPolicy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("radio", { name: t("mode_cloudflare") }),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: t("useAuto") }),
    ).toBeInTheDocument();
  });
  it("retains previous metrics while checking and cancels by operation ID", async () => {
    const checking = {
      ...initial(),
      status: "checking" as const,
      operationId: "operation-1",
    };
    vi.mocked(routeSelectionApi.status).mockResolvedValue(checking);
    vi.mocked(routeSelectionApi.cancel).mockResolvedValue(initial());
    mount();
    fireEvent.click(await screen.findByRole("button", { name: t("cancel") }));
    await waitFor(() =>
      expect(routeSelectionApi.cancel).toHaveBeenCalledWith("operation-1"),
    );
    expect(screen.getByText("120 ms")).toBeInTheDocument();
    expect(routeSelectionApi.setPolicy).not.toHaveBeenCalled();
  });
  it("disables choices when Core is unavailable and allows refresh", async () => {
    vi.mocked(routeSelectionApi.status).mockRejectedValue("core_unavailable");
    mount();
    await screen.findByText(t("errors.core_unavailable"));
    expect(screen.getByRole("radio", { name: t("mode_relay") })).toBeDisabled();
    vi.mocked(routeSelectionApi.status).mockResolvedValue(initial());
    fireEvent.click(screen.getByRole("button", { name: t("refresh") }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: t("mode_auto") })).toBeEnabled(),
    );
  });
});
