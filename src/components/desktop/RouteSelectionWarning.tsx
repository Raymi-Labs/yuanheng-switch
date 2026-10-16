import { useTranslation } from "react-i18next";
import { useRouteSelection } from "@/hooks/useRouteSelection";
import { Button } from "@/components/ui/button";

export function RouteSelectionWarning({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const { query } = useRouteSelection();
  if (
    query.isError ||
    !query.data ||
    !["degraded", "unavailable"].includes(query.data.status)
  )
    return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
    >
      <span>{t(`routeSelection.states.${query.data.status}`)}</span>
      <Button size="sm" variant="outline" onClick={onOpen}>
        {t("routeSelection.view")}
      </Button>
    </div>
  );
}
