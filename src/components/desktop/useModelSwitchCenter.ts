import { useEffect, useMemo, useRef, useState } from "react";
import { useInstallContinuation } from "./useInstallContinuation";
import { ClaudeWorkspaceDeferredError } from "@/lib/claudeWorkspaceSetup";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import {
  isToolLifecycleBusy,
  useToolLifecycleState,
} from "@/lib/toolLifecycleState";
import { showToolInstallError } from "./toolInstallFeedback";
import {
  type CodexAccountMode,
  isYuanhengCliTool,
  type YuanhengReasoningLevel,
  type YuanhengToolPreflight,
  type YuanhengToolId,
  yuanhengTerminalModels,
} from "@/lib/api";
import { settingsApi, yuanhengApi } from "@/lib/api";
import {
  useConfigureYuanhengTools,
  useCodexAccountMode,
  useCodexSessionBridgeStatus,
  usePreflightYuanhengTool,
  useRefreshYuanheng,
  useYuanhengConnection,
  useYuanhengToolStatuses,
  useYuanhengToolActivationStatuses,
  useSwitchCodexAccountMode,
} from "@/lib/query/yuanheng";
import { extractErrorMessage } from "@/utils/errorUtils";
import { canRestartDesktopApp } from "@/config/desktopTools";
import {
  DESKTOP_TOOLS,
  DESKTOP_DOWNLOAD_URLS,
  TOOL_VERSION_TARGETS,
  TOOL_COMMANDS,
  isDesktopApp,
  pickPreferredGroup,
  toolLabel,
} from "./ToolSetupGrid";
import {
  clearRestartRequired,
  getRestartRequiredApps,
  markRestartRequired,
  subscribeRestartRequired,
} from "./desktopRestartState";
import { dt } from "./desktopI18n";
import {
  launchDirectoryLabel,
  useToolLaunchDirectories,
} from "./useToolLaunchDirectories";
import { useDesktopInstallFlow } from "./useDesktopInstallFlow";
import { clearToolInventoryCache } from "./toolInventoryCache";
import { useToolInventory } from "@/lib/query/toolInventory";

export { toolIcon as providerIconOf } from "@/config/desktopTools";

export type ModelSwitchBootstrapPhase = "loading" | "ready" | "error";

/**
 * 工作台当前工具的选择、配置与启动状态，复用既有工具检测和操作链。
 */
