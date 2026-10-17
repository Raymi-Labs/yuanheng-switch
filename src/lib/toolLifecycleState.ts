import { useSyncExternalStore } from "react";

export type ToolLifecyclePhase =
  | "installing"
  | "updating"
  | "verifying"
  | "cancelling"
  | "external-install";
export interface ToolInstallProgress {
  stage:
    | "preparing"
    | "resolving"
    | "download"
    | "checksum"
    | "extract"
    | "package"
    | "verify"
    | "publishing"
    | "executing";
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  activity?: boolean;
}
export interface ToolInstallDetails extends ToolInstallProgress {
  startedAt: number;
  lastActivityAt: number;
}
let progressSnapshot: ReadonlyMap<string, ToolInstallDetails> = new Map();
const getProgressSnapshot = () => progressSnapshot;
export const useToolInstallProgress = () =>
  useSyncExternalStore(subscribe, getProgressSnapshot, getProgressSnapshot);

let snapshot: ReadonlyMap<string, ToolLifecyclePhase> = new Map();
const listeners = new Set<() => void>();
const cancelHandlers = new Map<string, () => Promise<boolean>>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => snapshot;
export const useToolLifecycleState = () =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
export const isToolLifecycleBusy = (tool: string) => snapshot.has(tool);
export const canCancelToolInstall = (tool: string) =>
  snapshot.get(tool) === "installing" && cancelHandlers.has(tool);

export async function cancelToolInstall(tool: string) {
  const cancel = cancelHandlers.get(tool);
  if (!cancel || !canCancelToolInstall(tool)) return false;
  return cancel();
}

/** Shared by all entry points; the lock is synchronous, before the first await. */
export async function runToolLifecycleJob(
  tools: string[],
  action: "install" | "update",
  execute: (
    setCancel: (cancel?: () => Promise<boolean>) => void,
    reportProgress: (progress: ToolInstallProgress) => void,
  ) => Promise<void>,
  verify?: () => Promise<void>,
) {
  const targets = [...new Set(tools)];
  if (targets.some(isToolLifecycleBusy))
    throw new Error("该工具正在安装或更新，请等待当前任务完成");
  const publish = (phase?: ToolLifecyclePhase) => {
    const next = new Map(snapshot);
    const details = new Map(progressSnapshot);
    const now = Date.now();
    for (const tool of targets) {
      if (phase) {
        next.set(tool, phase);
        const previous = details.get(tool);
        details.set(
          tool,
          previous
            ? {
                ...previous,
                lastActivityAt:
                  snapshot.get(tool) === phase ? previous.lastActivityAt : now,
              }
            : { stage: "preparing", startedAt: now, lastActivityAt: now },
        );
      } else {
        next.delete(tool);
        details.delete(tool);
      }
    }
    snapshot = next;
    progressSnapshot = details;
    listeners.forEach((listener) => listener());
  };
  publish(action === "install" ? "installing" : "updating");
  let active = true;
  let cancelling = false;
  const reportProgress = (progress: ToolInstallProgress) => {
    if (!active || cancelling) return;
    const next = new Map(progressSnapshot);
    for (const tool of targets) {
      const previous = next.get(tool);
      if (!previous) continue;
      const changed =
        previous.stage !== progress.stage ||
        previous.downloadedBytes !== progress.downloadedBytes;
      next.set(tool, {
        ...progress,
        startedAt: previous.startedAt,
        lastActivityAt:
          progress.activity || changed ? Date.now() : previous.lastActivityAt,
      });
    }
    progressSnapshot = next;
    listeners.forEach((listener) => listener());
  };
  const clearCancel = () =>
    targets.forEach((tool) => cancelHandlers.delete(tool));
  const setCancel = (cancel?: () => Promise<boolean>) => {
    if (!active || action !== "install") return;
    if (!cancel) {
      clearCancel();
      publish("external-install");
      return;
    }
    const request = async () => {
      if (!active || cancelling) return false;
      cancelling = true;
      publish("cancelling");
      try {
        const accepted = await cancel();
        // A late acknowledgement must never resurrect a completed/new job.
        if (active && !accepted) {
          cancelling = false;
          publish("installing");
        }
        return accepted;
      } catch (error) {
        if (active) {
          cancelling = false;
          publish("installing");
        }
        throw error;
      }
    };
    targets.forEach((tool) => cancelHandlers.set(tool, request));
    publish("installing");
  };
  try {
    await execute(setCancel, reportProgress);
    clearCancel();
    active = false;
    if (verify) {
      publish("verifying");
      await verify();
    }
  } finally {
    active = false;
    clearCancel();
    publish();
  }
}
