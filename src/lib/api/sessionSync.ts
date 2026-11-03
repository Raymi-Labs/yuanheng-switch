import { invoke } from "@tauri-apps/api/core";

export interface SessionSyncScope {
  projectDir?: string | null;
  sourceProviders?: string[];
  maxAgeDays?: number | null;
  maxPerDirectory?: number | null;
  minTurns?: number | null;
}

export interface PendingSource {
  sourceProvider: string;
  pending: number;
  diverged: number;
}

export interface PendingDirectory {
  projectDir: string;
  label: string;
  sources: PendingSource[];
  total: number;
}

export interface PendingSummary {
  targetProvider: string;
  directories: PendingDirectory[];
  total: number;
}

export interface SessionSyncOutcome {
  targetProvider: string;
  synced: number;
  updated: number;
  skippedDiverged: number;
  skippedUnchanged: number;
  failed: number;
  errors: string[];
}

export interface SyncedTarget {
  targetProvider: string;
  targetSessionId: string;
  status: "synced" | "diverged" | string;
  syncedAt: number;
}

export interface SessionSyncState {
  providerId: string;
  sessionId: string;
  originProvider?: string;
  originSessionId?: string;
  syncedTo: SyncedTarget[];
}

export const sessionSyncApi = {
  async targets(): Promise<string[]> {
    return invoke("get_session_sync_targets");
  },

  async check(
    targetProvider: string,
    scope?: SessionSyncScope,
  ): Promise<PendingSummary> {
    return invoke("check_session_sync", { targetProvider, scope });
  },

  async run(
    targetProvider: string,
    scope?: SessionSyncScope,
  ): Promise<SessionSyncOutcome> {
    return invoke("run_session_sync", { targetProvider, scope });
  },

  async undo(
    targetProvider: string,
    targetSessionId: string,
  ): Promise<boolean> {
    return invoke("undo_session_sync", { targetProvider, targetSessionId });
  },

  async states(): Promise<SessionSyncState[]> {
    return invoke("list_session_sync_states");
  },
};

/** 默认范围与后端常量一致；仅用于 UI 文案说明。 */
export const SESSION_SYNC_DEFAULTS = {
  maxAgeDays: 90,
  maxPerDirectory: 100,
  minTurns: 2,
} as const;

export const sessionSyncStateKey = (providerId: string, sessionId: string) =>
  `${providerId}:${sessionId}`;
