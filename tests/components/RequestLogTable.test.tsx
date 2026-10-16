import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestLogTable } from "@/components/usage/RequestLogTable";
import type { RequestLog, UsageRangeSelection } from "@/types/usage";

const useRequestLogsMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: {
        defaultValue?: string;
      },
    ) => options?.defaultValue ?? key,
    i18n: {
      resolvedLanguage: "en",
      language: "en",
    },
  }),
}));

vi.mock("@/lib/query/usage", () => ({
  useRequestLogs: (args: unknown) => useRequestLogsMock(args),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: any) => <span>{placeholder ?? null}</span>,
  SelectContent: () => null,
  SelectItem: () => null,
}));

vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: any) => <table>{children}</table>,
  TableBody: ({ children }: any) => <tbody>{children}</tbody>,
  TableCell: ({ children, ...props }: any) => <td {...props}>{children}</td>,
  TableHead: ({ children, ...props }: any) => <th {...props}>{children}</th>,
  TableHeader: ({ children }: any) => <thead>{children}</thead>,
  TableRow: ({ children }: any) => <tr>{children}</tr>,
}));

function makeUsageLog(overrides: Partial<RequestLog> = {}): RequestLog {
  return {
    requestId: "fallback-uuid",
    providerId: "codex-official",
    providerName: "OpenAI Official",
    appType: "codex",
    model: "gpt-6-astra",
    costMultiplier: "1",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputCostUsd: "0",
    outputCostUsd: "0",
    cacheReadCostUsd: "0",
    cacheCreationCostUsd: "0",
    totalCostUsd: "0",
    isStreaming: false,
    latencyMs: 11900,
    statusCode: 200,
    createdAt: 1,
    dataSource: "proxy",
    ...overrides,
  };
}

