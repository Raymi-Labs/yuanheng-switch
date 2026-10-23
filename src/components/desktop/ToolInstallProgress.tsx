import { useEffect, useState, useSyncExternalStore } from "react";
import {
  useToolInstallProgress,
  useToolLifecycleState,
} from "@/lib/toolLifecycleState";
import { claudeWorkspaceSetup } from "@/lib/claudeWorkspaceSetup";
import { dt } from "./desktopI18n";

const stages = {
  preparing: "正在准备安装…",
  resolving: "正在检查官方最新版本…",
  download: "正在下载运行环境…",
  checksum: "正在校验下载文件…",
  extract: "正在解压运行环境…",
  package: "正在下载并安装 DSH…",
  verify: "正在验证工具能否运行…",
  publishing: "正在保存并验证安装…",
  executing: "正在运行官方安装程序…",
} as const;
const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;

/** Progress is shared for native jobs; external downloads remain observation only. */
export function ToolInstallProgress({
  tool,
  waitingForDesktop = false,
  onDark = false,
}: {
  tool: string;
  waitingForDesktop?: boolean;
  onDark?: boolean;
}) {
  const phase = useToolLifecycleState().get(tool);
  const progress = useToolInstallProgress().get(tool);
  const workspace = useSyncExternalStore(
    claudeWorkspaceSetup.subscribe,
    claudeWorkspaceSetup.getSnapshot,
  );
  const preparingWorkspace = tool === "claude-desktop" && workspace.busy;
  const active = Boolean(phase || waitingForDesktop || preparingWorkspace);
  const [now, setNow] = useState(Date.now);
  const [observedAt, setObservedAt] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setObservedAt(Date.now());
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, tool]);
  if (!active) return null;
  const manual = !phase && !preparingWorkspace;
  const label = preparingWorkspace
    ? workspace.state?.message || dt("正在检查 Windows 运行环境…")
    : phase === "cancelling"
      ? dt("正在停止安装…")
      : phase === "verifying"
        ? dt(stages.verify)
        : manual
          ? dt("等待完成官网安装，正在自动检测…")
          : dt(stages[progress?.stage ?? "preparing"]);
  const running = phase === "installing" || phase === "updating";
  const downloading = running && progress?.stage === "download";
  const installingPackages = running && progress?.stage === "package";
  const received = downloading ? progress?.downloadedBytes : null;
  const total = downloading ? progress?.totalBytes : null;
  const validReceived =
    typeof received === "number" && Number.isFinite(received) && received >= 0;
  const downloadPercent =
    validReceived &&
    typeof total === "number" &&
    Number.isFinite(total) &&
    total > 0 &&
    received <= total
      ? Math.floor((received / total) * 100)
      : undefined;
  const completed = installingPackages ? progress?.completedItems : null;
  const totalItems = installingPackages ? progress?.totalItems : null;
  const packagePercent =
    typeof completed === "number" &&
    Number.isSafeInteger(completed) &&
    completed >= 0 &&
    typeof totalItems === "number" &&
    Number.isSafeInteger(totalItems) &&
    totalItems > 0 &&
    completed <= totalItems
      ? Math.floor((completed / totalItems) * 100)
      : undefined;
  const percent = downloadPercent ?? packagePercent;
  const progressLabel = downloading
    ? dt("下载进度")
    : installingPackages
      ? dt("组件进度")
      : dt("安装进度");
  const startedAt = progress?.startedAt ?? observedAt;
  const quiet = Math.max(0, now - (progress?.lastActivityAt ?? observedAt));
  return (
    <div
      className={`mt-3 w-full min-w-0 rounded-lg border p-3 text-left text-xs ${onDark ? "border-white/15 bg-white/5 text-white/85" : "border-border bg-muted/30 text-muted-foreground"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span role="status" className="break-words leading-5">
          {label}
        </span>
        {percent !== undefined && (
          <span className="shrink-0 tabular-nums">
            {progressLabel} {percent}%
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={progressLabel}
        aria-valuetext={
          percent === undefined ? label : `${progressLabel} ${percent}%`
        }
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className={`relative mt-2 h-1.5 overflow-hidden rounded-full ${onDark ? "bg-white/15" : "bg-primary/10"}`}
      >
        <div
          className={`h-full rounded-full ${onDark ? "bg-[#e9b67c]" : "bg-primary"} ${percent === undefined ? "install-progress-indeterminate" : "transition-[width] duration-300"}`}
          style={{ width: percent === undefined ? "35%" : `${percent}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] tabular-nums">
        <span>
          {dt("已用时 {{time}}", { time: duration(now - startedAt) })}
        </span>
        {validReceived && (
          <span>
            {dt("已下载 {{size}}", {
              size:
                total && downloadPercent !== undefined
                  ? `${bytes(received)} / ${bytes(total)}`
                  : bytes(received),
            })}
          </span>
        )}
        {packagePercent !== undefined && (
          <span>
            {dt("已处理 {{completed}} / {{total}} 个组件", {
              completed,
              total: totalItems,
            })}
          </span>
        )}
        {!manual && !preparingWorkspace && (
          <span>{dt("距上次进展 {{time}}", { time: duration(quiet) })}</span>
        )}
      </div>
      {downloading && downloadPercent === undefined && (
        <p className="mt-2 leading-5">{dt("正在下载，文件总大小暂不可用。")}</p>
      )}
      {installingPackages && packagePercent === undefined && (
        <p className="mt-2 leading-5">
          {dt("正在解析组件清单，确认总数后显示进度。")}
        </p>
      )}
      {manual ? (
        <p className="mt-2 leading-5">
          {dt(
            "请在官网下载并运行安装包；元衡每 3 秒检测一次，最多等待 5 分钟。",
          )}
        </p>
      ) : (
        phase &&
        quiet >= 60_000 && (
          <p className="mt-2 leading-5">
            {dt(
              "暂未收到新的进度，安装可能仍在进行。请检查网络或系统安装提示。",
            )}
          </p>
        )
      )}
    </div>
  );
}
