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
      <p>
        {dt(
          "实验功能：目前支持本地模型与文件任务，官方电商云端工具执行尚未支持；仅限已验证的 Apple Silicon Mac 和 Accio 版本。",
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
