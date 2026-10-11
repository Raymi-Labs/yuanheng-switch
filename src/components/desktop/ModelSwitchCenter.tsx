import { CodexHistoryHint } from "./CodexHistoryHint";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ProviderIcon";
import type { YuanhengReasoningLevel, YuanhengToolId } from "@/lib/api";
import { ModelPicker } from "./ModelPicker";
import { CompactSelectPicker } from "./CompactSelectPicker";
import { GroupPicker } from "./GroupPicker";
import {
  DESKTOP_DOWNLOAD_URLS,
  canInstallTool,
  isDesktopApp,
  pickPreferredGroup,
  reasoningLabel,
  toolLabel,
} from "./ToolSetupGrid";
import {
  providerIconOf,
  type ModelSwitchCenterState,
} from "./useModelSwitchCenter";
import { dt } from "./desktopI18n";
import { ToolActivationProgress } from "./ToolActivationProgress";
import { useToolLifecycleState } from "@/lib/toolLifecycleState";
import { toolInstallLabel } from "./toolInstallFeedback";
import { ToolInstallCancel } from "./ToolInstallCancel";
import { TOOL_VERSION_TARGETS } from "./ToolSetupGrid";

const controlsReasoning = (app: YuanhengToolId) =>
  app === "claude-desktop" || app === "codex" || app === "chatgpt-desktop";

interface ModelSwitchCenterProps {
  switcher: ModelSwitchCenterState;
  onOpenTools: () => void;
}

