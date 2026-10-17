import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Settings,
  WebDavSyncSettings,
  S3SyncSettings,
  RemoteSnapshotInfo,
} from "@/types";
import type { AppId } from "./types";
import { createSingleFlight } from "@/lib/singleFlight";
import {
  invalidateToolDetection,
  toolDetectionEpoch,
} from "@/lib/toolDetectionEpoch";
import {
  runToolLifecycleJob,
  type ToolInstallProgress,
} from "@/lib/toolLifecycleState";

const toolDetectionFlight = createSingleFlight();
function detectionKey(
  command: string,
  tools?: string[],
  preferences?: Record<string, unknown>,
) {
  return JSON.stringify([
    command,
    toolDetectionEpoch(),
    tools ? [...new Set(tools)].sort() : null,
    Object.entries(preferences ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

export interface ConfigTransferResult {
  success: boolean;
  message: string;
  filePath?: string;
  backupId?: string;
}

export interface WebDavTestResult {
  success: boolean;
  message?: string;
}

export interface CodexUnifyHistoryRestoreResult {
  restoredJsonlFiles: number;
  restoredStateRows: number;
  /** 还原被跳过的原因（如当前目录没有账本）；存在时不应报成功 */
  skippedReason?: string;
}

export type CodexHistoryMigrationStatus =
  | "preview"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "rolled_back";

export interface CodexHistoryMigrationPreview {
  ordinarySessions: number;
  archivedSessions: number;
  activeSessions: number;
  databaseRows: number;
  physicalFiles: number;
  totalCount: number;
  providerCounts: Record<string, number>;
}

export interface CodexHistoryMigrationValidation {
  totalCountUnchanged: boolean;
  conversationIdsUnchanged: boolean;
  rolloutFilesExist: boolean;
  sqliteIntegrityOk: boolean;
  duplicateSessionIds: number;
  duplicateSessionIdsUnchanged: boolean;
  orphanStateRows: number;
  orphanStateRowsUnchanged: boolean;
  archiveCountUnchanged: boolean;
}

export interface CodexHistoryMigrationTask {
  migrationId: string;
  sourceProviderIds: string[];
  targetNamespace: string;
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  status: CodexHistoryMigrationStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  preview: CodexHistoryMigrationPreview;
  pendingFiles: string[];
  backupDir?: string;
  validation?: CodexHistoryMigrationValidation;
  rollbackRequested: boolean;
}

export type CodexHistoryMigrationTaskPayload = Omit<
  CodexHistoryMigrationTask,
  "preview" | "sourceProviderIds" | "pendingFiles"
> & {
  sourceProviderIds?: string[] | null;
  pendingFiles?: string[] | null;
  preview?: Partial<CodexHistoryMigrationPreview> | null;
};

/**
 * Normalize migration payloads from older clients/backends. Rust omits empty
 * vectors with `skip_serializing_if`, while the UI treats these collections as
 * always-present arrays.
 */
export function normalizeCodexHistoryMigrationTask(
  task: CodexHistoryMigrationTaskPayload | null | undefined,
): CodexHistoryMigrationTask | null {
  if (!task) return null;

  return {
    ...task,
    sourceProviderIds: task.sourceProviderIds ?? [],
    pendingFiles: task.pendingFiles ?? [],
    preview: {
      ordinarySessions: 0,
      archivedSessions: 0,
      activeSessions: 0,
      databaseRows: 0,
      physicalFiles: 0,
      totalCount: 0,
      ...(task.preview ?? {}),
      providerCounts: task.preview?.providerCounts ?? {},
    },
  };
}

export interface WebDavSyncResult {
  status: string;
}

export interface ToolVersionInfo {
  name: string;
  version: string | null;
  latest_version: string | null;
  error: string | null;
  installed_but_broken: boolean;
  env_type: "windows" | "wsl" | "macos" | "linux" | "unknown";
  wsl_distro: string | null;
  install_path: string | null;
  detection_source:
    | "managed"
    | "automatic"
    | "registry"
    | "microsoft_store"
    | "shortcut"
    | "running"
    | "custom"
    | "not_found"
    | null;
  custom_path: string | null;
  custom_path_valid: boolean;
}

export const settingsApi = {
  async get(): Promise<Settings> {
    return await invoke("get_settings");
  },

  async save(settings: Settings): Promise<boolean> {
    return await invoke("save_settings", { settings });
  },

  /** 是否存在统一 Codex 会话历史的迁移备份（关闭弹窗据此显示"恢复备份"勾选） */
  async hasCodexUnifyHistoryBackup(): Promise<boolean> {
    return await invoke("has_codex_unify_history_backup");
  },

  /** 按迁移备份账本把当时迁入共享桶的官方会话还原回 openai 桶（幂等） */
  async restoreCodexUnifiedHistory(): Promise<CodexUnifyHistoryRestoreResult> {
    return await invoke("restore_codex_unified_history");
  },

  async previewCodexHistoryMigration(): Promise<CodexHistoryMigrationTask> {
    return await invoke("preview_codex_history_migration");
  },

  async getCodexHistoryMigrationStatus(): Promise<CodexHistoryMigrationTask | null> {
    return await invoke("get_codex_history_migration_status");
  },

  async startCodexHistoryMigration(): Promise<CodexHistoryMigrationTask> {
    return await invoke("start_codex_history_migration");
  },

  async resumeCodexHistoryMigration(): Promise<CodexHistoryMigrationTask> {
    return await invoke("resume_codex_history_migration");
  },

  async rollbackCodexHistoryMigration(): Promise<CodexHistoryMigrationTask> {
    return await invoke("rollback_codex_history_migration");
  },

  async restart(): Promise<boolean> {
    return await invoke("restart_app");
  },

  async installUpdateAndRestart(): Promise<boolean> {
    return await invoke("install_update_and_restart");
  },

  async checkUpdates(): Promise<void> {
    await invoke("check_for_updates");
  },

  async isPortable(): Promise<boolean> {
    return await invoke("is_portable_mode");
  },

  async getConfigDir(appId: AppId): Promise<string> {
    return await invoke("get_config_dir", { app: appId });
  },

  async openConfigFolder(appId: AppId): Promise<void> {
    await invoke("open_config_folder", { app: appId });
  },

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    return await invoke("pick_directory", { defaultPath });
  },

  async selectConfigDirectory(defaultPath?: string): Promise<string | null> {
    return await invoke("pick_directory", { defaultPath });
  },

  async getClaudeCodeConfigPath(): Promise<string> {
    return await invoke("get_claude_code_config_path");
  },

  async getAppConfigPath(): Promise<string> {
    return await invoke("get_app_config_path");
  },

  async openAppConfigFolder(): Promise<void> {
    await invoke("open_app_config_folder");
  },

  async getAppConfigDirOverride(): Promise<string | null> {
    return await invoke("get_app_config_dir_override");
  },

  async setAppConfigDirOverride(path: string | null): Promise<boolean> {
    return await invoke("set_app_config_dir_override", { path });
  },

  async applyClaudePluginConfig(options: {
    official: boolean;
  }): Promise<boolean> {
    const { official } = options;
    return await invoke("apply_claude_plugin_config", { official });
  },

  async applyClaudeOnboardingSkip(): Promise<boolean> {
    return await invoke("apply_claude_onboarding_skip");
  },

  async clearClaudeOnboardingSkip(): Promise<boolean> {
    return await invoke("clear_claude_onboarding_skip");
  },

  async saveFileDialog(defaultName: string): Promise<string | null> {
    return await invoke("save_file_dialog", { defaultName });
  },

  async openFileDialog(): Promise<string | null> {
    return await invoke("open_file_dialog");
  },

  async exportConfigToFile(filePath: string): Promise<ConfigTransferResult> {
    return await invoke("export_config_to_file", { filePath });
  },

  async importConfigFromFile(filePath: string): Promise<ConfigTransferResult> {
    return await invoke("import_config_from_file", { filePath });
  },

  // ─── WebDAV sync ──────────────────────────────────────────

  async webdavTestConnection(
    settings: WebDavSyncSettings,
    preserveEmptyPassword = true,
  ): Promise<WebDavTestResult> {
    return await invoke("webdav_test_connection", {
      settings,
      preserveEmptyPassword,
    });
  },

  async webdavSyncUpload(): Promise<WebDavSyncResult> {
    return await invoke("webdav_sync_upload");
  },

  async webdavSyncDownload(): Promise<WebDavSyncResult> {
    return await invoke("webdav_sync_download");
  },

  async webdavSyncSaveSettings(
    settings: WebDavSyncSettings,
    passwordTouched = false,
  ): Promise<{ success: boolean }> {
    return await invoke("webdav_sync_save_settings", {
      settings,
      passwordTouched,
    });
  },

  async webdavSyncFetchRemoteInfo(): Promise<
    RemoteSnapshotInfo | { empty: true }
  > {
    return await invoke("webdav_sync_fetch_remote_info");
  },

  // ===== S3 Sync API =====

  async s3TestConnection(
    settings: S3SyncSettings,
    preserveEmptyPassword = true,
  ): Promise<WebDavTestResult> {
    return await invoke("s3_test_connection", {
      settings,
      preserveEmptyPassword,
    });
  },

  async s3SyncUpload(): Promise<WebDavSyncResult> {
    return await invoke("s3_sync_upload");
  },

  async s3SyncDownload(): Promise<WebDavSyncResult> {
    return await invoke("s3_sync_download");
  },

  async s3SyncSaveSettings(
    settings: S3SyncSettings,
    passwordTouched: boolean,
  ): Promise<{ success: boolean }> {
    return await invoke("s3_sync_save_settings", {
      settings,
      passwordTouched,
    });
  },

  async s3SyncFetchRemoteInfo(): Promise<RemoteSnapshotInfo | { empty: true }> {
    return await invoke("s3_sync_fetch_remote_info");
  },

  async syncCurrentProvidersLive(): Promise<void> {
    const result = (await invoke("sync_current_providers_live")) as {
      success?: boolean;
      message?: string;
    };
    if (!result?.success) {
      throw new Error(result?.message || "Sync current providers failed");
    }
  },

  async openExternal(url: string): Promise<void> {
    try {
      const u = new URL(url);
      const scheme = u.protocol.replace(":", "").toLowerCase();
      if (scheme !== "http" && scheme !== "https") {
        throw new Error("Unsupported URL scheme");
      }
    } catch {
      throw new Error("Invalid URL");
    }
    await invoke("open_external", { url });
  },

  async setAutoLaunch(enabled: boolean): Promise<boolean> {
    return await invoke("set_auto_launch", { enabled });
  },

  async getAutoLaunchStatus(): Promise<boolean> {
    return await invoke("get_auto_launch_status");
  },

  async getToolVersions(
    tools?: string[],
    wslShellByTool?: Record<
      string,
      { wslShell?: string | null; wslShellFlag?: string | null }
    >,
  ): Promise<ToolVersionInfo[]> {
    const probeGeneration = toolDetectionEpoch();
    return toolDetectionFlight(
      detectionKey("full", tools, wslShellByTool),
      () =>
        invoke("get_tool_versions", { tools, wslShellByTool, probeGeneration }),
    );
  },

  /** 仅检测本机工具，不等待远程版本源。 */
  async getInstalledToolVersions(
    tools?: string[],
    wslShellByTool?: Record<
      string,
      { wslShell?: string | null; wslShellFlag?: string | null }
    >,
  ): Promise<ToolVersionInfo[]> {
    const probeGeneration = toolDetectionEpoch();
    return toolDetectionFlight(
      detectionKey("local", tools, wslShellByTool),
      () =>
        invoke("get_installed_tool_versions", {
          tools,
          wslShellByTool,
          probeGeneration,
        }),
    );
  },

  async pickDesktopAppPath(tool: string): Promise<string | null> {
    return await invoke("pick_desktop_app_path", { tool });
  },

  async clearDesktopAppPath(tool: string): Promise<boolean> {
    return await invoke("set_desktop_app_path", { tool, path: null });
  },

  async runToolLifecycleAction(
    tools: string[],
    action: "install" | "update",
    wslShellByTool?: Record<
      string,
      { wslShell?: string | null; wslShellFlag?: string | null }
    >,
  ): Promise<void> {
    // DSH updates install into staging with the same supervision and verification.
    // Other tools keep their existing update behavior.
    const supervised =
      action === "install" || (tools.length === 1 && tools[0] === "dsh");
    await runToolLifecycleJob(
      tools,
      supervised ? "install" : action,
      async (setCancel, reportProgress) => {
        const operationId = crypto.randomUUID();
        const native =
          supervised &&
          (await invoke<boolean>("native_tool_install_supported", { tools }));
        const progress = new Channel<ToolInstallProgress>();
        progress.onmessage = reportProgress;
        const execution = invoke<void>("run_tool_lifecycle_action", {
          tools,
          action,
          wslShellByTool,
          operationId,
          progress,
        });
        if (supervised) {
          setCancel(
            native
              ? () =>
                  invoke<boolean>("cancel_tool_installation", { operationId })
              : undefined,
          );
        }
        try {
          await execution;
        } finally {
          progress.onmessage = () => {};
          // Partial writes after failure/cancel invalidate negative detection cache too.
          invalidateToolDetection();
        }
      },
      supervised
        ? async () => {
            invalidateToolDetection();
            const versions = await settingsApi.getInstalledToolVersions(
              tools,
              wslShellByTool,
            );
            if (
              tools.some((tool) => {
                const detected = versions.find((item) => item.name === tool);
                return !detected?.version || detected.installed_but_broken;
              })
            ) {
              throw new Error(
                "安装命令已结束，但工具尚无法运行。请检查运行环境或重启客户端后重新检测，不要重复安装。",
              );
            }
          }
        : undefined,
    );
  },

  /** 探测各工具安装分布：枚举所有安装、标记冲突、生成锚定升级命令。
   *  诊断按钮、升级前确认、升级后补诊共用此命令，各取所需字段。 */
  async probeToolInstallations(
    tools: string[],
  ): Promise<ToolInstallationReport[]> {
    return await invoke("probe_tool_installations", { tools });
  },

  async getRectifierConfig(): Promise<RectifierConfig> {
    return await invoke("get_rectifier_config");
  },

  async setRectifierConfig(config: RectifierConfig): Promise<boolean> {
    return await invoke("set_rectifier_config", { config });
  },

  async getOptimizerConfig(): Promise<OptimizerConfig> {
    return await invoke("get_optimizer_config");
  },

  async setOptimizerConfig(config: OptimizerConfig): Promise<boolean> {
    return await invoke("set_optimizer_config", { config });
  },

  async getLogConfig(): Promise<LogConfig> {
    return await invoke("get_log_config");
  },

  async setLogConfig(config: LogConfig): Promise<boolean> {
    return await invoke("set_log_config", { config });
  },
};

/** 单处工具安装的诊断信息（多处安装冲突检测）。字段对应后端 ToolInstallation。 */
export interface ToolInstallation {
  path: string;
  version: string | null;
  runnable: boolean;
  error: string | null;
  source: string;
  is_path_default: boolean;
}

/** 一次"探测工具安装分布"的结果。字段对应后端 ToolInstallationReport。 */
export interface ToolInstallationReport {
  tool: string;
  installs: ToolInstallation[];
  is_conflict: boolean;
  needs_confirmation: boolean;
  command: string;
  anchored: boolean;
}

export interface RectifierConfig {
  enabled: boolean;
  requestThinkingSignature: boolean;
  requestThinkingBudget: boolean;
  requestMediaFallback: boolean;
  requestMediaHeuristic: boolean;
}

export interface OptimizerConfig {
  enabled: boolean;
  thinkingOptimizer: boolean;
  cacheInjection: boolean;
}

export interface LogConfig {
  enabled: boolean;
  level: "error" | "warn" | "info" | "debug" | "trace";
}

export interface BackupEntry {
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

export const backupsApi = {
  async createDbBackup(): Promise<string> {
    return await invoke("create_db_backup");
  },

  async listDbBackups(): Promise<BackupEntry[]> {
    return await invoke("list_db_backups");
  },

  async restoreDbBackup(filename: string): Promise<string> {
    return await invoke("restore_db_backup", { filename });
  },

  async renameDbBackup(oldFilename: string, newName: string): Promise<string> {
    return await invoke("rename_db_backup", { oldFilename, newName });
  },

  async deleteDbBackup(filename: string): Promise<void> {
    await invoke("delete_db_backup", { filename });
  },
};
