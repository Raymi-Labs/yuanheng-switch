import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Cloud,
  Download,
  Loader2,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  Stethoscope,
  Undo2,
  Wrench,
  FileSearch,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { settingsApi, yuanhengApi } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import {
  useRepairYuanheng,
  useRollbackYuanhengTools,
  useRotateYuanhengCredential,
  useYuanhengConnection,
  useYuanhengDiagnostics,
} from "@/lib/query/yuanheng";
import { extractErrorMessage } from "@/utils/errorUtils";
import { cn } from "@/lib/utils";
import { dt } from "./desktopI18n";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

import { LoopbackProxyCompatibility } from "./LoopbackProxyCompatibility";

interface YuanhengHealthCardProps {
  compact?: boolean;
  initiallyExpanded?: boolean;
  // Hides explicit repairs; the existing diagnostic command can maintain history routes.
  checkOnly?: boolean;
  onOpenConnection?: () => void;
  onConfigureTools?: () => void;
}

const STATUS_META = {
  idle: {
    title: "连接与配置检查",
    description: "工具无法连接或报错时，检查登录状态、访问凭据和本地路由。",
    icon: Stethoscope,
    tone: "text-muted-foreground",
    background: "bg-muted",
  },
  ok: {
    title: "检查通过",
    description: "配置检查已通过，实际调用以请求记录为准。",
    icon: CheckCircle2,
    tone: "text-emerald-600 dark:text-emerald-400",
    background: "bg-emerald-500/10",
  },
  warning: {
    title: "存在需要关注的项目",
    description: "请查看本次检查详情与诊断报告。",
    icon: AlertTriangle,
    tone: "text-amber-600 dark:text-amber-400",
    background: "bg-amber-500/10",
  },
  error: {
    title: "部分检查未通过",
    description: "检查结果中有需要处理的问题。",
    icon: ShieldAlert,
    tone: "text-red-600 dark:text-red-400",
    background: "bg-red-500/10",
  },
} as const;

