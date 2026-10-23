import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Bot,
  Boxes,
  BookOpenText,
  CheckCircle2,
  ChevronDown,
  Compass,
  Copy,
  ExternalLink,
  ImageIcon,
  Loader2,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import type { AppId } from "@/lib/api";
import { promptsApi, settingsApi } from "@/lib/api";
import {
  useInstallBuiltinImagegen,
  useInstalledSkills,
} from "@/hooks/useSkills";
import { useAllMcpServers, useUpsertMcpServer } from "@/hooks/useMcp";
import {
  BLENDER_DOWNLOAD_URL,
  BLENDER_MCP_ADDON_INSTALL_COMMAND,
  BLENDER_MCP_UV_INSTALL_COMMANDS,
  BLENDER_MCP_VERSION,
  UV_INSTALLATION_DOCS_URL,
  getMcpPresetWithDescription,
  mcpPresets,
} from "@/config/mcpPresets";
import { APP_ICON_MAP } from "@/config/appConfig";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { isWindows } from "@/lib/platform";
import { PageHeader } from "./PageHeader";
import type { DesktopView } from "./types";
import { dt } from "./desktopI18n";

interface CapabilityCenterProps {
  activeApp: AppId;
  onOpen: (view: DesktopView) => void;
}

export function CapabilityCenter({ activeApp, onOpen }: CapabilityCenterProps) {
  const { t } = useTranslation();
  const [blenderGuideOpen, setBlenderGuideOpen] = useState(true);
  const { data: skills = [] } = useInstalledSkills(true);
  const installImagegen = useInstallBuiltinImagegen();
  const { data: mcpServers = {} } = useAllMcpServers();
  const upsertMcp = useUpsertMcpServer();
  const { data: prompts = {} } = useQuery({
    queryKey: ["prompts", activeApp],
    queryFn: () => promptsApi.getPrompts(activeApp),
  });
  const imagegenSkill = skills.find(
    (skill) => skill.directory.toLowerCase() === "meta-api-imagegen",
  );
  const imagegenEnabled = Boolean(imagegenSkill?.apps.codex);
  const blenderPreset = mcpPresets.find(
    (preset) => preset.id === "blender-mcp",
  );
  const blenderServer = Object.entries(mcpServers).find(
    ([id, server]) =>
      id === "blender-mcp" ||
      server.docs?.includes("ahujasid/blender-mcp") ||
      server.server.args?.some((arg) => arg === "blender-mcp"),
  )?.[1];
  const blenderEnabledApps = blenderServer
    ? Object.values(blenderServer.apps).filter(Boolean).length
    : 0;
  const blenderUvInstallCommand = isWindows()
    ? BLENDER_MCP_UV_INSTALL_COMMANDS.windows
    : BLENDER_MCP_UV_INSTALL_COMMANDS.macos;

  const handleInstallImagegen = async () => {
    try {
      await installImagegen.mutateAsync("codex");
      toast.success(
        imagegenEnabled
          ? dt("图像生成能力已更新")
          : dt("图像生成能力已启用到 Codex"),
      );
    } catch (error) {
      toast.error(dt("图像生成能力安装失败"), {
        description: String(error),
      });
    }
  };

  const handleAddBlenderMcp = async () => {
    if (blenderServer) {
      onOpen("mcp");
      return;
    }
    if (!blenderPreset) return;
    try {
      await upsertMcp.mutateAsync(
        getMcpPresetWithDescription(blenderPreset, t),
      );
      toast.success(t("mcp.presets.blender-mcp.added"));
      onOpen("mcp");
    } catch (error) {
      toast.error(t("mcp.presets.blender-mcp.addFailed"), {
        description: String(error),
      });
    }
  };
  const handleOpenBlenderDocs = async () => {
    try {
      await settingsApi.openExternal("https://github.com/ahujasid/blender-mcp");
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };
  const handleOpenUvDocs = async () => {
    try {
      await settingsApi.openExternal(UV_INSTALLATION_DOCS_URL);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };
  const handleOpenBlenderDownload = async () => {
    try {
      await settingsApi.openExternal(BLENDER_DOWNLOAD_URL);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };
  const handleCopyBlenderGuideText = async (text: string, label: string) => {
    try {
      await copyText(text);
      toast.success(t("mcp.presets.blender-mcp.guide.copied", { label }));
    } catch (error) {
      toast.error(t("mcp.presets.blender-mcp.guide.copyFailed"), {
        description: String(error),
      });
    }
  };
  const cards = [
    {
      title: t("desktop.views.skills"),
      description: dt("给 AI 工具安装可复用的专业能力"),
      value: skills.length,
      icon: Wrench,
      color: "bg-[#d69554]/10 text-[#bd7736]",
      view: "skills" as const,
    },
    {
      title: t("desktop.views.mcp"),
      description: dt("连接文件、数据库和外部服务"),
      value: Object.keys(mcpServers).length,
      icon: Boxes,
      color: "bg-emerald-500/10 text-emerald-600",
      view: "mcp" as const,
    },
    {
      title: t("desktop.views.prompts"),
      description: dt("按工具维护系统提示词和指令"),
      value: Object.keys(prompts).length,
      icon: BookOpenText,
      color: "bg-sky-500/10 text-sky-600",
      view: "prompts" as const,
    },
    {
      title: t("desktop.views.agents"),
      description: dt("自治代理编排能力仍在建设中"),
      value: 0,
      icon: Bot,
      color: "bg-slate-500/10 text-slate-500",
      view: "agents" as const,
    },
  ];

  return (
    <div className="mx-auto flex h-full w-full max-w-[1120px] flex-col overflow-hidden px-7 pt-6">
      <PageHeader
        eyebrow={dt("能力中心")}
        title={dt("能力中心")}
        description={dt(
          "统一管理 {{v0}} 的 Skills、MCP、提示词与 Agent 能力。",
          { v0: APP_ICON_MAP[activeApp].label },
        )}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpen("skillsDiscovery")}
          >
            <Compass className="h-4 w-4" /> {t("skills.market.marketTab")}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
        <section className="relative overflow-hidden rounded-2xl border bg-card p-5 shadow-sm">
          <div className="absolute right-0 top-0 h-full w-1/3 bg-gradient-to-l from-primary/[0.06] to-transparent" />
          <div className="relative flex flex-wrap items-center gap-5">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Sparkles className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-base font-semibold">
                {dt("全局能力配置")}
              </h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {dt("当前管理")}
                {APP_ICON_MAP[activeApp].label}
                {dt("，启用状态直接同步到对应工具。")}
              </p>
            </div>
            <span className="rounded-full bg-primary/10 px-3 py-1 text-[10px] font-semibold text-primary">
              {APP_ICON_MAP[activeApp].label}
            </span>
          </div>
        </section>

        <section className="mt-4 overflow-hidden rounded-lg border border-emerald-600/20 bg-card">
          <div className="flex flex-wrap items-center gap-4 px-5 py-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
              <ImageIcon className="h-5 w-5" />
            </span>
            <div className="min-w-[220px] flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-sm font-semibold">
                  {dt("YuanHeng 图像生成")}
                </h2>
                <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold text-emerald-700 dark:text-emerald-300">
                  {dt("自动选模 · 质量优先")}
                </span>
                <span className="rounded bg-muted px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
                  Images API
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                {dt(
                  "配置元衡 Codex 后自动启用，按需在对话中生成或编辑图片。使用当前连接可用的最新 GPT Image 模型，生成后继续对话。",
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {imagegenEnabled && (
                <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {dt("已启用")}
                </span>
              )}
              <Button
                size="sm"
                variant={imagegenEnabled ? "outline" : "default"}
                disabled={installImagegen.isPending}
                onClick={() => void handleInstallImagegen()}
              >
                {installImagegen.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : imagegenEnabled ? (
                  <RefreshCw className="h-4 w-4" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {imagegenEnabled ? dt("更新能力") : dt("启用到 Codex")}
              </Button>
            </div>
          </div>
        </section>

        <section className="mt-4 overflow-hidden rounded-lg border border-orange-500/20 bg-card">
          <div className="flex flex-wrap items-center gap-4 px-5 py-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600">
              <Boxes className="h-5 w-5" />
            </span>
            <div className="min-w-[240px] flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-sm font-semibold">
                  Blender MCP
                </h2>
                <span className="rounded bg-orange-500/10 px-2 py-0.5 text-[9px] font-semibold text-orange-700 dark:text-orange-300">
                  {t("mcp.presets.blender-mcp.community")}
                </span>
                <span className="rounded bg-muted px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
                  MIT · PyPI · v{BLENDER_MCP_VERSION}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                {t("mcp.presets.blender-mcp.description")}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-[9.5px] text-amber-700 dark:text-amber-300">
                <ShieldCheck className="h-3 w-3 shrink-0" />
                {t("mcp.presets.blender-mcp.safety")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleOpenBlenderDocs()}
              >
                <BookOpenText className="h-4 w-4" />
                {t("mcp.presets.docs")}
              </Button>
              <Button
                size="sm"
                disabled={upsertMcp.isPending}
                onClick={() => void handleAddBlenderMcp()}
              >
                {upsertMcp.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : blenderServer ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {blenderServer
                  ? blenderEnabledApps > 0
                    ? t("mcp.presets.blender-mcp.enabledCount", {
                        count: blenderEnabledApps,
                      })
                    : t("mcp.presets.blender-mcp.configure")
                  : t("mcp.presets.blender-mcp.add")}
              </Button>
            </div>
          </div>
          <div className="border-t border-orange-500/15 bg-orange-500/[0.025]">
            <button
              type="button"
              className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-orange-500/[0.04]"
              aria-expanded={blenderGuideOpen}
              aria-controls="blender-mcp-beginner-guide"
              onClick={() => setBlenderGuideOpen((open) => !open)}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-500/10 text-xs font-semibold text-orange-700 dark:text-orange-300">
                6
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold">
                  {t("mcp.presets.blender-mcp.guide.title")}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {t("mcp.presets.blender-mcp.guide.subtitle")}
                </span>
              </span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                  blenderGuideOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            {blenderGuideOpen && (
              <div
                id="blender-mcp-beginner-guide"
                className="border-t border-orange-500/10 px-5 py-1"
              >
                <ol>
                  <li className="grid gap-3 py-4 sm:grid-cols-[28px_minmax(0,1fr)]">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/10 text-[11px] font-semibold text-orange-700 dark:text-orange-300">
                      1
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">
                        {t("mcp.presets.blender-mcp.guide.step1Title")}
                      </p>
                      <p className="mt-1 text-[10.5px] leading-5 text-muted-foreground">
                        {t("mcp.presets.blender-mcp.guide.step1Description")}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void handleOpenBlenderDownload()}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {t("mcp.presets.blender-mcp.guide.blenderDownload")}
                        </Button>
                        <code className="max-w-full overflow-x-auto rounded bg-muted px-2.5 py-1.5 text-[10px]">
                          {blenderUvInstallCommand}
                        </code>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void handleCopyBlenderGuideText(
                              blenderUvInstallCommand,
                              t(
                                "mcp.presets.blender-mcp.guide.uvInstallCommand",
                              ),
                            )
                          }
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {t("mcp.presets.blender-mcp.guide.copyCommand")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => void handleOpenUvDocs()}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {t("mcp.presets.blender-mcp.guide.uvDocs")}
                        </Button>
                      </div>
                    </div>
                  </li>

                  <li className="grid gap-3 border-t py-4 sm:grid-cols-[28px_minmax(0,1fr)]">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/10 text-[11px] font-semibold text-orange-700 dark:text-orange-300">
                      2
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">
                        {t("mcp.presets.blender-mcp.guide.step2Title")}
                      </p>
                      <p className="mt-1 text-[10.5px] leading-5 text-muted-foreground">
                        {t("mcp.presets.blender-mcp.guide.step2Description")}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <code className="max-w-full overflow-x-auto rounded bg-muted px-2.5 py-1.5 text-[10px]">
                          {BLENDER_MCP_ADDON_INSTALL_COMMAND}
                        </code>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void handleCopyBlenderGuideText(
                              BLENDER_MCP_ADDON_INSTALL_COMMAND,
                              t(
                                "mcp.presets.blender-mcp.guide.addonInstallCommand",
                              ),
                            )
                          }
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {t("mcp.presets.blender-mcp.guide.copyCommand")}
                        </Button>
                      </div>
                    </div>
                  </li>

                  <li className="grid gap-3 border-t py-4 sm:grid-cols-[28px_minmax(0,1fr)]">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/10 text-[11px] font-semibold text-orange-700 dark:text-orange-300">
                      3
                    </span>
                    <div>
                      <p className="text-xs font-semibold">
                        {t("mcp.presets.blender-mcp.guide.step3Title")}
                      </p>
                      <p className="mt-1 text-[10.5px] leading-5 text-muted-foreground">
                        {t("mcp.presets.blender-mcp.guide.step3Description")}
                      </p>
                    </div>
                  </li>

                  <li className="grid gap-3 border-t py-4 sm:grid-cols-[28px_minmax(0,1fr)]">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/10 text-[11px] font-semibold text-orange-700 dark:text-orange-300">
                      4
                    </span>
                    <div>
                      <p className="text-xs font-semibold">
                        {t("mcp.presets.blender-mcp.guide.step4Title")}
                      </p>
                      <p className="mt-1 text-[10.5px] leading-5 text-muted-foreground">
                        {t("mcp.presets.blender-mcp.guide.step4Description")}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        className="mt-2"
                        disabled={upsertMcp.isPending}
                        onClick={() => void handleAddBlenderMcp()}
                      >
                        {upsertMcp.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ArrowRight className="h-3.5 w-3.5" />
                        )}
                        {blenderServer
                          ? t(
                              "mcp.presets.blender-mcp.guide.openAgentSelection",
                            )
                          : t(
                              "mcp.presets.blender-mcp.guide.addAndSelectAgent",
                            )}
                      </Button>
                    </div>
                  </li>

                  <li className="grid gap-3 border-t py-4 sm:grid-cols-[28px_minmax(0,1fr)]">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/10 text-[11px] font-semibold text-orange-700 dark:text-orange-300">
                      5
                    </span>
                    <div>
                      <p className="text-xs font-semibold">
                        {t("mcp.presets.blender-mcp.guide.step5Title")}
                      </p>
                      <p className="mt-1 text-[10.5px] leading-5 text-muted-foreground">
                        {t("mcp.presets.blender-mcp.guide.step5Description")}
                      </p>
                      <p className="mt-1 text-[10px] leading-5 text-amber-700 dark:text-amber-300">
                        {t("mcp.presets.blender-mcp.guide.firstRunHint")}
                      </p>
                    </div>
                  </li>

                  <li className="grid gap-3 border-t py-4 sm:grid-cols-[28px_minmax(0,1fr)]">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/10 text-[11px] font-semibold text-orange-700 dark:text-orange-300">
                      6
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">
                        {t("mcp.presets.blender-mcp.guide.step6Title")}
                      </p>
                      <p className="mt-1 text-[10.5px] leading-5 text-muted-foreground">
                        {t("mcp.presets.blender-mcp.guide.step6Description")}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <code className="max-w-full overflow-x-auto rounded bg-muted px-2.5 py-1.5 text-[10px]">
                          {t("mcp.presets.blender-mcp.guide.testPrompt")}
                        </code>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void handleCopyBlenderGuideText(
                              t("mcp.presets.blender-mcp.guide.testPrompt"),
                              t(
                                "mcp.presets.blender-mcp.guide.testPromptLabel",
                              ),
                            )
                          }
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {t("mcp.presets.blender-mcp.guide.copyTestPrompt")}
                        </Button>
                      </div>
                    </div>
                  </li>
                </ol>

                <div className="mb-4 border-l-2 border-amber-500/50 pl-3 text-[10px] leading-5 text-amber-800 dark:text-amber-200">
                  <p>{t("mcp.presets.blender-mcp.guide.safetyHint")}</p>
                  <p>{t("mcp.presets.blender-mcp.guide.doNotRunHint")}</p>
                </div>
              </div>
            )}
          </div>
        </section>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {cards.map((card, index) => (
            <button
              key={card.title}
              type="button"
              onClick={() => onOpen(card.view)}
              className="animate-rise-in group rounded-2xl border bg-card p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <div className="flex items-start gap-3">
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-xl ${card.color}`}
                >
                  <card.icon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-display text-base font-semibold">
                      {card.title}
                    </h2>
                    <ArrowRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                    {card.description}
                  </p>
                </div>
              </div>
              <div className="mt-5 rounded-lg bg-muted/55 px-3 py-2">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  {dt("已配置")}
                </p>
                <p className="mt-0.5 font-display text-lg font-semibold">
                  {card.value}
                </p>
              </div>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => onOpen("skillsDiscovery")}
          className="mt-4 flex w-full items-center gap-3 rounded-xl border border-dashed bg-background/30 px-4 py-3 text-left transition-colors hover:border-primary/35"
        >
          <PackageCheck className="h-4 w-4 text-primary" />
          <span className="flex-1 text-[11px] text-muted-foreground">
            {t("skills.market.entryDescription")}
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}
