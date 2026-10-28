import type { YuanhengToolId } from "@/lib/api";
import type { DesktopView } from "./types";
import { useModelSwitchCenter } from "./useModelSwitchCenter";
import { FocusToolCard } from "./FocusToolCard";
import { TodayStatsBand } from "./TodayStatsBand";
import { YuanhengHealthCard } from "./YuanhengHealthCard";
import { dt } from "./desktopI18n";
import { RouteSelectionWarning } from "./RouteSelectionWarning";

interface WorkspaceDashboardProps {
  focusApp?: YuanhengToolId;
  availableTools: YuanhengToolId[];
  onToolChange: (app: YuanhengToolId) => void;
  onNavigate: (view: DesktopView) => void;
  onOpenRoutes?: () => void;
}

export function WorkspaceDashboard({
  focusApp,
  availableTools,
  onToolChange,
  onNavigate,
  onOpenRoutes,
}: WorkspaceDashboardProps) {
  const switcher = useModelSwitchCenter();

  return (
    <div className="mx-auto flex h-full w-full max-w-[1120px] flex-col gap-3.5 overflow-y-auto px-7 pb-8 pt-4">
      {switcher.downloadDialog}
      <h1 className="sr-only">{dt("工作台")}</h1>
      {onOpenRoutes && <RouteSelectionWarning onOpen={onOpenRoutes} />}

      <div className="animate-rise-in">
        <FocusToolCard
          switcher={switcher}
          focusApp={focusApp}
          availableTools={availableTools}
          onToolChange={onToolChange}
          onOpenTools={() => onNavigate("tools")}
        />
      </div>

      <div className="animate-rise-in stagger-1">
        <TodayStatsBand />
      </div>
      <div className="animate-rise-in stagger-2">
        <YuanhengHealthCard
          compact
          onOpenConnection={() => onNavigate("network")}
          onConfigureTools={() => onNavigate("tools")}
        />
      </div>
    </div>
  );
}
