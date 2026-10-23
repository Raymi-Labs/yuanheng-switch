import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BLENDER_MCP_UV_INSTALL_COMMANDS } from "@/config/mcpPresets";

const { copyText, mutateAsync } = vi.hoisted(() => ({
  copyText: vi.fn().mockResolvedValue(undefined),
  mutateAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: {} }),
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "mcp.presets.blender-mcp.community": "精选社区 MCP",
        "mcp.presets.blender-mcp.description": "让 AI 操作 Blender",
        "mcp.presets.blender-mcp.safety": "使用前请保存 Blender 工程",
        "mcp.presets.blender-mcp.add": "添加插件",
        "mcp.presets.blender-mcp.guide.title": "第一次使用？照着这 6 步做",
        "mcp.presets.blender-mcp.guide.subtitle": "按顺序完成即可",
        "mcp.presets.blender-mcp.guide.step1Title": "先装好 Blender 和 uv",
        "mcp.presets.blender-mcp.guide.step2Title": "把插件装进 Blender",
        "mcp.presets.blender-mcp.guide.copyCommand": "复制命令",
        "mcp.presets.blender-mcp.guide.uvInstallCommand": "uv 安装命令",
        "mcp.presets.blender-mcp.guide.blenderDownload": "打开 Blender 官网",
        "mcp.presets.blender-mcp.guide.uvDocs": "不会安装？",
      })[key] ?? key,
  }),
}));

vi.mock("@/hooks/useSkills", () => ({
  useInstalledSkills: () => ({ data: [] }),
  useInstallBuiltinImagegen: () => ({
    isPending: false,
    mutateAsync,
  }),
}));

vi.mock("@/hooks/useMcp", () => ({
  useAllMcpServers: () => ({ data: {} }),
  useUpsertMcpServer: () => ({
    isPending: false,
    mutateAsync,
  }),
}));

vi.mock("@/lib/platform", () => ({
  isWindows: () => true,
}));

vi.mock("@/lib/clipboard", () => ({ copyText }));

vi.mock("@/lib/api", () => ({
  promptsApi: { getPrompts: vi.fn() },
  settingsApi: { openExternal: vi.fn() },
}));

vi.mock("@/components/desktop/ImagegenCapabilityCard", () => ({
  ImagegenCapabilityCard: () => null,
}));

import { CapabilityCenter } from "@/components/desktop/CapabilityCenter";

describe("CapabilityCenter Blender MCP beginner guide", () => {
  beforeEach(() => {
    copyText.mockClear();
    mutateAsync.mockClear();
  });

  it("opens the six-step guide by default and lets the user collapse it", () => {
    render(
      <CapabilityCenter
        activeApp="codex"
        activeTool="codex"
        onOpen={vi.fn()}
      />,
    );

    const toggle = screen.getByRole("button", {
      name: /第一次使用？照着这 6 步做/,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("先装好 Blender 和 uv")).toBeInTheDocument();
    expect(screen.getByText("把插件装进 Blender")).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("先装好 Blender 和 uv")).not.toBeInTheDocument();
  });

  it("copies the operating-system-specific uv command", async () => {
    render(
      <CapabilityCenter
        activeApp="codex"
        activeTool="codex"
        onOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "复制命令" })[0]);

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith(
        BLENDER_MCP_UV_INSTALL_COMMANDS.windows,
      );
    });
  });
});
