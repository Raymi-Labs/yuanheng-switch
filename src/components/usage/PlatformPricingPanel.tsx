import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  usePlatformPricing,
  usePlatformQuoteGroup,
  useRefreshPlatformPricing,
  type PlatformPriceBook,
} from "@/lib/query/platformPricing";
import { toast } from "sonner";

function CatalogRate({
  book,
  model,
}: {
  book: PlatformPriceBook;
  model: PlatformPriceBook["models"][string];
}) {
  const { t } = useTranslation();
  if (model.billing_mode === "tiered_expr") return null;
  const groups = Object.entries(book.groups).filter(
    ([name]) =>
      model.enable_groups.includes(name) &&
      (!book.selectedGroup || name === book.selectedGroup),
  );
  const ratio = Math.min(...groups.map(([, ratio]) => Number(ratio)));
  const factor = ratio * Number(book.displayRate);
  if (!Number.isFinite(factor))
    return (
      <p className="text-xs text-muted-foreground">
        {t("usage.platformPricing.reason.group_missing")}
      </p>
    );
  const show = (price: number | undefined) =>
    price == null || !Number.isFinite(price * factor)
      ? "—"
      : `${book.symbol}${Number((price * factor).toFixed(6))}`;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {model.quota_type === 0
        ? `${t("usage.platformPricing.input")} ${show(model.model_ratio == null ? undefined : model.model_ratio * 2)} · ${t("usage.platformPricing.output")} ${show(model.model_ratio == null || model.completion_ratio == null ? undefined : model.model_ratio * 2 * model.completion_ratio)} / 1M Token`
        : `${show(model.quota_type === 1 ? model.model_price : model.audio_duration_price)} · ${t(`usage.platformPricing.${model.quota_type === 1 ? "perCall" : "perHour"}`)}`}
    </p>
  );
}

export function PlatformPricingPanel({
  catalog = false,
}: {
  catalog?: boolean;
}) {
  const { t } = useTranslation();
  const { data, error, isFetching } = usePlatformPricing();
  const refresh = useRefreshPlatformPricing();
  const group = usePlatformQuoteGroup();
  const [search, setSearch] = useState("");
  const pending = isFetching || refresh.isPending;
  return (
    <div className="space-y-3 rounded-lg border bg-card/40 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <strong className="text-sm">{t("usage.platformPricing.title")}</strong>
        {catalog && (
          <select
            aria-label={t("usage.platformPricing.group")}
            className="max-w-72 rounded-md border bg-background p-1.5 text-sm"
            value={data?.selectedGroup ?? ""}
            disabled={!data || group.isPending}
            onChange={(event) =>
              group.mutate(event.target.value || null, {
                onError: (e) => toast.error(String(e)),
              })
            }
          >
            <option value="">{t("usage.platformPricing.autoGroup")}</option>
            {data?.selectedGroup && !(data.selectedGroup in data.groups) && (
              <option value={data.selectedGroup}>
                {data.selectedGroup} (
                {t("usage.platformPricing.groupUnavailable")})
              </option>
            )}
            {Object.entries(data?.groups ?? {}).map(([name, ratio]) => (
              <option key={name} value={name}>
                {name} · ×{ratio}
              </option>
            ))}
          </select>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            refresh.mutate(undefined, {
              onError: (e) => toast.error(String(e)),
            })
          }
        >
          <RefreshCw
            className={`mr-2 h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`}
          />
          {t("usage.platformPricing.sync")}
        </Button>
        {data && (
          <span className="text-xs text-muted-foreground">
            {t("usage.platformPricing.synced", {
              count: Object.keys(data.models).length,
              time: new Date(data.fetchedAt * 1000).toLocaleString(),
            })}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          catalog
            ? "usage.platformPricing.catalogHelp"
            : "usage.platformPricing.help",
        )}
      </p>
      {(error || data?.stale || data?.syncError) && (
        <p role="status" className="text-xs text-amber-600">
          {data
            ? t("usage.platformPricing.stale")
            : t("usage.platformPricing.missing")}
          {error || data?.syncError
            ? ` ${String(error ?? data?.syncError)}`
            : ""}
        </p>
      )}
      {catalog && (
        <>
          <Input
            aria-label={t("usage.platformPricing.search")}
            placeholder={t("usage.platformPricing.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-96 overflow-auto divide-y">
            {Object.values(data?.models ?? {})
              .filter((m) =>
                m.model_name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((m) => (
                <div key={m.model_name} className="py-3 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <span className="font-mono">{m.model_name}</span>
                    <span className="text-muted-foreground">
                      {t(
                        `usage.platformPricing.${m.billing_mode === "tiered_expr" ? "dynamic" : m.quota_type === 1 ? "perCall" : m.quota_type === 2 ? "perHour" : "perToken"}`,
                      )}
                    </span>
                  </div>
                  {data && <CatalogRate book={data} model={m} />}
                  {m.billing_expr && (
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer">
                        {t("usage.platformPricing.rawRule")}
                      </summary>
                      <pre className="mt-2 whitespace-pre-wrap break-words">
                        {m.billing_expr}
                      </pre>
                    </details>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {m.enable_groups.join(" / ")}
                  </p>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
