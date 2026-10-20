import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolModelPicker } from "@/components/desktop/ToolModelPicker";
import type { YuanhengConnectionStatus } from "@/lib/api";

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});
const catalog = (): YuanhengConnectionStatus => ({
  connected: true,
  baseUrl: "https://example.test",
  userId: "test",
  account: null,
  models: ["deepseek-flash", "grok-4.6", "grok-4.7", "grok-unmapped"],
  groups: [
    { id: "企业专属", description: "", ratio: 0.1 },
    { id: "Grok 标准", description: "", ratio: 0.25 },
    { id: "Grok 优质", description: "", ratio: 1 },
  ],
  modelGroups: {
    "deepseek-flash": ["企业专属"],
    "grok-4.6": ["Grok 标准", "Grok 优质"],
    "grok-4.7": ["Grok 优质", "已撤销"],
  },
  reasoningLevels: {},
  announcement: null,
  lastSyncedAt: 1,
});
function setup(overrides = {}) {
  const connection = catalog();
  const onChange = vi.fn();
  const onRefresh = vi.fn();
  const props = {
    connection,
    models: connection.models,
    model: "deepseek-flash",
    group: "企业专属",
    tool: "DSH",
    onChange,
    onRefresh,
    ...overrides,
  };
  const view = render(<ToolModelPicker {...props} />);
  return { ...view, props, onChange, onRefresh };
}
async function browseGrok() {
  fireEvent.click(screen.getByLabelText("DSH 模型供应商"));
  fireEvent.click(await screen.findByRole("option", { name: "xAI" }));
  fireEvent.click(screen.getByLabelText("DSH 分组与模型"));
}
const branch = async (name: string) =>
  fireEvent.click(
    await screen.findByRole("option", { name: new RegExp(`^${name} `) }),
  );
beforeEach(() => {
  localStorage.clear();
});

