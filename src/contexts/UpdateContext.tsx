import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import type { UpdateInfo } from "../lib/updater";
import { checkForUpdate } from "../lib/updater";
import { settingsApi } from "@/lib/api";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface UpdateDownloadProgress {
  downloaded: number;
  total: number | null;
  phase?: "downloading" | "installing";
}

interface CheckUpdateOptions {
  showPrompt?: boolean;
  forcePrompt?: boolean;
}

interface UpdateContextValue {
  hasUpdate: boolean;
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  isUpdating: boolean;
  phase: UpdatePhase;
  progress: UpdateDownloadProgress | null;
  error: string | null;
  isPortable: boolean;
  isDismissed: boolean;
  isPromptOpen: boolean;
  autoCheckEnabled: boolean;
  checkUpdate: (options?: CheckUpdateOptions) => Promise<boolean>;
  startUpdate: () => Promise<boolean>;
  openUpdatePrompt: () => void;
  remindLater: () => void;
  ignoreUpdate: () => void;
  dismissUpdate: () => void;
  resetDismiss: () => void;
  setAutoCheckEnabled: (enabled: boolean) => void;
}

const UpdateContext = createContext<UpdateContextValue | undefined>(undefined);

export const UPDATE_STORAGE_KEYS = {
  autoCheck: "yuanhengswitch:update:autoCheck",
  ignoredVersion: "yuanhengswitch:update:ignoredVersion",
  legacyIgnoredVersion: "dismissedUpdateVersion",
  lastCheckAt: "yuanhengswitch:update:lastCheckAt",
  snoozeUntil: "yuanhengswitch:update:snoozeUntil",
} as const;

export const UPDATE_AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const UPDATE_STARTUP_DELAY_MS = 8 * 1000;
export const UPDATE_REMIND_LATER_MS = 24 * 60 * 60 * 1000;

const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function readIgnoredVersion(): string | null {
  let ignoredVersion = localStorage.getItem(UPDATE_STORAGE_KEYS.ignoredVersion);
  if (!ignoredVersion) {
    const legacy = localStorage.getItem(
      UPDATE_STORAGE_KEYS.legacyIgnoredVersion,
    );
    if (legacy) {
      localStorage.setItem(UPDATE_STORAGE_KEYS.ignoredVersion, legacy);
      localStorage.removeItem(UPDATE_STORAGE_KEYS.legacyIgnoredVersion);
      ignoredVersion = legacy;
    }
  }
  return ignoredVersion;
}

