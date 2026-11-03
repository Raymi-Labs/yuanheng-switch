import { http, HttpResponse } from "msw";
import type { AppId } from "@/lib/api/types";
import type { YuanhengToolId } from "@/lib/api/yuanheng";
import type { McpServer, Provider, Settings } from "@/types";
import {
  addProvider,
  deleteProvider,
  deleteSession,
  getCurrentProviderId,
  getLiveProviderIds,
  getSessionMessages,
  getProviders,
  listProviders,
  listSessions,
  getSessionSyncState,
  resetProviderState,
  setCurrentProviderId,
  updateProvider,
  updateSortOrder,
  getSettings,
  setSettings,
  getAppConfigDirOverride,
  setAppConfigDirOverrideState,
  getMcpConfig,
  setMcpServerEnabled,
  upsertMcpServer,
  deleteMcpServer,
  configureYuanhengTools,
  getYuanhengAnnouncements,
  getYuanhengConnection,
  getYuanhengToolStatuses,
  getToolLaunchDirectory,
  recordToolLaunch,
  recordToolRestart,
  setToolLaunchDirectory,
  setYuanhengConnection,
} from "./state";

const TAURI_ENDPOINT = "http://tauri.local";

const withJson = async <T>(request: Request): Promise<T> => {
  try {
    const body = await request.text();
    if (!body) return {} as T;
    return JSON.parse(body) as T;
  } catch {
    return {} as T;
  }
};

const success = <T>(payload: T) => HttpResponse.json(payload as any);

const authenticateYuanheng = (username: string) => {
  setYuanhengConnection({
    connected: true,
    userId: "1024",
    account: {
      username,
      displayName: username,
      group: "default",
      remainingUsd: 10,
      usedUsd: 1,
    },
    models: ["claude-sonnet-4-6", "gemini-3-pro", "gpt-5.6"],
    lastSyncedAt: Math.floor(Date.now() / 1000),
  });
  return {
    requiresTwoFactor: false,
    connection: getYuanhengConnection(),
  };
};

