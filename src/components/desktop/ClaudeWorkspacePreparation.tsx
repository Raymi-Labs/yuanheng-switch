import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  claudeWorkspaceSetup,
  refreshClaudeWorkspace,
  ensureClaudeWorkspaceReady,
} from "@/lib/claudeWorkspaceSetup";
import { dt } from "./desktopI18n";

export function ClaudeWorkspacePreparation({
  onContinue,
}: {
  onContinue: () => void;
}) {
  const reminderId = useId();
  const [preferenceSaveFailed, setPreferenceSaveFailed] = useState(false);
  const snapshot = useSyncExternalStore(
    claudeWorkspaceSetup.subscribe,
    claudeWorkspaceSetup.getSnapshot,
  );
  useEffect(() => {
    if (claudeWorkspaceSetup.resumePending()) {
      claudeWorkspaceSetup.show();
      void refreshClaudeWorkspace();
    }
  }, []);
  const state = snapshot.state;
  if (
    !snapshot.visible &&
    (snapshot.busy || claudeWorkspaceSetup.resumePending())
  ) {
    return (
      <Button
        className="fixed bottom-5 right-5 z-50"
        onClick={() => claudeWorkspaceSetup.show()}
      >
        {snapshot.busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {dt("继续准备 Claude")}
      </Button>
    );
  }
  return (
    <Dialog
      open={snapshot.visible}
      onOpenChange={(open) => {
        if (!open) claudeWorkspaceSetup.dismiss();
      }}
    >
      <DialogContent className="max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dt("准备 Claude Desktop 运行环境")}</DialogTitle>
          <DialogDescription>
            {dt(
              "安装应用、Windows 基础环境、官方工作区下载和模型连接分别检查；准备过程中不会自动重启或调用收费模型。",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 pb-6 pt-4">
          <div className="flex items-start gap-3" role="status">
            {snapshot.busy ? (
              <Loader2 className="h-5 w-5 shrink-0 animate-spin" />
            ) : (
              <ShieldCheck className="h-5 w-5 shrink-0" />
            )}
            <p className="text-sm leading-6">
              {state?.message ?? dt("正在检查 Windows 运行环境…")}
            </p>
          </div>
          {state?.phase === "restart_required" && (
            <p className="text-sm text-muted-foreground">
              {dt(
                snapshot.suppressStartupReminder
                  ? "请保存工作后重启 Windows。之后可在工具管理中继续安装或配置 Claude，不需要重新填写密钥。"
                  : "请保存工作后重启 Windows。重新打开元衡会恢复检查，之后点击继续即可，不需要重新填写密钥。",
              )}
            </p>
          )}
          {state &&
            state.phase !== "ready" &&
            state.phase !== "not_required" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={reminderId}
                    checked={snapshot.suppressStartupReminder}
                    aria-describedby={`${reminderId}-hint`}
                    onCheckedChange={(checked) => {
                      setPreferenceSaveFailed(
                        !claudeWorkspaceSetup.setSuppressStartupReminder(
                          checked === true,
                        ),
                      );
                    }}
                  />
                  <label
                    htmlFor={reminderId}
                    className="cursor-pointer text-sm"
                  >
                    {dt("不再提醒")}
                  </label>
                </div>
                <p
                  id={`${reminderId}-hint`}
                  className="text-xs leading-5 text-muted-foreground"
                >
                  {dt(
                    "仅在本机生效，下次进入元衡不再自动提醒。需要时仍可在工具管理中安装或配置 Claude。",
                  )}
                </p>
                {preferenceSaveFailed && (
                  <p role="alert" className="text-xs text-destructive">
                    {dt("无法保存提醒偏好，请重试。")}
                  </p>
                )}
              </div>
            )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => claudeWorkspaceSetup.dismiss()}
            >
              {snapshot.busy ? dt("后台继续") : dt("稍后处理")}
            </Button>
            {!snapshot.busy &&
            (state?.phase === "ready" || state?.phase === "not_required") ? (
              <Button
                onClick={() => {
                  claudeWorkspaceSetup.requestContinue();
                  onContinue();
                }}
              >
                {dt("继续安装或配置 Claude")}
              </Button>
            ) : (
              <Button
                disabled={snapshot.busy}
                onClick={() => {
                  if (
                    ["needs_preparation", "cancelled", "failed"].includes(
                      state?.phase ?? "",
                    )
                  ) {
                    void ensureClaudeWorkspaceReady()
                      .then(() => {
                        claudeWorkspaceSetup.requestContinue();
                        onContinue();
                      })
                      .catch(() => {});
                  } else {
                    void refreshClaudeWorkspace();
                  }
                }}
              >
                {snapshot.busy
                  ? dt("正在准备，请稍候")
                  : ["needs_preparation", "cancelled", "failed"].includes(
                        state?.phase ?? "",
                      )
                    ? dt("准备必要组件")
                    : dt("重新检查")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
