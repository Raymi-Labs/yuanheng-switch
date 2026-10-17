import { ToolInstallProgress } from "./ToolInstallProgress";
import { CodexHistoryHint } from "./CodexHistoryHint";
import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  Wrench,
} from "lucide-react";
import {
  isYuanhengCliTool,
  type YuanhengReasoningLevel,
  type YuanhengToolId,
} from "@/lib/api";
import { ModelPicker } from "./ModelPicker";
import { CompactSelectPicker } from "./CompactSelectPicker";
import { GroupPicker } from "./GroupPicker";
import {
  canInstallTool,
  DESKTOP_DOWNLOAD_URLS,
  TOOL_VERSION_TARGETS,
  pickPreferredGroup,
  reasoningLabel,
  toolLabel,
} from "./ToolSetupGrid";
import {
  providerIconOf,
  type ModelSwitchCenterState,
} from "./useModelSwitchCenter";
import { groupModelsByVendor, modelVendorOf } from "./modelVendors";
import { dt } from "./desktopI18n";
import { launchDirectoryLabel } from "./useToolLaunchDirectories";
import { ToolActivationProgress } from "./ToolActivationProgress";
import { DshUpdateControl } from "./DshUpdateControl";
import { ToolInstallCancel } from "./ToolInstallCancel";
import { toolInstallLabel } from "./toolInstallFeedback";
import { useToolLifecycleState } from "@/lib/toolLifecycleState";

interface FocusToolCardProps {
  switcher: ModelSwitchCenterState;
  focusApp?: YuanhengToolId;
  availableTools?: YuanhengToolId[];
  onToolChange?: (app: YuanhengToolId) => void;
  onOpenTools: () => void;
}

const focusCardShell =
  "relative min-h-[246px] overflow-hidden rounded-2xl bg-gradient-to-br from-[#0f2a26] to-[#173f3a] p-5 text-[#eef5f2] shadow-[0_18px_40px_-22px_rgba(15,42,38,0.55)]";

function FocusToolDecoration() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute -right-14 -top-20 h-52 w-52 rounded-full border border-white/[0.07]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-9 right-3 h-32 w-32 rounded-full border border-white/[0.07]"
      />
    </>
  );
}

