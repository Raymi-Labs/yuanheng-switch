import { useId } from "react";
import { Activity, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useRouteSelection } from "@/hooks/useRouteSelection";
import type { RouteId } from "@/lib/api/routeSelection";

export function RouteSelectionCard() {
  const { t } = useTranslation();
  const { query, mutation } = useRouteSelection();
  const name = useId();
  const data = query.data;
  const running = !!data && !query.isError;
  const checking = running && !!data.operationId;
  const mode =
    data?.policy.mode === "fixed" ? data.policy.fixedRouteId : "auto";
  const label = (route: RouteId) => t(`routeSelection.${route}`);
  const errorLabel = (error: unknown) => {
    const code = String(error);
    return t(`routeSelection.errors.${code}`, {
      defaultValue: t("routeSelection.errors.unknown"),
    });
  };
  const choose = (value: "auto" | RouteId) => {
    if (!data) return;
    mutation.mutate({
      policy: {
        mode: value === "auto" ? "auto" : "fixed",
        fixedRouteId: value === "auto" ? data.policy.fixedRouteId : value,
      },
      revision: data.revision,
    });
  };
  return (
    <section
      className="rounded-xl glass-card p-4 sm:p-6 space-y-4"
      aria-labelledby={`${name}-title`}
    >
      <div className="flex items-start gap-3">
        <Activity
          className="h-5 w-5 mt-0.5 shrink-0 text-primary"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <h3 id={`${name}-title`} className="font-semibold">
            {t("routeSelection.title")}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {t("routeSelection.description")}
          </p>
        </div>
      </div>
      {query.isPending && !data ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("routeSelection.loading")}
        </p>
      ) : (
        <>
          <fieldset
            disabled={!running || mutation.isPending}
            className="space-y-2"
          >
            <legend className="sr-only">{t("routeSelection.mode")}</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {(["auto", "relay", "cloudflare"] as const).map((value) => (
                <label
                  key={value}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm cursor-pointer ${mode === value ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border"}`}
                >
                  <input
                    type="radio"
                    name={name}
                    value={value}
                    checked={mode === value}
                    onChange={() => choose(value)}
                    className="shrink-0 accent-current"
                  />
                  <span>{t(`routeSelection.mode_${value}`)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="rounded-lg bg-muted/40 p-4 flex flex-wrap items-center justify-between gap-3">
            <div aria-live="polite">
              <p className="text-xs text-muted-foreground">
                {t(
                  mode === "auto"
                    ? "routeSelection.selected"
                    : "routeSelection.fixed",
                )}
              </p>
              <p className="font-medium mt-1">
                {data ? label(data.selectedRouteId) : "—"}
              </p>
              <p
                className={`text-sm mt-1 ${running && data?.status === "healthy" ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}
              >
                {running
                  ? t(`routeSelection.states.${data.status}`)
                  : errorLabel(query.error)}
              </p>
            </div>
            {checking ? (
              <Button
                variant="outline"
                size="sm"
                disabled={mutation.isPending}
                onClick={() =>
                  data.operationId &&
                  mutation.mutate({ cancel: data.operationId })
                }
              >
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t("routeSelection.cancel")}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={mutation.isPending || (query.isFetching && !running)}
                onClick={() =>
                  running
                    ? mutation.mutate({ stream: false })
                    : void query.refetch()
                }
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                {t(running ? "routeSelection.probe" : "routeSelection.refresh")}
              </Button>
            )}
          </div>
          {mutation.isError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {errorLabel(mutation.error)}
            </p>
          )}
          {data && (
            <>
              <p className="text-xs text-muted-foreground">
                {t(
                  checking ||
                    !running ||
                    data.status === "stale" ||
                    data.status === "unknown"
                    ? "routeSelection.previous"
                    : "routeSelection.results",
                )}
              </p>
              <div className="divide-y divide-border">
                {data.routes.map((route) => (
                  <div
                    key={route.routeId}
                    className="py-3 flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <span>{label(route.routeId)}</span>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 justify-end text-right">
                      <span className="tabular-nums">
                        {route.latencyMs == null
                          ? "—"
                          : `${route.latencyMs} ms`}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {t("routeSelection.samples", {
                          count: route.successes,
                          total: route.samples,
                        })}
                      </span>
                      {route.error && (
                        <span className="basis-full text-xs text-muted-foreground">
                          {errorLabel(route.error)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  mode === "auto"
                    ? "routeSelection.autoHint"
                    : "routeSelection.fixedHint",
                )}
              </p>
              {running && mode !== "auto" && data.status === "degraded" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => choose("auto")}
                >
                  {t("routeSelection.useAuto")}
                </Button>
              )}
              <details className="border-t border-border pt-3">
                <summary className="text-sm text-muted-foreground cursor-pointer">
                  {t("routeSelection.details")}
                </summary>
                <div className="space-y-2 pt-3 text-xs text-muted-foreground break-words">
                  <p>
                    {t("routeSelection.checkedAt")}:{" "}
                    {data.lastCheckedAt
                      ? new Date(data.lastCheckedAt).toLocaleString()
                      : t("routeSelection.never")}
                  </p>
                  <p>
                    {t("routeSelection.reason")}:{" "}
                    {t(`routeSelection.reasons.${data.reason}`, {
                      defaultValue: t("routeSelection.never"),
                    })}
                  </p>
                  {data.routes.map((route) => (
                    <div key={route.routeId}>
                      <p>
                        {label(route.routeId)} · {route.origin}
                      </p>
                      {route.streamStatus && (
                        <p>
                          {t("routeSelection.streaming")}:{" "}
                          {route.streamStatus === "ok"
                            ? t("routeSelection.states.healthy")
                            : errorLabel(route.streamStatus)}
                        </p>
                      )}
                    </div>
                  ))}
                  <p>{t("routeSelection.scope")}</p>
                  <p>{t("routeSelection.schedule")}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!running || checking || mutation.isPending}
                    onClick={() => mutation.mutate({ stream: true })}
                  >
                    {t("routeSelection.streamProbe")}
                  </Button>
                </div>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
