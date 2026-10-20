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
    expect(onRefresh).toHaveBeenCalledTimes(1);
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
