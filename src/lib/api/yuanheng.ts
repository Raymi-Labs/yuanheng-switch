import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";
import {
  ensureClaudeWorkspaceReady,
  ClaudeWorkspaceDeferredError,
} from "@/lib/claudeWorkspaceSetup";

export type YuanhengToolId =
  | AppId
  | "chatgpt-desktop"
  | "workbuddy"
  | "dsh"
  | "accio-work";

export const YUANHENG_CLI_TOOLS = [
  "claude",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "openclaw",
  "hermes",
] as const satisfies readonly YuanhengToolId[];

export type YuanhengCliToolId = (typeof YUANHENG_CLI_TOOLS)[number];

export const isYuanhengCliTool = (
  app: YuanhengToolId,
): app is YuanhengCliToolId => YUANHENG_CLI_TOOLS.some((tool) => tool === app);

export interface YuanhengAccount {
  username: string;
  displayName: string;
  group: string;
  remainingUsd: number;
  usedUsd: number;
}

export interface YuanhengGroupOption {
  id: string;
  description: string;
  ratio: number | null;
}

export type YuanhengAnnouncementType =
  | "default"
  | "ongoing"
  | "success"
  | "warning"
  | "error";

export interface YuanhengAnnouncement {
  id: string;
  content: string;
  extra: string | null;
  publishDate: string;
  type: YuanhengAnnouncementType;
}

export interface YuanhengAnnouncementFeed {
  enabled: boolean;
  announcements: YuanhengAnnouncement[];
  source: "platform" | "legacy";
}

export interface YuanhengModelVendor {
  id: string;
  name: string;
}

export interface YuanhengConnectionStatus {
  connected: boolean;
  sessionOnly?: boolean;
  baseUrl: string;
  userId: string | null;
  account: YuanhengAccount | null;
  models: string[];
  terminalModels?: string[];
  imageGenerationModels?: string[];
  groups: YuanhengGroupOption[];
  modelGroups: Record<string, string[]>;
  modelVendors?: Record<string, YuanhengModelVendor>;
  reasoningLevels: Record<string, YuanhengReasoningLevel[]>;
  reasoningDefaults?: Record<string, YuanhengReasoningLevel>;
  announcement: string | null;
  lastSyncedAt: number | null;
}

export function yuanhengTerminalModels(
  connection?: YuanhengConnectionStatus,
): string[] {
  return connection?.terminalModels ?? connection?.models ?? [];
}

export interface YuanhengAuthResult {
  requiresTwoFactor: boolean;
  connection: YuanhengConnectionStatus | null;
}

export type YuanhengReasoningLevel =
  | "auto"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface AccioReleaseStatus {
  latestVersion: string | null;
  latestVerified: boolean;
  checkedAt: number | null;
  stale: boolean;
  error: string | null;
}

export function accioConfigurationBlocked(
  status?: YuanhengToolStatus,
): boolean {
  return (
    status?.app === "accio-work" &&
    !!status.accioCompatibility &&
    status.accioCompatibility.state !== "verified_version"
  );
}

export interface YuanhengToolStatus {
  accioCompatibility?: {
    installedVersion: string | null;
    supportedVersions: string[];
    state: "verified_version" | "unverified_version" | "unavailable";
  } | null;
  app: YuanhengToolId;
  supported: boolean;
  configured: boolean;
  needsUpdate: boolean;
  model: string | null;
  group?: string | null;
  reasoning?: YuanhengReasoningLevel | null;
  recommendedModel: string | null;
  message: string | null;
  runtimeWarning?: string | null;
  runtimeStatus?: YuanhengRuntimeStatus | null;
}

export interface YuanhengRuntimeStatus {
  state: "downloading" | "stalled";
  title: string;
  message: string;
  downloadedBytes: number;
  updatedAt: number;
}

export interface CodexSessionBridgeStatus {
  running: boolean;
  endpoint: string | null;
  connectedTerminals: number;
  appliedTerminals: number;
  pendingTerminals: number;
  model: string | null;
  reasoningEffort: string | null;
}

export type CodexAccountMode = "yuanheng" | "official" | "unknown";

