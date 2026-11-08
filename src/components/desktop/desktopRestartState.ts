import type { YuanhengToolId } from "@/lib/api";

const STORAGE_KEY = "yuanheng.desktop-restart-required";
const listeners = new Set<() => void>();

const canUseSessionStorage = () => typeof window !== "undefined";

export const requiresRestartAfterConfiguration = (app: YuanhengToolId) =>
  app === "chatgpt-desktop";

export function getRestartRequiredApps(): Set<YuanhengToolId> {
  if (!canUseSessionStorage()) return new Set();
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY);
    return new Set(value ? (JSON.parse(value) as YuanhengToolId[]) : []);
  } catch {
    return new Set();
  }
}

function writeRestartRequiredApps(apps: Set<YuanhengToolId>) {
  if (canUseSessionStorage()) {
    if (apps.size > 0) {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...apps]));
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  }
  listeners.forEach((listener) => listener());
}

export function markRestartRequired(
  app: YuanhengToolId,
  accountModeChanged = false,
) {
  if (
    !requiresRestartAfterConfiguration(app) &&
    !(accountModeChanged && app === "claude-desktop")
  )
    return;
  const apps = getRestartRequiredApps();
  apps.add(app);
  writeRestartRequiredApps(apps);
}

export function clearRestartRequired(app: YuanhengToolId) {
  const apps = getRestartRequiredApps();
  if (!apps.delete(app)) return;
  writeRestartRequiredApps(apps);
}

export function subscribeRestartRequired(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