export function ModelSwitchCenter({
  switcher,
  onOpenTools,
}: ModelSwitchCenterProps) {
  const cliLifecycle = useToolLifecycleState();
  const {
    connection,
    terminalModels,
    modelMeta,
    bootstrapPhase,
    bootstrapRefreshing,
    retryBootstrap,
    rows,
    installedApps,
    models,
    groups,
    reasoning,
    pendingApps,
    installingApps,
    restartRequiredApps,
    statusMap,
    activationMap,
    preflightResults,
    codexBridge,
    codexAccountMode,
    codexModePending,
    refreshModels,
    install,
    chooseDesktopPath,
    applyModel,
    applyGroup,
    applyReasoning,
    switchCodexMode,
    launch,
  } = switcher;
  const groupMap = new Map(
    connection?.groups.map((group) => [group.id, group]),
  );
  const connected = Boolean(connection?.connected);

  if (bootstrapPhase === "loading") {
    return (
      <section
        className="flex min-h-40 flex-col rounded-2xl border bg-card p-4 shadow-sm"
        aria-label={dt("正在检测本机工具")}
        aria-busy="true"
      >
        <div className="flex items-center justify-between px-1 pb-3">
          <div>
            <h2 className="font-display text-base font-semibold">
              {dt("快捷控制台")}
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {dt("正在读取本机工具与配置状态")}
            </p>
          </div>
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
        <div className="space-y-2" aria-hidden>
          {[0, 1].map((item) => (
            <div
              key={item}
              className="animate-pulse rounded-xl border bg-background/60 p-3"
            >
              <div className="flex items-center gap-2.5">
                <span className="h-8 w-8 rounded-lg bg-muted" />
                <div className="space-y-1.5">
                  <div className="h-2.5 w-20 rounded-full bg-muted" />
                  <div className="h-2 w-28 rounded-full bg-muted/70" />
                </div>
              </div>
              <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
                <div className="h-8 rounded-md bg-muted/70" />
                <div className="h-8 rounded-md bg-muted/70" />
                <div className="h-8 rounded-md bg-muted/70" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between px-1 pb-3">
        <div>
          <h2 className="font-display text-base font-semibold">
            {dt("快捷控制台")}
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {connected
              ? dt("直接调整模型、令牌分组和推理等级")
              : dt("连接元衡后即可在此切换模型")}
          </p>
        </div>
        {bootstrapRefreshing && (
          <Loader2
            className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground"
            aria-label={dt("正在核验工具状态")}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={bootstrapRefreshing}
          onClick={() => void retryBootstrap()}
        >
          <RefreshCw
            className={
              bootstrapRefreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"
            }
          />
          {dt("重新检测")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenTools}>
          {dt("安装与维护")}
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>

      {!connected && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[10px] text-amber-800 dark:text-amber-200">
          <Settings2 className="h-3.5 w-3.5 shrink-0" />
          <span>{dt("模型目录与可用分组来自你的元衡账号。")}</span>
        </div>
      )}

      {switcher.inventoryRefreshFailed && (
        <p
          role="status"
          className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground"
        >
          {dt("本次检测暂未完成，仍显示上次本机快照；启动前会重新验证。")}
        </p>
      )}
      {bootstrapPhase === "error" && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[10px] text-amber-800 dark:text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{dt("检测失败不会再显示成“未安装”，请重新检测。")}</span>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-center">
          <p className="text-[12px] text-muted-foreground">
            {dt("未检测到已安装的 AI 工具")}
          </p>
          <Button variant="outline" size="sm" onClick={onOpenTools}>
            {dt("去安装与配置")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((app) => {
            const status = statusMap.get(app);
            const detectionFailed = bootstrapPhase === "error";
            const installed = installedApps.has(app);
            const supported = Boolean(status?.supported);
            const isCodexSurface = app === "codex" || app === "chatgpt-desktop";
            const usesOfficialCodexAccount =
              isCodexSurface && codexAccountMode.data?.mode === "official";
            const runnable =
              installed &&
              (usesOfficialCodexAccount || (connected && supported));
            const configured = Boolean(
              installed && (usesOfficialCodexAccount || status?.configured),
            );
            const installing = installingApps.has(app);
            const pending = pendingApps.has(app) || installing;
            const selectedModel =
              models[app] ??
              status?.model ??
              status?.recommendedModel ??
              undefined;
            const availableGroups = selectedModel
              ? (connection?.modelGroups[selectedModel] ?? [])
              : [];
            const selectedGroup = selectedModel
              ? pickPreferredGroup(
                  connection,
                  selectedModel,
                  groups[app] ?? status?.group ?? undefined,
                )
              : undefined;
            const supportedReasoning = selectedModel
              ? (connection?.reasoningLevels[selectedModel] ?? [])
              : [];
            const defaultReasoning = selectedModel
              ? connection?.reasoningDefaults?.[selectedModel]
              : undefined;
            const reasoningOptions: YuanhengReasoningLevel[] = [
              "auto",
              ...supportedReasoning.filter((level) => level !== "auto"),
            ];
            const requestedReasoning =
              reasoning[app] ?? status?.reasoning ?? "auto";
            const selectedReasoning: YuanhengReasoningLevel =
              requestedReasoning === "auto" ||
              supportedReasoning.includes(requestedReasoning)
                ? requestedReasoning
                : "auto";
            const showReasoning =
              controlsReasoning(app) && supportedReasoning.length > 0;
            const restartRequired = restartRequiredApps.has(app);
            const codexStatus = (() => {
              if (app !== "codex" || !codexBridge.data?.connectedTerminals)
                return null;
              if (codexBridge.data.pendingTerminals > 0) {
                return dt("待 {{v0}} 个终端下一条消息应用", {
                  v0: codexBridge.data.pendingTerminals,
                });
              }
              if (codexBridge.data.appliedTerminals > 0) {
                return dt("已应用 {{v0}}", {
                  v0: codexBridge.data.model ?? models.codex,
                });
              }
              return dt("已连接 {{v0}} 个终端", {
                v0: codexBridge.data.connectedTerminals,
              });
            })();
            return (
              <div key={app} className="rounded-xl border bg-background/60 p-3">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <ProviderIcon
                      icon={providerIconOf(app)}
                      name={toolLabel(app)}
                      size={17}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-semibold">
                      {toolLabel(app)}
                    </p>
                    <p
                      className="flex min-w-0 items-center gap-1 text-[9.5px] text-muted-foreground"
                      title={codexStatus ?? undefined}
                    >
                      {configured ? (
                        <>
                          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                          <span className="truncate">
                            {restartRequired
                              ? dt("需要重启以加载模型目录")
                              : usesOfficialCodexAccount
                                ? dt("OpenAI 官方账号")
                                : activationMap.get(app)?.lastStatusCode &&
                                    activationMap.get(app)!.lastStatusCode! >=
                                      400
                                  ? dt("调用失败（HTTP {{code}}）", {
                                      code: activationMap.get(app)!
                                        .lastStatusCode,
                                    })
                                  : (codexStatus ?? dt("配置已写入"))}
                          </span>
                        </>
                      ) : detectionFailed ? (
                        dt("本机工具检测失败")
                      ) : !installed ? (
                        dt("未检测到")
                      ) : supported ? (
                        dt("待配置")
                      ) : (
                        (status?.message ??
                        dt("{{v0}} 没有可用模型", { v0: toolLabel(app) }))
                      )}
                    </p>
                  </div>
                  <ToolInstallCancel tool={TOOL_VERSION_TARGETS[app] ?? ""} />
                  {runnable ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 px-3 text-[11px]"
                      disabled={pending}
                      aria-label={
                        restartRequired
                          ? dt("重启并应用 {{v0}}", { v0: toolLabel(app) })
                          : dt("启动 {{v0}}", { v0: toolLabel(app) })
                      }
                      title={
                        restartRequired
                          ? dt("重启并应用 {{v0}}", { v0: toolLabel(app) })
                          : dt("启动 {{v0}}", { v0: toolLabel(app) })
                      }
                      onClick={() => void launch(app)}
                    >
                      {pending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5 fill-current" />
                      )}
                      {restartRequired ? dt("重启并应用") : dt("启动")}
                    </Button>
                  ) : (
                    <div className="flex shrink-0 gap-1.5">
                      {isDesktopApp(app) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 px-2.5 text-[10px]"
                          onClick={() => void chooseDesktopPath(app)}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                          {dt("选择路径")}
                        </Button>
                      )}
                      {!installed &&
                        !detectionFailed &&
                        canInstallTool(app) && (
                          <Button
                            size="sm"
                            className="h-8 px-2.5 text-[10px]"
                            disabled={installing}
                            onClick={() => void install(app)}
                          >
                            {installing ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Download className="h-3.5 w-3.5" />
                            )}
                            {installing
                              ? DESKTOP_DOWNLOAD_URLS[app]
                                ? dt("等待安装")
                                : toolInstallLabel(
                                    cliLifecycle.get(
                                      TOOL_VERSION_TARGETS[app] ?? "",
                                    ),
                                  )
                              : DESKTOP_DOWNLOAD_URLS[app]
                                ? dt("官方下载")
                                : dt("一键安装")}
                          </Button>
                        )}
                    </div>
                  )}
                </div>

                {isCodexSurface && installed && (
                  <div className="mt-2.5 flex items-center justify-between gap-3 rounded-lg border bg-muted/25 px-2.5 py-2">
                    <div className="min-w-0">
                      <p className="text-[9px] font-medium text-muted-foreground">
                        {dt("使用方式")}
                      </p>
                      <p className="truncate text-[10px]">
                        {usesOfficialCodexAccount
                          ? dt("使用 Codex 中已登录的 OpenAI 官方账号")
                          : dt("使用元衡模型与令牌分组")}
                      </p>
                      <CodexHistoryHint status={codexAccountMode.data} />
                    </div>
                    <div className="flex shrink-0 rounded-md border bg-background p-0.5">
                      {(["yuanheng", "official"] as const).map((mode) => {
                        const active = codexAccountMode.data?.mode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            disabled={codexModePending || pending}
                            onClick={() => void switchCodexMode(mode)}
                            className={`h-6 rounded px-2 text-[9px] font-semibold transition-colors disabled:opacity-50 ${
                              active
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            }`}
                          >
                            {codexModePending && !active ? (
                              <Loader2 className="mx-auto h-3 w-3 animate-spin" />
                            ) : mode === "yuanheng" ? (
                              dt("元衡中转")
                            ) : (
                              dt("OpenAI 官方")
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {(configured || preflightResults[app]) && (
                  <div className="mt-2.5">
                    <ToolActivationProgress
                      activation={activationMap.get(app)}
                      preflight={preflightResults[app]}
                      restartRequired={restartRequired}
                      compact
                    />
                  </div>
                )}

                {runnable ? (
                  usesOfficialCodexAccount ? (
                    <p className="mt-2.5 rounded-lg border border-emerald-500/15 bg-emerald-500/[0.05] px-3 py-2 text-[10px] leading-4 text-muted-foreground">
                      {dt(
                        "模型与推理等级由 Codex 官方账号管理；切回元衡后会恢复上次选择。",
                      )}
                    </p>
                  ) : (
                    <div className="mt-2.5 grid gap-2 sm:grid-cols-[minmax(0,1.55fr)_minmax(92px,.8fr)_minmax(92px,.8fr)]">
                      <label className="min-w-0">
                        <span className="mb-1 block text-[9px] font-medium text-muted-foreground">
                          {dt("模型")}
                        </span>
                        <ModelPicker
                          models={terminalModels}
                          value={selectedModel}
                          recommended={status?.recommendedModel}
                          modelMeta={modelMeta}
                          label={dt("{{v0}} 模型选择", { v0: toolLabel(app) })}
                          disabled={pending}
                          className="mt-0 h-8"
                          onRefresh={refreshModels}
                          onChange={(model) => void applyModel(app, model)}
                        />
                      </label>

                      <label className="min-w-0">
                        <span className="mb-1 block text-[9px] font-medium text-muted-foreground">
                          {dt("令牌分组")}
                        </span>
                        <GroupPicker
                          label={dt("{{v0}} 快捷令牌分组", {
                            v0: toolLabel(app),
                          })}
                          value={selectedGroup ?? ""}
                          disabled={pending || availableGroups.length <= 1}
                          options={
                            availableGroups.length === 0
                              ? [{ value: "", label: dt("账号默认") }]
                              : availableGroups.map((group) => {
                                  const option = groupMap.get(group);
                                  return {
                                    value: group,
                                    label: `${group}${option?.ratio != null ? ` · ${option.ratio}x` : ""}`,
                                  };
                                })
                          }
                          onChange={(group) => void applyGroup(app, group)}
                        />
                      </label>

                      <label className="min-w-0">
                        <span className="mb-1 block text-[9px] font-medium text-muted-foreground">
                          {dt("推理等级")}
                        </span>
                        <CompactSelectPicker
                          label={dt("{{v0}} 快捷推理等级", {
                            v0: toolLabel(app),
                          })}
                          value={
                            showReasoning ? selectedReasoning : "unsupported"
                          }
                          disabled={pending || !showReasoning}
                          options={
                            !showReasoning
                              ? [{ value: "unsupported", label: dt("不适用") }]
                              : reasoningOptions.map((level) => ({
                                  value: level,
                                  label: reasoningLabel(
                                    level,
                                    defaultReasoning,
                                  ),
                                }))
                          }
                          onChange={(level) =>
                            void applyReasoning(
                              app,
                              level as YuanhengReasoningLevel,
                            )
                          }
                        />
                      </label>
                    </div>
                  )
                ) : (
                  <p className="mt-2.5 rounded-lg bg-muted/45 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
                    {detectionFailed
                      ? dt("检测失败不会再显示成“未安装”，请重新检测。")
                      : !installed
                        ? dt("安装后即可由元衡自动配置。")
                        : !connected
                          ? dt("连接元衡后即可在此切换模型")
                          : (status?.message ??
                            dt("{{v0}} 没有可用模型", { v0: toolLabel(app) }))}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
