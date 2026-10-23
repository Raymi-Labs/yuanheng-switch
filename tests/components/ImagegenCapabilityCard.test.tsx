import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImagegenToolStatus } from "@/lib/api/skills";
import type { YuanhengToolId } from "@/lib/api/yuanheng";
import { createTestQueryClient } from "../utils/testQueryClient";

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

const api = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listGroups: vi.fn(),
  configureGroup: vi.fn(),
  install: vi.fn(),
  setEnabled: vi.fn(),
  exportSkill: vi.fn(),
}));
const state = vi.hoisted(() => ({
  connection: {
    connected: true,
    userId: "account-a",
    baseUrl: "https://example.test",
  },
  save: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  prompts: vi.fn(),
}));
vi.mock("@/lib/api/skills", () => ({ imagegenApi: api }));
vi.mock("@/lib/query/yuanheng", () => ({
  useYuanhengConnection: () => ({ data: state.connection }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: state.save }));
vi.mock("sonner", () => ({
  toast: { success: state.success, error: state.error },
}));
vi.mock("@/components/desktop/desktopI18n", () => ({
  dt: (text: string, values: Record<string, string> = {}) =>
    text.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? ""),
}));
vi.mock("@/hooks/useSkills", () => ({
  useInstalledSkills: () => ({ data: [] }),
}));
vi.mock("@/hooks/useMcp", () => ({
  useAllMcpServers: () => ({ data: {} }),
  useUpsertMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/api", () => ({
  promptsApi: { getPrompts: state.prompts },
  settingsApi: { openExternal: vi.fn() },
}));

import { ImagegenCapabilityCard } from "@/components/desktop/ImagegenCapabilityCard";
import { CapabilityCenter } from "@/components/desktop/CapabilityCenter";

const status = (
  tool: YuanhengToolId,
  updates: Partial<ImagegenToolStatus> = {},
): ImagegenToolStatus => ({
  tool,
  target: tool === "chatgpt-desktop" ? "codex" : tool,
  supported: true,
  enabled: true,
  configured: true,
  ready: true,
  imageGroup: null,
  imageModels: ["gpt-image-2.5-sunburst", "gpt-image-2"],
  selectedImageModel: "gpt-image-2.5-sunburst",
  catalogChecked: true,
  scope: tool === "workbuddy" ? "code-and-office-import" : "local-skill",
  ...updates,
});
function mount(tool: YuanhengToolId, center = false) {
  const client = createTestQueryClient();
  const content = (current: YuanhengToolId) =>
    center ? (
      <CapabilityCenter
        activeApp="codex"
        activeTool={current}
        onOpen={vi.fn()}
      />
    ) : (
      <ImagegenCapabilityCard tool={current} onOpenTools={vi.fn()} />
    );
  const view = render(
    <QueryClientProvider client={client}>{content(tool)}</QueryClientProvider>,
  );
  return {
    ...view,
    client,
    select: (current: YuanhengToolId) =>
      view.rerender(
        <QueryClientProvider client={client}>
          {content(current)}
        </QueryClientProvider>,
      ),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  state.connection = {
    connected: true,
    userId: "account-a",
    baseUrl: "https://example.test",
  };
  api.getStatus.mockImplementation(async (tool: YuanhengToolId) =>
    status(tool),
  );
  api.listGroups.mockResolvedValue([
    { id: "image-standard", description: "图片标准", ratio: 1 },
  ]);
  api.install.mockImplementation(async (tool: YuanhengToolId) => status(tool));
  api.setEnabled.mockImplementation(
    async (tool: YuanhengToolId, enabled: boolean) =>
      status(tool, { enabled, ready: enabled }),
  );
  api.exportSkill.mockResolvedValue("/tmp/office.zip");
  state.save.mockResolvedValue("/tmp/office.zip");
  state.prompts.mockResolvedValue({});
});

