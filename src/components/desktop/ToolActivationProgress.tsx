import { AlertCircle, Check, Circle, Loader2 } from "lucide-react";
import type {
  YuanhengToolActivationStatus,
  YuanhengToolPreflight,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { dt } from "./desktopI18n";

interface ToolActivationProgressProps {
  activation?: YuanhengToolActivationStatus;
  preflight?: YuanhengToolPreflight;
  restartRequired?: boolean;
  dark?: boolean;
  compact?: boolean;
}

type StepState = "done" | "active" | "waiting" | "error" | "unknown";

export function ToolActivationProgress({
  activation,
  preflight,
  restartRequired = false,
  dark = false,
  compact = false,
}: ToolActivationProgressProps) {
  if (!activation && !preflight) return null;

  const configDone = Boolean(activation?.configWritten);
  const routeDone = Boolean(
    configDone && (!activation?.routeRequired || activation.routeReady),
  );
  const accio = activation?.app === "accio-work";
  const requestObservable = Boolean(activation?.routeRequired);
  const requestDone = Boolean(
    activation?.requestReceived && (!accio || routeDone),
  );
  const successDone = Boolean(
    activation?.requestSucceeded && (!accio || routeDone),
  );
  const unconfirmedOutput =
    accio &&
    requestDone &&
    !successDone &&
    activation?.lastStatusCode != null &&
    activation.lastStatusCode >= 200 &&
    activation.lastStatusCode < 300;
  const requestFailed = requestDone && !successDone && !unconfirmedOutput;

  const steps: Array<{ label: string; state: StepState }> = [
    {
      label: dt(accio ? "配置已保存" : "配置已写入"),
      state: configDone ? "done" : "waiting",
    },
    {
      label: accio
        ? dt("Accio 已由元衡启动")
        : activation?.routeRequired
          ? dt("路由已启动")
          : dt("无需本地路由"),
      state: routeDone ? "done" : "waiting",
    },
    {
      label: restartRequired
        ? dt("等待重新打开")
        : requestDone
          ? dt("客户端已就绪")
          : dt("配置待验证"),
      state: !restartRequired && requestDone ? "done" : "waiting",
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
                (dark ? "text-emerald-200" : "text-emerald-700"),
              step.state === "active" &&
                (dark ? "text-amber-200" : "text-amber-700"),
              step.state === "error" &&
                (dark ? "text-red-200" : "text-red-700"),
              (step.state === "waiting" || step.state === "unknown") &&
                (dark ? "text-white/35" : "text-muted-foreground/70"),
            )}
          >
            <span className="shrink-0">{iconFor(step.state)}</span>
            <span className="truncate">{step.label}</span>
          </div>
        ))}
      </div>
      {activation?.message && (
        <p
          className={cn(
            "mt-1.5 text-[9px]",
            dark ? "text-white/45" : "text-muted-foreground",
          )}
        >
          {dt(activation.message)}
        </p>
      )}
    </div>
  );
}
