import { useTranslation } from "react-i18next";
import { CalendarDays, Info, Loader2, RefreshCw } from "lucide-react";
import { usePlatformUsage } from "@/lib/query/platformUsage";
import { resolveUsageRange } from "@/lib/usageRange";
import type { UsageRangePreset, UsageRangeSelection } from "@/types/usage";
import { UsageDateRangePicker } from "./UsageDateRangePicker";
import { fmtInt, fmtSettlementAmount, getLocaleFromLanguage } from "./format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const QUICK_RANGES: UsageRangePreset[] = ["today", "1d", "7d", "30d"];

export function UsageCostSummary({
  range,
  rangeLabel,
  refreshIntervalMs,
  onRangeChange,
}: {
  range: UsageRangeSelection;
  rangeLabel: string;
  refreshIntervalMs: number;
  onRangeChange: (range: UsageRangeSelection) => void;
}) {
  const { t, i18n } = useTranslation();
  const {
    data,
    isLoading,
    isFetching,
    errorCode,
    refetch,
    canRefresh,
    stale,
    partial,
  } = usePlatformUsage(range, refreshIntervalMs);
  const locale = getLocaleFromLanguage(i18n.resolvedLanguage || i18n.language);
  const fallback = resolveUsageRange(range);
  const date = (seconds: number) =>
    new Date(seconds * 1000).toLocaleString(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  const displayAmount = fmtSettlementAmount(data?.amount, data?.symbol, locale);
  return (
    <section
      aria-label={t("usage.platformSummary.title")}
      className="rounded-2xl border border-primary/20 bg-card p-5 md:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">
            {t("usage.platformSummary.title")}
          </h2>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("usage.platformSummary.scope")}
                  className="text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <Info className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-80">
                {t("usage.platformSummary.scope")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={t("usage.periodSummary.range")}
        >
          {QUICK_RANGES.map((preset) => (
            <button
              type="button"
              key={preset}
              aria-pressed={range.preset === preset}
              onClick={() => onRangeChange({ preset })}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
                range.preset === preset
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted",
              )}
            >
              {t(`usage.periodSummary.${preset}`)}
            </button>
          ))}
          <UsageDateRangePicker
            triggerClassName="w-auto min-w-[136px] max-w-[220px]"
            selection={range}
            triggerLabel={
              range.preset === "custom" || range.preset === "14d"
                ? rangeLabel
                : t("usage.periodSummary.custom")
            }
            onApply={onRangeChange}
          />
          <Button
            size="icon"
            variant="ghost"
            disabled={!canRefresh || isFetching}
            aria-label={t("usage.platformSummary.refresh")}
            title={t("usage.platformSummary.refresh")}
            onClick={() => void refetch()}
          >
            <RefreshCw
              className={cn("h-4 w-4", isFetching && "animate-spin")}
            />
          </Button>
        </div>
      </div>
      <div className="mt-5 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {t("usage.platformSummary.charged")}
          </p>
          <div
            aria-live="polite"
            className="mt-2 break-all text-4xl font-semibold tracking-tight tabular-nums md:text-5xl"
          >
            {isLoading && !errorCode ? (
              <Loader2 className="h-8 w-8 animate-spin" />
            ) : displayAmount != null ? (
              displayAmount
            ) : (
              <span className="text-xl text-muted-foreground">
                {t("usage.platformSummary.notSynced")}
              </span>
            )}
          </div>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5 shrink-0" />
            {date(data?.periodStart ?? fallback.startDate)} —{" "}
            {date(data?.periodEnd ?? fallback.endDate)}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-5 text-sm sm:text-right">
          {[
            ["requests", data?.requests],
            ["tokens", data?.tokens],
          ].map(([key, value]) => (
            <div key={String(key)}>
              <dt className="text-xs text-muted-foreground">
                {t(`usage.platformSummary.${key}`)}
              </dt>
              <dd className="mt-1 font-semibold tabular-nums">
                {data ? fmtInt(value, locale, "—") : "—"}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {(errorCode || partial) && (
        <p
          role={stale || partial ? "status" : "alert"}
          className={cn(
            "mt-4 text-xs",
            stale || partial ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {stale
            ? t("usage.platformSummary.stale", { time: date(data!.fetchedAt) })
            : partial
              ? t("usage.platformSummary.partial")
              : t(`usage.platformSummary.${errorCode}`)}
        </p>
      )}
    </section>
  );
}