export interface CodexAccountModeStatus {
  mode: CodexAccountMode;
  officialLoginAvailable: boolean;
  yuanhengAvailable: boolean;
  restartRequired: boolean;
  historyRepairNeeded?: boolean;
  historyConflicts?: string[];
  message: string | null;
}

export interface YuanhengPreflightCheck {
  id: string;
  status: "ok" | "warning" | "error";
  title: string;
  message: string;
}

export interface YuanhengToolPreflight {
  app: YuanhengToolId;
  model: string;
  group: string;
  status: "ok" | "warning" | "error";
  sourceProtocol: string;
  targetProtocol: string;
  streamingSupported: boolean;
  toolCall: "supported" | "unsupported" | "unknown";
  reasoningSupported: boolean;
  imageInput: "supported" | "unsupported" | "unknown";
  checks: YuanhengPreflightCheck[];
  message: string;
  requiresConfiguration?: boolean;
}

export interface YuanhengToolActivationStatus {
  app: YuanhengToolId;
  configuredAt: number | null;
  configWritten: boolean;
  routeRequired: boolean;
  routeReady: boolean;
  requestReceived: boolean;
  requestSucceeded: boolean;
  lastRequestAt: number | null;
  lastStatusCode: number | null;
  lastModel: string | null;
  message: string;
}

export interface YuanhengToolConfigureResult {
  app: YuanhengToolId;
  configured: boolean;
  model: string | null;
  warnings: string[];
  error: string | null;
}

export interface YuanhengDisconnectResult {
  disconnected: boolean;
  restoredTools: YuanhengToolId[];
  removedTools: YuanhengToolId[];
  retainedTools: YuanhengToolId[];
  warnings: string[];
}

export type YuanhengDiagnosticStatus = "ok" | "warning" | "error";

export interface YuanhengDiagnosticCheck {
  id: string;
  status: YuanhengDiagnosticStatus;
  title: string;
  message: string;
  action:
    | "login"
    | "repair_credentials"
    | "repair_tools"
    | "configure_tools"
    | null;
}

export interface YuanhengDiagnosticReport {
  status: YuanhengDiagnosticStatus;
  checkedAt: number;
  readyTools: number;
  attentionTools: YuanhengToolId[];
  checks: YuanhengDiagnosticCheck[];
  supportJson?: string | null;
  snapshotId?: string | null;
}

export function isCredentialAccessRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("YUANHENG_CREDENTIAL_ACCESS_REQUIRED:");
}