export const handlers = [
  http.post(`${TAURI_ENDPOINT}/get_desktop_release_notes`, () => success(null)),
  http.post(`${TAURI_ENDPOINT}/get_migration_result`, () => success(false)),
  http.post(`${TAURI_ENDPOINT}/get_yuanheng_connection`, () =>
    success(getYuanhengConnection()),
  ),
  http.post(`${TAURI_ENDPOINT}/get_yuanheng_announcement`, () =>
    success(getYuanhengConnection().announcement),
  ),
  http.post(`${TAURI_ENDPOINT}/get_yuanheng_announcements`, () =>
    success(getYuanhengAnnouncements()),
  ),
  http.post(`${TAURI_ENDPOINT}/get_codex_session_bridge_status`, () =>
    success({
      running: false,
      endpoint: null,
      connectedTerminals: 0,
      appliedTerminals: 0,
      pendingTerminals: 0,
      model: null,
      reasoningEffort: null,
    }),
  ),
  http.post(`${TAURI_ENDPOINT}/get_codex_account_mode`, () =>
    success({
      mode: "yuanheng",
      officialLoginAvailable: true,
      yuanhengAvailable: true,
      restartRequired: false,
      message: null,
    }),
  ),
  http.post(
    `${TAURI_ENDPOINT}/switch_codex_account_mode`,
    async ({ request }) => {
      const body = (await request.json()) as { mode?: string };
      return success({
        mode: body.mode ?? "unknown",
        officialLoginAvailable: true,
        yuanhengAvailable: true,
        restartRequired: true,
        message: null,
      });
    },
  ),
  http.post(`${TAURI_ENDPOINT}/get_usage_summary`, () =>
    success({
      totalRequests: 128,
      totalCost: "3.45",
      totalInputTokens: 82_000,
      totalOutputTokens: 21_000,
      totalCacheCreationTokens: 7_000,
      totalCacheReadTokens: 15_000,
      successRate: 0.984,
      realTotalTokens: 125_000,
      cacheHitRate: 0.42,
    }),
  ),
  http.post(`${TAURI_ENDPOINT}/login_yuanheng`, async ({ request }) => {
    const { username = "mock-user" } = await withJson<{ username?: string }>(
      request,
    );
    if (username === "twofactor") {
      return success({ requiresTwoFactor: true, connection: null });
    }
    return success(authenticateYuanheng(username));
  }),
  http.post(`${TAURI_ENDPOINT}/register_yuanheng`, async ({ request }) => {
    const { username = "mock-user" } = await withJson<{ username?: string }>(
      request,
    );
    return success(authenticateYuanheng(username));
  }),
  http.post(`${TAURI_ENDPOINT}/verify_yuanheng_two_factor`, () =>
    success(authenticateYuanheng("twofactor")),
  ),
  http.post(`${TAURI_ENDPOINT}/get_platform_pricing`, () =>
    success({
      fetchedAt: 1789080000,
      symbol: "⚡️",
      displayRate: "1",
      quotaPerUnit: "500000",
      selectedGroup: null,
      stale: false,
      syncError: null,
      groups: {},
      models: {},
    }),
  ),
  http.post(`${TAURI_ENDPOINT}/set_platform_quote_group`, () => success(null)),
  http.post(`${TAURI_ENDPOINT}/refresh_yuanheng_connection`, () =>
    success(getYuanhengConnection()),
  ),
  http.post(`${TAURI_ENDPOINT}/rotate_yuanheng_device_token`, () =>
    success(getYuanhengConnection()),
  ),
  http.post(`${TAURI_ENDPOINT}/disconnect_yuanheng`, () => {
    setYuanhengConnection({ connected: false });
    return success({
      disconnected: true,
      restoredTools: [],
      removedTools: [],
      retainedTools: [],
      warnings: [],
    });
  }),
  http.post(`${TAURI_ENDPOINT}/sign_out_yuanheng`, () => {
    setYuanhengConnection({ connected: false });
    return success(true);
  }),
  http.post(`${TAURI_ENDPOINT}/open_yuanheng_topup`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/get_yuanheng_tool_statuses`, () =>
    success(getYuanhengToolStatuses()),
  ),
  http.post(`${TAURI_ENDPOINT}/get_yuanheng_tool_activation_statuses`, () =>
    success(
      getYuanhengToolStatuses().map((status) => ({
        app: status.app,
        configuredAt: status.configured ? 1_700_000_000 : null,
        configWritten: status.configured,
        routeRequired: ["claude-desktop", "codex", "chatgpt-desktop"].includes(
          status.app,
        ),
        routeReady: status.configured,
        requestReceived: false,
        requestSucceeded: false,
        lastRequestAt: null,
        lastStatusCode: null,
        lastModel: null,
        message: status.configured
          ? "配置与路由已就绪，等待工具发出第一条请求"
          : "尚未写入有效配置",
      })),
    ),
  ),
  http.post(
    `${TAURI_ENDPOINT}/preflight_yuanheng_tool`,
    async ({ request }) => {
      const body = (await request.json()) as {
        app: string;
        model: string;
        group?: string;
      };
      return success({
        app: body.app,
        model: body.model,
        group: body.group ?? "default",
        status: "ok",
        sourceProtocol: "openai_responses",
        targetProtocol: "openai_responses",
        streamingSupported: true,
        toolCall: "unknown",
        reasoningSupported: true,
        imageInput: "unknown",
        checks: [],
        message: "兼容性预检通过，可以安全配置",
      });
    },
  ),
  http.post(`${TAURI_ENDPOINT}/get_yuanheng_diagnostics`, () => {
    const connection = getYuanhengConnection();
    const readyTools = getYuanhengToolStatuses().filter(
      (item) => item.configured,
    ).length;
    return success({
      status: connection.connected
        ? readyTools > 0
          ? "ok"
          : "warning"
        : "error",
      checkedAt: Math.floor(Date.now() / 1000),
      readyTools,
      attentionTools: [],
      checks: connection.connected
        ? [
            {
              id: "connection",
              status: "ok",
              title: "账号连接正常",
              message: "登录状态有效。",
              action: null,
            },
            {
              id: "credential",
              status: "ok",
              title: "API 连接正常",
              message: "本机凭据可访问模型接口。",
              action: null,
            },
            {
              id: "tools",
              status: readyTools > 0 ? "ok" : "warning",
              title: readyTools > 0 ? "工具配置正常" : "尚未配置 AI 工具",
              message:
                readyTools > 0
                  ? `${readyTools} 个工具已经就绪。`
                  : "选择本机已安装的工具后即可一键配置。",
              action: readyTools > 0 ? null : "configure_tools",
            },
          ]
        : [
            {
              id: "connection",
              status: "error",
              title: "尚未连接元衡",
              message: "登录后会自动检查。",
              action: "login",
            },
          ],
    });
  }),
  http.post(`${TAURI_ENDPOINT}/export_yuanheng_diagnostics`, () =>
    success("/tmp/yuanheng-diagnostics.json"),
  ),
  http.post(
    `${TAURI_ENDPOINT}/configure_yuanheng_tools`,
    async ({ request }) => {
      const {
        apps = [],
        models = {},
        groups = {},
        reasoning = {},
      } = await withJson<{
        apps?: YuanhengToolId[];
        models?: Partial<Record<YuanhengToolId, string>>;
        groups?: Partial<Record<YuanhengToolId, string>>;
        reasoning?: Partial<
          Record<
            YuanhengToolId,
            | "auto"
            | "none"
            | "minimal"
            | "low"
            | "medium"
            | "high"
            | "xhigh"
            | "max"
            | "ultra"
          >
        >;
      }>(request);
      return success(configureYuanhengTools(apps, models, groups, reasoning));
    },
  ),
  http.post(`${TAURI_ENDPOINT}/launch_tool`, async ({ request }) => {
    const {
      tool,
      restart = false,
      cwd,
    } = await withJson<{
      tool: YuanhengToolId;
      restart?: boolean;
      cwd?: string;
    }>(request);
    recordToolLaunch(tool, cwd);
    if (restart) recordToolRestart(tool);
    return success(true);
  }),
  http.post(`${TAURI_ENDPOINT}/get_tool_launch_cwd`, async ({ request }) => {
    const { tool } = await withJson<{ tool: YuanhengToolId }>(request);
    return success(getToolLaunchDirectory(tool));
  }),
  http.post(`${TAURI_ENDPOINT}/set_tool_launch_cwd`, async ({ request }) => {
    const { tool, cwd } = await withJson<{
      tool: YuanhengToolId;
      cwd: string;
    }>(request);
    return success(setToolLaunchDirectory(tool, cwd));
  }),
  http.post(`${TAURI_ENDPOINT}/get_installed_skills`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/inspect_skill_security`, () =>
    success({
      risk: "low",
      blocked: false,
      sourceTrust: "community",
      filesScanned: 1,
      executableFiles: 0,
      findings: [],
    }),
  ),
  http.post(`${TAURI_ENDPOINT}/scan_unmanaged_skills`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/discover_available_skills`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_skill_repos`, () => success([])),
  http.post(
    `${TAURI_ENDPOINT}/set_installed_skill_order`,
    async ({ request }) => {
      const { ids } = await withJson<{ ids: string[] }>(request);
      return success(ids);
    },
  ),
  http.post(`${TAURI_ENDPOINT}/get_mcp_servers`, () => success({})),
  http.post(`${TAURI_ENDPOINT}/get_prompts`, () => success({})),
  http.post(`${TAURI_ENDPOINT}/get_tool_versions`, async ({ request }) => {
    const { tools = [] } = await withJson<{ tools?: string[] }>(request);
    return success(
      tools.map((name) => ({
        name,
        version: "1.0.0",
        latest_version: "1.0.0",
        error: null,
        installed_but_broken: false,
        env_type: "macos",
        wsl_distro: null,
      })),
    );
  }),
  http.post(
    `${TAURI_ENDPOINT}/get_installed_tool_versions`,
    async ({ request }) => {
      const { tools = [] } = await withJson<{ tools?: string[] }>(request);
      return success(
        tools.map((name) => ({
          name,
          version: "1.0.0",
          latest_version: null,
          error: null,
          installed_but_broken: false,
          env_type: "macos",
          wsl_distro: null,
        })),
      );
    },
  ),
  http.post(`${TAURI_ENDPOINT}/get_skills_migration_result`, () =>
    success(null),
  ),
  http.post(`${TAURI_ENDPOINT}/get_providers`, async ({ request }) => {
    const { app } = await withJson<{ app: AppId }>(request);
    return success(getProviders(app));
  }),

  http.post(`${TAURI_ENDPOINT}/get_current_provider`, async ({ request }) => {
    const { app } = await withJson<{ app: AppId }>(request);
    return success(getCurrentProviderId(app));
  }),

  http.post(
    `${TAURI_ENDPOINT}/update_providers_sort_order`,
    async ({ request }) => {
      const { updates = [], app } = await withJson<{
        updates: { id: string; sortIndex: number }[];
        app: AppId;
      }>(request);
      updateSortOrder(app, updates);
      return success(true);
    },
  ),

  http.post(`${TAURI_ENDPOINT}/update_tray_menu`, () => success(true)),

  http.post(`${TAURI_ENDPOINT}/get_opencode_live_provider_ids`, () =>
    success(getLiveProviderIds("opencode")),
  ),

  http.post(`${TAURI_ENDPOINT}/get_openclaw_live_provider_ids`, () =>
    success(getLiveProviderIds("openclaw")),
  ),

  http.post(`${TAURI_ENDPOINT}/get_openclaw_default_model`, () =>
    success({ primary: null, fallback: [] }),
  ),

  http.post(`${TAURI_ENDPOINT}/scan_openclaw_config_health`, () => success([])),

  http.post(`${TAURI_ENDPOINT}/switch_provider`, async ({ request }) => {
    const { id, app } = await withJson<{ id: string; app: AppId }>(request);
    const providers = listProviders(app);
    if (!providers[id]) {
      return HttpResponse.json(false, { status: 404 });
    }
    setCurrentProviderId(app, id);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/add_provider`, async ({ request }) => {
    const { provider, app } = await withJson<{
      provider: Provider & { id?: string };
      app: AppId;
    }>(request);

    const newId = provider.id ?? `mock-${Date.now()}`;
    addProvider(app, { ...provider, id: newId });
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/update_provider`, async ({ request }) => {
    const { provider, app } = await withJson<{
      provider: Provider;
      app: AppId;
    }>(request);
    updateProvider(app, provider);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/delete_provider`, async ({ request }) => {
    const { id, app } = await withJson<{ id: string; app: AppId }>(request);
    deleteProvider(app, id);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/import_default_config`, async () => {
    resetProviderState();
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/open_external`, () => success(true)),

  http.post(`${TAURI_ENDPOINT}/list_sessions`, () => success(listSessions())),

  http.post(`${TAURI_ENDPOINT}/get_session_sync_targets`, () =>
    success(getSessionSyncState().targets),
  ),

  http.post(`${TAURI_ENDPOINT}/list_session_sync_states`, () =>
    success(getSessionSyncState().states),
  ),

  http.post(`${TAURI_ENDPOINT}/check_session_sync`, async ({ request }) => {
    const { targetProvider } = await withJson<{ targetProvider: string }>(
      request,
    );
    return success(
      getSessionSyncState().pending[targetProvider] ?? {
        targetProvider,
        directories: [],
        total: 0,
      },
    );
  }),

  http.post(`${TAURI_ENDPOINT}/run_session_sync`, async ({ request }) => {
    const body = await withJson<{ targetProvider: string; scope?: unknown }>(
      request,
    );
    getSessionSyncState().runCalls.push(body);
    return success({
      targetProvider: body.targetProvider,
      synced: 3,
      updated: 0,
      skippedDiverged: 0,
      skippedUnchanged: 0,
      failed: 0,
      errors: [],
    });
  }),

  http.post(`${TAURI_ENDPOINT}/undo_session_sync`, async ({ request }) => {
    const body = await withJson<{
      targetProvider: string;
      targetSessionId: string;
    }>(request);
    getSessionSyncState().undoCalls.push(body);
    return success(true);
  }),

  http.post(`${TAURI_ENDPOINT}/get_session_messages`, async ({ request }) => {
    const { providerId, sourcePath } = await withJson<{
      providerId: string;
      sourcePath: string;
    }>(request);
    return success(getSessionMessages(providerId, sourcePath));
  }),

  http.post(`${TAURI_ENDPOINT}/delete_session`, async ({ request }) => {
    const { providerId, sessionId, sourcePath } = await withJson<{
      providerId: string;
      sessionId: string;
      sourcePath: string;
    }>(request);
    return success(deleteSession(providerId, sessionId, sourcePath));
  }),

  http.post(`${TAURI_ENDPOINT}/delete_sessions`, async ({ request }) => {
    const { items = [] } = await withJson<{
      items?: {
        providerId: string;
        sessionId: string;
        sourcePath: string;
      }[];
    }>(request);

    return success(
      items.map((item) => ({
        providerId: item.providerId,
        sessionId: item.sessionId,
        sourcePath: item.sourcePath,
        success: deleteSession(
          item.providerId,
          item.sessionId,
          item.sourcePath,
        ),
      })),
    );
  }),

  // MCP APIs
  http.post(`${TAURI_ENDPOINT}/get_mcp_config`, async ({ request }) => {
    const { app } = await withJson<{ app: AppId }>(request);
    return success(getMcpConfig(app));
  }),

  http.post(`${TAURI_ENDPOINT}/import_mcp_from_claude`, () => success(1)),
  http.post(`${TAURI_ENDPOINT}/import_mcp_from_codex`, () => success(1)),

  http.post(`${TAURI_ENDPOINT}/set_mcp_enabled`, async ({ request }) => {
    const { app, id, enabled } = await withJson<{
      app: AppId;
      id: string;
      enabled: boolean;
    }>(request);
    setMcpServerEnabled(app, id, enabled);
    return success(true);
  }),

  http.post(
    `${TAURI_ENDPOINT}/upsert_mcp_server_in_config`,
    async ({ request }) => {
      const { app, id, spec } = await withJson<{
        app: AppId;
        id: string;
        spec: McpServer;
      }>(request);
      upsertMcpServer(app, id, spec);
      return success(true);
    },
  ),

  http.post(
    `${TAURI_ENDPOINT}/delete_mcp_server_in_config`,
    async ({ request }) => {
      const { app, id } = await withJson<{ app: AppId; id: string }>(request);
      deleteMcpServer(app, id);
      return success(true);
    },
  ),

  http.post(`${TAURI_ENDPOINT}/restart_app`, () => success(true)),

  http.post(`${TAURI_ENDPOINT}/get_settings`, () => success(getSettings())),

  http.post(`${TAURI_ENDPOINT}/check_env_conflicts`, () => success([])),

  http.post(`${TAURI_ENDPOINT}/save_settings`, async ({ request }) => {
    const { settings } = await withJson<{ settings: Settings }>(request);
    setSettings(settings);
    return success(true);
  }),

  http.post(
    `${TAURI_ENDPOINT}/set_app_config_dir_override`,
    async ({ request }) => {
      const { path } = await withJson<{ path: string | null }>(request);
      setAppConfigDirOverrideState(path ?? null);
      return success(true);
    },
  ),

  http.post(`${TAURI_ENDPOINT}/get_app_config_dir_override`, () =>
    success(getAppConfigDirOverride()),
  ),

  http.post(
    `${TAURI_ENDPOINT}/apply_claude_plugin_config`,
    async ({ request }) => {
      const { official } = await withJson<{ official: boolean }>(request);
      setSettings({ enableClaudePluginIntegration: !official });
      return success(true);
    },
  ),

  http.post(`${TAURI_ENDPOINT}/apply_claude_onboarding_skip`, () =>
    success(true),
  ),

  http.post(`${TAURI_ENDPOINT}/clear_claude_onboarding_skip`, () =>
    success(true),
  ),

  http.post(`${TAURI_ENDPOINT}/get_config_dir`, async ({ request }) => {
    const { app } = await withJson<{ app: AppId }>(request);
    return success(app === "claude" ? "/default/claude" : "/default/codex");
  }),

  http.post(`${TAURI_ENDPOINT}/is_portable_mode`, () => success(false)),

  http.post(
    `${TAURI_ENDPOINT}/select_config_directory`,
    async ({ request }) => {
      const { defaultPath, default_path } = await withJson<{
        defaultPath?: string;
        default_path?: string;
      }>(request);
      const initial = defaultPath ?? default_path;
      return success(initial ? `${initial}/picked` : "/mock/selected-dir");
    },
  ),

  http.post(`${TAURI_ENDPOINT}/pick_directory`, async ({ request }) => {
    const { defaultPath, default_path } = await withJson<{
      defaultPath?: string;
      default_path?: string;
    }>(request);
    const initial = defaultPath ?? default_path;
    return success(initial ? `${initial}/picked` : "/mock/selected-dir");
  }),

  http.post(`${TAURI_ENDPOINT}/open_file_dialog`, () =>
    success("/mock/import-settings.json"),
  ),

  http.post(
    `${TAURI_ENDPOINT}/import_config_from_file`,
    async ({ request }) => {
      const { filePath } = await withJson<{ filePath: string }>(request);
      if (!filePath) {
        return success({ success: false, message: "Missing file" });
      }
      setSettings({ language: "en" });
      return success({ success: true, backupId: "backup-123" });
    },
  ),

  http.post(`${TAURI_ENDPOINT}/export_config_to_file`, async ({ request }) => {
    const { filePath } = await withJson<{ filePath: string }>(request);
    if (!filePath) {
      return success({ success: false, message: "Invalid destination" });
    }
    return success({ success: true, filePath });
  }),

  http.post(`${TAURI_ENDPOINT}/save_file_dialog`, () =>
    success("/mock/export-settings.json"),
  ),

  // Sync current providers live (no-op success)
  http.post(`${TAURI_ENDPOINT}/sync_current_providers_live`, () =>
    success({ success: true }),
  ),

  // Proxy status (for SettingsPage / ProxyPanel hooks)
  http.post(`${TAURI_ENDPOINT}/get_proxy_status`, () =>
    success({
      running: false,
      address: "127.0.0.1",
      port: 0,
      active_connections: 0,
      total_requests: 0,
      success_requests: 0,
      failed_requests: 0,
      success_rate: 0,
      uptime_seconds: 0,
      current_provider: null,
      current_provider_id: null,
      last_request_at: null,
      last_error: null,
      failover_count: 0,
      active_targets: [],
    }),
  ),

  http.post(`${TAURI_ENDPOINT}/get_proxy_takeover_status`, () =>
    success({
      claude: false,
      codex: false,
      gemini: false,
      grokbuild: false,
    }),
  ),

  http.post(`${TAURI_ENDPOINT}/is_live_takeover_active`, () => success(false)),

  // Failover / circuit breaker defaults
  http.post(`${TAURI_ENDPOINT}/get_failover_queue`, () => success([])),
  http.post(`${TAURI_ENDPOINT}/get_available_providers_for_failover`, () =>
    success([]),
  ),
  http.post(`${TAURI_ENDPOINT}/add_to_failover_queue`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/remove_from_failover_queue`, () =>
    success(true),
  ),
  http.post(`${TAURI_ENDPOINT}/reorder_failover_queue`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/set_failover_item_enabled`, () => success(true)),

  http.post(`${TAURI_ENDPOINT}/get_circuit_breaker_config`, () =>
    success({
      failureThreshold: 3,
      successThreshold: 2,
      timeoutSeconds: 60,
      errorRateThreshold: 50,
      minRequests: 5,
    }),
  ),
  http.post(`${TAURI_ENDPOINT}/update_circuit_breaker_config`, () =>
    success(true),
  ),
  http.post(`${TAURI_ENDPOINT}/get_provider_health`, () =>
    success({
      provider_id: "mock-provider",
      app_type: "claude",
      is_healthy: true,
      consecutive_failures: 0,
      last_success_at: null,
      last_failure_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    }),
  ),
  http.post(`${TAURI_ENDPOINT}/reset_circuit_breaker`, () => success(true)),
  http.post(`${TAURI_ENDPOINT}/get_circuit_breaker_stats`, () => success(null)),
];
