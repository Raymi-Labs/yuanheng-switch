import type { YuanhengToolStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dt } from "./desktopI18n";

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