describe("ToolModelPicker", () => {
  it("offers exactly two controls and submits a Grok pair only after selecting its model", async () => {
    const { onChange } = setup();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    await browseGrok();
    expect(
      screen.queryByRole("option", { name: /企业专属/ }),
    ).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    await branch("Grok 标准");
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("option", { name: "grok-4.7" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "grok-unmapped" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "grok-4.6" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      model: "grok-4.6",
      group: "Grok 标准",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("retains existing selection when browsing, favoriting or cancelling", async () => {
    const { onChange } = setup();
    await browseGrok();
    fireEvent.click(screen.getByRole("button", { name: "收藏分组 Grok 标准" }));
    await branch("Grok 标准");
    fireEvent.click(screen.getByRole("button", { name: "收藏模型 grok-4.6" }));
    fireEvent.keyDown(screen.getByPlaceholderText("搜索分组或模型…"), {
      key: "Escape",
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem("yuanheng:group-favorites:v1")).toContain(
      "Grok 标准",
    );
    expect(localStorage.getItem("yuanheng:model-favorites:v1")).toContain(
      "grok-4.6",
    );
  });
  it("searches the selected vendor's real group/model relations", async () => {
    setup();
    await browseGrok();
    fireEvent.change(screen.getByPlaceholderText("搜索分组或模型…"), {
      target: { value: "4.7" },
    });
    expect(
      screen.queryByRole("option", { name: /^Grok 标准/ }),
    ).not.toBeInTheDocument();
    await branch("Grok 优质");
    expect(
      screen.getByRole("option", { name: "grok-4.7" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /已撤销/ }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("搜索分组或模型…"), {
      target: { value: "deepseek" },
    });
    expect(screen.getByText("没有找到匹配的分组或模型")).toBeInTheDocument();
  });
  it("does not fall back to another group when refresh removes the browsed branch", async () => {
    const { props, rerender, onChange } = setup();
    await browseGrok();
    await branch("Grok 标准");
    const connection = {
      ...props.connection,
      modelGroups: {
        ...props.connection.modelGroups,
        "grok-4.6": ["Grok 优质"],
      },
    };
    rerender(<ToolModelPicker {...props} connection={connection} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "grok-4.6" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("先选择左侧分组")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("preserves the popup and branch during a background refresh", async () => {
    const { props, rerender, onRefresh, onChange } = setup();
    await browseGrok();
    await branch("Grok 标准");
    rerender(
      <ToolModelPicker
        {...props}
        connection={{ ...props.connection, lastSyncedAt: 2 }}
      />,
    );
    expect(
      screen.getByRole("option", { name: "grok-4.6" }),
    ).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("shows stale saved values without inventing groups or models", () => {
    const { onChange } = setup({
      connection: { ...catalog(), modelGroups: {} },
      model: "retired",
      group: "企业专属",
    });
    expect(screen.getByLabelText("DSH 分组与模型")).toHaveTextContent(
      "企业专属 / retired",
    );
    fireEvent.click(screen.getByLabelText("DSH 分组与模型"));
    expect(
      screen.getByText("该厂商暂无可用分组，请刷新模型目录"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("supports keyboard group expansion, back navigation and model selection", async () => {
    const { onChange } = setup();
    await browseGrok();
    const input = screen.getByPlaceholderText("搜索分组或模型…");
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(
      screen.getByRole("option", { name: "grok-4.6" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(
      screen.queryByRole("option", { name: "grok-4.6" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      model: "grok-4.6",
      group: "Grok 标准",
    });
  });
  it("disables both controls while a selection is being applied", () => {
    setup({ disabled: true });
    for (const control of screen.getAllByRole("combobox"))
      expect(control).toBeDisabled();
  });
});

describe("cloud vendor cascade", () => {
  const connection = (): YuanhengConnectionStatus => ({
    ...catalog(),
    models: ["qwen-plus", "custom-chat"],
    modelVendors: {
      "qwen-plus": { id: "16", name: "阿里百联大模型" },
      "custom-chat": { id: "42", name: "新厂商" },
      "private-chat": { id: "99", name: "不可见厂商" },
    },
    modelGroups: { "qwen-plus": ["企业专属"], "custom-chat": ["Grok 标准"] },
  });
  it("shows a previously unknown cloud vendor and submits only its allowed model/group pair", async () => {
    const data = connection();
    const { onChange, onRefresh } = setup({
      connection: data,
      models: data.models,
    });
    fireEvent.click(screen.getByLabelText("DSH 模型供应商"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("option", { name: "阿里千问" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "不可见厂商" }),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("option", { name: "新厂商" }));
    fireEvent.click(screen.getByLabelText("DSH 分组与模型"));
    expect(
      screen.queryByRole("option", { name: /^企业专属/ }),
    ).not.toBeInTheDocument();
    await branch("Grok 标准");
    fireEvent.click(screen.getByRole("option", { name: "custom-chat" }));
    expect(onChange).toHaveBeenCalledWith({
      model: "custom-chat",
      group: "Grok 标准",
    });
  });
  it("updates names and associations while open, retaining stable vendor identity and removing revoked models", async () => {
    const data = connection();
    const { props, rerender, onChange } = setup({
      connection: data,
      models: data.models,
      model: "qwen-plus",
    });
    fireEvent.click(screen.getByLabelText("DSH 分组与模型"));
    const dialog = screen.getByRole("dialog");
    expect(
      screen.getByRole("option", { name: "qwen-plus" }),
    ).toBeInTheDocument();
    const updated = {
      ...data,
      modelVendors: {
        "qwen-plus": { id: "16", name: "阿里巴巴" },
        "custom-chat": { id: "16", name: "阿里巴巴" },
      },
      modelGroups: { "custom-chat": ["企业专属"] },
    };
    rerender(
      <ToolModelPicker
        {...props}
        connection={updated}
        models={["custom-chat"]}
      />,
    );
    expect(screen.getByLabelText("DSH 模型供应商")).toHaveTextContent(
      "阿里巴巴",
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(
      screen.queryByRole("option", { name: "qwen-plus" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "custom-chat" }),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("preserves the browsed legacy vendor when refresh first provides cloud metadata", async () => {
    const { props, rerender, onChange } = setup();
    await browseGrok();
    await branch("Grok 标准");
    rerender(
      <ToolModelPicker
        {...props}
        connection={{
          ...props.connection,
          modelVendors: {
            "grok-4.6": { id: "9", name: "云端 Grok" },
            "grok-4.7": { id: "9", name: "云端 Grok" },
            "grok-unmapped": { id: "9", name: "云端 Grok" },
          },
        }}
      />,
    );
    expect(screen.getByLabelText("DSH 模型供应商")).toHaveTextContent(
      "云端 Grok",
    );
    expect(
      screen.getByRole("option", { name: "grok-4.6" }),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("resolves old vendor favorites, persists cloud IDs only on a user toggle, and survives rename", () => {
    localStorage.setItem(
      "yuanheng:model-favorites:v1",
      JSON.stringify({
        models: ["qwen-plus"],
        vendors: ["qwen", "absent-vendor"],
      }),
    );
    const before = localStorage.getItem("yuanheng:model-favorites:v1");
    const data = connection();
    const { props, rerender, onChange } = setup({
      connection: data,
      models: data.models,
      model: "qwen-plus",
    });
    expect(
      screen.getByLabelText("取消收藏厂商 阿里百联大模型"),
    ).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("yuanheng:model-favorites:v1")).toBe(before);
    fireEvent.click(screen.getByLabelText("取消收藏厂商 阿里百联大模型"));
    fireEvent.click(screen.getByLabelText("收藏厂商 阿里百联大模型"));
    expect(
      JSON.parse(localStorage.getItem("yuanheng:model-favorites:v1")!),
    ).toEqual({
      models: ["qwen-plus"],
      vendors: ["absent-vendor", "cloud:16"],
    });
    rerender(
      <ToolModelPicker
        {...props}
        connection={{
          ...data,
          modelVendors: {
            ...data.modelVendors,
            "qwen-plus": { id: "16", name: "阿里巴巴" },
          },
        }}
      />,
    );
    expect(screen.getByLabelText("取消收藏厂商 阿里巴巴")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