function FocusToolLoadingCard({ toolPicker }: { toolPicker?: ReactNode }) {
  return (
    <section
      className={focusCardShell}
      aria-label={dt("正在检测本机工具")}
      aria-busy="true"
    >
      <FocusToolDecoration />
      {toolPicker && <div className="relative mb-4">{toolPicker}</div>}
      <div className="relative animate-pulse">
        <div className="flex items-center gap-3">
          <span className="h-[42px] w-[42px] rounded-xl bg-white/10" />
          <div className="space-y-2">
            <div className="h-2 w-16 rounded-full bg-white/10" />
            <div className="h-4 w-24 rounded-full bg-white/15" />
          </div>
          <div className="ml-auto h-[34px] w-20 rounded-[10px] bg-white/10" />
        </div>
        <div className="mt-5 flex items-center gap-3">
          <div className="h-2.5 w-14 rounded-full bg-white/10" />
          <div className="h-7 w-40 rounded-full bg-white/15" />
        </div>
        <div className="mt-5 rounded-xl border border-white/10 bg-black/10 p-3">
          <div className="mb-3 h-2.5 w-20 rounded-full bg-white/10" />
          <div className="grid gap-2 sm:grid-cols-3">
            {[0, 1, 2].map((item) => (
              <div key={item} className="space-y-1.5">
                <div className="h-2 w-14 rounded-full bg-white/10" />
                <div className="h-8 rounded-md bg-white/10" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="sr-only">{dt("正在读取本机工具与配置状态")}</p>
    </section>
  );
}

function FocusToolStateCard({
  error,
  selectedTool,
  onOpenTools,
  onRetry,
  refreshing,
  toolPicker,
  onInstall,
  installing = false,
}: {
  error?: boolean;
  selectedTool?: YuanhengToolId;
  onOpenTools: () => void;
  onRetry: () => Promise<void>;
  refreshing: boolean;
  toolPicker?: ReactNode;
  onInstall?: () => void;
  installing?: boolean;
}) {
  const lifecycle = useToolLifecycleState();
  const target = selectedTool ? TOOL_VERSION_TARGETS[selectedTool] : undefined;
  const phase = lifecycle.get(target ?? "");
  const busy = installing || Boolean(phase);
  const download = selectedTool && DESKTOP_DOWNLOAD_URLS[selectedTool];
  const Icon = error ? AlertTriangle : Wrench;
  return (
    <section className={focusCardShell}>
      <FocusToolDecoration />
      {toolPicker && <div className="relative mb-4">{toolPicker}</div>}
      <div className="relative flex min-h-[206px] flex-col items-center justify-center text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/10">
          <Icon className="h-5 w-5 text-[#e9b67c]" />
        </span>
        <h2 className="mt-3 font-display text-[16px] font-semibold">
          {selectedTool
            ? toolLabel(selectedTool)
            : error
              ? dt("本机工具检测失败")
              : dt("尚未检测到已安装的 AI 工具")}
        </h2>
        <p className="mt-1 max-w-sm text-[10.5px] text-white/55">
          {error
            ? dt("没有将检测失败误判为未安装，你可以重新检测或进入工具管理。")
            : dt("安装或配置工具后，这里会显示当前工具、模型和令牌分组。")}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            disabled={refreshing || busy}
            onClick={() => void onRetry()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.08] px-3 text-[11px] font-semibold transition-colors hover:bg-white/[0.13] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
            {dt("重新检测")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onInstall ?? onOpenTools}
            aria-label={
              onInstall && selectedTool && !busy
                ? download
                  ? dt("打开 {{v0}} 官方下载页", {
                      v0: toolLabel(selectedTool),
                    })
                  : dt("一键安装 {{v0}}", { v0: toolLabel(selectedTool) })
                : undefined
            }
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#e9b67c] px-3 text-[11px] font-semibold text-[#163a36] transition-colors hover:bg-[#f3c995] disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wrench className="h-3.5 w-3.5" />
            )}
            {busy
              ? phase
                ? toolInstallLabel(phase)
                : dt("等待安装")
              : error || !onInstall
                ? dt("打开工具管理")
                : download
                  ? dt("官方下载")
                  : dt("安装与配置")}
          </button>
          {target && <ToolInstallCancel tool={target} />}
        </div>
        <div className="w-full max-w-lg">
          <ToolInstallProgress
            tool={target ?? ""}
            waitingForDesktop={Boolean(busy && download)}
            onDark
          />
        </div>
      </div>
    </section>
  );
}

/**
 * 首页焦点工具卡：当前工具的大字模型展示 + 供应商 / 模型 / 分组切换。
 * 复用工作台状态处理配置、推理等级、检测与启动。
 */
export function FocusToolCard({
  switcher,
  focusApp,
  availableTools,
  onToolChange,
  onOpenTools,
}: FocusToolCardProps) {
  const {
    connection,
    terminalModels,
    modelMeta,
    bootstrapPhase,
    bootstrapRefreshing,
    inventoryRefreshFailed,
    retryBootstrap,
    runnableRows,
    models,
    groups,
    reasoning,
    pendingApps,
    restartRequiredApps,
    launchDirectories,
    launchDirectoryPendingApps,
    statusMap,
    activationMap,
    preflightResults,
    codexBridge,
    codexAccountMode,
    codexModePending,
    refreshModels,
    applyModel,
    applyGroup,
    applyReasoning,
    switchCodexMode,
    chooseLaunchDirectory,
    launch,
  } = switcher;

  const app = focusApp ?? runnableRows[0];
  const status = app ? statusMap.get(app) : undefined;
  const current = app ? models[app] : undefined;
  const currentGroup = app ? (groups[app] ?? status?.group) : undefined;
  const currentReasoning = app
    ? (reasoning[app] ?? status?.reasoning ?? "auto")
    : "auto";
  const vendorGroups = useMemo(
    () => groupModelsByVendor(terminalModels),
    [terminalModels],
  );
  const currentVendorId = current ? modelVendorOf(current).id : undefined;
  const [selectedVendors, setSelectedVendors] = useState<
    Partial<Record<YuanhengToolId, string>>
  >({});

  const toolPicker =
    app && onToolChange && availableTools ? (
      <div className="min-w-0 max-w-[260px]">
        <p className="mb-1.5 text-[10px] font-semibold tracking-[0.12em] text-white/65">
          {dt("当前工具")}
        </p>
        <CompactSelectPicker
          label={dt("选择当前工具")}
          value={app}
          options={availableTools.map((tool) => ({
            value: tool,
            label: toolLabel(tool),
            icon: providerIconOf(tool),
          }))}
          onChange={(tool) => onToolChange(tool as YuanhengToolId)}
          triggerClassName="h-10 border-[#e9b67c]/50 bg-white/10 px-3 text-[15px] font-semibold text-white hover:bg-white/15 focus:ring-[#e9b67c] [&>svg]:text-[#e9b67c] [&>svg]:opacity-100"
          itemClassName="text-sm"
        />
      </div>
    ) : null;

  if (
    bootstrapPhase === "loading" ||
    (!connection?.connected && codexAccountMode.data?.mode !== "official")
  ) {
    return <FocusToolLoadingCard toolPicker={toolPicker} />;
  }
  if (bootstrapPhase === "error") {
    return (
      <FocusToolStateCard
        error
        onOpenTools={onOpenTools}
        onRetry={retryBootstrap}
        refreshing={bootstrapRefreshing}
        toolPicker={toolPicker}
      />
    );
  }
  if (!app || !runnableRows.includes(app)) {
    const canInstall =
      app && !switcher.installedApps.has(app) && canInstallTool(app);
    return (
      <FocusToolStateCard
        error={inventoryRefreshFailed}
        selectedTool={app}
        onOpenTools={onOpenTools}
        onInstall={
          canInstall && !inventoryRefreshFailed
            ? () => void switcher.install(app)
            : undefined
        }
        installing={app ? switcher.installingApps.has(app) : false}
        onRetry={retryBootstrap}
        refreshing={bootstrapRefreshing}
        toolPicker={toolPicker}
      />
    );
  }

  const pending = pendingApps.has(app) || switcher.installingApps.has(app);
  const isCodexSurface = app === "codex" || app === "chatgpt-desktop";
  const usesOfficialCodexAccount =
    isCodexSurface && codexAccountMode.data?.mode === "official";
  const supportedReasoning = current
    ? (connection?.reasoningLevels[current] ?? [])
    : [];
  const defaultReasoning = current
    ? connection?.reasoningDefaults?.[current]
    : undefined;
  const showReasoning =
    (app === "claude-desktop" || isCodexSurface) &&
    supportedReasoning.length > 0;
  const selectedReasoning =
    currentReasoning === "auto" || supportedReasoning.includes(currentReasoning)
      ? currentReasoning
      : "auto";
  const reasoningOptions: YuanhengReasoningLevel[] = [
    "auto",
    ...supportedReasoning.filter((level) => level !== "auto"),
  ];
  const codexStatus =
    app === "codex" &&
    !usesOfficialCodexAccount &&
    codexBridge.data?.connectedTerminals
      ? codexBridge.data.pendingTerminals > 0
        ? dt("待 {{v0}} 个终端下一条消息应用", {
            v0: codexBridge.data.pendingTerminals,
          })
        : codexBridge.data.appliedTerminals > 0
          ? dt("已应用 {{v0}}", { v0: codexBridge.data.model ?? current })
          : dt("已连接 {{v0}} 个终端", {
              v0: codexBridge.data.connectedTerminals,
            })
      : null;
  const launchDirectory = launchDirectories[app];
  const launchDirectoryPending = launchDirectoryPendingApps.has(app);
  const configured = usesOfficialCodexAccount || Boolean(status?.configured);
  const restartRequired = restartRequiredApps.has(app);
  const selectedVendor =
    vendorGroups.find((vendor) => vendor.id === selectedVendors[app]) ??
    vendorGroups.find((vendor) => vendor.id === currentVendorId) ??
    vendorGroups[0];
  const visibleModel =
    selectedVendor?.id === currentVendorId ? current : undefined;
  const recommendedModel =
    status?.recommendedModel &&
    modelVendorOf(status.recommendedModel).id === selectedVendor?.id
      ? status.recommendedModel
      : undefined;
  const availableGroups = current
    ? (connection?.modelGroups[current] ?? [])
    : [];
  const selectedGroup = current
    ? pickPreferredGroup(
        connection,
        current,
        groups[app] ?? status?.group ?? undefined,
      )
    : undefined;
  const groupMap = new Map(
    (connection?.groups ?? []).map((group) => [group.id, group]),
  );
  const vendorOptions = vendorGroups.map((vendor) => ({
    value: vendor.id,
    label: `${vendor.label} · ${vendor.models.length}`,
    icon: vendor.icon,
    iconName: vendor.label,
  }));
  const groupOptions =
    availableGroups.length === 0
      ? [{ value: "", label: dt("账号默认") }]
      : availableGroups.map((group) => {
          const option = groupMap.get(group);
          return {
            value: group,
            label: `${group}${option?.ratio != null ? ` · ${option.ratio}x` : ""}`,
          };
        });

  return (
    <section className={focusCardShell}>
      <FocusToolDecoration />

      <div className="relative flex flex-wrap items-center gap-3">
        {toolPicker ? (
          <div className="min-w-0 flex-1 basis-40">
            {toolPicker}
            {configured && (
              <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-emerald-300">
                <CheckCircle2 className="h-3 w-3" />
                {dt("已配置")}
              </span>
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="text-[10px] text-white/65">{dt("当前工具")}</p>
            <p className="font-display text-[17px] font-semibold">
              {toolLabel(app)}
            </p>
          </div>
        )}
        <button
          type="button"
          disabled={bootstrapRefreshing}
          aria-label={dt("重新检测")}
          title={dt("重新检测")}
          onClick={() => void retryBootstrap()}
          className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${bootstrapRefreshing ? "animate-spin" : ""}`}
          />
        </button>
        <button
          type="button"
          disabled={pending}
          aria-label={
            restartRequired
              ? dt("重启并应用 {{v0}}", { v0: toolLabel(app) })
              : dt("启动 {{v0}}", { v0: toolLabel(app) })
          }
          onClick={() => void launch(app)}
          className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-[10px] bg-[#e9b67c] px-4 text-[12px] font-semibold text-[#163a36] transition-colors hover:bg-[#f3c995] disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5 fill-current" />
          )}
          {restartRequired ? dt("重启并应用") : dt("启动")}
        </button>
      </div>

      {app === "dsh" && <DshUpdateControl busy={pendingApps.has(app)} onDark />}

      <div className="relative mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[11px] text-white/55">{dt("当前模型")}</span>
        <span className="font-display text-2xl font-semibold tabular-nums tracking-tight">
          {usesOfficialCodexAccount
            ? dt("OpenAI 官方账号")
            : (current ?? dt("未选择"))}
        </span>
        {!usesOfficialCodexAccount && currentGroup && (
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/75">
            {currentGroup} {dt("分组")}
          </span>
        )}
        {!usesOfficialCodexAccount && currentReasoning !== "auto" && (
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/75">
            {currentReasoning} {dt("推理")}
          </span>
        )}
        {isYuanhengCliTool(app) && (
          <button
            type="button"
            disabled={pending || launchDirectoryPending}
            aria-label={dt("选择 {{tool}} 工作目录", {
              tool: toolLabel(app),
            })}
            title={launchDirectory ?? dt("用户主目录")}
            onClick={() => void chooseLaunchDirectory(app)}
            className="inline-flex min-w-0 items-center gap-1.5 text-[10px] text-white/60 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {launchDirectoryPending ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            ) : (
              <FolderOpen className="h-3 w-3 shrink-0" />
            )}
            <span>{dt("工作目录")}</span>
            <span className="max-w-[180px] truncate font-medium text-white/85">
              {launchDirectoryLabel(launchDirectory)}
            </span>
          </button>
        )}
      </div>

      {codexStatus && (
        <p
          role="status"
          className="relative mt-2 text-[10px] text-emerald-200/80"
        >
          {codexStatus}
        </p>
      )}
      {inventoryRefreshFailed && (
        <p
          role="status"
          className="relative mt-2 rounded-lg bg-amber-300/10 px-3 py-2 text-[10px] text-amber-100/80"
        >
          {dt("本次检测暂未完成，仍显示上次本机快照；启动前会重新验证。")}
        </p>
      )}

      {isCodexSurface && (
        <div className="relative mt-3 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2">
          <div>
            <p className="text-[10px] font-semibold text-white/75">
              {dt("使用方式")}
            </p>
            <p className="mt-0.5 text-[9px] text-white/45">
              {usesOfficialCodexAccount
                ? dt("使用 Codex 中已登录的 OpenAI 官方账号")
                : dt("使用元衡模型、分组与本地安全路由")}
            </p>
            <CodexHistoryHint status={codexAccountMode.data} />
          </div>
          <div className="flex shrink-0 rounded-lg border border-white/10 bg-black/15 p-0.5">
            {(["yuanheng", "official"] as const).map((mode) => {
              const active = codexAccountMode.data?.mode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={codexModePending || pending}
                  onClick={() => void switchCodexMode(mode)}
                  className={`h-7 rounded-md px-2.5 text-[10px] font-semibold transition-colors disabled:opacity-50 ${
                    active
                      ? "bg-[#e9b67c] text-[#163a36]"
                      : "text-white/60 hover:bg-white/10 hover:text-white"
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

      <div className="relative mt-3">
        <ToolActivationProgress
          activation={activationMap.get(app)}
          preflight={preflightResults[app]}
          restartRequired={restartRequired}
          dark
        />
      </div>

      {!usesOfficialCodexAccount && (
        <div className="relative mt-4 rounded-xl border border-white/10 bg-black/10 p-3">
          <div
            className={`grid gap-2 ${showReasoning ? "sm:grid-cols-2" : "sm:grid-cols-[minmax(116px,.8fr)_minmax(0,1.35fr)_minmax(108px,.8fr)]"}`}
          >
            <label className="min-w-0">
              <span className="mb-1 block text-[9px] font-medium text-white/50">
                {dt("1 · 模型供应商")}
              </span>
              <CompactSelectPicker
                label={dt("{{v0}} 模型供应商", { v0: toolLabel(app) })}
                value={selectedVendor?.id ?? ""}
                options={vendorOptions}
                disabled={pending || vendorGroups.length === 0}
                triggerClassName="border-white/15 bg-white/[0.08] px-2.5 text-[10.5px] text-white transition-colors hover:bg-white/[0.12] focus:border-[#e9b67c]/70"
                onChange={(vendor) =>
                  setSelectedVendors((currentSelections) => ({
                    ...currentSelections,
                    [app]: vendor,
                  }))
                }
              />
            </label>

            <label className="min-w-0">
              <span className="mb-1 block text-[9px] font-medium text-white/50">
                {dt("2 · 细分模型")}
              </span>
              <ModelPicker
                models={selectedVendor?.models ?? []}
                value={visibleModel}
                recommended={recommendedModel}
                modelMeta={modelMeta}
                label={dt("{{v0}} {{v1}}模型", {
                  v0: toolLabel(app),
                  v1: selectedVendor?.label ?? "",
                })}
                disabled={pending || !selectedVendor}
                triggerLabel={
                  visibleModel ??
                  dt("选择 {{v0}}模型", {
                    v0: selectedVendor?.label ?? dt("供应商"),
                  })
                }
                className="mt-0 h-8 border-white/15 bg-white/[0.08] text-[10.5px] text-white shadow-sm hover:bg-white/[0.12]"
                onRefresh={refreshModels}
                onChange={(model) => void applyModel(app, model)}
              />
            </label>

            <label className="min-w-0">
              <span className="mb-1 block text-[9px] font-medium text-white/50">
                {dt("3 · 令牌分组")}
              </span>
              <GroupPicker
                label={dt("{{v0}} 当前工具令牌分组", {
                  v0: toolLabel(app),
                })}
                value={selectedGroup ?? ""}
                options={groupOptions}
                disabled={pending || availableGroups.length <= 1}
                triggerClassName="border-white/15 bg-white/[0.08] px-2.5 text-[10.5px] text-white transition-colors hover:bg-white/[0.12] focus:border-[#e9b67c]/70"
                onChange={(group) => void applyGroup(app, group)}
              />
            </label>
            {showReasoning && (
              <label className="min-w-0">
                <span className="mb-1 block text-[9px] font-medium text-white/50">
                  {dt("推理等级")}
                </span>
                <CompactSelectPicker
                  label={dt("{{v0}} 推理等级", { v0: toolLabel(app) })}
                  value={selectedReasoning}
                  options={reasoningOptions.map((level) => ({
                    value: level,
                    label: reasoningLabel(level, defaultReasoning),
                  }))}
                  disabled={pending}
                  triggerClassName="border-white/15 bg-white/[0.08] px-2.5 text-[10.5px] text-white transition-colors hover:bg-white/[0.12] focus:border-[#e9b67c]/70"
                  onChange={(level) =>
                    void applyReasoning(app, level as YuanhengReasoningLevel)
                  }
                />
              </label>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
