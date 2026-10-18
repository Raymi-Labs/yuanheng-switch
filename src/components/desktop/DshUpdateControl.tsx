import { ToolInstallProgress } from "./ToolInstallProgress";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { settingsApi } from "@/lib/api";
import { DESKTOP_INVENTORY_KEY } from "@/lib/query/toolInventory";
import { useToolLifecycleState } from "@/lib/toolLifecycleState";
import { isUpdateAvailable } from "@/lib/version";
import { extractErrorMessage } from "@/utils/errorUtils";
import { Button } from "@/components/ui/button";
import { dt } from "./desktopI18n";
import { ToolInstallCancel } from "./ToolInstallCancel";
import { clearToolInventoryCache } from "./toolInventoryCache";

const DSH_RELEASE_KEY = ["desktop", "dsh-release"] as const;

/** Tool management entry for DSH release checks and supervised updates. */
export function DshUpdateControl({
  busy = false,
  onDark = false,
}: {
  busy?: boolean;
  onDark?: boolean;
}) {
  const queryClient = useQueryClient();
  const phase = useToolLifecycleState().get("dsh");
  const release = useQuery({
    queryKey: DSH_RELEASE_KEY,
    queryFn: async () => {
      const rows = await settingsApi.getToolVersions(["dsh"]);
      const result = rows.find((row) => row.name === "dsh");
      if (!result) throw new Error("DSH version unavailable");
      return result;
    },
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const info = release.data;
  const managed = info?.detection_source === "managed" && !info.custom_path;
  const failed =
    release.isError || Boolean(info?.error) || !info?.latest_version;
  const available = isUpdateAvailable(info?.version, info?.latest_version);
  const updating = Boolean(phase);
  const update = async () => {
    try {
      await settingsApi.runToolLifecycleAction(["dsh"], "update");
      toast.success(dt("DSH 更新完成并已验证；重新打开 DSH 后使用新版本。"));
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes("[INSTALL_CANCELLED]")) {
        toast.info(dt("DSH 更新已取消，原安装保持不变。"));
      } else {
        toast.error(message);
      }
    } finally {
      clearToolInventoryCache();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: DSH_RELEASE_KEY }),
        queryClient.invalidateQueries({ queryKey: DESKTOP_INVENTORY_KEY }),
      ]);
    }
  };

  return (
    <div
      className={`relative mt-3 rounded-lg border p-3 text-xs ${onDark ? "border-white/15 bg-white/5 text-white/85" : "border-border bg-muted/30 text-muted-foreground"}`}
      aria-label={dt("DSH 版本更新")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {dt("当前版本 {{version}}", { version: info?.version ?? "—" })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className={
            onDark ? "text-white/85 hover:bg-white/10 hover:text-white" : ""
          }
          disabled={release.isFetching || updating || busy}
          onClick={(event) => {
            event.stopPropagation();
            void release.refetch();
          }}
        >
          <RefreshCw
            className={`h-3 w-3 ${release.isFetching ? "animate-spin" : ""}`}
          />
          {dt("检查更新")}
        </Button>
      </div>
      <p role="status" className="mt-1 break-words leading-5">
        {updating
          ? phase === "cancelling"
            ? dt("正在停止更新…")
            : phase === "verifying"
              ? dt("正在验证 DSH 更新…")
              : dt("正在下载并更新 DSH…")
          : release.isFetching
            ? dt("正在检查 DSH 官方版本…")
            : failed
              ? dt("无法检查 DSH 官方版本，请稍后重试。")
              : dt("官方 latest：{{version}}", {
                  version: info?.latest_version,
                })}
      </p>
      <ToolInstallProgress tool="dsh" onDark={onDark} />
      {info && !managed && (
        <p className="mt-1 leading-5">
          {dt("此 DSH 来自自选路径或外部安装，请通过原渠道更新。")}
        </p>
      )}
      {managed && !failed && !release.isFetching && !available && !updating && (
        <p className="mt-1">{dt("当前版本无需更新")}</p>
      )}
      {managed && (available || updating) && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || updating || failed || release.isFetching}
            onClick={(event) => {
              event.stopPropagation();
              void update();
            }}
          >
            {updating && <Loader2 className="h-3 w-3 animate-spin" />}
            {dt("更新 DSH")}
          </Button>
          <ToolInstallCancel tool="dsh" label={dt("取消更新")} />
        </div>
      )}
    </div>
  );
}