describe("RequestLogTable", () => {
  beforeEach(() => {
    useRequestLogsMock.mockReset();
    useRequestLogsMock.mockImplementation(
      ({ page = 0, pageSize = 20 }: { page?: number; pageSize?: number }) => ({
        data: {
          data: [],
          total: 120,
          page,
          pageSize,
        },
        isLoading: false,
      }),
    );
  });

  it("does not display missing official usage as free zero-token requests", () => {
    const official = makeUsageLog();
    const imported = {
      ...official,
      requestId: "codex_session:thread:1",
      providerId: "_codex_session",
      providerName: "Codex (Session)",
      dataSource: "codex_session",
      inputTokens: 225330,
      cacheReadTokens: 224256,
      outputTokens: 94,
      latencyMs: 0,
    };
    useRequestLogsMock.mockReturnValue({
      data: { data: [official, imported], total: 2, page: 0, pageSize: 20 },
      isLoading: false,
    });
    render(
      <RequestLogTable
        range={{ preset: "today" }}
        rangeLabel="Today"
        appType="codex"
        refreshIntervalMs={0}
      />,
    );
    expect(screen.getByText("usage.accountBilling")).toBeInTheDocument();
    expect(
      screen.getByText("usage.sessionProviderUnknown"),
    ).toBeInTheDocument();
    expect(screen.getByText("usage.codexSessionSource")).toBeInTheDocument();
    expect(screen.getByText("1,074")).toBeInTheDocument();
    expect(screen.getByText("R224,256")).toBeInTheDocument();
    expect(screen.queryByText("$0.0000")).not.toBeInTheDocument();
    expect(screen.queryByText("0.0s")).not.toBeInTheDocument();
  });

  it("shows the request group and desktop fresh input without displaying an unrelated quote group", () => {
    useRequestLogsMock.mockReturnValue({
      data: {
        data: [
          makeUsageLog({
            appType: "chatgpt-desktop",
            dataSource: "proxy",
            requestGroup: "OpenAI · 优质",
            inputTokens: 41466,
            cacheReadTokens: 41088,
            outputTokens: 130,
            platformQuote: {
              amount: "0.115578",
              symbol: "⚡️",
              reason: "estimate",
              group: "OpenAI · 企业专属",
              groupRatio: "1",
            },
          }),
        ],
        total: 1,
        page: 0,
        pageSize: 20,
      },
      isLoading: false,
    });
    render(
      <RequestLogTable
        range={{ preset: "today" }}
        rangeLabel="Today"
        refreshIntervalMs={0}
      />,
    );
    expect(
      screen.getByText("usage.platformPricing.requestGroup: OpenAI · 优质"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/企业专属/)).not.toBeInTheDocument();
    expect(screen.getByText("378")).toBeInTheDocument();
    expect(screen.getByText("≈ ⚡️0.1156")).toBeInTheDocument();
  });

  it.each([null, "auto"])(
    "does not invent a billing group for %s",
    (requestGroup) => {
      useRequestLogsMock.mockReturnValue({
        data: {
          data: [
            makeUsageLog({
              requestGroup,
              platformQuote: {
                amount: null,
                symbol: "⚡️",
                reason: "request_group_unknown",
              },
            }),
          ],
          total: 1,
          page: 0,
          pageSize: 20,
        },
        isLoading: false,
      });
      render(
        <RequestLogTable
          range={{ preset: "today" }}
          rangeLabel="Today"
          refreshIntervalMs={0}
        />,
      );
      expect(
        screen.getByText(
          requestGroup === "auto"
            ? "usage.platformPricing.requestGroup: usage.platformPricing.autoRequestGroup"
            : "usage.platformPricing.unknownRequestGroup",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText("usage.platformPricing.reason.request_group_unknown"),
      ).toBeInTheDocument();
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
    },
  );

  it("shows platform credits beside official account billing without relabelling legacy USD", () => {
    const official = makeUsageLog({
      requestId: "session:codex:codex-official:resp-priced",
      inputTokens: 225330,
      cacheReadTokens: 224256,
      outputTokens: 94,
      totalCostUsd: "0.239696",
      platformQuote: {
        amount: "0.539316",
        symbol: "⚡️",
        reason: "estimate",
        group: "OpenAI · 优质",
        groupRatio: "0.45",
      },
      isStreaming: true,
    });
    useRequestLogsMock.mockReturnValue({
      data: { data: [official], total: 1, page: 0, pageSize: 20 },
      isLoading: false,
    });
    render(
      <RequestLogTable
        range={{ preset: "today" }}
        rangeLabel="Today"
        appType="codex"
        refreshIntervalMs={0}
      />,
    );
    expect(screen.getByText("usage.accountBilling")).toBeInTheDocument();
    expect(screen.getByText("≈ ⚡️0.5393")).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.2397/)).not.toBeInTheDocument();
  });

  it("shows the declared official provider separately from the session source", () => {
    useRequestLogsMock.mockReturnValue({
      data: {
        data: [
          makeUsageLog({
            providerId: "codex-official",
            providerName: "OpenAI Official",
            dataSource: "codex_session",
            providerAttribution: "session_meta",
            declaredProvider: "yuanheng-switch-official",
            inputTokens: 10,
            outputTokens: 1,
          }),
        ],
        total: 1,
        page: 0,
        pageSize: 20,
      },
      isLoading: false,
    });
    render(
      <RequestLogTable
        range={{ preset: "1d" }}
        rangeLabel="24 hours"
        refreshIntervalMs={0}
      />,
    );
    expect(screen.getByText("OpenAI Official")).toBeInTheDocument();
    expect(screen.getByText("usage.codexSessionSource")).toBeInTheDocument();
    expect(screen.getByText("usage.sessionDeclared")).toBeInTheDocument();
    expect(
      screen.queryByText("usage.sessionProviderUnknown"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("usage.accountBilling")).not.toBeInTheDocument();
  });

  it("resets pagination when the dashboard range changes", async () => {
    const initialRange: UsageRangeSelection = { preset: "today" };
    const nextRange: UsageRangeSelection = {
      preset: "custom",
      customStartDate: 1_710_000_000,
      customEndDate: 1_710_086_400,
    };

    const { rerender } = render(
      <RequestLogTable
        range={initialRange}
        rangeLabel="Today"
        appType="all"
        refreshIntervalMs={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2" }));

    await waitFor(() => {
      expect(useRequestLogsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 1,
          range: initialRange,
        }),
      );
    });

    rerender(
      <RequestLogTable
        range={nextRange}
        rangeLabel="Custom"
        appType="all"
        refreshIntervalMs={0}
      />,
    );

    await waitFor(() => {
      expect(useRequestLogsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 0,
          range: nextRange,
        }),
      );
    });
  });

  it("resets pagination when the dashboard app filter changes", async () => {
    const range: UsageRangeSelection = { preset: "today" };
    const { rerender } = render(
      <RequestLogTable
        range={range}
        rangeLabel="Today"
        appType="all"
        refreshIntervalMs={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2" }));

    await waitFor(() => {
      expect(useRequestLogsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 1,
          range,
        }),
      );
    });

    rerender(
      <RequestLogTable
        range={range}
        rangeLabel="Today"
        appType="claude"
        refreshIntervalMs={0}
      />,
    );

    await waitFor(() => {
      expect(useRequestLogsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 0,
          range,
        }),
      );
    });
  });
});
