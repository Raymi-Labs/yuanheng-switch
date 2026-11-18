import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useModelStats } from "@/lib/query/usage";
import { UsageQueryNotice } from "./UsageQueryNotice";
import { fmtCredits } from "./format";
import type { UsageRangeSelection } from "@/types/usage";

interface ModelStatsTableProps {
  range: UsageRangeSelection;
  appType?: string;
  providerName?: string;
  model?: string;
  refreshIntervalMs: number;
}

export function ModelStatsTable({
  range,
  appType,
  providerName,
  model,
  refreshIntervalMs,
}: ModelStatsTableProps) {
  const { t } = useTranslation();
  const {
    data: stats,
    isLoading,
    isError,
    dataUpdatedAt,
    refetch,
    isFetching,
  } = useModelStats(
    range,
    { appType, providerName, model },
    {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  );

  if (isLoading) {
    return <div className="h-[400px] animate-pulse rounded bg-gray-100" />;
  }

  const notice = isError ? (
    <UsageQueryNotice
      hasData={stats != null}
      updatedAt={dataUpdatedAt}
      retry={refetch}
      busy={isFetching}
    />
  ) : null;
  if (isError && stats == null) return notice;
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 backdrop-blur-sm overflow-hidden">
      {notice}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("usage.model", "模型")}</TableHead>
            <TableHead className="text-right">
              {t("usage.requests", "请求数")}
            </TableHead>
            <TableHead className="text-right">
              {t("usage.tokens", "Tokens")}
            </TableHead>
            <TableHead className="text-right">
              {t("usage.totalCost", "总成本")}
            </TableHead>
            <TableHead className="text-right">
              {t("usage.avgCost", "平均成本")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats?.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={5}
                className="text-center text-muted-foreground"
              >
                {t("usage.noData", "暂无数据")}
              </TableCell>
            </TableRow>
          ) : (
            stats?.map((stat) => (
              <TableRow key={stat.model}>
                <TableCell className="font-mono text-sm">
                  {stat.model}
                </TableCell>
                <TableCell className="text-right">
                  {stat.requestCount.toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  {stat.totalTokens.toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  {fmtCredits(stat.totalCost, 4, stat.costSymbol)}
                  {!!stat.unpricedRequests && (
                    <div className="text-xs text-muted-foreground">
                      {t("usage.platformPricing.uncovered", {
                        count: stat.unpricedRequests,
                      })}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {fmtCredits(stat.avgCostPerRequest, 6, stat.costSymbol)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
