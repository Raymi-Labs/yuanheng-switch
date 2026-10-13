import { ArrowRight, Blocks, ServerCog } from "lucide-react";
import { useInstalledSkills } from "@/hooks/useSkills";
import { useAllMcpServers } from "@/hooks/useMcp";
import { useYuanhengToolStatuses } from "@/lib/query/yuanheng";
import type { YuanhengToolId } from "@/lib/api";
import type { DesktopView } from "./types";
import { useModelSwitchCenter } from "./useModelSwitchCenter";
import { FocusToolCard } from "./FocusToolCard";
import { AccountUsageCard } from "./AccountUsageCard";
import { TodayStatsBand } from "./TodayStatsBand";
import { YuanhengHealthCard } from "./YuanhengHealthCard";
import { dt } from "./desktopI18n";

interface WorkspaceDashboardProps {
  focusApp?: YuanhengToolId;
  availableTools: YuanhengToolId[];
  onToolChange: (app: YuanhengToolId) => void;
  onNavigate: (view: DesktopView) => void;
}

export function WorkspaceDashboard({
  focusApp,
  availableTools,
  onToolChange,
  onNavigate,
}: WorkspaceDashboardProps) {
  const switcher = useModelSwitchCenter();
  const { data: toolStatuses = [] } = useYuanhengToolStatuses();
  const { data: skills = [] } = useInstalledSkills();
  const { data: mcpServers = {} } = useAllMcpServers();
  const configuredTools = toolStatuses.filter((item) => item.configured);

  return (
    <div className="mx-auto flex h-full w-full max-w-[1120px] flex-col gap-3.5 overflow-y-auto px-7 pb-8 pt-4">
      <h1 className="sr-only">{dt("工作台")}</h1>

      <div className="grid animate-rise-in items-start gap-4 lg:grid-cols-[1.58fr_1fr]">
        <FocusToolCard
          switcher={switcher}
          focusApp={focusApp}
          availableTools={availableTools}
          onToolChange={onToolChange}
          onOpenTools={() => onNavigate("tools")}
        />
        <div className="flex min-w-0 flex-col gap-3.5">
          <AccountUsageCard onOpenUsage={() => onNavigate("usage")} />
          <YuanhengHealthCard
            compact
            onOpenConnection={() => onNavigate("network")}
            onConfigureTools={() => onNavigate("tools")}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              {
                title: dt("能力中心"),
                value: dt("{{v0}} 个技能 · {{v1}} 个 MCP", {
                  v0: skills.length,
                  v1: Object.keys(mcpServers).length,
                }),
                icon: Blocks,
                view: "capabilities" as const,
              },
              {
                title: dt("工具管理"),
                value: dt("{{count}} 个已就绪", {
                  count: configuredTools.length,
                }),
                icon: ServerCog,
                view: "tools" as const,
              },
            ].map((item) => (
              <button
                key={item.title}
                type="button"
                onClick={() => onNavigate(item.view)}
                className="group flex items-center gap-2.5 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors hover:border-primary/30"
              >
                <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-primary/[0.08] text-primary">
                  <item.icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] font-semibold">
                    {item.title}
                  </span>
                  <span className="block truncate text-[9.5px] text-muted-foreground">
                    {item.value}
                  </span>
                </span>
                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-primary" />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="animate-rise-in stagger-1">
        <TodayStatsBand />
      </div>
    </div>
  );
}
