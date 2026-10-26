import { useEffect, useState } from "react";
import { ArrowUpCircle, ExternalLink, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { useUpdate } from "@/contexts/UpdateContext";
import { settingsApi } from "@/lib/api";
import { getCurrentVersion } from "@/lib/updater";

/** Updates must remain reachable before authentication, including loading/2FA. */
export function AccessUpdateControl() {
  const { t } = useTranslation();
  const { hasUpdate, updateInfo, isChecking, isUpdating, phase, checkUpdate } =
    useUpdate();
  const [version, setVersion] = useState("");
  const [checkedCurrent, setCheckedCurrent] = useState(false);
  const [openingDownload, setOpeningDownload] = useState(false);

  useEffect(() => {
    let active = true;
    void getCurrentVersion().then((value) => {
      if (active) setVersion(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const handleCheck = async () => {
    if (isChecking || isUpdating) return;
    setCheckedCurrent(false);
    try {
      const available = await checkUpdate({
        showPrompt: true,
        forcePrompt: true,
      });
      setCheckedCurrent(!available);
    } catch {
      // The shared context exposes a retryable error; keep the login form intact.
    }
  };

  const handleDownload = async () => {
    setOpeningDownload(true);
    try {
      await settingsApi.checkUpdates();
    } catch {
      toast.error(t("notifications.openLinkFailed"));
    } finally {
      setOpeningDownload(false);
    }
  };

  const currentVersion = version || updateInfo?.currentVersion;
  // App's top row owns the available-update action; keep manual recovery here.
  const hasAvailableUpdate = hasUpdate && Boolean(updateInfo);
  const label = t(
    isChecking ? "settings.checking" : "settings.checkForUpdates",
  );

  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-2 text-[11px]">
      {currentVersion && (
        <span className="text-slate-400">
          {t("settings.currentVersion")}{" "}
          <span className="font-mono">v{currentVersion}</span>
        </span>
      )}
      {!hasAvailableUpdate && (
        <button
          type="button"
          onClick={() => void handleCheck()}
          disabled={isChecking || isUpdating}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] px-3 py-2 font-medium text-slate-200 transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:opacity-60"
        >
          {isChecking || isUpdating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUpCircle className="h-3.5 w-3.5 text-emerald-300" />
          )}
          {label}
        </button>
      )}
      {phase === "error" && (
        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={openingDownload}
          className="inline-flex items-center gap-1.5 rounded px-1 py-2 text-slate-300 underline underline-offset-4 hover:text-white disabled:opacity-60"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("settings.openDownloadPage")}
        </button>
      )}
      <p className="w-full text-right text-slate-300" aria-live="polite">
        {phase === "error" && !hasUpdate
          ? t("settings.checkUpdateFailed")
          : checkedCurrent && phase === "idle"
            ? t("settings.upToDate")
            : null}
      </p>
    </div>
  );
}