describe("tool-scoped image capability", () => {
  it("keeps a DSH chat connection without image models unready until an image group is explicitly selected", async () => {
    let current = status("dsh", {
      ready: false,
      imageModels: [],
      selectedImageModel: null,
    });
    api.getStatus.mockImplementation(async () => current);
    api.configureGroup.mockImplementation(async (tool, group) => {
      current = status(tool, { imageGroup: group });
      return current;
    });
    const view = mount("dsh");
    await screen.findByText(/当前连接没有可用的 GPT 图像模型/);
    expect(screen.queryByText("图像能力已就绪")).not.toBeInTheDocument();
    expect(api.configureGroup).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: "DSH 图片分组" }),
    ).toHaveTextContent("使用聊天连接");
    await waitFor(() => expect(api.listGroups).toHaveBeenCalledWith("dsh"));
    fireEvent.click(screen.getByRole("combobox", { name: "DSH 图片分组" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "image-standard · 图片标准" }),
    );
    await waitFor(() =>
      expect(api.configureGroup).toHaveBeenCalledWith("dsh", "image-standard"),
    );
    await screen.findByText("图像能力已就绪");
    expect(
      screen.getByText("当前自动选择：gpt-image-2.5-sunburst"),
    ).toBeInTheDocument();
    expect(screen.getByText(/聊天模型和分组保持不变/)).toBeInTheDocument();
    view.unmount();
    view.client.clear();
  });

  it("resets the independent image group to the chat connection explicitly", async () => {
    let current = status("dsh", { imageGroup: "image-standard" });
    api.getStatus.mockImplementation(async () => current);
    api.configureGroup.mockImplementation(async (tool, group) => {
      current = status(tool, { imageGroup: group });
      return current;
    });
    const view = mount("dsh");
    await screen.findByText("图像能力已就绪");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "DSH 图片分组" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "DSH 图片分组" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "使用聊天连接" }),
    );
    await waitFor(() =>
      expect(api.configureGroup).toHaveBeenCalledWith("dsh", null),
    );
    expect(api.install).not.toHaveBeenCalled();
    view.unmount();
    view.client.clear();
  });

  it("can reset an existing image group even when listing groups fails", async () => {
    api.getStatus.mockResolvedValue(
      status("dsh", { imageGroup: "saved-image-group" }),
    );
    api.listGroups.mockRejectedValue(new Error("Group catalog unavailable"));
    api.configureGroup.mockResolvedValue(status("dsh"));
    const view = mount("dsh");
    await screen.findByText("无法读取图片分组，请重新检查图像能力。");
    fireEvent.click(screen.getByRole("combobox", { name: "DSH 图片分组" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "使用聊天连接" }),
    );
    await waitFor(() =>
      expect(api.configureGroup).toHaveBeenCalledWith("dsh", null),
    );
    view.unmount();
    view.client.clear();
  });

  it.each([
    { catalogChecked: false },
    { imageModels: [], selectedImageModel: null },
    { selectedImageModel: "gpt-image-99-unconfirmed" },
    { error: "图片目录不可用" },
  ])(
    "does not claim readiness without a verified selected image model: %s",
    async (updates) => {
      api.getStatus.mockResolvedValue(status("dsh", updates));
      const view = mount("dsh");
      await screen.findByText("图像技能已启用");
      expect(screen.queryByText("图像能力已就绪")).not.toBeInTheDocument();
      view.unmount();
      view.client.clear();
    },
  );

  it("retains the saved group and does not announce success when image group configuration fails", async () => {
    api.configureGroup.mockRejectedValue(new Error("该分组没有可用图片模型"));
    api.getStatus.mockResolvedValue(
      status("dsh", {
        ready: false,
        imageModels: [],
        selectedImageModel: null,
      }),
    );
    const view = mount("dsh");
    await screen.findByText(/当前连接没有可用的 GPT 图像模型/);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "DSH 图片分组" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "DSH 图片分组" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "image-standard · 图片标准" }),
    );
    await waitFor(() => expect(state.error).toHaveBeenCalled());
    expect(state.success).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: "DSH 图片分组" }),
    ).toHaveTextContent("使用聊天连接");
    expect(screen.queryByText("图像能力已就绪")).not.toBeInTheDocument();
    view.unmount();
    view.client.clear();
  });

  it.each(["dsh", "workbuddy"] as const)(
    "uses selected %s for image actions while ordinary capability APIs retain Codex",
    async (tool) => {
      const view = mount(tool, true);
      await screen.findByText("图像能力已就绪");
      expect(api.getStatus).toHaveBeenCalledWith(tool);
      expect(api.getStatus).not.toHaveBeenCalledWith("codex");
      expect(
        screen.getByText("此处管理 Codex 的通用能力，启用状态同步到该工具。"),
      ).toBeInTheDocument();
      await waitFor(() => expect(state.prompts).toHaveBeenCalledWith("codex"));
      fireEvent.click(screen.getByRole("button", { name: "更新能力" }));
      await waitFor(() => expect(api.install).toHaveBeenCalledWith(tool));
      await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
      fireEvent.click(screen.getByRole("switch"));
      await waitFor(() =>
        expect(api.setEnabled).toHaveBeenCalledWith(tool, false),
      );
      view.unmount();
      view.client.clear();
    },
  );

  it("exports WorkBuddy office ZIP after save and explains the local-only package", async () => {
    const view = mount("workbuddy");
    await screen.findByText("图像能力已就绪");
    expect(screen.getByText(/~\/.codebuddy\/skills/)).toHaveTextContent(
      "导入包仅限本机使用",
    );
    fireEvent.click(screen.getByRole("button", { name: "导出办公模式 ZIP" }));
    await waitFor(() =>
      expect(api.exportSkill).toHaveBeenCalledWith(
        "workbuddy",
        "/tmp/office.zip",
      ),
    );
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      }),
    );
    view.unmount();
    view.client.clear();
  });

  it.each(["claude-desktop", "openclaw"] as const)(
    "does not offer writes for unsupported %s",
    async (tool) => {
      api.getStatus.mockResolvedValue(
        status(tool, {
          target: null,
          supported: false,
          enabled: false,
          ready: false,
          configured: false,
        }),
      );
      const view = mount(tool);
      await screen.findByText(/当前工具暂不支持此图像技能/);
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "安装并启用" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "导出办公模式 ZIP" }),
      ).not.toBeInTheDocument();
      expect(api.install).not.toHaveBeenCalled();
      view.unmount();
      view.client.clear();
    },
  );

  it("does not present cached readiness as current when refreshing status fails", async () => {
    const view = mount("dsh");
    await screen.findByText("图像能力已就绪");
    api.getStatus.mockRejectedValue(new Error("Core unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "检查图像能力" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("图像能力已就绪")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    api.getStatus.mockResolvedValue(status("dsh"));
    fireEvent.click(screen.getByRole("button", { name: "检查图像能力" }));
    await screen.findByText("图像能力已就绪");
    view.unmount();
    view.client.clear();
  });

  it("retains saved enabled state after a failed toggle and reports the error", async () => {
    api.setEnabled.mockRejectedValue(
      new Error("Do not overwrite local changes"),
    );
    const view = mount("dsh");
    await screen.findByText("图像能力已就绪");
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(state.error).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("switch")).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(state.success).not.toHaveBeenCalled();
    view.unmount();
    view.client.clear();
  });

  it("does not export after cancelling save", async () => {
    state.save.mockResolvedValue(null);
    const view = mount("workbuddy");
    await screen.findByText("图像能力已就绪");
    fireEvent.click(screen.getByRole("button", { name: "导出办公模式 ZIP" }));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "导出办公模式 ZIP" }),
      ).toBeEnabled(),
    );
    expect(api.exportSkill).not.toHaveBeenCalled();
    view.unmount();
    view.client.clear();
  });

  it("abandons the open export dialog after switching to a different tool", async () => {
    let finishSave!: (path: string) => void;
    state.save.mockImplementation(
      () =>
        new Promise<string>((done) => {
          finishSave = done;
        }),
    );
    const view = mount("workbuddy");
    await screen.findByText("图像能力已就绪");
    fireEvent.click(screen.getByRole("button", { name: "导出办公模式 ZIP" }));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    view.select("dsh");
    await act(async () => {
      finishSave("/tmp/stale-office.zip");
    });
    expect(api.exportSkill).not.toHaveBeenCalled();
    view.unmount();
    view.client.clear();
  });

  it("shows a backend configuration error without claiming readiness", async () => {
    api.getStatus.mockResolvedValue(
      status("dsh", { ready: false, error: "技能内容已修改，已保留" }),
    );
    const view = mount("dsh");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "技能内容已修改，已保留",
    );
    expect(screen.queryByText("图像能力已就绪")).not.toBeInTheDocument();
    view.unmount();
    view.client.clear();
  });
});