export function YuanhengHealthCard({
  compact = false,
  initiallyExpanded = false,
  checkOnly = false,
  onOpenConnection,
  onConfigureTools,
}: YuanhengHealthCardProps) {
  const { data: connection } = useYuanhengConnection();
  // 首屏不发起账号/多个分组的网络体检，由用户主动检查，避免和工具探测抢资源。
  const diagnostics = useYuanhengDiagnostics(false);
  const repair = useRepairYuanheng();
  const rotateCredential = useRotateYuanhengCredential();
  const rollbackTools = useRollbackYuanhengTools();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [credentialChoice, setCredentialChoice] = useState<{
    userId: string;
    groups: { id: string; description: string }[];
  } | null>(null);
  const [credentialGroup, setCredentialGroup] = useState("");
  const [credentialLoading, setCredentialLoading] = useState(false);
  const credentialBusy = useRef(false);
  const currentUser = useRef(connection?.userId);
  currentUser.current = connection?.userId;
  useEffect(() => {
    setCredentialChoice(null);
    setCredentialGroup("");
  }, [connection?.userId, connection?.connected]);
  useEffect(() => {
    setPreviewOpen(false);
  }, [
    connection?.baseUrl,
    connection?.userId,
    connection?.connected,
    connection?.lastSyncedAt,
  ]);
  const report = diagnostics.data;
  const meta =
    STATUS_META[diagnostics.isError ? "warning" : (report?.status ?? "idle")];
  const StatusIcon = meta.icon;
  const actions = new Set(
    report?.checks.map((check) => check.action).filter(Boolean) ?? [],
  );

  const handlePrimaryAction = async () => {
    if (!report || checkOnly) {
      const result = await diagnostics.refetch();
      if (result.isError) toast.error(dt("暂时无法检查"));
      return;
    }
    if (!connection?.connected || actions.has("login")) {
      onOpenConnection?.();
      return;
    }
    if (actions.has("repair_credentials")) {
      await openCredentialChoice();
      return;
    }
    if (actions.has("configure_tools") && !actions.has("repair_credentials")) {
      onConfigureTools?.();
      return;
    }
    if (
      report?.status === "ok" ||
      (!actions.has("repair_tools") && !actions.has("repair_credentials"))
    ) {
      const result = await diagnostics.refetch();
      if (result.isError) toast.error(dt("暂时无法检查"));
      else if (result.data?.status === "ok")
        toast.success(dt("本次检查项已通过"));
      else toast.warning(dt("本次检查发现需要关注的项目"));
      return;
    }
    const repairTargets =
      report?.checks
        .filter((check) => check.action?.startsWith("repair_"))
        .map((check) => `• ${dt(check.title)}`) ?? [];
    if (
      repairTargets.length > 0 &&
      !window.confirm(
        `${dt("即将执行以下修复：")}\n${repairTargets.join("\n")}\n\n${dt(
          "修复前会保留可恢复的原工具配置，是否继续？",
        )}`,
      )
    ) {
      return;
    }
    try {
      const result = await repair.mutateAsync(
        [...actions].filter(Boolean) as string[],
      );
      const checked = await diagnostics.refetch();
      if (checked.isError || checked.data?.status !== "ok") {
        toast.warning(dt("修复后仍有检查项未通过，请查看详情"));
        return;
      }
      toast.success(
        result.repairedTools.length > 0
          ? dt("已修复 {{v0}} 个工具配置", { v0: result.repairedTools.length })
          : dt("连接与凭据已恢复"),
      );
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("自动修复失败，请重新登录"));
    }
  };

  const copyDiagnostics = async () => {
    if (!report?.snapshotId || sharing) return;
    setSharing(true);
    try {
      const content = await yuanhengApi.getDiagnosticSnapshot(
        report.snapshotId,
      );
      await copyText(content);
      toast.success(dt("脱敏诊断已复制"));
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("复制诊断失败"));
    } finally {
      setSharing(false);
    }
  };

  const openCredentialChoice = async () => {
    if (
      credentialBusy.current ||
      repair.isPending ||
      rotateCredential.isPending
    )
      return;
    credentialBusy.current = true;
    setCredentialLoading(true);
    const userId = currentUser.current;
    try {
      const fresh = await yuanhengApi.refresh();
      if (!userId || fresh.userId !== userId || currentUser.current !== userId)
        return;
      if (!fresh.groups.length)
        throw new Error(dt("当前没有可用分组，未创建凭据，请联系管理员"));
      setCredentialGroup("");
      setCredentialChoice({ userId, groups: fresh.groups });
    } catch (error) {
      toast.error(
        extractErrorMessage(error) || dt("读取可用分组失败，未创建凭据"),
      );
    } finally {
      credentialBusy.current = false;
      setCredentialLoading(false);
    }
  };

  const rotateDeviceCredential = async () => {
    if (
      credentialBusy.current ||
      !credentialChoice ||
      !credentialGroup ||
      currentUser.current !== credentialChoice.userId
    )
      return;
    if (
      !window.confirm(
        `${dt("将为通用功能使用所选分组，实际请求按该分组计费；现有工具分组和旧令牌保持不变。是否继续？")}\n${credentialGroup}`,
      )
    ) {
      return;
    }
    credentialBusy.current = true;
    try {
      await rotateCredential.mutateAsync({
        group: credentialGroup,
        userId: credentialChoice.userId,
      });
      if (currentUser.current !== credentialChoice.userId) return;
      setCredentialChoice(null);
      const checked = await diagnostics.refetch();
      const credential = checked.data?.checks?.find(
        (check) => check.id === "credential",
      );
      if (checked.isError || credential?.status !== "ok") {
        toast.warning(dt("凭据保存后复验未通过，请查看详情；未修改工具配置"));
      } else {
        toast.success(dt("通用凭据验证通过，工具配置保持不变"));
      }
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("重新生成凭据失败"));
    } finally {
      credentialBusy.current = false;
    }
  };

  const exportDiagnostics = async () => {
    if (!report?.snapshotId || sharing) return;
    setSharing(true);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      const filePath = await settingsApi.saveFileDialog(
        `yuanheng-diagnostics-${stamp}.json`,
      );
      if (!filePath) return;
      await yuanhengApi.exportDiagnostics(filePath, report.snapshotId);
      toast.success(dt("脱敏诊断已导出"));
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("导出诊断失败"));
    } finally {
      setSharing(false);
    }
  };

  const rollbackToolConfigs = async () => {
    if (
      !window.confirm(
        dt(
          "将恢复元衡接管前的工具配置，并保留账号连接。外部修改过的文件不会被覆盖，是否继续？",
        ),
      )
    ) {
      return;
    }
    try {
      const result = await rollbackTools.mutateAsync();
      await diagnostics.refetch();
      const changed = result.restoredTools.length + result.removedTools.length;
      toast.success(
        changed > 0
          ? dt("已回滚 {{v0}} 个工具配置", { v0: changed })
          : dt("没有可安全回滚的工具配置"),
      );
      if (result.warnings.length > 0) {
        toast.info(dt("部分外部修改的配置已保留，请查看诊断详情"));
      }
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("回滚工具配置失败"));
    }
  };

  const primaryLabel = diagnostics.isFetching
    ? dt("检查中…")
    : !report
      ? dt(diagnostics.isError ? "重新检查" : "开始检查")
      : checkOnly
        ? dt("重新检查")
        : !connection?.connected || actions.has("login")
          ? dt("前往登录")
          : actions.has("configure_tools") && !actions.has("repair_credentials")
            ? dt("配置工具")
            : report?.status === "ok" ||
                (!actions.has("repair_tools") &&
                  !actions.has("repair_credentials"))
              ? dt("重新检查")
              : dt("一键修复");

  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className={cn("flex items-center gap-3 p-5", compact && "p-4")}>
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            meta.background,
            meta.tone,
          )}
        >
          <StatusIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {dt("智能体检")}
          </p>
          <h2 className="mt-1 font-display text-base font-semibold">
            {report
              ? dt(meta.title)
              : diagnostics.isError
                ? dt("暂时无法检查")
                : dt(STATUS_META.idle.title)}
          </h2>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
            {report?.checks.find((item) => item.status !== "ok")?.message
              ? dt(report.checks.find((item) => item.status !== "ok")!.message)
              : !report
                ? dt(STATUS_META.idle.description)
                : dt(meta.description)}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
          <Button
            size="sm"
            onClick={() => void handlePrimaryAction()}
            disabled={repair.isPending || diagnostics.isFetching}
          >
            {repair.isPending || diagnostics.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : !report || checkOnly ? (
              <Stethoscope className="h-3.5 w-3.5" />
            ) : report.status === "ok" ? (
              <RefreshCw className="h-3.5 w-3.5" />
            ) : !connection?.connected || actions.has("login") ? (
              <Cloud className="h-3.5 w-3.5" />
            ) : (
              <Wrench className="h-3.5 w-3.5" />
            )}
            {primaryLabel}
          </Button>
          {report && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <Stethoscope className="h-3.5 w-3.5" />
              {dt("检查详情")}
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </Button>
          )}
        </div>
      </div>

      {expanded && report && (
        <div className="space-y-2 border-t px-4 py-3">
          {diagnostics.isError && (
            <p role="status">{dt("状态刷新失败，以下为上次结果")}</p>
          )}
          <p className="text-[11px] leading-5 text-muted-foreground">
            {dt(
              "默认体检不调用模型、不测试收费推理；服务运行、网关认证和桌面工作区是不同检查项。失败时可预览并导出同一份脱敏诊断。",
            )}
          </p>
          <LoopbackProxyCompatibility />
          {report.checks.map((check) => (
            <div
              key={check.id}
              className="flex items-start gap-2 rounded-lg bg-muted/35 px-3 py-2"
            >
              {check.status === "ok" ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
              ) : (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              )}
              <div className="min-w-0">
                <p className="text-[11px] font-medium">{dt(check.title)}</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {dt(check.message)}
                </p>
              </div>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-[11px]"
            disabled={!report?.supportJson}
            onClick={() => setPreviewOpen(true)}
          >
            <FileSearch className="h-3.5 w-3.5" />
            {dt("预览脱敏报告")}
          </Button>
          <p className="text-[10px] leading-4 text-muted-foreground">
            {dt(
              "仅包含诊断元数据，不含账号、令牌、原始路径和对话内容。复制与导出使用本次快照，不会重新体检。",
            )}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-[11px]"
            onClick={() => void copyDiagnostics()}
            disabled={sharing || !report?.snapshotId || diagnostics.isFetching}
          >
            <ClipboardCheck className="h-3.5 w-3.5" />
            {dt("复制脱敏诊断")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-[11px]"
            onClick={() => void exportDiagnostics()}
            disabled={sharing || !report?.snapshotId || diagnostics.isFetching}
          >
            <Download className="h-3.5 w-3.5" />
            {dt("导出脱敏诊断")}
          </Button>
          {!checkOnly && connection?.connected && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-[11px]"
              disabled={
                credentialLoading ||
                rotateCredential.isPending ||
                repair.isPending
              }
              onClick={() => void openCredentialChoice()}
            >
              {rotateCredential.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
              {dt("配置或修复通用凭据")}
            </Button>
          )}
          {!checkOnly && connection?.connected && report.readyTools > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-[11px]"
              disabled={rollbackTools.isPending}
              onClick={() => void rollbackToolConfigs()}
            >
              {rollbackTools.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Undo2 className="h-3.5 w-3.5" />
              )}
              {dt("恢复接管前配置")}
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={!!credentialChoice}
        onOpenChange={(open) => {
          if (!open && !rotateCredential.isPending) setCredentialChoice(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dt("选择通用凭据分组")}</DialogTitle>
            <DialogDescription>
              {dt(
                "用于声音克隆等通用功能；不改变已配置工具的分组。列表来自当前账号，提交时会再次验证权限。",
              )}
            </DialogDescription>
          </DialogHeader>
          <select
            aria-label={dt("通用凭据分组")}
            className="w-full rounded-md border bg-background p-2"
            value={credentialGroup}
            onChange={(e) => setCredentialGroup(e.target.value)}
            disabled={rotateCredential.isPending}
          >
            <option value="">{dt("请选择分组")}</option>
            {credentialChoice?.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.description || group.id} ({group.id})
              </option>
            ))}
          </select>
          <Button
            disabled={!credentialGroup || rotateCredential.isPending}
            onClick={() => void rotateDeviceCredential()}
          >
            {dt("验证并保存通用凭据")}
          </Button>
        </DialogContent>
      </Dialog>
      {report?.supportJson && (
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-[800px] overflow-hidden" zIndex="top">
            <DialogHeader>
              <DialogTitle>{dt("预览脱敏报告")}</DialogTitle>
              <DialogDescription>
                {dt(
                  "分享前请确认内容；报告不会自动上传，快照有效期为 15 分钟。",
                )}
              </DialogDescription>
            </DialogHeader>
            <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-xs">
              {report.supportJson}
            </pre>
            <Button onClick={() => setPreviewOpen(false)}>{dt("关闭")}</Button>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
