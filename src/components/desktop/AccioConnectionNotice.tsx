import type { YuanhengToolStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dt } from "./desktopI18n";
import { AccioReleaseNotice } from "./AccioReleaseNotice";

export function AccioConnectionNotice({
  status,
  dark = false,
}: {
  status?: YuanhengToolStatus;
  dark?: boolean;
}) {
  if (status?.app !== "accio-work") return null;
  if (!status.supported) {
    return (
      <p
        role="status"
        className={cn(
          "mt-3 text-[11px] leading-5",
          dark ? "text-amber-200" : "text-amber-700 dark:text-amber-300",
        )}
      >
        {dt("Accio 入口已开放；当前系统或构建暂不支持元衡配置和启动。")}
      </p>
    );
  }
  return (
    <div
      className={cn(
        "mt-3 space-y-1 text-[11px] leading-5",
        dark ? "text-white/65" : "text-muted-foreground",
      )}
    >
      {status.accioCompatibility && (
        <div className="space-y-1 rounded-lg border border-current/15 p-2">
          <p>
            {dt("已安装 Accio：{{version}}", {
              version:
                status.accioCompatibility.installedVersion ??
                dt("未检测到有效版本"),
            })}
          </p>
          <p>
            {dt("元衡已验证版本：{{versions}}", {
              versions: status.accioCompatibility.supportedVersions.join("、"),
            })}
          </p>
          {status.accioCompatibility.state !== "verified_version" && (
            <p role="alert">
              {dt(
                status.accioCompatibility.state === "unverified_version"
                  ? "当前版本尚未验证，配置和启动暂不可用。请到设置 → 关于检查元衡更新。"
                  : "暂无法确认 Accio 安装，请重新检测或选择官方应用路径。",
              )}
            </p>
          )}
          <AccioReleaseNotice />
        </div>
      )}
      <p>
        {dt(
          "配置保存后，请从元衡点击启动。普通打开 Accio 不会自动走元衡；接通后可在输入框的模型菜单直接切换当前分组模型。",
        )}
      </p>
      <p>
        {dt(
          "客户端选择的是默认模型，Accio 的 Auto 使用该模型；已在 Accio 中明确选择的模型由其菜单控制。",
        )}
      </p>
      <details>
        <summary className="cursor-pointer">
          {dt("任务一直等待或工具失败？")}
        </summary>
        <p>
          {dt(
            "先查看 Accio 是否正在等待文件操作审批；只批准你确认的操作。模型有回复不代表工具已执行成功。",
          )}
        </p>
        <p>
          {dt(
            "工具参数错误请保留错误提示和诊断编号；官方电商云端工具尚未接入，更新或重复发送不会自动解决。",
          )}
        </p>
      </details>
      {status.runtimeWarning && (
        <p
          role="alert"
          className={
            dark ? "text-amber-200" : "text-amber-700 dark:text-amber-300"
          }
        >
          {dt(status.runtimeWarning)}
        </p>
      )}
    </div>
  );
}
