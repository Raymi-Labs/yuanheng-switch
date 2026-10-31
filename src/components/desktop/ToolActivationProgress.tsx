import { AlertCircle, Check, Circle, Loader2 } from "lucide-react";
import type {
  YuanhengToolActivationStatus,
  YuanhengToolPreflight,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { dt } from "./desktopI18n";
import { assessToolActivation } from "@/lib/toolActivationAssessment";
import { Button } from "@/components/ui/button";
import { ToolDiagnosticDialog } from "./ToolDiagnosticDialog";

interface ToolActivationProgressProps {
  activation?: YuanhengToolActivationStatus;
  preflight?: YuanhengToolPreflight;
  restartRequired?: boolean;
  dark?: boolean;
  compact?: boolean;
  onRefresh?: () => Promise<unknown>;
  refreshing?: boolean;
  refreshFailed?: boolean;
}

type StepState = "done" | "active" | "waiting" | "error" | "unknown";

export function ToolActivationProgress({
  activation,
  preflight,
  restartRequired = false,
  dark = false,
  compact = false,
  onRefresh,
  refreshing = false,
  refreshFailed = false,
}: ToolActivationProgressProps) {
  if (!activation && !preflight && !onRefresh) return null;

  const configDone = Boolean(activation?.configWritten);
  const routeDone = Boolean(
    configDone && (!activation?.routeRequired || activation.routeReady),
  );
  const accio = activation?.app === "accio-work";
  const requestObservable = Boolean(activation?.routeRequired);
  const requestDone = Boolean(
    requestObservable && activation?.requestReceived && (!accio || routeDone),
  );
  const successDone = Boolean(
    requestDone &&
      activation?.requestSucceeded &&
      routeDone &&
      activation.lastStatusCode != null &&
      activation.lastStatusCode >= 200 &&
      activation.lastStatusCode < 300 &&
      !restartRequired &&
      activation.configuredAt != null,
  );
  const unconfirmedOutput =
    requestDone &&
    !activation?.requestSucceeded &&
    activation?.lastStatusCode != null &&
    activation.lastStatusCode >= 200 &&
    activation.lastStatusCode < 300;
  const requestFailed =
    requestDone && !activation?.requestSucceeded && !unconfirmedOutput;

  const steps: Array<{ label: string; state: StepState }> = [
    {
      label: dt(accio ? "配置已保存" : "配置已写入"),
      state: configDone ? "done" : "waiting",
    },
    {
      label: !activation
        ? dt("等待状态检查")
        : accio
          ? dt("Accio 已由元衡启动")
          : activation?.routeRequired
            ? dt("路由已启动")
            : dt("无需本地路由"),
      state: routeDone ? "done" : "waiting",
    },
    {
      label: restartRequired
        ? dt("等待重新打开")
        : requestDone && routeDone
          ? dt("客户端已就绪")
          : dt("配置待验证"),
      state: !restartRequired && routeDone && requestDone ? "done" : "waiting",
    },
    {
      label: !requestObservable
        ? dt("请求不可观测")
        : requestDone
          ? dt("已收到请求")
          : dt("等待请求记录"),
      state: !requestObservable ? "unknown" : requestDone ? "done" : "waiting",
    },
    {
      label: requestFailed
        ? dt("调用失败（HTTP {{code}}）", {
            code: activation?.lastStatusCode ?? "?",
          })
        : unconfirmedOutput
          ? dt("尚未确认模型输出")
          : successDone
            ? dt("模型调用成功")
            : dt("等待调用验证"),
      state: !requestObservable
        ? "unknown"
        : successDone
          ? "done"
          : requestFailed
            ? "error"
            : "waiting",
    },
  ];

  const iconFor = (state: StepState) => {
    if (state === "done") return <Check className="h-2.5 w-2.5" />;
    if (state === "active")
      return <Loader2 className="h-2.5 w-2.5 animate-spin" />;
    if (state === "error") return <AlertCircle className="h-2.5 w-2.5" />;
    return <Circle className="h-2.5 w-2.5" />;
  };

  const assessment = assessToolActivation(activation, restartRequired);
  return (
    <div
      title={preflight?.checks
        .map((check) => `${check.title}：${check.message}`)
        .join("\n")}
      className={cn(
        "rounded-lg border px-2.5 py-2",
        dark ? "border-white/10 bg-black/10" : "bg-muted/20",
      )}
    >
      {preflight && (
        <div
          className={cn(
            "mb-2 flex items-center justify-between gap-2 text-[9px]",
            dark ? "text-white/55" : "text-muted-foreground",
          )}
        >
          <span>{dt("模型兼容性预检")}</span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-semibold",
              preflight.status === "ok" &&
                (dark
                  ? "bg-emerald-300/10 text-emerald-200"
                  : "bg-emerald-500/10 text-emerald-700"),
              preflight.status === "warning" &&
                (dark
                  ? "bg-amber-300/10 text-amber-200"
                  : "bg-amber-500/10 text-amber-700"),
              preflight.status === "error" &&
                (dark
                  ? "bg-red-300/10 text-red-200"
                  : "bg-red-500/10 text-red-700"),
            )}
          >
            {preflight.status === "ok"
              ? dt("预检通过")
              : preflight.status === "warning"
                ? dt("需要自动准备")
                : dt("预检未通过")}
          </span>
        </div>
      )}
      <div
        className={cn(
          "grid gap-1.5",
          compact ? "grid-cols-5" : "sm:grid-cols-5",
        )}
      >
        {steps.map((step) => (
          <div
            key={step.label}
            className={cn(
              "flex min-w-0 items-center gap-1 text-[8.5px]",
              step.state === "done" &&
                !refreshFailed &&
                (dark ? "text-emerald-200" : "text-emerald-700"),
              step.state === "active" &&
                (dark ? "text-amber-200" : "text-amber-700"),
              step.state === "error" &&
                (dark ? "text-red-200" : "text-red-700"),
              (step.state === "waiting" ||
                step.state === "unknown" ||
                refreshFailed) &&
                (dark ? "text-white/35" : "text-muted-foreground/70"),
            )}
          >
            <span className="shrink-0">{iconFor(step.state)}</span>
            <span className="truncate">{step.label}</span>
          </div>
        ))}
      </div>
      <div
        className={cn(
          "mt-1.5 text-[11px] leading-relaxed",
          dark ? "text-white/45" : "text-muted-foreground",
        )}
      >
        <p role="status" className="font-medium">
          {dt(
            refreshFailed ? "状态刷新失败，以下为上次结果" : assessment.title,
          )}
        </p>
        <p>{dt(assessment.message)}</p>
        {accio && activation?.message && (
          <p className="mt-1">{dt(activation.message)}</p>
        )}
        {activation?.lastRequestAt != null && (
          <p>
            {dt("最近请求记录：{{time}}", {
              time: new Date(activation.lastRequestAt * 1000).toLocaleString(),
            })}
          </p>
        )}
      </div>
      {onRefresh && (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={refreshing}
            onClick={() => {
              void Promise.resolve()
                .then(onRefresh)
                .catch(() => undefined);
            }}
          >
            {dt(refreshing ? "检查中…" : "刷新状态")}
          </Button>
          <ToolDiagnosticDialog />
        </div>
      )}
    </div>
  );
}
