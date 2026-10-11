import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  claudeWorkspaceSetup,
  ClaudeWorkspaceDeferredError,
} from "@/lib/claudeWorkspaceSetup";
import { isWindows } from "@/lib/platform";
import {
  Check,
  CheckCircle2,
  CircleOff,
  Download,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  isToolLifecycleBusy,
  useToolLifecycleState,
} from "@/lib/toolLifecycleState";
import { showToolInstallError, toolInstallLabel } from "./toolInstallFeedback";
import { ToolInstallCancel } from "./ToolInstallCancel";
import {
  type YuanhengConnectionStatus,
  type YuanhengReasoningLevel,
  type YuanhengToolId,
  isYuanhengCliTool,
  settingsApi,
  yuanhengApi,
  yuanhengTerminalModels,
} from "@/lib/api";
import {
  useConfigureYuanhengTools,
  useCodexAccountMode,
  usePreflightYuanhengTool,
  useRefreshYuanheng,
  useYuanhengConnection,
  useYuanhengToolStatuses,
} from "@/lib/query/yuanheng";
import {
  DESKTOP_TOOLS,
  isDesktopApp,
  toolLabel,
  toolIcon,
} from "@/config/desktopTools";
export {
  DESKTOP_TOOLS,
  isCoreApp,
  isDesktopApp,
  toolLabel,
} from "@/config/desktopTools";
import { ProviderIcon } from "@/components/ProviderIcon";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "./ModelPicker";
import { CompactSelectPicker } from "./CompactSelectPicker";
import { GroupPicker } from "./GroupPicker";
import { cn } from "@/lib/utils";
import { extractErrorMessage } from "@/utils/errorUtils";
import { dt } from "./desktopI18n";
import {
  launchDirectoryLabel,
  useToolLaunchDirectories,
} from "./useToolLaunchDirectories";
import {
  clearRestartRequired,
  markRestartRequired,
} from "./desktopRestartState";
import { useDesktopInstallFlow } from "./useDesktopInstallFlow";
import { clearToolInventoryCache } from "./toolInventoryCache";
import { useToolInventory } from "@/lib/query/toolInventory";
import {
  pickPreferredGroup,
  resolveToolSetupSelection,
} from "./toolSetupSelection";
import { useInstallContinuation } from "./useInstallContinuation";
export { pickPreferredGroup } from "./toolSetupSelection";

export const TOOL_COMMANDS: Partial<Record<YuanhengToolId, string>> = {
  claude: "claude",
  codex: "codex",
  "chatgpt-desktop": "chatgpt-desktop",
  workbuddy: "workbuddy",
  gemini: "gemini",
  grokbuild: "grok",
  opencode: "opencode",
  openclaw: "openclaw",
  hermes: "hermes",
  dsh: "dsh",
};

export const TOOL_VERSION_TARGETS: Partial<Record<YuanhengToolId, string>> = {
  ...TOOL_COMMANDS,
  dsh: "dsh",
  "claude-desktop": "claude-desktop",
};

export const DESKTOP_DOWNLOAD_URLS: Partial<Record<YuanhengToolId, string>> = {
  "claude-desktop": "https://claude.ai/download",
  "chatgpt-desktop": "https://openai.com/codex/",
  workbuddy: "https://www.codebuddy.cn/work/",
};

/** Detection alone never grants installation capability. Shared by both surfaces. */
export const canInstallTool = (app: YuanhengToolId) =>
  Boolean(TOOL_COMMANDS[app] || DESKTOP_DOWNLOAD_URLS[app]);

export const REASONING_LABELS: Record<YuanhengReasoningLevel, string> = {
  auto: "自动",
  none: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
  ultra: "极限",
};

export const reasoningLabel = (
  level: YuanhengReasoningLevel,
  defaultLevel?: YuanhengReasoningLevel,
) =>
  level === "auto" && defaultLevel
    ? dt("自动（默认：{{v0}}）", { v0: dt(REASONING_LABELS[defaultLevel]) })
    : dt(REASONING_LABELS[level]);

interface ToolSetupGridProps {
  activeApp?: YuanhengToolId;
  compact?: boolean;
  onSetActiveApp?: (app: YuanhengToolId) => void;
  onConfigured?: () => void;
}

export function ToolSetupGrid(props: ToolSetupGridProps) {
  const { data: connection } = useYuanhengConnection();
  return (
    <ToolSetupGridContent
      key={JSON.stringify([
        connection?.baseUrl,
        connection?.userId,
        connection?.connected,
      ])}
      {...props}
      connection={connection}
    />
  );
}

