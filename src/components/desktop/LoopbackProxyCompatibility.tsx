import { useState } from "react";
import { yuanhengApi } from "@/lib/api";
import type { LoopbackProxyCompatibility as Status } from "@/lib/api/yuanheng";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { extractErrorMessage } from "@/utils/errorUtils";
import { dt } from "./desktopI18n";

export function LoopbackProxyCompatibility() {
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<Status>) => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus(await action());
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-lg border p-3 text-xs">
      <p className="font-medium">{dt("本机代理兼容")}</p>
      <p className="text-muted-foreground">
        {dt(
          "开启 Shadowrocket 等代理后无法连接时，先查看本机连接对照与进程检查。macOS 兼容修复只为当前用户后续启动且支持绕过变量的应用保护本机连接，保留公网代理和已有绕过条目；支持 Dock/Finder 启动及重新登录，可撤销。",
        )}
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          void run(() => yuanhengApi.getLoopbackProxyCompatibility())
        }
      >
        {dt("检查兼容状态")}
      </Button>
      {status && (
        <>
          <p role="status">
            {status.supported
              ? dt(
                  `登录环境：${status.loginEnvironmentProtected ? "已保护" : "未确认"}；登录修复：${status.installed ? "已安装" : "未安装"}。桌面进程 ${status.desktopProcesses} 个，模型后端 ${status.backendProcesses} 个，绕过已确认 ${status.protectedProcesses} 个，未确认 ${status.unverifiedProcesses} 个。`,
                )
              : dt(
                  "当前平台支持元衡管理的 App Server 启动保护；用户登录环境修复仅适用于 macOS。",
                )}
          </p>
          {status.supported && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      dt(
                        "启用当前用户的登录环境兼容修复？后续启动且支持绕过变量的应用会直连本机地址，已有进程需要重启。保留原有条目并可撤销。",
                      ),
                    )
                  )
                    void run(() =>
                      yuanhengApi.setLoopbackProxyCompatibility(true),
                    );
                }}
              >
                {dt(status.installed ? "重新应用兼容修复" : "启用兼容修复")}
              </Button>
              {status.installed && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        dt(
                          "撤销登录兼容修复并恢复应用前的环境？外部修改发生冲突时将保留配置；已运行应用需要重新启动。",
                        ),
                      )
                    )
                      void run(() =>
                        yuanhengApi.setLoopbackProxyCompatibility(false),
                      );
                  }}
                >
                  {dt("撤销兼容修复")}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      dt(
                        "请先保存 Codex 中的任务。现在退出并重启桌面应用，随后检查实际进程环境？",
                      ),
                    )
                  )
                    void run(async () => {
                      await invoke("launch_tool", {
                        tool: "chatgpt-desktop",
                        restart: true,
                      });
                      return yuanhengApi.getLoopbackProxyCompatibility();
                    });
                }}
              >
                {dt("重启 Codex 并复验")}
              </Button>
            </div>
          )}
          <p className="text-muted-foreground">
            {dt(
              "环境已保护不代表模型调用成功；后端未启动时无法验证。重启后请重新检查，并保持代理开启完成一次真实流式调用。",
            )}
          </p>
        </>
      )}
    </div>
  );
}
