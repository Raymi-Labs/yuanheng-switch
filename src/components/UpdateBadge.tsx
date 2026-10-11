import { useUpdate } from "@/contexts/UpdateContext";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ArrowUpCircle, Loader2 } from "lucide-react";

interface UpdateBadgeProps {
  className?: string;
  onClick?: () => void;
}

export function UpdateBadge({ className = "", onClick }: UpdateBadgeProps) {
  const {
    hasUpdate,
    updateInfo,
    isChecking,
    isUpdating,
    phase,
    resetDismiss,
    openUpdatePrompt,
  } = useUpdate();
  const { t } = useTranslation();

  if (!hasUpdate || !updateInfo) {
    return null;
  }

  const label = isUpdating
    ? t(
        phase === "installing"
          ? "settings.installingUpdate"
          : "settings.downloadingUpdate",
      )
    : isChecking
      ? t("settings.checking")
      : t("settings.updateTo", { version: updateInfo.availableVersion });

  return (
    <Button
      type="button"
      size="sm"
      title={t("settings.updateAvailable", {
        version: updateInfo.availableVersion,
      })}
      disabled={isChecking || isUpdating}
      onClick={() => {
        resetDismiss();
        (onClick ?? openUpdatePrompt)();
      }}
      className={`relative h-7 shrink-0 gap-1.5 rounded-full border border-emerald-500 bg-emerald-600 px-3 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 dark:border-emerald-400 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400 ${className}`}
    >
      {isChecking || isUpdating ? (
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
      ) : (
        <ArrowUpCircle className="h-3.5 w-3.5" />
      )}
      <span>{label}</span>
      <span
        aria-hidden="true"
        data-testid="update-notification-dot"
        className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-background"
      />
    </Button>
  );
}
