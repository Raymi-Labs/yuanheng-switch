import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FolderArchive,
  History,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Search,
  PackageCheck,
  Settings,
  Store,
  X,
} from "lucide-react";
import { toast } from "sonner";

import type { AppId, YuanhengToolId } from "@/lib/api";
import { settingsApi } from "@/lib/api";
import { useSettingsQuery } from "@/lib/query";
import { checkAllEnvConflicts } from "@/lib/api/env";
import type { EnvConflict } from "@/types/env";
import type { VisibleApps } from "@/types";
import { extractErrorMessage } from "@/utils/errorUtils";
import { isTextEditableTarget } from "@/utils/domUtils";
import {
  DRAG_REGION_ATTR,
  DRAG_REGION_STYLE,
  isLinux,
  isWindows,
} from "@/lib/platform";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useUsageCacheBridge } from "@/hooks/useUsageCacheBridge";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { useUiDensity } from "@/hooks/useUiDensity";
import { useScanUnmanagedSkills } from "@/hooks/useSkills";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { UpdateBadge } from "@/components/UpdateBadge";
import { useUpdate } from "@/contexts/UpdateContext";
import { ClaudeWorkspacePreparation } from "@/components/desktop/ClaudeWorkspacePreparation";
import { ModeToggle } from "@/components/mode-toggle";
import { LanguageSwitcher } from "@/components/desktop/LanguageSwitcher";
import { EnvWarningBanner } from "@/components/env/EnvWarningBanner";
import { DeepLinkImportDialog } from "@/components/DeepLinkImportDialog";
import { SettingsPage } from "@/components/settings/SettingsPage";
import UnifiedMcpPanel from "@/components/mcp/UnifiedMcpPanel";
import PromptPanel from "@/components/prompts/PromptPanel";
import UnifiedSkillsPanel from "@/components/skills/UnifiedSkillsPanel";
import {
  SkillsPage,
  getSkillsPageHeaderActions,
  type SkillsPageSource,
} from "@/components/skills/SkillsPage";
import { AgentsPanel } from "@/components/agents/AgentsPanel";
import WorkspaceFilesPanel from "@/components/workspace/WorkspaceFilesPanel";
import EnvPanel from "@/components/openclaw/EnvPanel";
import ToolsPanel from "@/components/openclaw/ToolsPanel";
import AgentsDefaultsPanel from "@/components/openclaw/AgentsDefaultsPanel";
import HermesMemoryPanel from "@/components/hermes/HermesMemoryPanel";

import { DesktopSidebar } from "@/components/desktop/DesktopSidebar";
import { GlobalCommandPalette } from "@/components/desktop/GlobalCommandPalette";
import { WorkspaceDashboard } from "@/components/desktop/WorkspaceDashboard";
import { ToolsPage } from "@/components/desktop/ToolsPage";
import { CapabilityCenter } from "@/components/desktop/CapabilityCenter";
import { UsageCenter } from "@/components/desktop/UsageCenter";
import { VoiceClonePage } from "@/components/desktop/VoiceClonePage";
import { ConnectionCenter } from "@/components/desktop/ConnectionCenter";
import { OnboardingWizard } from "@/components/desktop/OnboardingWizard";
import { YuanhengAccessScreen } from "@/components/desktop/YuanhengAccessScreen";
import type { DesktopView } from "@/components/desktop/types";
import { useYuanhengConnection } from "@/lib/query/yuanheng";
import { PlatformAnnouncementCenter } from "@/components/desktop/PlatformAnnouncementCenter";

import { DESKTOP_TOOLS, isCoreApp } from "@/config/desktopTools";

const DEFAULT_DRAG_BAR_HEIGHT = isWindows() || isLinux() ? 0 : 28;
const VIEW_KEY = "yuanheng-desktop-last-view";
const APP_KEY = "yuanheng-switch-last-app";
const IS_TAURI_RUNTIME =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type SkillsSection = "installed" | "market";

interface SyncStatusUpdatedPayload {
  source?: string;
  status?: string;
  error?: string;
}

const ALL_APPS: AppId[] = [
  "claude",
  "claude-desktop",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "openclaw",
  "hermes",
];

const TOP_LEVEL_VIEWS: DesktopView[] = [
  "home",
  "tools",
  "capabilities",
  "usage",
  "voiceClone",
  "network",
  "settings",
];

