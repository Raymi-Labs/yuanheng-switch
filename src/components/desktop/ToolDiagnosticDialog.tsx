import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useYuanhengConnection } from "@/lib/query/yuanheng";
import { YuanhengHealthCard } from "./YuanhengHealthCard";
import { dt } from "./desktopI18n";

export function ToolDiagnosticDialog() {
  const [open, setOpen] = useState(false);
  const { data: connection } = useYuanhengConnection();
  useEffect(() => {
    setOpen(false);
  }, [connection?.baseUrl, connection?.userId, connection?.connected]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          {dt("诊断与报告")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dt("连接与配置检查")}</DialogTitle>
          <DialogDescription>
            {dt(
              "检查覆盖当前账号的工具连接，不发送模型消息。报告可预览、复制或导出，不会自动上传。",
            )}
          </DialogDescription>
          <p className="text-xs text-muted-foreground">
            {dt(
              "详细体检可能补齐 Codex 历史会话路由；其他配置修复请返回连接检查入口操作。",
            )}
          </p>
        </DialogHeader>
        <YuanhengHealthCard initiallyExpanded checkOnly />
      </DialogContent>
    </Dialog>
  );
}
