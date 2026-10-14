import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");

describe("desktop localization coverage", () => {
  it("does not leave the desktop shell controls hardcoded in Chinese", () => {
    const source = readSource("src/App.tsx");

    expect(source).not.toContain('title="快捷操作 (⌘K)"');
    expect(source).not.toContain('{t("desktop.skills.import")}已有配置');
    expect(source).not.toContain('title="Skills"');
    expect(source).toContain('t("desktop.toolbar.quickActions")');
    expect(source).toContain('title={t("desktop.views.skills")}');
  });

  it("routes settings section and density labels through i18n", () => {
    const settings = readSource("src/components/settings/SettingsPage.tsx");
    const density = readSource("src/components/settings/DensitySettings.tsx");

    expect(settings).not.toContain('title="外观与语言"');
    expect(settings).not.toContain('title="桌面体验"');
    expect(settings).toContain('t("settings.appearanceAndLanguage")');
    expect(settings).toContain('t("settings.desktopExperience")');
    expect(density).not.toContain('label: "舒适"');
    expect(density).toContain('t("settings.interfaceDensity")');
  });

  it("localizes the Agents placeholder and hides expected probe errors", () => {
    const agents = readSource("src/components/agents/AgentsPanel.tsx");
    const about = readSource("src/components/settings/AboutSection.tsx");

    expect(agents).not.toContain(">Coming Soon<");
    expect(agents).toContain('t("desktop.agents.comingSoon")');
    expect(about).not.toContain("{tool.error}");
    expect(about).toContain("localizeToolVersionError(tool?.error)");
  });

  it("localizes workspace capability counts", () => {
    const source = readSource("src/components/desktop/WorkspaceDashboard.tsx");

    expect(source).not.toContain("Skills ·");
    expect(source).toContain('dt("{{v0}} 个技能 · {{v1}} 个 MCP"');
  });
});