const VIEW_LABEL_KEYS: Record<DesktopView, string> = {
  home: "desktop.views.home",
  tools: "desktop.views.tools",
  capabilities: "desktop.views.capabilities",
  skills: "desktop.views.skills",
  skillsDiscovery: "desktop.views.skillsDiscovery",
  mcp: "desktop.views.mcp",
  prompts: "desktop.views.prompts",
  agents: "desktop.views.agents",
  usage: "desktop.views.usage",
  voiceClone: "desktop.views.voiceClone",
  network: "desktop.views.network",
  settings: "desktop.views.settings",
  workspace: "desktop.views.workspace",
  openclawEnv: "desktop.views.openclawEnv",
  openclawTools: "desktop.views.openclawTools",
  openclawAgents: "desktop.views.openclawAgents",
  hermesMemory: "desktop.views.hermesMemory",
};

const VIEW_PARENTS: Partial<Record<DesktopView, DesktopView>> = {
  skills: "capabilities",
  mcp: "capabilities",
  prompts: "capabilities",
  agents: "capabilities",
  skillsDiscovery: "skills",
};

function getInitialTool(): YuanhengToolId {
  const saved = localStorage.getItem(APP_KEY) as YuanhengToolId | null;
  return saved && DESKTOP_TOOLS.includes(saved) ? saved : "claude";
}

function getInitialView(): DesktopView {
  const saved = localStorage.getItem(VIEW_KEY) as DesktopView | null;
  return saved && TOP_LEVEL_VIEWS.includes(saved) ? saved : "home";
}

interface DetailFrameProps {
  title: string;
  description: string;
  onBack: () => void;
  backLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
}

function DetailFrame({
  title,
  description,
  onBack,
  backLabel,
  actions,
  children,
}: DetailFrameProps) {
  const { t } = useTranslation();
  const resolvedBackLabel = backLabel ?? t("desktop.views.capabilities");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-7 pt-5">
      <div className="flex shrink-0 items-start gap-3 pb-4">
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          aria-label={t("desktop.back", { label: resolvedBackLabel })}
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-xl font-semibold">{title}</h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {description}
          </p>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-card/45">
        {children}
      </div>
    </div>
  );
}

