import { useEffect, useRef, useState } from "react";
import { FolderOpen, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { settingsApi } from "@/lib/api";
import { isMac } from "@/lib/platform";
import { useToolInventory } from "@/lib/query/toolInventory";
import { TRAE_EDITIONS, type TraeEdition } from "@/lib/traeSetup";
import { Button } from "@/components/ui/button";
import { clearToolInventoryCache } from "./toolInventoryCache";
import { useDesktopInstallFlow } from "./useDesktopInstallFlow";
import { dt } from "./desktopI18n";

export function TraeInstallationActions({
  edition = "international",
}: {
  edition?: TraeEdition;
}) {
  return isMac() ? (
    <MacTraeInstallationActions key={edition} edition={edition} />
  ) : (
    <p className="text-xs text-muted-foreground">
      {dt("此系统请手动安装并打开 TRAE；自动启动仍待验证。")}
    </p>
  );
}

function MacTraeInstallationActions({ edition }: { edition: TraeEdition }) {
  const target = TRAE_EDITIONS[edition];
  const inventory = useToolInventory();
  const install = useDesktopInstallFlow();
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const tool = inventory.data?.find((item) => item.name === target.tool);
  const stalePath = Boolean(tool?.custom_path && !tool.custom_path_valid);
  const found = Boolean(
    tool?.install_path && tool.version && !tool.installed_but_broken,
  );
  const observing = install.monitoringApps.has(target.tool);
  const busy = pending || observing || inventory.isFetching;

  const refresh = async () => {
    clearToolInventoryCache();
    await inventory.refetch({ throwOnError: true });
  };
  const run = async (action: () => Promise<void>) => {
    if (lock.current || observing) return;
    lock.current = true;
    setPending(true);
    try {
      await action();
    } catch {
      if (alive.current)
        toast.error(dt("TRAE 操作未完成，请确认官方安装与应用路径后重试。"));
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  const download = async () => {
    const result = await install.openAndMonitor(
      target.tool,
      target.tool,
      target.downloadUrl,
    );
    if (!alive.current || result.status === "cancelled") return;
    if (result.status === "timeout") {
      toast.info(dt("暂未检测到 TRAE，请安装后重新检测或选择路径。"));
      return;
    }
    await refresh();
    if (alive.current)
      toast.success(dt("已检测到 TRAE，请打开后登录官方账号并完成模型配置。"));
  };
  return (
    <div
      className="space-y-2 rounded-lg border p-3"
      aria-label={dt("TRAE 安装与启动")}
    >
      <p className="text-xs font-medium">
        {dt("当前版本：{{edition}}", { edition: dt(target.label) })}
      </p>
      <p className="text-xs" role="status">
        {dt(
          inventory.isError
            ? "TRAE 检测失败，请重新检测。"
            : stalePath
              ? "TRAE 自选路径已失效，请重新选择或清除后检测。"
              : found
                ? "已检测到 TRAE，启动时核验官方签名；不代表模型已配置。"
                : "尚未检测到 TRAE，请安装后重新检测。",
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {dt("重新检测 TRAE")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const selected = await settingsApi.pickDesktopAppPath(
                target.tool,
              );
              if (selected) {
                clearToolInventoryCache();
                if (alive.current)
                  await inventory.refetch({ throwOnError: true });
              }
            })
          }
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {dt("选择 TRAE 路径")}
        </Button>
        {tool?.custom_path && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await settingsApi.clearDesktopAppPath(target.tool);
                clearToolInventoryCache();
                if (alive.current)
                  await inventory.refetch({ throwOnError: true });
              })
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
            {dt("清除 TRAE 自选路径")}
          </Button>
        )}
        <Button
          size="sm"
          disabled={busy || !found || stalePath || inventory.isError}
          onClick={() =>
            void run(async () => {
              if (!(await settingsApi.launchTrae(target.tool)))
                throw new Error("launch_failed");
              if (alive.current)
                toast.success(
                  dt("已请求打开 TRAE，请在官方应用中登录并配置模型。"),
                );
            })
          }
        >
          <Play className="h-3.5 w-3.5" />
          {dt("打开 TRAE")}
        </Button>
        {!found && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run(download)}
          >
            {dt("下载并检测 TRAE")}
          </Button>
        )}
        {observing && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => install.stop(target.tool)}
          >
            <Square className="h-3.5 w-3.5" />
            {dt("停止 TRAE 安装检测")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {dt(
          "关闭此向导会停止安装检测；不会关闭 TRAE，也不会写入或修改它的模型配置。",
        )}
      </p>
    </div>
  );
}
