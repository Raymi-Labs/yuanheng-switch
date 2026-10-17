import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  cancelToolInstall,
  canCancelToolInstall,
  useToolLifecycleState,
} from "@/lib/toolLifecycleState";
import { dt } from "./desktopI18n";

/** Same operation and cancel state across dashboard, tools and settings. */
export function ToolInstallCancel({
  tool,
  label,
}: {
  tool: string;
  label?: string;
}) {
  const phases = useToolLifecycleState();
  const phase = phases.get(tool);
  if (phase === "external-install") {
    return (
      <span role="status" className="text-xs text-muted-foreground">
        {dt("WSL 安装暂不支持安全取消，请在对应发行版检查进程")}
      </span>
    );
  }
  if (!canCancelToolInstall(tool) && phase !== "cancelling") return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={phase === "cancelling"}
      title={dt("取消不回滚已写文件；停止后请先重新检测")}
      onClick={(event) => {
        event.stopPropagation();
        void cancelToolInstall(tool)
          .then((accepted) => {
            if (!accepted)
              toast.info(dt("安装已结束或尚未就绪，请稍后重新检测"));
          })
          .catch(() => {
            toast.error(dt("取消请求失败，安装可能仍在运行，请重试取消"));
          });
      }}
    >
      {phase === "cancelling" ? dt("正在停止安装…") : (label ?? dt("取消安装"))}
    </Button>
  );
}
