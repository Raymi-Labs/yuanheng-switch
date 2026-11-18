import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useYuanhengConnection } from "./yuanheng";
import { resolveUsageRange } from "@/lib/usageRange";
import type { UsageRangeSelection } from "@/types/usage";

export interface PlatformUsageSummary {
  accountId: string;
  amount: string | null;
  symbol: string | null;
  requests: number | null;
  tokens: number | null;
  periodStart: number;
  periodEnd: number;
  fetchedAt: number;
}

export const platformUsageKey = ["yuanheng", "platform-usage"] as const;

export function usePlatformUsage(
  range: UsageRangeSelection,
  refreshIntervalMs: number,
) {
  const queryClient = useQueryClient();
  const account = useYuanhengConnection();
  const owner =
    account.data?.connected && !account.isError
      ? account.data.userId
      : undefined;
  const currentRange = resolveUsageRange(range);
  const invalidRange =
    currentRange.startDate <= 0 ||
    currentRange.endDate <= currentRange.startDate ||
    currentRange.endDate - currentRange.startDate > 30 * 86400;
  const identityKey = [
    ...platformUsageKey,
    account.data?.baseUrl ?? null,
    owner ?? null,
  ];
  const queryKey = [
    ...identityKey,
    // Metadata refresh is not an identity change. Calendar-based presets
    // still need a new cache entry when the local date rolls over.
    ["today", "7d", "14d", "30d"].includes(range.preset)
      ? currentRange.startDate
      : null,
    range,
  ];
  const query = useQuery({
    queryKey,
    enabled: !!owner && !invalidRange,
    queryFn: async () => {
      if (!owner) throw new Error("platform_usage_login");
      const period = resolveUsageRange(range);
      try {
        const result = await invoke<PlatformUsageSummary>(
          "get_yuanheng_platform_usage",
          {
            startDate: period.startDate,
            endDate: period.endDate,
            expectedUserId: owner,
          },
        );
        if (result.accountId !== owner) throw new Error("platform_usage_login");
        return result;
      } catch (error) {
        const code = String(error).replace(/^Error: /, "");
        // A subsequent transport error must never resurrect a snapshot after
        // authentication failed, including a cached alternative date range.
        if (code === "platform_usage_login")
          queryClient.setQueriesData<PlatformUsageSummary | null>(
            { queryKey: identityKey },
            null,
          );
        else if (code === "platform_usage_invalid")
          queryClient.setQueryData<PlatformUsageSummary | null>(queryKey, null);
        throw error;
      }
    },
    retry: false,
    // Native HTTP owns connectivity. Browser offline detection must not pause a
    // refresh while incorrectly treating cached totals as up to date.
    networkMode: "always",
    staleTime: 15_000,
    refetchInterval:
      owner && !invalidRange && refreshIntervalMs > 0
        ? Math.max(30_000, refreshIntervalMs)
        : false,
    refetchIntervalInBackground: false,
  });
  const errorCode = !owner
    ? "login"
    : invalidRange
      ? "range"
      : query.isError
        ? ({
            platform_usage_login: "login",
            platform_usage_range: "range",
            platform_usage_invalid: "invalid",
          }[String(query.error).replace(/^Error: /, "")] ?? "unavailable")
        : null;
  const data =
    owner &&
    !invalidRange &&
    (!errorCode || errorCode === "unavailable") &&
    query.data?.accountId === owner
      ? query.data
      : undefined;
  return {
    ...query,
    data,
    stale: !!data && errorCode === "unavailable",
    partial:
      !!data &&
      [data.amount, data.symbol, data.requests, data.tokens].some(
        (value) => value == null,
      ),
    errorCode,
    canRefresh: !!owner && !invalidRange,
  };
}