function readTimestamp(key: string): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPortable, setIsPortable] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const [autoCheckEnabledState, setAutoCheckEnabledState] = useState(
    () => localStorage.getItem(UPDATE_STORAGE_KEYS.autoCheck) !== "false",
  );
  const isCheckingRef = useRef(false);
  const isUpdatingRef = useRef(false);

  const isChecking = phase === "checking";
  const isUpdating = phase === "downloading" || phase === "installing";

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void settingsApi
      .isPortable()
      .then(setIsPortable)
      .catch((portableError) => {
        console.warn("[Update] Failed to detect portable mode", portableError);
      });
  }, []);

  const checkUpdate = useCallback(
    async ({
      showPrompt = true,
      forcePrompt = true,
    }: CheckUpdateOptions = {}) => {
      if (isCheckingRef.current || isUpdatingRef.current) return false;
      isCheckingRef.current = true;
      setPhase("checking");
      setError(null);

      try {
        const result = await checkForUpdate({ timeout: 30000 });
        localStorage.setItem(
          UPDATE_STORAGE_KEYS.lastCheckAt,
          String(Date.now()),
        );

        if (result.status === "up-to-date") {
          setHasUpdate(false);
          setUpdateInfo(null);
          setIsDismissed(false);
          setIsPromptOpen(false);
          setPhase("idle");
          return false;
        }

        const version = result.info.availableVersion;
        const ignoredVersion = readIgnoredVersion();
        const snoozeUntil = readTimestamp(UPDATE_STORAGE_KEYS.snoozeUntil);

        if (forcePrompt && ignoredVersion === version) {
          localStorage.removeItem(UPDATE_STORAGE_KEYS.ignoredVersion);
        }

        const ignored = !forcePrompt && ignoredVersion === version;
        const snoozed = !forcePrompt && snoozeUntil > Date.now();

        setHasUpdate(true);
        setUpdateInfo(result.info);
        setIsDismissed(ignored);
        setPhase("available");
        if (showPrompt && !ignored && !snoozed) {
          setIsPromptOpen(true);
        }
        return true;
      } catch (checkError) {
        console.error("[Update] Failed to check for updates", checkError);
        localStorage.setItem(
          UPDATE_STORAGE_KEYS.lastCheckAt,
          String(Date.now()),
        );
        setError(
          checkError instanceof Error
            ? checkError.message
            : "Failed to check for updates",
        );
        setPhase("error");
        throw checkError;
      } finally {
        isCheckingRef.current = false;
      }
    },
    [],
  );

  useEffect(() => {
    if (!isTauriRuntime() || !autoCheckEnabledState) return;

    const lastCheckAt = readTimestamp(UPDATE_STORAGE_KEYS.lastCheckAt);
    const elapsed = Date.now() - lastCheckAt;
    const initialDelay =
      lastCheckAt === 0 || elapsed >= UPDATE_AUTO_CHECK_INTERVAL_MS
        ? UPDATE_STARTUP_DELAY_MS
        : Math.max(
            UPDATE_STARTUP_DELAY_MS,
            UPDATE_AUTO_CHECK_INTERVAL_MS - elapsed,
          );

    const runAutomaticCheck = () => {
      void checkUpdate({ showPrompt: true, forcePrompt: false }).catch(() => {
        // 自动检查失败保持静默，登录页和“关于”页面仍可手动重试。
      });
    };

    let intervalId: number | undefined;
    const timeoutId = window.setTimeout(() => {
      runAutomaticCheck();
      intervalId = window.setInterval(
        runAutomaticCheck,
        UPDATE_AUTO_CHECK_INTERVAL_MS,
      );
    }, initialDelay);

    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [autoCheckEnabledState, checkUpdate]);

  const startUpdate = useCallback(async () => {
    if (!updateInfo || isUpdatingRef.current || isCheckingRef.current)
      return false;
    isUpdatingRef.current = true;

    setError(null);
    setProgress(null);
    let unlisten: (() => void) | undefined;
    let restarting = false;

    try {
      if (isPortable) {
        await settingsApi.checkUpdates();
        setIsPromptOpen(false);
        return true;
      }

      setPhase("downloading");
      try {
        unlisten = await listen<UpdateDownloadProgress>(
          "update-download-progress",
          (event) => {
            const nextProgress = event.payload;
            setProgress(nextProgress);
            if (nextProgress.phase) {
              setPhase(nextProgress.phase);
            } else if (
              nextProgress.total &&
              nextProgress.downloaded >= nextProgress.total
            ) {
              setPhase("installing");
            }
          },
        );
      } catch (listenError) {
        console.warn(
          "[Update] Failed to listen for download progress",
          listenError,
        );
      }

      const installed = await settingsApi.installUpdateAndRestart();
      if (!installed) {
        setHasUpdate(false);
        setUpdateInfo(null);
        setIsPromptOpen(false);
        setPhase("idle");
        return false;
      }

      setPhase("installing");
      restarting = true;
      return true;
    } catch (installError) {
      console.error("[Update] Failed to install update", installError);
      setError(
        installError instanceof Error
          ? installError.message
          : typeof installError === "string" && installError.trim()
            ? installError
            : "Failed to install update",
      );
      setPhase("error");
      throw installError;
    } finally {
      unlisten?.();
      if (!restarting) isUpdatingRef.current = false;
    }
  }, [isPortable, updateInfo]);

  const openUpdatePrompt = useCallback(() => {
    if (!updateInfo) return;
    setIsPromptOpen(true);
  }, [updateInfo]);

  const remindLater = useCallback(() => {
    localStorage.setItem(
      UPDATE_STORAGE_KEYS.snoozeUntil,
      String(Date.now() + UPDATE_REMIND_LATER_MS),
    );
    setIsPromptOpen(false);
  }, []);

  const ignoreUpdate = useCallback(() => {
    if (updateInfo?.availableVersion) {
      localStorage.setItem(
        UPDATE_STORAGE_KEYS.ignoredVersion,
        updateInfo.availableVersion,
      );
    }
    localStorage.removeItem(UPDATE_STORAGE_KEYS.snoozeUntil);
    setIsDismissed(true);
    setIsPromptOpen(false);
  }, [updateInfo?.availableVersion]);

  const resetDismiss = useCallback(() => {
    setIsDismissed(false);
    localStorage.removeItem(UPDATE_STORAGE_KEYS.ignoredVersion);
    localStorage.removeItem(UPDATE_STORAGE_KEYS.legacyIgnoredVersion);
    localStorage.removeItem(UPDATE_STORAGE_KEYS.snoozeUntil);
  }, []);

  const setAutoCheckEnabled = useCallback((enabled: boolean) => {
    setAutoCheckEnabledState(enabled);
    localStorage.setItem(UPDATE_STORAGE_KEYS.autoCheck, String(enabled));
  }, []);

  const value = useMemo<UpdateContextValue>(
    () => ({
      hasUpdate,
      updateInfo,
      isChecking,
      isUpdating,
      phase,
      progress,
      error,
      isPortable,
      isDismissed,
      isPromptOpen,
      autoCheckEnabled: autoCheckEnabledState,
      checkUpdate,
      startUpdate,
      openUpdatePrompt,
      remindLater,
      ignoreUpdate,
      dismissUpdate: ignoreUpdate,
      resetDismiss,
      setAutoCheckEnabled,
    }),
    [
      autoCheckEnabledState,
      checkUpdate,
      error,
      hasUpdate,
      ignoreUpdate,
      isChecking,
      isDismissed,
      isPortable,
      isPromptOpen,
      isUpdating,
      openUpdatePrompt,
      phase,
      progress,
      remindLater,
      resetDismiss,
      setAutoCheckEnabled,
      startUpdate,
      updateInfo,
    ],
  );

  return (
    <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
  );
}

export function useUpdate() {
  const context = useContext(UpdateContext);
  if (!context) {
    throw new Error("useUpdate must be used within UpdateProvider");
  }
  return context;
}
