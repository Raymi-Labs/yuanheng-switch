import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/** Keep previously loaded local rows visible, while distinguishing failed reads from empty data. */
export function UsageQueryNotice({
  hasData,
  updatedAt,
  retry,
  busy,
}: {
  hasData: boolean;
  updatedAt: number;
  retry: () => unknown;
  busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const time = new Date(updatedAt).toLocaleString(
    i18n.resolvedLanguage || i18n.language,
  );
  return (
    <div
      role={hasData ? "status" : "alert"}
      className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-muted-foreground"
    >
      <span>
        {hasData
          ? t("usage.localStatus.stale", { time })
          : t("usage.localStatus.failed")}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void retry()}
      >
        {t("usage.localStatus.retry")}
      </Button>
    </div>
  );
}