export function useModelSwitchCenter() {
  const queryClient = useQueryClient();
  const { data: connection } = useYuanhengConnection();
  const installContinuation = useInstallContinuation(connection);
  const refreshConnection = useRefreshYuanheng();
  const statuses = useYuanhengToolStatuses();
  const configure = useConfigureYuanhengTools();
  const preflight = usePreflightYuanhengTool();
  const activationStatuses = useYuanhengToolActivationStatuses();
  const codexAccountMode = useCodexAccountMode();
  const switchCodexAccountMode = useSwitchCodexAccountMode();
  const codexBridge = useCodexSessionBridgeStatus();
  const desktopInstall = useDesktopInstallFlow();
  const cliLifecycle = useToolLifecycleState();
  const inventory = useToolInventory();
  const [models, setModels] = useState<Partial<Record<YuanhengToolId, string>>>(
    {},
  );
  const [groups, setGroups] = useState<Partial<Record<YuanhengToolId, string>>>(
    {},
  );
  const [reasoning, setReasoning] = useState<
    Partial<Record<YuanhengToolId, YuanhengReasoningLevel>>
  >({});
  const [pendingApps, setPendingApps] = useState<Set<YuanhengToolId>>(
    () => new Set(),
  );
  const [restartRequiredApps, setRestartRequiredApps] = useState(
    getRestartRequiredApps,
  );
  const operationIds = useRef<Partial<Record<YuanhengToolId, number>>>({});
  const operationSequence = useRef(0);
  const preflightCache = useRef(
    new Map<string, { checkedAt: number; result: YuanhengToolPreflight }>(),
  );
  const [preflightResults, setPreflightResults] = useState<
    Partial<Record<YuanhengToolId, YuanhengToolPreflight>>
  >({});

  useEffect(() => {
    setPendingApps(new Set());
    return () => {
      // A selection from another account or an unmounted page cannot continue
      // from its completed preflight into a configuration write.
      operationIds.current = {};
      preflightCache.current.clear();
    };
  }, [connection?.baseUrl, connection?.userId, connection?.connected]);

  const versionMap = useMemo(
    () => new Map((inventory.data ?? []).map((item) => [item.name, item])),
    [inventory.data],
  );
  const statusMap = useMemo(
    () => new Map((statuses.data ?? []).map((item) => [item.app, item])),
    [statuses.data],
  );
  const activationMap = useMemo(
    () =>
      new Map((activationStatuses.data ?? []).map((item) => [item.app, item])),
    [activationStatuses.data],
  );
  const terminalModels = useMemo(
    () => yuanhengTerminalModels(connection),
    [connection],
  );
  const modelMeta = useMemo(
    () =>
      Object.fromEntries(
        terminalModels.map((model) => [
          model,
          {
            groups: connection?.modelGroups[model]?.length ?? 0,
            reasoningLevels: connection?.reasoningLevels[model]?.length ?? 0,
            available: true,
          },
        ]),
      ),
    [connection?.modelGroups, connection?.reasoningLevels, terminalModels],
  );

  useEffect(() => {
    preflightCache.current.clear();
    setPreflightResults({});
  }, [connection?.lastSyncedAt, connection?.userId, connection?.connected]);

  useEffect(
    () =>
      subscribeRestartRequired(() =>
        setRestartRequiredApps(getRestartRequiredApps()),
      ),
    [],
  );

  // 后端状态与模型目录变化时同步；正在提交的工具保留乐观选择。
  useEffect(() => {
    if (!connection || !statuses.data) return;
    setModels((current) => {
      const next = { ...current };
      for (const status of statuses.data) {
        if (pendingApps.has(status.app)) continue;
        const model =
          status.model && terminalModels.includes(status.model)
            ? status.model
            : status.recommendedModel &&
                terminalModels.includes(status.recommendedModel)
              ? status.recommendedModel
              : undefined;
        if (model) next[status.app] = model;
        else delete next[status.app];
      }
      return next;
    });
    setGroups((current) => {
      const next = { ...current };
      for (const status of statuses.data) {
        if (pendingApps.has(status.app)) continue;
        if (status.group) next[status.app] = status.group;
        else delete next[status.app];
      }
      return next;
    });
    setReasoning((current) => {
      const next = { ...current };
      for (const status of statuses.data) {
        if (pendingApps.has(status.app)) continue;
        next[status.app] = status.reasoning ?? "auto";
      }
      return next;
    });
  }, [connection, pendingApps, statuses.data, terminalModels]);

  const isInstalled = (app: YuanhengToolId) => {
    const versionTarget = TOOL_VERSION_TARGETS[app];
    return Boolean(versionTarget && versionMap.get(versionTarget)?.version);
  };
  const installedApps = useMemo(
    () => new Set(DESKTOP_TOOLS.filter((app) => isInstalled(app))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [versionMap],
  );

  const runnableRows = useMemo(
    () =>
      DESKTOP_TOOLS.filter(
        (app) =>
          isInstalled(app) &&
          ((app === "codex" || app === "chatgpt-desktop") &&
          codexAccountMode.data?.mode === "official"
            ? true
            : statusMap.get(app)?.supported),
      ).sort((left, right) => {
        const configuredRank = (app: YuanhengToolId) =>
          ((app === "codex" || app === "chatgpt-desktop") &&
            codexAccountMode.data?.mode === "official") ||
          statusMap.get(app)?.configured
            ? 0
            : 1;
        const leftConfigured = configuredRank(left);
        const rightConfigured = configuredRank(right);
        return leftConfigured - rightConfigured;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [codexAccountMode.data?.mode, statusMap, versionMap],
  );
  const rows = useMemo(
    () =>
      [...DESKTOP_TOOLS].sort((left, right) => {
        const rank = (app: YuanhengToolId) => {
          if (
            (app === "codex" || app === "chatgpt-desktop") &&
            codexAccountMode.data?.mode === "official" &&
            isInstalled(app)
          )
            return 0;
          if (statusMap.get(app)?.configured && isInstalled(app)) return 0;
          if (isInstalled(app) && statusMap.get(app)?.supported) return 1;
          if (isInstalled(app)) return 2;
          return 3;
        };
        return rank(left) - rank(right);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [codexAccountMode.data?.mode, statusMap, versionMap],
  );
  const launchDirectoryState = useToolLaunchDirectories(
    Boolean(connection?.connected),
  );

  const hasInventory = inventory.data !== undefined;
  const hasStatuses = statuses.data !== undefined;
  const bootstrapPhase: ModelSwitchBootstrapPhase =
    (!hasInventory && inventory.isError) || statuses.isError
      ? "error"
      : !hasInventory || !hasStatuses
        ? (!hasInventory && inventory.isError) ||
          (!hasStatuses && statuses.isError)
          ? "error"
          : "loading"
        : "ready";

  const retryBootstrap = async () => {
    desktopInstall.stopAll();
    clearToolInventoryCache();
    preflightCache.current.clear();
    await Promise.all([
      inventory.refetch(),
      statuses.refetch(),
      codexAccountMode.refetch(),
      activationStatuses.refetch(),
    ]);
  };

  const refreshModels = () => {
    if (!connection?.connected || refreshConnection.isPending) return;
    void refreshConnection.mutateAsync().catch(() => {
      toast.error(dt("网站模型同步失败，已保留上次可用列表"));
    });
  };

  const runPreflight = async (
    app: YuanhengToolId,
    model: string,
    group?: string,
    selectedReasoning?: YuanhengReasoningLevel,
  ) => {
    const cacheKey = [
      app,
      model,
      group ?? "",
      selectedReasoning ?? "auto",
    ].join("\u0000");
    const cached = preflightCache.current.get(cacheKey);
    if (cached && Date.now() - cached.checkedAt < 60_000) {
      setPreflightResults((current) => ({
        ...current,
        [app]: cached.result,
      }));
      if (cached.result.status === "error") {
        throw new Error(cached.result.message);
      }
      return cached.result;
    }
    const result = await preflight.mutateAsync({
      app,
      model,
      group,
      reasoning: selectedReasoning,
    });
    if (result.status === "ok" && !result.requiresConfiguration) {
      preflightCache.current.set(cacheKey, { checkedAt: Date.now(), result });
    } else {
      preflightCache.current.delete(cacheKey);
    }
    setPreflightResults((current) => ({ ...current, [app]: result }));
    if (result.status === "error") {
      const failed = result.checks.find((check) => check.status === "error");
      throw new Error(failed?.message || result.message);
    }
    return result;
  };

  const install = async (app: YuanhengToolId) => {
    const canContinue = installContinuation();
    const command = TOOL_COMMANDS[app];
    const downloadUrl = DESKTOP_DOWNLOAD_URLS[app];
    if (!command && !downloadUrl) return;
    if (
      desktopInstall.monitoringApps.has(app) ||
      (command && isToolLifecycleBusy(command))
    )
      return;
    try {
      if (downloadUrl) {
        const versionTarget = TOOL_VERSION_TARGETS[app];
        if (!versionTarget) return;
        const monitor = desktopInstall.openAndMonitor(
          app,
          versionTarget,
          downloadUrl,
        );
        if (app !== "dsh")
          toast.info(
            app === "claude-desktop"
              ? dt(
                  "先检查 Claude 必要组件，通过后打开官方下载页；安装完成后自动检测。",
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
        clearToolInventoryCache();
        await inventory.refetch();
        if (!canContinue()) return;
        if (app === "dsh") {
          if (connection?.connected) await launch(app, canContinue);
          return;
        }
        const freshStatuses = await yuanhengApi.getToolStatuses();
        const status = freshStatuses.find((item) => item.app === app);
        const selectedModel = models[app] ?? status?.recommendedModel;
        if (connection?.connected && status?.supported && selectedModel) {
          const group = pickPreferredGroup(
            connection,
            selectedModel,
            groups[app] ?? status.group ?? undefined,
          );
          const selectedReasoning =
            reasoning[app] ?? status.reasoning ?? "auto";
          const supportedReasoning =
            connection.reasoningLevels[selectedModel] ?? [];
          const normalizedReasoning: YuanhengReasoningLevel =
            selectedReasoning === "auto" ||
            supportedReasoning.includes(selectedReasoning)
              ? selectedReasoning
              : "auto";
          await runPreflight(app, selectedModel, group, normalizedReasoning);
          if (!canContinue()) return;
          const configured = await configure.mutateAsync({
            apps: [app],
            models: { [app]: selectedModel },
            groups: group ? { [app]: group } : undefined,
            reasoning: { [app]: normalizedReasoning },
          });
          const configuredResult = configured.find((item) => item.app === app);
          if (!configuredResult?.configured) {
            throw new Error(configuredResult?.error || dt("自动配置失败"));
          }
          markRestartRequired(app);
          toast.success(
            dt("已检测到 {{v0}}，并完成元衡配置", { v0: toolLabel(app) }),
          );
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
      await inventory.refetch();
    } catch (error) {
      showToolInstallError(error);
    }
  };

  const chooseDesktopPath = async (app: YuanhengToolId) => {
    if (!isDesktopApp(app)) return;
    try {
      const selected = await settingsApi.pickDesktopAppPath(app);
      if (!selected) return;
      desktopInstall.stop(app);
      clearToolInventoryCache();
      await inventory.refetch();
      toast.success(dt("已保存 {{v0}} 应用路径", { v0: toolLabel(app) }));
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("应用路径无效"));
    }
  };

  const beginOperation = (app: YuanhengToolId) => {
    const operationId = ++operationSequence.current;
    operationIds.current[app] = operationId;
    setPendingApps((current) => {
      if (current.has(app)) return current;
      const next = new Set(current);
      next.add(app);
      return next;
    });
    return operationId;
  };

  const isCurrentOperation = (app: YuanhengToolId, operationId: number) =>
    operationIds.current[app] === operationId;

  const finishOperation = (app: YuanhengToolId, operationId: number) => {
    if (!isCurrentOperation(app, operationId)) return;
    setPendingApps((current) => {
      if (!current.has(app)) return current;
      const next = new Set(current);
      next.delete(app);
      return next;
    });
  };

  const applySelection = async (
    app: YuanhengToolId,
    patch: {
      model?: string;
      group?: string;
      reasoning?: YuanhengReasoningLevel;
    },
    successMessage: (model: string, group?: string) => string,
  ) => {
    if (
      (app === "codex" || app === "chatgpt-desktop") &&
      codexAccountMode.data?.mode === "official"
    ) {
      toast.info(dt("当前使用 OpenAI 官方账号，模型由 Codex 管理"));
      return;
    }
    const status = statusMap.get(app);
    const previous = {
      model: models[app],
      group: groups[app],
      reasoning: reasoning[app],
    };
    const model =
      patch.model ?? models[app] ?? status?.model ?? status?.recommendedModel;
    if (!model) {
      toast.error(dt("{{v0}} 没有可用模型", { v0: toolLabel(app) }));
      return;
    }
    const availableGroups = connection?.modelGroups[model] ?? [];
    const requestedGroup = patch.group ?? groups[app] ?? status?.group;
    let group =
      requestedGroup && availableGroups.includes(requestedGroup)
        ? requestedGroup
        : pickPreferredGroup(connection, model, requestedGroup ?? undefined);
    // Explicit cross-model switches can change groups only after confirmation.
    // Refresh/launch and missing catalogs must continue to preserve the old group.
    if (
      patch.model &&
      model !== (previous.model ?? status?.model) &&
      !patch.group &&
      group &&
      availableGroups.length > 0 &&
      !availableGroups.includes(group)
    ) {
      const suggestion = pickPreferredGroup(connection, model);
      if (
        !suggestion ||
        !window.confirm(
          dt(
            "新模型的目录未包含原分组 {{old}}。是否改用 {{next}}？取消将保留原配置。",
            {
              old: group,
              next: suggestion,
            },
          ),
        )
      )
        return;
      group = suggestion;
    }
    const supportedReasoning = connection?.reasoningLevels[model] ?? [];
    const requestedReasoning =
      patch.reasoning ?? reasoning[app] ?? status?.reasoning ?? "auto";
    const selectedReasoning: YuanhengReasoningLevel =
      requestedReasoning === "auto" ||
      supportedReasoning.includes(requestedReasoning)
        ? requestedReasoning
        : "auto";

    const operationId = beginOperation(app);
    try {
      const preflightResult = await runPreflight(
        app,
        model,
        group,
        selectedReasoning,
      );
      if (!isCurrentOperation(app, operationId)) return;
      if (preflightResult.status === "warning") {
        toast.info(preflightResult.message);
      }
      setModels((current) => ({ ...current, [app]: model }));
      setGroups((current) => {
        const next = { ...current };
        if (group) next[app] = group;
        else delete next[app];
        return next;
      });
      setReasoning((current) => ({
        ...current,
        [app]: selectedReasoning,
      }));
      const results = await configure.mutateAsync({
        apps: [app],
        models: { [app]: model },
        groups: group ? { [app]: group } : undefined,
        reasoning: { [app]: selectedReasoning },
      });
      const result = results.find((item) => item.app === app);
      if (!result?.configured) throw new Error(result?.error || dt("配置失败"));
      if (!isCurrentOperation(app, operationId)) return;
      setModels((current) => ({
        ...current,
        [app]: result.model ?? model,
      }));
      setGroups((current) => {
        const next = { ...current };
        if (group) next[app] = group;
        else delete next[app];
        return next;
      });
      setReasoning((current) => ({
        ...current,
        [app]: selectedReasoning,
      }));
      markRestartRequired(app);
      if (app === "codex") {
        const bridgeStatus = await codexBridge.refetch();
        if (!isCurrentOperation(app, operationId)) return;
        if (patch.model) {
          toast.success(
            bridgeStatus.data?.connectedTerminals
              ? dt("已选择 {{v0}}，终端下一条消息自动应用", { v0: model })
              : dt("Codex 默认模型已切换到 {{v0}}", { v0: model }),
          );
        } else {
          toast.success(successMessage(model, group));
        }
      } else {
        toast.success(
          app === "chatgpt-desktop"
            ? dt("配置已保存；重启 Codex App 后加载新的模型与推理档位")
            : app === "accio-work"
              ? dt(
                  "Accio 默认模型和分组已保存；请从元衡启动，在 Accio 输入框模型菜单切换。Auto 使用客户端默认模型。",
                )
              : successMessage(model, group),
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["yuanheng"] });
      await activationStatuses.refetch();
    } catch (error) {
      if (error instanceof ClaudeWorkspaceDeferredError) {
        if (isCurrentOperation(app, operationId)) {
          markRestartRequired(app);
          toast.info(error.message);
        }
        return;
      }
      if (isCurrentOperation(app, operationId)) {
        setModels((current) => {
          const next = { ...current };
          if (previous.model) next[app] = previous.model;
          else delete next[app];
          return next;
        });
        setGroups((current) => {
          const next = { ...current };
          if (previous.group) next[app] = previous.group;
          else delete next[app];
          return next;
        });
        setReasoning((current) => {
          const next = { ...current };
          if (previous.reasoning) next[app] = previous.reasoning;
          else delete next[app];
          return next;
        });
        toast.error(extractErrorMessage(error) || dt("模型切换失败"));
      }
    } finally {
      finishOperation(app, operationId);
    }
  };

  /** 首页快捷控制：修改后立即写入工具配置。 */
  const applyModel = (app: YuanhengToolId, model: string) =>
    applySelection(app, { model }, () =>
      dt("{{v0}} 已切换到 {{v1}}", { v0: toolLabel(app), v1: model }),
    );

  const applyModelGroup = (app: YuanhengToolId, model: string, group: string) =>
    applySelection(app, { model, group }, () =>
      dt("{{tool}} 已切换到 {{group}} 分组 · {{model}}", {
        tool: toolLabel(app),
        group,
        model,
      }),
    );

  const applyGroup = (app: YuanhengToolId, group: string) =>
    applySelection(app, { group }, (model) =>
      dt("{{v0}} 已切换到 {{v1}} 分组 · {{v2}}", {
        v0: toolLabel(app),
        v1: group,
        v2: model,
      }),
    );

  const applyReasoning = (app: YuanhengToolId, level: YuanhengReasoningLevel) =>
    applySelection(app, { reasoning: level }, (model) =>
      dt("{{v0}} 推理等级已更新 · {{v1}}", { v0: toolLabel(app), v1: model }),
    );

  const switchCodexMode = async (
    mode: Exclude<CodexAccountMode, "unknown">,
  ) => {
    const expectedMode = codexAccountMode.data?.mode;
    if (switchCodexAccountMode.isPending) return;
    try {
      const result = await switchCodexAccountMode.mutateAsync({
        mode,
        expectedMode,
      });
      if (result.restartRequired) {
        markRestartRequired("codex");
        markRestartRequired("chatgpt-desktop");
      }
      toast.success(
        result.message ??
          (mode === "official"
            ? dt("已切换到 OpenAI 官方账号")
            : dt("已切换到元衡中转")),
      );
    } catch (error) {
      await codexAccountMode.refetch();
      toast.error(extractErrorMessage(error) || dt("Codex 使用方式切换失败"));
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

  const launch = async (app: YuanhengToolId, canContinue = () => true) => {
    const operationId = beginOperation(app);
    try {
      const status = statusMap.get(app);
      const usesOfficialCodexAccount =
        (app === "codex" || app === "chatgpt-desktop") &&
        codexAccountMode.data?.mode === "official";
      const model = models[app] ?? status?.recommendedModel ?? status?.model;
      const group = model
        ? pickPreferredGroup(
            connection,
            model,
            groups[app] ?? status?.group ?? undefined,
          )
        : undefined;
      const supportedReasoning = model
        ? (connection?.reasoningLevels[model] ?? [])
        : [];
      const selectedReasoning = reasoning[app] ?? status?.reasoning ?? "auto";
      const normalizedReasoning: YuanhengReasoningLevel =
        selectedReasoning === "auto" ||
        supportedReasoning.includes(selectedReasoning)
          ? selectedReasoning
          : "auto";
      const restartPending = getRestartRequiredApps().has(app);
      const dirty =
        !usesOfficialCodexAccount &&
        !restartPending &&
        Boolean(
          !status?.configured ||
            (model && model !== status.model) ||
            (group && group !== status.group) ||
            normalizedReasoning !== (status.reasoning ?? "auto"),
        );
      // 启动不是仅检查“文件写过”：验证这个工具/分组实际使用的凭据。
      const credentialCheck =
        !usesOfficialCodexAccount && model
          ? await runPreflight(app, model, group, normalizedReasoning)
          : undefined;
      if (!isCurrentOperation(app, operationId) || !canContinue()) return;
      const needsApply =
        dirty || Boolean(credentialCheck?.requiresConfiguration);
      if (needsApply && model) {
        const results = await configure.mutateAsync({
          apps: [app],
          models: { [app]: model },
          groups: group ? { [app]: group } : undefined,
          reasoning: { [app]: normalizedReasoning },
        });
        const result = results.find((item) => item.app === app);
        if (!result?.configured)
          throw new Error(result?.error || dt("配置失败"));
        if (!isCurrentOperation(app, operationId)) return;
        const configuredModel = result.model;
        if (configuredModel) {
          setModels((current) => ({ ...current, [app]: configuredModel }));
        }
      }
      if (!isCurrentOperation(app, operationId) || !canContinue()) return;
      const shouldRestart =
        canRestartDesktopApp(app) && (needsApply || restartPending);
      await yuanhengApi.launchTool(
        app,
        shouldRestart,
        isYuanhengCliTool(app)
          ? launchDirectoryState.directories[app]
          : undefined,
      );
      if (shouldRestart || app === "accio-work") clearRestartRequired(app);
      if (!isCurrentOperation(app, operationId)) return;
      if (app === "codex") await codexBridge.refetch();
      if (!isCurrentOperation(app, operationId)) return;
      toast.success(dt("{{v0}} 已启动", { v0: toolLabel(app) }));
      await queryClient.invalidateQueries({ queryKey: ["yuanheng"] });
      await activationStatuses.refetch();
    } catch (error) {
      if (isCurrentOperation(app, operationId)) {
        toast.error(extractErrorMessage(error) || dt("启动失败"));
      }
    } finally {
      finishOperation(app, operationId);
    }
  };

  return {
    connection,
    terminalModels,
    modelMeta,
    bootstrapPhase,
    bootstrapRefreshing: inventory.isFetching || statuses.isFetching,
    inventoryRefreshFailed: inventory.isError && hasInventory,
    retryBootstrap,
    rows,
    runnableRows,
    installedApps,
    downloadDialog: desktopInstall.downloadDialog,
    models,
    groups,
    reasoning,
    pendingApps,
    installingApps: new Set([
      ...desktopInstall.monitoringApps,
      ...DESKTOP_TOOLS.filter((app) =>
        cliLifecycle.has(TOOL_VERSION_TARGETS[app] ?? ""),
      ),
    ]),
    restartRequiredApps,
    launchDirectories: launchDirectoryState.directories,
    launchDirectoryPendingApps: launchDirectoryState.pendingApps,
    statusMap,
    activationMap,
    activationRefreshing: activationStatuses.isFetching,
    preflightResults,
    preflightPending: preflight.isPending,
    codexBridge,
    codexAccountMode,
    codexModePending: switchCodexAccountMode.isPending,
    refreshModels,
    install,
    chooseDesktopPath,
    applyModel,
    applyModelGroup,
    applyGroup,
    applyReasoning,
    switchCodexMode,
    chooseLaunchDirectory,
    launch,
  };
}

export type ModelSwitchCenterState = ReturnType<typeof useModelSwitchCenter>;
