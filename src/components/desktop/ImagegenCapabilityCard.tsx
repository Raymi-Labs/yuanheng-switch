import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  Download,
  ImageIcon,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import type { YuanhengToolId } from "@/lib/api/yuanheng";
import { toolLabel } from "@/config/desktopTools";
import { useImagegen } from "@/hooks/useImagegen";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { dt } from "./desktopI18n";

export function ImagegenCapabilityCard({
  tool,
  onOpenTools,
}: {
  tool: YuanhengToolId;
  onOpenTools: () => void;
}) {
  const capability = useImagegen(tool);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  const currentContext = useRef(capability.contextKey);
  currentContext.current = capability.contextKey;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const status = capability.query.data;
  const statusKnown = Boolean(status) && !capability.query.isError;
  const supported = statusKnown && Boolean(status?.supported);
  const busy = capability.busy || saving;
  const label = toolLabel(tool);
  const reportError = (error: unknown) =>
    toast.error(dt("图像能力操作失败"), { description: String(error) });

  const install = async () => {
    try {
      await capability.install();
      toast.success(dt("图像能力已安装或更新"));
    } catch (error) {
      reportError(error);
    }
  };
  const toggle = async (enabled: boolean) => {
    try {
      await capability.setEnabled(enabled);
    } catch (error) {
      reportError(error);
    }
  };
  const exportOffice = async () => {
    const context = capability.contextKey;
    setSaving(true);
    try {
      const filePath = await save({
        defaultPath: "yuanheng-imagegen-workbuddy.zip",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!filePath || !alive.current || currentContext.current !== context)
        return;
      const path = await capability.exportSkill(filePath);
      if (alive.current && currentContext.current === context)
        toast.success(dt("办公技能包已导出"), { description: path });
    } catch (error) {
      if (alive.current && currentContext.current === context)
        reportError(error);
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  return (
    <section
      aria-label={dt("{{tool}} 图像生成能力", { tool: label })}
      className="mt-4 overflow-hidden rounded-lg border border-emerald-600/20 bg-card"
    >
      <div className="flex flex-wrap items-start gap-4 px-5 py-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
          <ImageIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-sm font-semibold">
              {dt("YuanHeng 图像生成")}
            </h2>
            <span className="rounded bg-muted px-2 py-0.5 text-[10px]">
              {label}
            </span>
            <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
              {dt("最新可用版本 · 质量优先")}
            </span>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {dt("使用当前工具的元衡连接，按需生成或编辑图片，完成后继续对话。")}
          </p>
          {capability.query.isPending && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {dt("正在检查图像能力…")}
            </p>
          )}
          {capability.query.isError && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {dt("无法检查图像能力，请重试。")}
            </p>
          )}
          {statusKnown && !status?.supported && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {dt("当前工具暂不支持此图像技能。请选择其他工具。")}
            </p>
          )}
          {supported && (
            <>
              <div
                className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
                aria-live="polite"
              >
                <span>
                  {status?.enabled
                    ? dt("图像技能已启用")
                    : dt("图像技能未启用")}
                </span>
                <span className="text-muted-foreground">
                  {status?.configured
                    ? dt("元衡连接已配置")
                    : dt("元衡连接未配置")}
                </span>
                {status?.ready && !status.error && (
                  <span className="flex items-center gap-1 text-emerald-600">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {dt("图像能力已就绪")}
                  </span>
                )}
                {status?.enabled &&
                  status.configured &&
                  !status.ready &&
                  !status.error && (
                    <span className="text-muted-foreground">
                      {dt("等待本地连接就绪")}
                    </span>
                  )}
              </div>
              {status?.error && (
                <p
                  role="alert"
                  className="mt-2 break-words text-xs text-destructive"
                >
                  {status.error}
                </p>
              )}
              {!status?.configured && (
                <Button
                  variant="link"
                  size="sm"
                  className="mt-1 h-auto p-0"
                  onClick={onOpenTools}
                >
                  {dt("前往工具管理配置连接")}
                </Button>
              )}
              {tool === "workbuddy" && (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {dt(
                    "开发模式安装到 ~/.codebuddy/skills；办公模式请导出 ZIP 后在 WorkBuddy 中导入。导入包仅限本机使用。",
                  )}
                </p>
              )}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {supported && (
            <>
              <Switch
                aria-label={dt("在 {{tool}} 中启用图像生成", { tool: label })}
                checked={Boolean(status?.enabled)}
                disabled={busy}
                onCheckedChange={(enabled) => void toggle(enabled)}
              />
              <Button
                size="sm"
                variant={status?.enabled ? "outline" : "default"}
                disabled={busy}
                onClick={() => void install()}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : status?.enabled ? (
                  <RefreshCw className="h-4 w-4" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {status?.enabled ? dt("更新能力") : dt("安装并启用")}
              </Button>
              {tool === "workbuddy" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !status?.enabled}
                  onClick={() => void exportOffice()}
                >
                  <Download className="h-4 w-4" />
                  {dt("导出办公模式 ZIP")}
                </Button>
              )}
            </>
          )}
          {!capability.query.isPending && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || capability.query.isFetching}
              onClick={() => void capability.query.refetch()}
            >
              <RefreshCw
                className={`h-4 w-4${capability.query.isFetching ? " animate-spin" : ""}`}
              />
              {dt("检查图像能力")}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