function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [view, setView] = useState<DesktopView>(getInitialView);
  const [activeTool, setActiveTool] = useState<YuanhengToolId>(getInitialTool);
  // Capability APIs accept core app IDs only; desktop configuration has its own selection.
  const [activeApp, setActiveAppState] = useState<AppId>(() => {
    const tool = getInitialTool();
    return isCoreApp(tool) ? tool : "codex";
  });
  const [settingsDefaultTab, setSettingsDefaultTab] = useState("general");
  const [skillsSection, setSkillsSection] =
    useState<SkillsSection>("installed");
  const [skillsDiscoverySource, setSkillsDiscoverySource] =
    useState<SkillsPageSource>("skillssh");
  const [envConflicts, setEnvConflicts] = useState<EnvConflict[]>([]);
  const [showEnvBanner, setShowEnvBanner] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const promptPanelRef = useRef<any>(null);
  const mcpPanelRef = useRef<any>(null);
  const skillsPageRef = useRef<any>(null);
  const unifiedSkillsPanelRef = useRef<any>(null);

  const { data: settingsData } = useSettingsQuery();
  const { data: yuanhengConnection, isLoading: isYuanhengConnectionLoading } =
    useYuanhengConnection();
  useEffect(() => {
    if (!yuanhengConnection?.connected) setHelpOpen(false);
  }, [yuanhengConnection?.connected]);
  const { data: unmanagedSkills } = useScanUnmanagedSkills();
  const hasUnmanagedSkills = (unmanagedSkills?.length ?? 0) > 0;
  const { isRunning: isProxyRunning } = useProxyStatus();

  useUsageCacheBridge();
  useUiDensity();

  const visibleApps: VisibleApps = settingsData?.visibleApps ?? {
    claude: true,
    "claude-desktop": true,
    codex: true,
    gemini: true,
    grokbuild: true,
    opencode: true,
    openclaw: true,
    hermes: true,
  };
  const useAppWindowControls =
    isLinux() && (settingsData?.useAppWindowControls ?? false);
  const { hasUpdate, updateInfo } = useUpdate();
  const showUpdateEntry = hasUpdate && Boolean(updateInfo);
  const dragBarHeight = showUpdateEntry
    ? 36
    : useAppWindowControls
      ? 32
      : DEFAULT_DRAG_BAR_HEIGHT;

  const persistActiveApp = (app: YuanhengToolId) => {
    setActiveTool(app);
    if (isCoreApp(app)) setActiveAppState(app);
    localStorage.setItem(APP_KEY, app);
  };

  const navigate = (next: DesktopView) => {
    if (next === "skillsDiscovery") {
      setSkillsSection("market");
      setView("skills");
      return;
    }
    if (next === "skills") setSkillsSection("installed");
    setView(next);
    if (TOP_LEVEL_VIEWS.includes(next)) localStorage.setItem(VIEW_KEY, next);
  };

  useEffect(() => {
    if (!isCoreApp(activeTool) || visibleApps[activeTool] !== false) return;
    const fallback =
      ALL_APPS.find((app) => visibleApps[app] !== false) ?? "claude";
    persistActiveApp(fallback);
  }, [activeTool, visibleApps]);

  const saveSettingsPatch = async (updates: Record<string, unknown>) => {
    if (!settingsData) return false;
    const next = { ...settingsData, ...updates };
    const webdavSync = next.webdavSync;
    void webdavSync;
    const { webdavSync: _removed, ...payload } = next;
    void _removed;
    await settingsApi.save(payload);
    await queryClient.invalidateQueries({ queryKey: ["settings"] });
    return true;
  };

  const finishOnboarding = () => {
    void saveSettingsPatch({ firstRunNoticeConfirmed: true }).catch((error) => {
      console.error("Failed to save onboarding state", error);
    });
  };

  useTauriEvent<SyncStatusUpdatedPayload | null | undefined>(
    "webdav-sync-status-updated",
    async (payload) => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (payload?.source === "auto" && payload.status === "error") {
        toast.error(
          t("desktop.syncFailed", {
            service: "WebDAV",
            error: payload.error || t("common.unknown"),
          }),
        );
      }
    },
  );

  useTauriEvent<SyncStatusUpdatedPayload | null | undefined>(
    "s3-sync-status-updated",
    async (payload) => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (payload?.source === "auto" && payload.status === "error") {
        toast.error(
          t("desktop.syncFailed", {
            service: "S3",
            error: payload.error || t("common.unknown"),
          }),
        );
      }
    },
  );

  useTauriEvent<null | undefined>("yuanheng-topup-closed", async () => {
    await queryClient.invalidateQueries({
      queryKey: ["yuanheng", "connection"],
    });
  });

  useTauriEvent<null | undefined>("yuanheng-imagegen-updated", async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["skills", "installed"] }),
      queryClient.invalidateQueries({ queryKey: ["imagegen", "tools"] }),
    ]);
  });

  useEffect(() => {
    const checkEnvironment = async () => {
      try {
        const all = await checkAllEnvConflicts();
        const conflicts = Object.values(all).flat();
        setEnvConflicts(conflicts);
        if (
          conflicts.length > 0 &&
          !sessionStorage.getItem("env_banner_dismissed")
        ) {
          setShowEnvBanner(true);
        }
      } catch (error) {
        console.error("Failed to check environment conflicts", error);
      }
    };
    void checkEnvironment();
  }, []);

  useEffect(() => {
    void invoke<boolean>("get_migration_result")
      .then((migrated) => migrated && toast.success("配置迁移成功"))
      .catch((error) =>
        console.error("Failed to read migration result", error),
      );
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (helpOpen) return;
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setCommandPaletteOpen((current) => !current);
        return;
      }
      if (event.key === "," && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        navigate("settings");
        return;
      }
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !isTextEditableTarget(event.target) &&
        !TOP_LEVEL_VIEWS.includes(view)
      ) {
        event.preventDefault();
        navigate("capabilities");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, helpOpen]);

  useEffect(() => {
    if (!IS_TAURI_RUNTIME) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const sync = async () => {
      try {
        const window = getCurrentWindow();
        const update = async () => {
          const maximized = await window.isMaximized();
          if (active) setIsWindowMaximized(maximized);
        };
        await update();
        unlisten = await window.onResized(() => void update());
      } catch (error) {
        console.error("Failed to sync window state", error);
      }
    };
    void sync();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!settingsData || !IS_TAURI_RUNTIME) return;
    try {
      void getCurrentWindow()
        .setDecorations(!useAppWindowControls)
        .catch((error) =>
          console.error("Failed to update window decorations", error),
        );
    } catch (error) {
      console.debug("Window decorations unavailable", error);
    }
  }, [settingsData, useAppWindowControls]);

  const windowAction = async (action: "minimize" | "maximize" | "close") => {
    try {
      const window = getCurrentWindow();
      if (action === "minimize") await window.minimize();
      if (action === "maximize") {
        await window.toggleMaximize();
        setIsWindowMaximized(await window.isMaximized());
      }
      if (action === "close") await window.close();
    } catch (error) {
      toast.error(
        t("desktop.window.actionFailed", { error: extractErrorMessage(error) }),
      );
    }
  };

  const renderContent = () => {
    switch (view) {
      case "home":
        return (
          <WorkspaceDashboard
            focusApp={activeTool}
            onToolChange={persistActiveApp}
            availableTools={DESKTOP_TOOLS.filter(
              (app) => !isCoreApp(app) || visibleApps[app] !== false,
            )}
            onNavigate={navigate}
            onOpenRoutes={() => {
              setSettingsDefaultTab("proxy");
              navigate("settings");
            }}
          />
        );
      case "tools":
        return (
          <ToolsPage activeApp={activeTool} onSetActiveApp={persistActiveApp} />
        );
      case "capabilities":
        return (
          <CapabilityCenter
            activeApp={activeApp}
            activeTool={activeTool}
            onOpen={navigate}
          />
        );
      case "usage":
        return (
          <UsageCenter
            activeApp={activeApp}
            onSetActiveApp={persistActiveApp}
            refreshIntervalMs={settingsData?.usageDashboardRefreshIntervalMs}
            onRefreshIntervalChange={(usageDashboardRefreshIntervalMs) =>
              saveSettingsPatch({ usageDashboardRefreshIntervalMs })
            }
          />
        );
      case "voiceClone":
        return <VoiceClonePage />;
      case "network":
        return <ConnectionCenter />;
      case "settings":
        return (
          <div className="h-full">
            <SettingsPage
              open
              onOpenChange={() => navigate("home")}
              defaultTab={settingsDefaultTab}
              onImportSuccess={() => queryClient.invalidateQueries()}
            />
          </div>
        );
      case "skills":
      case "skillsDiscovery": {
        const activeSkillsSection =
          view === "skillsDiscovery" ? "market" : skillsSection;
        const skillTargetApp =
          activeApp === "openclaw" || activeApp === "claude-desktop"
            ? "claude"
            : activeApp;
        return (
          <DetailFrame
            title={t("desktop.views.skills")}
            description={t(
              activeSkillsSection === "market"
                ? "desktop.skills.discoveryDescription"
                : "desktop.skills.description",
            )}
            onBack={() => navigate("capabilities")}
            actions={
              activeSkillsSection === "installed" ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      unifiedSkillsPanelRef.current?.openRestoreFromBackup()
                    }
                  >
                    <History className="h-3.5 w-3.5" />{" "}
                    {t("desktop.skills.restore")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      unifiedSkillsPanelRef.current?.openInstallFromZip()
                    }
                  >
                    <FolderArchive className="h-3.5 w-3.5" /> ZIP
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="relative"
                    onClick={() => unifiedSkillsPanelRef.current?.openImport()}
                  >
                    <Download className="h-3.5 w-3.5" />{" "}
                    {t("desktop.skills.import")}
                    {hasUnmanagedSkills && (
                      <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    )}
                  </Button>
                </>
              ) : (
                getSkillsPageHeaderActions(skillsDiscoverySource).map(
                  ({ key, labelKey, Icon, execute }) => (
                    <Button
                      key={key}
                      variant="outline"
                      size="sm"
                      onClick={() => execute(skillsPageRef.current)}
                    >
                      <Icon className="h-3.5 w-3.5" /> {t(labelKey)}
                    </Button>
                  ),
                )
              )
            }
          >
            <div
              className="flex h-full min-h-0 w-full flex-col"
              data-testid="skills-hub"
            >
              <div
                className="flex shrink-0 items-center gap-1 border-b bg-background/45 px-4 py-2"
                role="tablist"
                aria-label={t("skills.market.sectionLabel")}
              >
                <Button
                  type="button"
                  role="tab"
                  aria-selected={activeSkillsSection === "installed"}
                  variant={
                    activeSkillsSection === "installed" ? "default" : "ghost"
                  }
                  size="sm"
                  onClick={() => setSkillsSection("installed")}
                  data-testid="skills-tab-installed"
                >
                  <PackageCheck className="h-3.5 w-3.5" />
                  {t("skills.market.installedTab")}
                </Button>
                <Button
                  type="button"
                  role="tab"
                  aria-selected={activeSkillsSection === "market"}
                  variant={
                    activeSkillsSection === "market" ? "default" : "ghost"
                  }
                  size="sm"
                  onClick={() => setSkillsSection("market")}
                  data-testid="skills-tab-market"
                >
                  <Store className="h-3.5 w-3.5" />
                  {t("skills.market.marketTab")}
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                {activeSkillsSection === "installed" ? (
                  <UnifiedSkillsPanel
                    ref={unifiedSkillsPanelRef}
                    onOpenDiscovery={() => setSkillsSection("market")}
                    currentApp={skillTargetApp}
                  />
                ) : (
                  <SkillsPage
                    ref={skillsPageRef}
                    initialApp={skillTargetApp}
                    initialSource="skillssh"
                    onSourceChange={setSkillsDiscoverySource}
                  />
                )}
              </div>
            </div>
          </DetailFrame>
        );
      }
      case "mcp":
        return (
          <DetailFrame
            title={t("desktop.views.mcp")}
            description={t("desktop.mcp.description")}
            onBack={() => navigate("capabilities")}
            actions={
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => mcpPanelRef.current?.openImport()}
                >
                  <Download className="h-3.5 w-3.5" /> {t("desktop.mcp.import")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => mcpPanelRef.current?.openAdd()}
                >
                  <Plus className="h-3.5 w-3.5" /> {t("desktop.mcp.add")}
                </Button>
              </>
            }
          >
            <UnifiedMcpPanel
              ref={mcpPanelRef}
              onOpenChange={() => navigate("capabilities")}
            />
          </DetailFrame>
        );
      case "prompts":
        return (
          <DetailFrame
            title={t("desktop.views.prompts")}
            description={t("desktop.prompts.description")}
            onBack={() => navigate("capabilities")}
            actions={
              <Button
                size="sm"
                onClick={() => promptPanelRef.current?.openAdd()}
              >
                <Plus className="h-3.5 w-3.5" /> {t("desktop.prompts.add")}
              </Button>
            }
          >
            <PromptPanel
              ref={promptPanelRef}
              open
              onOpenChange={() => navigate("capabilities")}
              appId={activeApp === "claude-desktop" ? "claude" : activeApp}
            />
          </DetailFrame>
        );
      case "agents":
        return (
          <DetailFrame
            title={t("desktop.views.agents")}
            description={t("desktop.agents.description")}
            onBack={() => navigate("capabilities")}
          >
            <AgentsPanel onOpenChange={() => navigate("capabilities")} />
          </DetailFrame>
        );
      case "workspace":
        return <WorkspaceFilesPanel />;
      case "openclawEnv":
        return <EnvPanel />;
      case "openclawTools":
        return <ToolsPanel />;
      case "openclawAgents":
        return <AgentsDefaultsPanel />;
      case "hermesMemory":
        return <HermesMemoryPanel />;
      default:
        return null;
    }
  };

  const forceOnboardingPreview =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).has("onboarding");
  const onboardingOpen =
    Boolean(yuanhengConnection?.connected) &&
    (forceOnboardingPreview ||
      Boolean(settingsData && settingsData.firstRunNoticeConfirmed !== true));

  return (
    <div
      className="h-screen overflow-hidden bg-background text-foreground selection:bg-primary/20"
      style={{ paddingTop: dragBarHeight }}
    >
      <ClaudeWorkspacePreparation onContinue={() => setView("tools")} />
      {(dragBarHeight > 0 || useAppWindowControls) && (
        <div
          className={cn(
            "fixed left-0 right-0 top-0 z-[80] flex items-center justify-end gap-3 px-3",
            showUpdateEntry && "border-b bg-background",
            useAppWindowControls && "bg-[#11191b]",
          )}
          data-testid="app-top-bar"
          {...DRAG_REGION_ATTR}
          style={
            {
              ...DRAG_REGION_STYLE,
              height: dragBarHeight,
            } as React.CSSProperties
          }
        >
          {showUpdateEntry && (
            <div
              className="shrink-0"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <UpdateBadge />
            </div>
          )}
          {useAppWindowControls && (
            <div
              className="flex items-center gap-1"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-slate-300"
                aria-label={t("desktop.window.minimize")}
                onClick={() => void windowAction("minimize")}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-slate-300"
                aria-label={
                  isWindowMaximized
                    ? t("desktop.window.restore")
                    : t("desktop.window.maximize")
                }
                onClick={() => void windowAction("maximize")}
              >
                {isWindowMaximized ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-slate-300 hover:bg-red-500/20 hover:text-red-300"
                aria-label={t("desktop.window.close")}
                onClick={() => void windowAction("close")}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {isYuanhengConnectionLoading || !yuanhengConnection?.connected ? (
        <YuanhengAccessScreen loading={isYuanhengConnectionLoading} />
      ) : (
        <div className="flex h-full min-h-0">
          <DesktopSidebar
            view={view}
            onNavigate={navigate}
            connection={yuanhengConnection}
            proxyRunning={isProxyRunning}
            helpOpen={helpOpen}
            onHelpOpenChange={setHelpOpen}
          />
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_92%_5%,hsl(var(--primary)/0.055),transparent_34%)]">
            <header
              className="flex h-[54px] shrink-0 items-center gap-3 border-b bg-background/85 px-5 backdrop-blur-md"
              {...DRAG_REGION_ATTR}
              style={{ ...DRAG_REGION_STYLE } as React.CSSProperties}
            >
              <div
                className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-[12px]"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                {VIEW_PARENTS[view] && (
                  <>
                    <button
                      type="button"
                      onClick={() => navigate(VIEW_PARENTS[view]!)}
                      className="shrink-0 font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {t(VIEW_LABEL_KEYS[VIEW_PARENTS[view]!])}
                    </button>
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                  </>
                )}
                <span className="truncate font-semibold">
                  {t(VIEW_LABEL_KEYS[view])}
                </span>
              </div>
              <div
                className="flex items-center gap-1.5"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <button
                  type="button"
                  onClick={() => setCommandPaletteOpen(true)}
                  className="hidden h-8 items-center gap-2 rounded-lg border bg-background px-2.5 text-[10px] text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground md:flex"
                  title={`${t("desktop.toolbar.quickActions")} (⌘K)`}
                >
                  <Search className="h-3.5 w-3.5" />
                  <span>{t("desktop.toolbar.quickActions")}</span>
                  <kbd className="rounded border bg-muted/70 px-1 py-0.5 font-mono text-[9px]">
                    ⌘K
                  </kbd>
                </button>
                <PlatformAnnouncementCenter />
                <LanguageSwitcher />
                <ModeToggle />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    setSettingsDefaultTab("general");
                    navigate("settings");
                  }}
                  title={t("desktop.toolbar.settings")}
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </div>
            </header>

            {showEnvBanner && envConflicts.length > 0 && (
              <EnvWarningBanner
                conflicts={envConflicts}
                onDismiss={() => {
                  setShowEnvBanner(false);
                  sessionStorage.setItem("env_banner_dismissed", "true");
                }}
                onDeleted={async () => {
                  const all = await checkAllEnvConflicts();
                  const conflicts = Object.values(all).flat();
                  setEnvConflicts(conflicts);
                  if (conflicts.length === 0) setShowEnvBanner(false);
                }}
              />
            )}

            <main className="min-h-0 flex-1 overflow-hidden">
              {renderContent()}
            </main>
          </section>
        </div>
      )}

      <GlobalCommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        activeApp={activeTool}
        visibleApps={visibleApps}
        onNavigate={navigate}
        onSetActiveApp={persistActiveApp}
        onOpenHelp={() => {
          if (!yuanhengConnection?.connected) return;
          setHelpOpen(true);
        }}
      />

      {yuanhengConnection?.connected && (
        <>
          <OnboardingWizard open={onboardingOpen} onFinish={finishOnboarding} />
          <DeepLinkImportDialog />
        </>
      )}
    </div>
  );
}

export default App;
