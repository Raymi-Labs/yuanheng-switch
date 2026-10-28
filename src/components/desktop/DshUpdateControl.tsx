import { dt } from "./desktopI18n";

/** The official desktop app manages its updates independently of npm. */
export function DshUpdateControl({ version }: { version?: string | null }) {
  return (
    <div
      className="relative mt-3 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground"
      aria-label={dt("DSH 版本更新")}
    >
      <span>{dt("当前版本 {{version}}", { version: version ?? "—" })}</span>
      <p className="mt-1 leading-5">{dt("请在 DSH 桌面端菜单中检查更新。")}</p>
    </div>
  );
}