export const yuanhengApi = {
  getConnection(): Promise<YuanhengConnectionStatus> {
    return invoke("get_yuanheng_connection");
  },

  restoreKeychainAccess(): Promise<YuanhengConnectionStatus> {
    return invoke("restore_yuanheng_keychain_access");
  },

  getAnnouncement(): Promise<string | null> {
    return invoke("get_yuanheng_announcement");
  },

  getAnnouncements(): Promise<YuanhengAnnouncementFeed> {
    return invoke("get_yuanheng_announcements");
  },

  login(username: string, password: string): Promise<YuanhengAuthResult> {
    return invoke("login_yuanheng", { username, password });
  },

  register(username: string, password: string): Promise<YuanhengAuthResult> {
    return invoke("register_yuanheng", { username, password });
  },

  verifyTwoFactor(code: string): Promise<YuanhengAuthResult> {
    return invoke("verify_yuanheng_two_factor", { code });
  },

  refresh(): Promise<YuanhengConnectionStatus> {
    return invoke("refresh_yuanheng_connection");
  },

  rotateDeviceToken(): Promise<YuanhengConnectionStatus> {
    return invoke("rotate_yuanheng_device_token");
  },

  signOut(): Promise<boolean> {
    return invoke("sign_out_yuanheng");
  },

  disconnect(): Promise<YuanhengDisconnectResult> {
    return invoke("disconnect_yuanheng");
  },

  rollbackTools(): Promise<YuanhengDisconnectResult> {
    return invoke("rollback_yuanheng_tools");
  },

  openTopup(): Promise<boolean> {
    return invoke("open_yuanheng_topup");
  },

  openPulse(): Promise<boolean> {
    return invoke("open_yuanheng_pulse");
  },

  getToolStatuses(): Promise<YuanhengToolStatus[]> {
    return invoke("get_yuanheng_tool_statuses");
  },
  getAccioReleaseStatus(): Promise<AccioReleaseStatus> {
    return invoke("get_accio_release_status");
  },

  getToolActivationStatuses(): Promise<YuanhengToolActivationStatus[]> {
    return invoke("get_yuanheng_tool_activation_statuses");
  },

  preflightTool(
    app: YuanhengToolId,
    model: string,
    group?: string,
    reasoning?: YuanhengReasoningLevel,
  ): Promise<YuanhengToolPreflight> {
    return invoke("preflight_yuanheng_tool", {
      app,
      model,
      group,
      reasoning,
    });
  },

  getCodexSessionBridgeStatus(): Promise<CodexSessionBridgeStatus> {
    return invoke("get_codex_session_bridge_status");
  },

  getCodexAccountMode(): Promise<CodexAccountModeStatus> {
    return invoke("get_codex_account_mode");
  },

  switchCodexAccountMode(
    mode: Exclude<CodexAccountMode, "unknown">,
    expectedMode?: CodexAccountMode,
  ): Promise<CodexAccountModeStatus> {
    return invoke("switch_codex_account_mode", { mode, expectedMode });
  },

  getDiagnostics(): Promise<YuanhengDiagnosticReport> {
    return invoke("get_yuanheng_diagnostics");
  },

  getDiagnosticSnapshot(snapshotId: string): Promise<string> {
    return invoke("get_yuanheng_diagnostic_snapshot", { snapshotId });
  },

  exportDiagnostics(filePath: string, snapshotId: string): Promise<string> {
    return invoke("export_yuanheng_diagnostics", { filePath, snapshotId });
  },

  async configureTools(
    apps: YuanhengToolId[],
    models?: Partial<Record<YuanhengToolId, string>>,
    groups?: Partial<Record<YuanhengToolId, string>>,
    reasoning?: Partial<Record<YuanhengToolId, YuanhengReasoningLevel>>,
  ): Promise<YuanhengToolConfigureResult[]> {
    // Save the selected account/model/group through the existing transactional
    // path before a required reboot; no credentials go into the UI resume marker.
    const result = await invoke<YuanhengToolConfigureResult[]>(
      "configure_yuanheng_tools",
      {
        apps,
        models,
        groups,
        reasoning,
      },
    );
    if (
      result.some((item) => item.app === "claude-desktop" && item.configured)
    ) {
      try {
        await ensureClaudeWorkspaceReady();
      } catch (error) {
        throw new ClaudeWorkspaceDeferredError(
          `Claude 配置已保存，运行环境尚未准备完成。${error instanceof Error ? error.message : "请在准备窗口中继续。"}`,
        );
      }
    }
    return result;
  },

  getLaunchDirectory(app: YuanhengToolId): Promise<string | null> {
    return invoke("get_tool_launch_cwd", { tool: app });
  },

  setLaunchDirectory(app: YuanhengToolId, cwd: string): Promise<string> {
    return invoke("set_tool_launch_cwd", { tool: app, cwd });
  },

  async launchTool(
    app: YuanhengToolId | "dsh-web",
    restart = false,
    cwd?: string,
  ): Promise<boolean> {
    if (
      app === "accio-work" &&
      !(await window.confirm(
        "Accio Work 实验性接入：主模型走元衡；插件目录和连接状态由官方账号服务提供，云端业务工具尚未接入。官方应用仍可能联网登录、发送设备遥测或工作区路径；这不是完全离线模式。请先保存工作并退出已运行的 Accio。继续启动？",
      ))
    ) {
      throw new Error("已取消启动 Accio Work");
    }
    if (app === "claude-desktop") await ensureClaudeWorkspaceReady();
    return invoke(
      "launch_tool",
      cwd ? { tool: app, restart, cwd } : { tool: app, restart },
    );
  },
};
