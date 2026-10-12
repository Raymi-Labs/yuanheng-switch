import {
  Activity,
  Blocks,
  Bot,
  Boxes,
  ChevronRight,
  CreditCard,
  Gauge,
  Globe,
  HelpCircle,
  Network,
  LoaderCircle,
  Mic2,
  Settings,
  UserRound,
  WalletCards,
  Wrench,
} from "lucide-react";
import appIcon from "@/assets/icons/app-icon.png";
import { YUANHENG_WEBSITE_URL } from "@/config/yuanhengBrand";
import { useYuanhengTopup } from "@/hooks/useYuanhengTopup";
import { settingsApi } from "@/lib/api";
import type { YuanhengConnectionStatus } from "@/lib/api/yuanheng";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { DesktopView } from "./types";
import { desktopSection } from "./types";
import { dt } from "./desktopI18n";
import { HelpDrawer } from "./HelpDrawer";

interface DesktopSidebarProps {
  view: DesktopView;
  onNavigate: (view: DesktopView) => void;
  connection?: YuanhengConnectionStatus;
  proxyRunning: boolean;
  helpOpen: boolean;
  onHelpOpenChange: (open: boolean) => void;
}

const dailyItems = [
  { id: "home" as const, label: "工作台", icon: Gauge },
  { id: "tools" as const, label: "工具管理", icon: Bot },
  { id: "capabilities" as const, label: "能力中心", icon: Blocks },
  { id: "usage" as const, label: "会话与用量", icon: Activity },
  { id: "voiceClone" as const, label: "声音克隆", icon: Mic2 },
];

const professionalItems = [
  { id: "network" as const, label: "连接与路由", icon: Network },
  { id: "settings" as const, label: "设置", icon: Settings },
];

export function DesktopSidebar({
  view,
  onNavigate,
  connection,
  proxyRunning,
  helpOpen,
  onHelpOpenChange,
}: DesktopSidebarProps) {
  const active = desktopSection(view);
  const accountName =
    connection?.account?.displayName ||
    connection?.account?.username ||
    (connection?.userId
      ? dt("用户 {{id}}", { id: connection.userId })
      : dt("元衡用户"));
  const balance = connection?.account?.remainingUsd ?? 0;
  const { isOpening, openTopup } = useYuanhengTopup();

  const handleOpenWebsite = () => {
    void settingsApi.openExternal(YUANHENG_WEBSITE_URL).catch((error) => {
      console.error("[DesktopSidebar] Failed to open website", error);
      toast.error(dt("打开官网失败，请稍后重试"));
    });
  };

  const renderItem = ({
    id,
    label,
    icon: Icon,
  }: (typeof dailyItems)[number] | (typeof professionalItems)[number]) => {
    const selected = active === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => onNavigate(id)}
        className={cn(
          "group relative flex h-9 [@media(max-height:680px)]:h-8 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13px] font-medium transition-colors",
          selected
            ? "bg-white/[0.095] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.035)]"
            : "text-slate-400 hover:bg-white/[0.07] hover:text-white",
        )}
        aria-current={selected ? "page" : undefined}
      >
        {selected && (
          <span className="absolute bottom-2.5 left-0 top-2.5 w-0.5 rounded-full bg-[#d69554]" />
        )}
        <Icon
          className={cn("h-4 w-4 shrink-0", selected && "text-[#e3aa70]")}
          strokeWidth={1.8}
        />
        <span className="flex-1">{dt(label)}</span>
      </button>
    );
  };

  return (
    <aside className="flex h-full w-[212px] shrink-0 flex-col border-r border-white/[0.06] bg-[#11191b] px-3 pb-3 pt-4 text-white">
      <div className="flex shrink-0 items-center gap-2.5 px-2 pb-5 [@media(max-height:680px)]:pb-3">
        <div className="relative h-9 w-9 shrink-0">
          <img src={appIcon} alt="" className="h-9 w-9 object-contain" />
          <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full border-2 border-[#11191b] bg-[#d69554]" />
        </div>
        <div className="min-w-0">
          <p className="font-display text-[15px] font-semibold tracking-wide">
            {dt("元衡桌面端")}
          </p>
          <p className="mt-0.5 text-[10px] tracking-[0.16em] text-slate-500">
            AI WORKSPACE
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <nav className="space-y-1 [@media(max-height:680px)]:space-y-0.5">
          <p className="px-3 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-600">
            {dt("日常使用")}
          </p>
          {dailyItems.map(renderItem)}
        </nav>

        <nav className="mt-5 space-y-1 [@media(max-height:680px)]:mt-3 [@media(max-height:680px)]:space-y-0.5">
          <p className="px-3 pb-1.5 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-600">
            {dt("专业控制")}
          </p>
          {professionalItems.map(renderItem)}
        </nav>
      </div>

      <div className="shrink-0 space-y-2 pt-3 [@media(max-height:680px)]:pt-2">
        <div className="relative w-full rounded-xl border border-white/[0.09] bg-white/[0.055] text-left transition-colors hover:bg-white/[0.075]">
          <button
            type="button"
            onClick={() => onNavigate("network")}
            className="group w-full p-3 text-left [@media(max-height:680px)]:p-2"
            aria-label={dt("账号与余额")}
          >
            <span className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#d69554]/15 text-[#e3aa70]">
                <UserRound className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-semibold text-slate-200">
                  {accountName}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[9px] text-emerald-400/80">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  {dt("已登录")}
                </span>
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-slate-600 transition-colors group-hover:text-slate-300" />
            </span>
            <span className="mt-3 block border-t border-white/[0.07] pt-2.5 [@media(max-height:680px)]:mt-1 [@media(max-height:680px)]:pt-2">
              <span className="flex items-center gap-1.5 text-[9px] text-slate-500 [@media(max-height:680px)]:hidden">
                <WalletCards className="h-3 w-3" /> {dt("可用余额")}
              </span>
              <strong className="mt-0.5 block pr-16 font-display text-[17px] font-semibold tracking-[-0.02em] text-white">
                ${balance.toFixed(2)}
              </strong>
            </span>
          </button>
          <button
            type="button"
            onClick={() => void openTopup()}
            disabled={isOpening || !connection?.connected}
            className="absolute bottom-3 right-3 inline-flex h-7 items-center gap-1 rounded-md bg-[#d69554] px-2.5 text-[10px] font-semibold text-[#19120b] transition-colors hover:bg-[#e3aa70] disabled:cursor-wait disabled:opacity-50"
            aria-label={dt("充值")}
          >
            {isOpening ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : (
              <CreditCard className="h-3 w-3" />
            )}
            {dt("充值")}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-1">
          <HelpDrawer open={helpOpen} onOpenChange={onHelpOpenChange}>
            <button
              type="button"
              className="flex h-9 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.07] hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d69554]"
            >
              <HelpCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
              <span className="truncate">{dt("帮助")}</span>
            </button>
          </HelpDrawer>
          <button
            type="button"
            onClick={handleOpenWebsite}
            className="flex h-9 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.07] hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d69554]"
            aria-label={dt("访问元衡官网")}
          >
            <Globe className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
            <span className="truncate">{dt("官网")}</span>
          </button>
        </div>

        <div className="flex items-center gap-2 px-2 text-[10px] text-slate-600">
          {proxyRunning ? (
            <Boxes className="h-3.5 w-3.5" />
          ) : (
            <Wrench className="h-3.5 w-3.5" />
          )}
          {proxyRunning ? dt("本地路由运行中") : dt("本地路由未启动")}
        </div>
      </div>
    </aside>
  );
}
