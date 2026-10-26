import {
  ArrowRight,
  ExternalLink,
  Globe,
  Layers3,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "@/lib/toast";
import appIcon from "@/assets/icons/app-icon.png";
import { YUANHENG_WEBSITE_URL } from "@/config/yuanhengBrand";
import { settingsApi } from "@/lib/api";
import { YuanhengConnectionPanel } from "./YuanhengConnectionPanel";
import { AccessUpdateControl } from "./AccessUpdateControl";
import { ErrorFeedbackButton } from "./ErrorFeedbackButton";
import { dt } from "./desktopI18n";

interface YuanhengAccessScreenProps {
  loading?: boolean;
}

export function YuanhengAccessScreen({
  loading = false,
}: YuanhengAccessScreenProps) {
  const handleOpenWebsite = () => {
    void settingsApi.openExternal(YUANHENG_WEBSITE_URL).catch((error) => {
      console.error("[YuanhengAccessScreen] Failed to open website", error);
      toast.error(dt("打开官网失败，请稍后重试"));
    });
  };

  return (
    <main className="relative flex h-full min-h-0 flex-col overflow-y-auto bg-[#10191a] text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_18%,rgba(57,143,125,0.28),transparent_32%),radial-gradient(circle_at_84%_78%,rgba(214,149,84,0.18),transparent_30%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(255,255,255,0.16)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.16)_1px,transparent_1px)] [background-size:42px_42px]" />

      <div className="sticky top-0 z-10 mx-auto flex w-full max-w-[1120px] shrink-0 justify-end bg-[#10191a]/90 px-6 pb-1 pt-3 backdrop-blur-md md:px-8 lg:px-12">
        <div className="flex items-center gap-2">
          <ErrorFeedbackButton />
          <AccessUpdateControl />
        </div>
      </div>

      <div className="relative mx-auto grid w-full max-w-[1120px] flex-1 items-center gap-6 px-6 py-4 md:grid-cols-[0.86fr_1.14fr] md:px-8 lg:gap-9 lg:px-12">
        <section className="animate-rise-in max-w-lg">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/10">
              <img src={appIcon} alt="" className="h-8 w-8 object-contain" />
            </span>
            <div>
              <p className="font-display text-base font-semibold tracking-wide">
                {dt("元衡桌面端")}
              </p>
              <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-200/45">
                Yuanheng AI Workspace
              </p>
            </div>
          </div>

          <p className="mt-7 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#e2ae75]">
            {dt("一个入口，连接全部工具")}
          </p>
          <h1 className="mt-2.5 font-display text-[28px] font-semibold leading-[1.18] md:text-[30px] lg:text-[34px]">
            {dt("登录后，模型与额度")}
            <br />
            {dt("自动同步到本机")}
          </h1>
          <p className="mt-3 max-w-md text-[12px] leading-5 text-slate-300/70">
            {dt(
              "使用元衡账号统一管理 Claude、Codex、ChatGPT 等 AI\n            工具，无需逐个填写接口与密钥。",
            )}
          </p>

          <div className="mt-6 grid max-w-md gap-2 sm:grid-cols-3 md:grid-cols-1 lg:grid-cols-3">
            {[
              { icon: Layers3, label: dt("模型自动同步") },
              { icon: Sparkles, label: dt("配置立即生效") },
              { icon: ShieldCheck, label: dt("本机安全凭据") },
            ].map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-2 text-[10px] text-slate-300"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-[#e2ae75]" />
                {label}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={handleOpenWebsite}
            className="group mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.045] px-3 py-1.5 text-[10px] font-medium text-slate-300 transition-colors hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
            aria-label={dt("访问元衡官网")}
          >
            <Globe className="h-3.5 w-3.5 text-[#e2ae75]" />
            {dt("访问元衡官网")}
            <ExternalLink className="h-3 w-3 text-slate-600 transition-colors group-hover:text-slate-300" />
          </button>
        </section>

        <section className="animate-rise-in stagger-1 w-full md:justify-self-end">
          {loading ? (
            <div
              className="flex min-h-[340px] items-center justify-center rounded-2xl border border-white/10 bg-white/[0.055] backdrop-blur-xl"
              aria-live="polite"
            >
              <div className="text-center">
                <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#e2ae75]" />
                <p className="mt-3 text-[12px] text-slate-400">
                  {dt("正在检查登录状态…")}
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-[#f7f4ed] p-1 text-[#142d2a] shadow-[0_30px_90px_-35px_rgba(0,0,0,0.75)] dark:bg-[#152221] dark:text-white">
              <YuanhengConnectionPanel compact />
              <p className="flex items-center justify-center gap-1.5 px-4 pb-1 pt-0.5 text-[9px] text-muted-foreground">
                {dt("登录后自动进入工作台")}
                <ArrowRight className="h-3 w-3" />
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
