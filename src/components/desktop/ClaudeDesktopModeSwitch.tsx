import type { useClaudeDesktopMode } from "./useClaudeDesktopMode";
import { dt } from "./desktopI18n";

export function ClaudeDesktopModeSwitch({
  control,
  busy = false,
  dark = false,
}: {
  control: ReturnType<typeof useClaudeDesktopMode>;
  busy?: boolean;
  dark?: boolean;
}) {
  return (
    <div
      className={`relative mt-3 rounded-xl border p-3 text-xs ${dark ? "border-white/10 bg-white/5 text-white/75" : "border-border bg-muted/30"}`}
    >
      <p className="mb-2 font-medium">{dt("使用方式")}</p>
      <div className="flex gap-2">
        {(["yuanheng", "official"] as const).map((mode) => (
          <button
            type="button"
            key={mode}
            aria-pressed={control.data?.mode === mode}
            disabled={busy || control.pending || !control.data}
            className={`rounded-md border px-3 py-1.5 disabled:opacity-50 ${control.data?.mode === mode ? "bg-primary text-primary-foreground" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              void control.switchMode(mode);
            }}
          >
            {dt(mode === "official" ? "Claude 官方" : "元衡中转")}
          </button>
        ))}
      </div>
      <p className="mt-2 leading-relaxed">
        {dt(
          control.error || control.data?.mode === "unknown"
            ? "Claude Desktop 模式检测失败，请重新检测。"
            : control.data?.mode === "official" && !control.setupRequested
              ? "官方模式使用 Claude 原生账号登录；请重启客户端，并使用原账号查看官方会话。中转模型与分组会保留，切换模式不会替你登录账号。"
              : "中转模式使用元衡模型与分组；切回 Claude 官方后需要重启客户端。首次使用中转，请先选择模型并应用配置。",
        )}
      </p>
    </div>
  );
}