function ToolSetupGridContent({
  activeApp,
  compact = false,
  onSetActiveApp,
  onConfigured,
  connection,
}: ToolSetupGridProps & { connection?: YuanhengConnectionStatus }) {
  const installContinuation = useInstallContinuation(connection);
  const refreshConnection = useRefreshYuanheng();
  const statuses = useYuanhengToolStatuses();
  const configure = useConfigureYuanhengTools();
  const codexAccountMode = useCodexAccountMode();
  const preflight = usePreflightYuanhengTool();
  const desktopInstall = useDesktopInstallFlow();
  const workspaceSetup = useSyncExternalStore(
    claudeWorkspaceSetup.subscribe,
    claudeWorkspaceSetup.getSnapshot,
  );
  const cliLifecycle = useToolLifecycleState();
  const launchDirectoryState = useToolLaunchDirectories();
  const versions = useToolInventory();
  const [selected, setSelected] = useState<YuanhengToolId[]>([]);
  const [modelDrafts, setModels] = useState<
    Partial<Record<YuanhengToolId, string>>
  >({});
  const [groupDrafts, setGroups] = useState<
    Partial<Record<YuanhengToolId, string>>
  >({});
  const [reasoningDrafts, setReasoning] = useState<
    Partial<Record<YuanhengToolId, YuanhengReasoningLevel>>
  >({});
  const selectionInitialized = useRef(false);
  const actionLocked = useRef(false);
  const mounted = useRef(true);
  const [actionPending, setActionPending] = useState(false);
  const busy = actionPending || configure.isPending;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const beginAction = () => {
    if (
      actionLocked.current ||
      !connection?.connected ||
      !statuses.data ||
      statuses.isError
    )
      return false;
    actionLocked.current = true;
    setActionPending(true);
    return true;
  };
  const endAction = () => {
    actionLocked.current = false;
    if (mounted.current) setActionPending(false);
  };

  const versionMap = useMemo(
    () => new Map((versions.data ?? []).map((item) => [item.name, item])),
    [versions.data],
  );
  const statusMap = useMemo(
    () => new Map((statuses.data ?? []).map((item) => [item.app, item])),
    [statuses.data],
  );
  const tools = DESKTOP_TOOLS;
  // Drafts are only user edits; saved settings are read on every render.
  // This avoids arrival-order races and lets refreshes update untouched tools.
  const models: Partial<Record<YuanhengToolId, string>> = {};
  const groups: Partial<Record<YuanhengToolId, string>> = {};
  const reasoning: Partial<Record<YuanhengToolId, YuanhengReasoningLevel>> = {};
  for (const app of tools) {
    const selection = resolveToolSetupSelection(
      connection,
      statusMap.get(app),
      {
        model: modelDrafts[app],
        group: groupDrafts[app],
        reasoning: reasoningDrafts[app],
      },
    );
    models[app] = selection.model;
    groups[app] = selection.group;
    reasoning[app] = selection.reasoning;
  }
  const groupMap = useMemo(
    () => new Map((connection?.groups ?? []).map((group) => [group.id, group])),
    [connection?.groups],
  );
  const modelMeta = useMemo(
    () =>
      Object.fromEntries(
        yuanhengTerminalModels(connection).map((model) => [
          model,
          {
            groups: connection?.modelGroups[model]?.length ?? 0,
            reasoningLevels: connection?.reasoningLevels[model]?.length ?? 0,
            available: true,
          },
        ]),
      ),
    [connection],
  );

  useEffect(() => {
    if (selectionInitialized.current || !versions.data || !statuses.data)
      return;
    const defaults = tools.filter((app) => {
      if (isDesktopApp(app)) return false;
      const versionTarget = TOOL_VERSION_TARGETS[app];
      return Boolean(
        versionTarget &&
          versionMap.get(versionTarget)?.version &&
          statusMap.get(app)?.supported,
      );
    });
    setSelected(defaults);
    selectionInitialized.current = true;
  }, [statusMap, statuses.data, tools, versionMap, versions.data]);

  const isInstalled = (app: YuanhengToolId) => {
    const versionTarget = TOOL_VERSION_TARGETS[app];
    return Boolean(versionTarget && versionMap.get(versionTarget)?.version);
  };

  const compatibleModels = () => yuanhengTerminalModels(connection);

  const selectedReasoningFor = (app: YuanhengToolId, model?: string | null) => {
    const selected = reasoning[app] ?? "auto";
    const supported = model ? (connection?.reasoningLevels[model] ?? []) : [];
    return selected === "auto" || supported.includes(selected)
      ? selected
      : "auto";
  };

  const preflightApps = async (
    apps: YuanhengToolId[],
    overrides: Partial<Record<YuanhengToolId, string>> = {},
    groupOverrides: Partial<Record<YuanhengToolId, string>> = {},
  ) => {
    const checked = new Set<string>();
    let requiresConfiguration = false;
    for (const app of apps) {
      const model =
        overrides[app] ?? models[app] ?? statusMap.get(app)?.recommendedModel;
      if (!model)
        throw new Error(dt("{{v0}} 没有可用模型", { v0: toolLabel(app) }));
      const group = groupOverrides[app] ?? groups[app];
      if (!group) throw new Error(dt("请先选择令牌分组，再配置或启动。"));
      const selectedReasoning = selectedReasoningFor(app, model);
      const key = [app, model, group ?? "", selectedReasoning].join("\u0000");
      if (checked.has(key)) continue;
      checked.add(key);
      const result = await preflight.mutateAsync({
        app,
        model,
        group,
        reasoning: selectedReasoning,
      });
      if (!mounted.current) throw new Error("操作已取消");
      if (result.status === "error") {
        const failed = result.checks.find((check) => check.status === "error");
        throw new Error(failed?.message || result.message);
      }
      if (result.status === "warning") toast.info(result.message);
      requiresConfiguration ||= Boolean(result.requiresConfiguration);
    }
    return requiresConfiguration;
  };

  const configureApps = async (
    apps: YuanhengToolId[],
    canContinue = () => true,
  ) => {
    if (!beginAction()) return false;
    try {
      await preflightApps(apps);
      if (!canContinue()) return false;
      const selectedModels = Object.fromEntries(
        apps
          .map((app) => [app, models[app]])
          .filter((entry): entry is [YuanhengToolId, string] =>
            Boolean(entry[1]),
          ),
      ) as Partial<Record<YuanhengToolId, string>>;
      const results = await configure.mutateAsync({
        apps,
        models:
          Object.keys(selectedModels).length > 0 ? selectedModels : undefined,
        groups: Object.fromEntries(
          apps
            .map((app) => [app, groups[app]])
            .filter((entry): entry is [YuanhengToolId, string] =>
              Boolean(entry[1]),
            ),
        ),
        reasoning: Object.fromEntries(
          apps
            .map((app) => [app, selectedReasoningFor(app, models[app])])
            .filter(
              (entry): entry is [YuanhengToolId, YuanhengReasoningLevel] =>
                Boolean(entry[1]),
            ),
        ),
      });
      const succeeded = results.filter((item) => item.configured);
      const failed = results.filter((item) => !item.configured);
      if (succeeded.length > 0) {
        succeeded.forEach((item) => markRestartRequired(item.app));
        toast.success(
          dt("已完成 {{v0}} 个工具的元衡配置", { v0: succeeded.length }),
        );
        onConfigured?.();
      }
      if (failed.length > 0) {
        toast.error(
          failed
            .map((item) =>
              dt("{{v0}}：{{v1}}", {
                v0: toolLabel(item.app),
                v1: item.error ?? dt("配置失败"),
              }),
            )
            .join("；"),
        );
      }
      return succeeded.length > 0 && failed.length === 0;
    } catch (error) {
      if (error instanceof ClaudeWorkspaceDeferredError) {
        toast.info(error.message);
        onConfigured?.();
        return false;
      }
      toast.error(extractErrorMessage(error) || dt("工具配置失败"));
      return false;
    } finally {
      endAction();
    }
  };

  const applyCodexModel = async (model: string) => {
    if (!beginAction()) return;
    const previousModel = models.codex;
    const previousGroup = groups.codex;
    let group = previousGroup;
    const available = connection?.modelGroups[model] ?? [];
    if (
      model !== previousModel &&
      group &&
      available.length > 0 &&
      !available.includes(group)
    ) {
      const suggestion = pickPreferredGroup(connection, model);
      if (
        !suggestion ||
        !window.confirm(
          dt(
            "新模型的目录未包含原分组 {{old}}。是否改用 {{next}}？取消将保留原配置。",
            { old: group, next: suggestion },
          ),
        )
      ) {
        endAction();
        return;
      }
      group = suggestion;
    }
    const selectedReasoning = selectedReasoningFor("codex", model);
    setModels((current) => ({ ...current, codex: model }));
    setGroups((current) => {
      const next = { ...current };
      if (group) next.codex = group;
      else delete next.codex;
      return next;
    });
    try {
      await preflightApps(
        ["codex"],
        { codex: model },
        group ? { codex: group } : {},
      );
      const results = await configure.mutateAsync({
        apps: ["codex"],
        models: { codex: model },
        groups: group ? { codex: group } : undefined,
        reasoning: { codex: selectedReasoning },
      });
      const result = results.find((item) => item.app === "codex");
      if (!result?.configured)
        throw new Error(result?.error || dt("模型切换失败"));
      toast.success(dt("Codex 已切换到 {{v0}}，下一条消息生效", { v0: model }));
      onConfigured?.();
    } catch (error) {
      setModels((current) => ({ ...current, codex: previousModel }));
      setGroups((current) => {
        const next = { ...current };
        if (previousGroup) next.codex = previousGroup;
        else delete next.codex;
        return next;
      });
      toast.error(extractErrorMessage(error) || dt("模型切换失败"));
    } finally {
      endAction();
    }
  };

  const installTool = async (app: YuanhengToolId) => {
    const canContinue = installContinuation();
    const command = TOOL_COMMANDS[app];
    const downloadUrl = DESKTOP_DOWNLOAD_URLS[app];
    if (!command && !downloadUrl) return;
    if (command && isToolLifecycleBusy(command)) return;
    try {
      if (downloadUrl) {
        const versionTarget = TOOL_VERSION_TARGETS[app];
        if (!versionTarget) return;
        const monitor = desktopInstall.openAndMonitor(
          app,
          versionTarget,
          downloadUrl,
        );
        const notifyDownload =
          app === "claude-desktop" && isWindows() ? toast.info : toast.success;
        notifyDownload(
          app === "claude-desktop" && isWindows()
            ? dt(
                "先准备 Claude 必要组件，通过后自动打开官方下载页；可能需要管理员授权及重启。",
              )
            : dt("已打开 {{v0}} 官方下载页，安装完成后请刷新检测", {
                v0: toolLabel(app),
              }),
        );
        const result = await monitor;
        if (result.status === "cancelled") return;
        if (result.status === "timeout") {
          toast.info(
            dt("暂未检测到 {{v0}}，可重新检测或手动选择路径", {
              v0: toolLabel(app),
            }),
          );
          return;
        }
        await versions.refetch();
        if (connection?.connected) {
          const configured = await configureApps([app]);
          if (!configured) {
            toast.info(
              dt("已检测到 {{v0}}，但自动配置未完成，可点击配置重试", {
                v0: toolLabel(app),
              }),
            );
          }
        } else {
          toast.success(
            dt("已检测到 {{v0}}，现在可以进行配置", { v0: toolLabel(app) }),
          );
        }
        return;
      }
      if (!command) return;
      await settingsApi.runToolLifecycleAction([command], "install");
      toast.success(
        dt("{{v0}} 安装完成并已验证可运行", { v0: toolLabel(app) }),
      );
      clearToolInventoryCache();
      await versions.refetch();
      if (app === "dsh" && connection?.connected && canContinue()) {
        const configured = await configureApps([app], canContinue);
        if (!configured) {
          toast.info(dt("DSH 已安装，但配置未完成，请重试配置后启动"));
          return;
        }
        if (!canContinue()) return;
        await yuanhengApi.launchTool(app);
        toast.success(dt("DSH 已配置，正在打开本机 Web 界面"));
      }
    } catch (error) {
      showToolInstallError(error);
    }
  };

  const chooseDesktopPath = async (app: YuanhengToolId) => {
    try {
      const selected = await settingsApi.pickDesktopAppPath(app);
      if (!selected) return;
      desktopInstall.stop(app);
      clearToolInventoryCache();
      await versions.refetch();
      toast.success(dt("已保存 {{v0}} 应用路径", { v0: toolLabel(app) }));
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("应用路径无效"));
    }
  };

  const clearDesktopPath = async (app: YuanhengToolId) => {
    try {
      await settingsApi.clearDesktopAppPath(app);
      clearToolInventoryCache();
      await versions.refetch();
      toast.success(dt("已恢复自动检测"));
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("清除应用路径失败"));
    }
  };

  const chooseLaunchDirectory = async (app: YuanhengToolId) => {
    try {
      const saved = await launchDirectoryState.chooseDirectory(app);
      if (!saved) return;
      toast.success(
        dt("已将 {{tool}} 工作目录切换为 {{directory}}", {
          tool: toolLabel(app),
          directory: launchDirectoryLabel(saved),
        }),
      );
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("选择工作目录失败"));
    }
  };

  const launchTool = async (app: YuanhengToolId, forceRestart = false) => {
    if (!beginAction()) return;
    try {
      if (
        (app === "codex" || app === "chatgpt-desktop") &&
        codexAccountMode.data?.mode === "official"
      ) {
        await yuanhengApi.launchTool(
          app,
          forceRestart,
          launchDirectoryState.directories[app],
        );
        return;
      }
      const status = statusMap.get(app);
      const selectedModel = models[app] ?? status?.recommendedModel;
      const launchedModel = selectedModel ?? status?.model;
      const selectedGroup = groups[app];
      const selectedReasoning = selectedReasoningFor(app, selectedModel);
      const needsCredentialRepair = await preflightApps([app]);
      const needsApply =
        needsCredentialRepair ||
        Boolean(
          !status?.configured ||
            selectedModel !== status.model ||
            (selectedGroup && selectedGroup !== status.group) ||
            ((app === "claude-desktop" ||
              app === "codex" ||
              app === "chatgpt-desktop") &&
              selectedReasoning !== (status.reasoning ?? "auto")),
        );
      if (needsApply) {
        const results = await configure.mutateAsync({
          apps: [app],
          models: selectedModel ? { [app]: selectedModel } : undefined,
          groups: selectedGroup ? { [app]: selectedGroup } : undefined,
          reasoning: { [app]: selectedReasoning },
        });
        const result = results.find((item) => item.app === app);
        if (!result?.configured) {
          throw new Error(result?.error || dt("模型配置失败"));
        }
        onConfigured?.();
      }
      if (!mounted.current) return;
      const restarted = isDesktopApp(app) && (needsApply || forceRestart);
      await yuanhengApi.launchTool(
        app,
        restarted,
        isYuanhengCliTool(app)
          ? launchDirectoryState.directories[app]
          : undefined,
      );
      if (restarted) clearRestartRequired(app);
      toast.success(
        dt("{{v0}} 已使用 {{v1}} {{v2}}", {
          v0: toolLabel(app),
          v1: launchedModel ?? dt("推荐模型"),
          v2: restarted
            ? dt("重新打开")
            : isDesktopApp(app)
              ? dt("打开")
              : dt("启动"),
        }),
      );
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("启动失败"));
    } finally {
      endAction();
    }
  };

  const toggleSelected = (app: YuanhengToolId) => {
    setSelected((current) =>
      current.includes(app)
        ? current.filter((item) => item !== app)
        : [...current, app],
    );
  };

  const refresh = async () => {
    desktopInstall.stopAll();
    clearToolInventoryCache();
    // Local re-detection must not wait on the model directory/network.
    // Models retain their own explicit refresh action.
    await Promise.all([versions.refetch(), statuses.refetch()]);
  };

  const refreshModels = () => {
    if (!connection?.connected || refreshConnection.isPending) return;
    void refreshConnection.mutateAsync().catch(() => {
      toast.error(dt("网站模型同步失败，已保留上次可用列表"));
    });
  };

  useEffect(() => {
    if (
      !workspaceSetup.resumeRequested ||
      versions.isLoading ||
      statuses.isLoading ||
      busy
    )
      return;
    if (!claudeWorkspaceSetup.consumeContinue()) return;
    if (versions.isError || statuses.isError) {
      toast.info(
        dt(
          "基础环境已就绪，但工具检测未完成。请先点击重新检测，再继续配置 Claude。",
        ),
      );
      return;
    }
    if (!isInstalled("claude-desktop")) {
      void installTool("claude-desktop");
    } else if (connection?.connected) {
      void launchTool("claude-desktop", false);
    } else {
      toast.info(dt("运行环境已准备，请先连接元衡账号，再配置 Claude。"));
    }
  }, [
    workspaceSetup.resumeRequested,
    versions.isLoading,
    statuses.isLoading,
    versions.isError,
    statuses.isError,
    busy,
    connection?.connected,
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card px-4 py-3 shadow-sm">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold">
            {selected.length > 0
              ? dt("已选择 {{v0}} 个工具", { v0: selected.length })
              : dt("选择你需要使用的工具")}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {dt(
              "元衡将写入 API、模型和认证配置；工作目录仅在你主动选择时更改。",
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={
            versions.isFetching ||
            statuses.isFetching ||
            refreshConnection.isPending
          }
          aria-label={dt("刷新工具状态")}
        >
          <RefreshCw
            className={cn(
              "h-3.5 w-3.5",
              (versions.isFetching ||
                statuses.isFetching ||
                refreshConnection.isPending) &&
                "animate-spin",
            )}
          />
          {dt("刷新")}
        </Button>
        <Button
          size="sm"
          disabled={
            !connection?.connected ||
            selected.length === 0 ||
            busy ||
            !statuses.data ||
            statuses.isError
          }
          onClick={() => void configureApps(selected)}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Settings2 className="h-3.5 w-3.5" />
          )}
          {dt("一键配置所选工具")}
        </Button>
      </div>

      {!connection?.connected && (
        <div className="rounded-xl border border-dashed border-amber-500/30 bg-amber-500/[0.055] px-4 py-3 text-[11px] text-amber-800 dark:text-amber-200">
          {dt("请先连接元衡账号，再为工具写入配置。")}
        </div>
      )}

      {connection?.connected &&
        (connection.imageGenerationModels?.length ?? 0) > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-sky-500/20 bg-sky-500/[0.055] px-4 py-3 text-[11px] text-sky-900 dark:text-sky-100">
            <ImageIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {dt(
                "已识别 {{v0}} 个图像生成专用模型。它们不能作为终端主模型，请通过 Images API 或图像生成工具调用。",
                {
                  v0: connection.imageGenerationModels?.length ?? 0,
                },
              )}
            </span>
          </div>
        )}

      <div
        className={cn(
          "grid gap-3",
          compact ? "sm:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3",
        )}
      >
        {tools.map((app, index) => {
          const versionTarget = TOOL_VERSION_TARGETS[app];
          const version = versionTarget
            ? versionMap.get(versionTarget)
            : undefined;
          const canInstall = canInstallTool(app);
          const installed = isInstalled(app);
          const cliPhase = cliLifecycle.get(TOOL_VERSION_TARGETS[app] ?? "");
          const installing =
            desktopInstall.monitoringApps.has(app) ||
            Boolean(cliPhase) ||
            (app === "claude-desktop" && workspaceSetup.busy);
          const status = statusMap.get(app);
          const configured = Boolean(status?.configured);
          const selectable = Boolean(
            connection?.connected &&
              (installed || app === "dsh") &&
              status?.supported,
          );
          const isSelected = selected.includes(app);
          const availableModels = compatibleModels();
          const selectedModel =
            models[app] ?? status?.recommendedModel ?? undefined;
          const availableGroups = selectedModel
            ? (connection?.modelGroups[selectedModel] ?? [])
            : [];
          const selectedGroup = groups[app];
          const groupUnconfirmed = Boolean(
            selectedGroup && !availableGroups.includes(selectedGroup),
          );
          const displayGroups = groupUnconfirmed
            ? [selectedGroup!, ...availableGroups]
            : availableGroups;
          const supportedReasoning = selectedModel
            ? (connection?.reasoningLevels[selectedModel] ?? [])
            : [];
          const defaultReasoning = selectedModel
            ? connection?.reasoningDefaults?.[selectedModel]
            : undefined;
          const reasoningOptions: YuanhengReasoningLevel[] = [
            "auto",
            ...supportedReasoning,
          ];
          const selectedReasoning = selectedReasoningFor(app, selectedModel);
          const controlsReasoning =
            app === "claude-desktop" ||
            app === "codex" ||
            app === "chatgpt-desktop";
          const supportsCustomPath = isDesktopApp(app);
          const supportsLaunchDirectory = isYuanhengCliTool(app);
          const launchDirectory = launchDirectoryState.directories[app];
          const launchDirectoryPending =
            launchDirectoryState.pendingApps.has(app);
          const detectionLabel =
            version?.detection_source === "custom"
              ? dt("自定义路径")
              : version?.detection_source === "microsoft_store"
                ? "Microsoft Store"
                : version?.detection_source === "registry"
                  ? dt("注册表检测")
                  : version?.detection_source === "automatic"
                    ? dt("自动检测")
                    : version?.detection_source === "shortcut"
                      ? dt("开始菜单检测")
                      : version?.detection_source === "running"
                        ? dt("运行中检测")
                        : dt("未检测到");
          const modelChanged =
            Boolean(
              selectedModel &&
                configured &&
                (selectedModel !== status?.model ||
                  (selectedGroup && selectedGroup !== status?.group)),
            ) ||
            Boolean(
              controlsReasoning &&
                configured &&
                selectedReasoning !== (status?.reasoning ?? "auto"),
            );
          return (
            <article
              key={app}
              className={cn(
                "animate-rise-in flex flex-col rounded-2xl border bg-card p-4 shadow-sm transition-colors",
                activeApp === app && "border-primary/35 ring-1 ring-primary/10",
                isSelected && "border-emerald-500/35",
              )}
              style={{ animationDelay: `${Math.min(index, 7) * 40}ms` }}
              onClick={() => {
                onSetActiveApp?.(app);
              }}
            >
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  aria-label={dt("选择 {{v0}}", { v0: toolLabel(app) })}
                  aria-pressed={isSelected}
                  disabled={!selectable}
                  className="mt-0.5 text-primary disabled:text-muted-foreground/35"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSelected(app);
                  }}
                >
                  {isSelected ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                </button>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted/70">
                  <ProviderIcon
                    icon={toolIcon(app)}
                    name={toolLabel(app)}
                    size={22}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-display text-[15px] font-semibold">
                    {toolLabel(app)}
                  </h2>
                  <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                    {installed ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <CircleOff className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <span className="truncate text-muted-foreground">
                      {installed
                        ? version?.version || dt("桌面应用")
                        : dt("未检测到")}
                    </span>
                  </div>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[9px] font-semibold",
                    configured
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : status?.needsUpdate
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {configured
                    ? dt("已配置")
                    : status?.needsUpdate
                      ? dt("需更新")
                      : dt("待配置")}
                </span>
              </div>

              {supportsCustomPath && (
                <div className="mt-3 border-t border-border/60 pt-3 text-[10px]">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        "shrink-0 font-medium",
                        version?.detection_source === "not_found"
                          ? "text-amber-700 dark:text-amber-300"
                          : "text-muted-foreground",
                      )}
                    >
                      {detectionLabel}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-muted-foreground"
                      title={
                        version?.install_path ?? version?.custom_path ?? ""
                      }
                    >
                      {version?.install_path ??
                        version?.custom_path ??
                        dt("尚未选择应用路径")}
                    </span>
                  </div>
                  {app === "dsh" && (
                    <p className="mt-1 text-muted-foreground">
                      {dt(
                        "可选择 DeepSeek Harness 应用或源码目录；源码需要依赖及构建。一键安装会独立准备运行环境并打开本机 Web，不修改旧目录。",
                      )}
                    </p>
                  )}
                  {version?.custom_path && !version.custom_path_valid && (
                    <p className="mt-1 text-amber-700 dark:text-amber-300">
                      {dt("原自定义路径已失效，当前继续使用自动检测结果。")}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[10px]"
                      onClick={(event) => {
                        event.stopPropagation();
                        void chooseDesktopPath(app);
                      }}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      {version?.custom_path ? dt("重新选择") : dt("选择路径")}
                    </Button>
                    {version?.custom_path && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground"
                        title={dt("清除自定义路径")}
                        aria-label={dt("清除自定义路径")}
                        onClick={(event) => {
                          event.stopPropagation();
                          void clearDesktopPath(app);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {supportsLaunchDirectory && (
                <button
                  type="button"
                  disabled={launchDirectoryPending}
                  aria-label={dt("选择 {{tool}} 工作目录", {
                    tool: toolLabel(app),
                  })}
                  title={launchDirectory ?? dt("用户主目录")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void chooseLaunchDirectory(app);
                  }}
                  className="mt-3 flex min-w-0 items-center gap-2 border-t border-border/60 pt-3 text-left text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {launchDirectoryPending ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="shrink-0 font-medium">{dt("工作目录")}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground/80">
                    {launchDirectoryLabel(launchDirectory)}
                  </span>
                </button>
              )}

              {status?.runtimeStatus && (
                <div
                  className={cn(
                    "mt-3 rounded-lg border px-3 py-2.5 text-[10px] leading-4",
                    status.runtimeStatus.state === "downloading"
                      ? "border-sky-500/25 bg-sky-500/[0.06] text-sky-800 dark:text-sky-200"
                      : "border-amber-500/25 bg-amber-500/[0.06] text-amber-800 dark:text-amber-200",
                  )}
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    {status.runtimeStatus.state === "downloading" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {status.runtimeStatus.title}
                  </div>
                  <p className="mt-1">{status.runtimeStatus.message}</p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 bg-background/70 px-2.5 text-[10px]"
                      onClick={(event) => {
                        event.stopPropagation();
                        void launchTool("claude-desktop");
                      }}
                    >
                      <Play className="h-3 w-3 fill-current" />
                      {dt("打开 Claude Desktop")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2.5 text-[10px]"
                      disabled={statuses.isFetching}
                      onClick={(event) => {
                        event.stopPropagation();
                        void statuses.refetch();
                      }}
                    >
                      <RefreshCw
                        className={cn(
                          "h-3 w-3",
                          statuses.isFetching && "animate-spin",
                        )}
                      />
                      {dt("重新检测")}
                    </Button>
                  </div>
                </div>
              )}

              {status?.runtimeWarning && !status.runtimeStatus && (
                <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[10px] leading-4 text-amber-800 dark:text-amber-200">
                  {status.runtimeWarning}
                </div>
              )}

              {(installed || app === "dsh") &&
              connection?.connected &&
              status?.supported ? (
                <div className="mt-3 rounded-xl bg-muted/45 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold">
                      {isDesktopApp(app) ? dt("桌面模型") : dt("终端模型")}
                    </p>
                    <span className="text-[9px] text-muted-foreground">
                      {dt("可选")}
                      {availableModels.length} {dt("个 · 点击切换")}
                    </span>
                  </div>
                  <ModelPicker
                    models={availableModels}
                    value={selectedModel}
                    recommended={status.recommendedModel}
                    modelMeta={modelMeta}
                    label={dt("{{v0}} 模型选择", { v0: toolLabel(app) })}
                    disabled={busy}
                    onRefresh={refreshModels}
                    onChange={(value) => {
                      if (app === "codex") {
                        void applyCodexModel(value);
                        return;
                      }
                      setModels((current) => ({ ...current, [app]: value }));
                      const group = groups[app];
                      setGroups((current) => {
                        const next = { ...current };
                        if (group) next[app] = group;
                        else delete next[app];
                        return next;
                      });
                      setReasoning((current) => {
                        const supported =
                          connection.reasoningLevels[value] ?? [];
                        const selected = current[app] ?? "auto";
                        if (
                          selected === "auto" ||
                          supported.includes(selected)
                        ) {
                          return current;
                        }
                        return { ...current, [app]: "auto" };
                      });
                    }}
                  />
                  {displayGroups.length > 0 && (
                    <div className="mt-2 flex items-center gap-2 text-[10px]">
                      <span className="shrink-0 text-muted-foreground">
                        {dt("令牌分组")}
                      </span>
                      <GroupPicker
                        label={dt("{{v0}} 令牌分组", {
                          v0: toolLabel(app),
                        })}
                        triggerClassName="h-7 flex-1"
                        value={selectedGroup ?? ""}
                        disabled={busy}
                        options={[
                          ...(!selectedGroup
                            ? [{ value: "", label: dt("选择令牌分组") }]
                            : []),
                          ...displayGroups.map((group) => {
                            const option = groupMap.get(group);
                            return {
                              value: group,
                              label: `${group}${option?.ratio != null ? ` · ${option.ratio}x` : ""}`,
                            };
                          }),
                        ]}
                        onChange={(value) => {
                          setGroups((current) => ({
                            ...current,
                            [app]: value,
                          }));
                        }}
                      />
                    </div>
                  )}
                  {groupUnconfirmed && (
                    <p
                      role="status"
                      className="mt-2 text-[10px] text-amber-700 dark:text-amber-300"
                    >
                      {dt(
                        "保留原分组：当前目录尚未确认其可用性。请刷新或手动选择，不会自动换组。",
                      )}
                    </p>
                  )}
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    {dt(
                      "分组选择需点击配置或启动后保存；再次打开将恢复已保存配置。",
                    )}
                  </p>
                  {controlsReasoning && (
                    <div className="mt-2 flex items-center gap-2 text-[10px]">
                      <span className="shrink-0 text-muted-foreground">
                        {dt("推理等级")}
                        {supportedReasoning.length > 0 &&
                          dt(" · {{v0}} 档", { v0: supportedReasoning.length })}
                      </span>
                      <CompactSelectPicker
                        label={dt("{{v0}} 推理等级", {
                          v0: toolLabel(app),
                        })}
                        triggerClassName="h-7 flex-1"
                        value={
                          supportedReasoning.length > 0
                            ? selectedReasoning
                            : "unsupported"
                        }
                        disabled={busy || supportedReasoning.length === 0}
                        options={
                          supportedReasoning.length === 0
                            ? [{ value: "unsupported", label: dt("不适用") }]
                            : reasoningOptions.map((level) => ({
                                value: level,
                                label: reasoningLabel(level, defaultReasoning),
                              }))
                        }
                        onChange={(value) => {
                          setReasoning((current) => ({
                            ...current,
                            [app]: value as YuanhengReasoningLevel,
                          }));
                        }}
                      />
                    </div>
                  )}
                  {app === "claude-desktop" && (
                    <p className="mt-2 text-[9px] leading-4 text-amber-700 dark:text-amber-300">
                      {dt(
                        "右下角固定显示“元衡\n                      AI”；模型与推理等级在此切换，无需重启。",
                      )}
                    </p>
                  )}
                  {app === "codex" && (
                    <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
                      {dt(
                        "从元衡启动后，模型会在同一会话的下一条消息自动切换，无需重启。",
                      )}
                    </p>
                  )}
                  {app === "chatgpt-desktop" && (
                    <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
                      {dt("使用独立桌面配置；已有任务保持原模型，请新建任务。")}
                    </p>
                  )}
                  {app === "dsh" && (
                    <div className="mt-2 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {dt(
                          "同步桌面端和本机 Web 的模型目录。已有会话保留原模型；自定义 profile 和远程 Web 需单独配置。",
                        )}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          busy || !connection?.connected || !status?.supported
                        }
                        onClick={() => {
                          void configureApps(["dsh"])
                            .then((configured) =>
                              configured
                                ? yuanhengApi.launchTool("dsh-web")
                                : false,
                            )
                            .catch((error) =>
                              toast.error(extractErrorMessage(error)),
                            );
                        }}
                      >
                        {dt("启动 DSH Web")}
                      </Button>
                    </div>
                  )}
                  {app === "workbuddy" && (
                    <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
                      {dt("写入 WorkBuddy 自定义模型；应用后会重新打开。")}
                    </p>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                  {configured
                    ? dt("配置已就绪，可直接启动使用。")
                    : status?.needsUpdate
                      ? dt("配置发生变化，点击即可自动恢复。")
                      : installed
                        ? dt("元衡会自动选择适合的模型。")
                        : dt("安装后即可由元衡自动配置。")}
                </p>
              )}

              <div className="mt-auto flex gap-2 pt-3">
                <ToolInstallCancel tool={versionTarget ?? ""} />
                {!installed && canInstall ? (
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={installing}
                    aria-label={
                      app === "claude-desktop" && isWindows()
                        ? dt("安装并准备 Claude Desktop")
                        : DESKTOP_DOWNLOAD_URLS[app]
                          ? dt("打开 {{v0}} 官方下载页", { v0: toolLabel(app) })
                          : dt("一键安装 {{v0}}", { v0: toolLabel(app) })
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      void installTool(app);
                    }}
                  >
                    {installing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {installing
                      ? app === "claude-desktop" && workspaceSetup.busy
                        ? dt("准备运行环境")
                        : cliPhase
                          ? toolInstallLabel(cliPhase)
                          : dt("等待安装")
                      : app === "claude-desktop" && isWindows()
                        ? dt("安装并准备")
                        : DESKTOP_DOWNLOAD_URLS[app]
                          ? dt("官方下载")
                          : dt("一键安装")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={
                      !connection?.connected ||
                      !status?.supported ||
                      busy ||
                      !statuses.data ||
                      statuses.isError
                    }
                    aria-label={dt("配置 {{v0}}", { v0: toolLabel(app) })}
                    onClick={(event) => {
                      event.stopPropagation();
                      void configureApps([app]);
                    }}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                    {modelChanged
                      ? dt("应用模型")
                      : status?.needsUpdate
                        ? dt("自动恢复")
                        : configured
                          ? dt("重新配置")
                          : dt("配置")}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    !installed ||
                    !connection?.connected ||
                    !status?.supported ||
                    busy ||
                    !statuses.data ||
                    statuses.isError
                  }
                  aria-label={dt("启动 {{v0}}", { v0: toolLabel(app) })}
                  onClick={(event) => {
                    event.stopPropagation();
                    void launchTool(app, isDesktopApp(app));
                  }}
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  {!configured || modelChanged
                    ? isDesktopApp(app)
                      ? dt("应用并刷新")
                      : dt("应用并启动")
                    : isDesktopApp(app)
                      ? dt("刷新显示")
                      : dt("启动")}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
