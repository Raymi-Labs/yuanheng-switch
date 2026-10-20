import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "@/components/desktop/ModelPicker";
vi.mock("@/components/desktop/desktopI18n", () => ({
  dt: (s: string, vars: Record<string, unknown> = {}) =>
    s.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? "")),
}));
Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});
const models = [
  "claude-test",
  "gpt-test",
  "gpt-test",
  "gemini-test",
  "unknown-model",
];
function open() {
  fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
  return screen.getByRole("dialog");
}
describe("grouped model picker", () => {
  it("pins current once, deduplicates and shows vendor groups with existing metadata", () => {
    render(
      <ModelPicker
        label="模型"
        models={models}
        value="claude-test"
        recommended="claude-test"
        modelMeta={{ "claude-test": { groups: 5, reasoningLevels: 4 } }}
        onChange={vi.fn()}
      />,
    );
    const dialog = open();
    expect(within(dialog).getAllByRole("option")).toHaveLength(4);
    expect(within(dialog).getAllByText("claude-test")).toHaveLength(1);
    expect(within(dialog).getByText("当前使用")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Anthropic · 5 个可用分组 · 4 档推理等级"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("OpenAI · 1")).toBeInTheDocument();
    expect(within(dialog).queryByText(/新版本在前/)).not.toBeInTheDocument();
  });
  it("combines search and vendor filters, clears empty states and selects exact original ID", () => {
    const change = vi.fn();
    render(
      <ModelPicker
        label="模型"
        models={models}
        value="claude-test"
        onChange={change}
      />,
    );
    const dialog = open();
    fireEvent.click(within(dialog).getByRole("button", { name: "OpenAI" }));
    expect(within(dialog).getAllByRole("option")).toHaveLength(1);
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: "claude" } });
    expect(within(dialog).getByRole("status")).toHaveTextContent("没有找到");
    fireEvent.click(within(dialog).getByRole("button", { name: "清除筛选" }));
    fireEvent.change(input, { target: { value: "  GOOGLE  " } });
    expect(within(dialog).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(within(dialog).getByText("gemini-test"));
    expect(change).toHaveBeenCalledWith("gemini-test");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("preserves disabled models and resets filters on reopening", () => {
    const change = vi.fn();
    render(
      <ModelPicker
        label="模型"
        models={models}
        modelMeta={{ "gpt-test": { available: false, groups: 0 } }}
        onChange={change}
      />,
    );
    let dialog = open();
    const option = within(dialog).getByRole("option", { name: /gpt-test/ });
    expect(option).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(option);
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "OpenAI" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    dialog = open();
    expect(within(dialog).getAllByRole("option")).toHaveLength(4);
  });
  it("keeps open on catalog refresh and drops obsolete filters without inventing current models", () => {
    const view = render(
      <ModelPicker
        label="模型"
        models={models}
        value="missing-current"
        onChange={vi.fn()}
      />,
    );
    const dialog = open();
    fireEvent.click(within(dialog).getByRole("button", { name: "OpenAI" }));
    view.rerender(
      <ModelPicker
        label="模型"
        models={["claude-test"]}
        value="missing-current"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getAllByRole("option")).toHaveLength(1);
    expect(within(dialog).queryByText("当前使用")).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "全部" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

it("uses the same cloud vendor catalog for standalone search and filtering", () => {
  const change = vi.fn();
  const props = {
    label: "模型",
    models: ["qwen-plus", "custom-chat"],
    onChange: change,
  };
  const view = render(
    <ModelPicker
      {...props}
      modelVendors={{
        "qwen-plus": { id: "16", name: "阿里百联大模型" },
        "custom-chat": { id: "42", name: "新增厂商" },
      }}
    />,
  );
  const dialog = open();
  fireEvent.click(within(dialog).getByRole("button", { name: "新增厂商" }));
  expect(within(dialog).getAllByRole("option")).toHaveLength(1);
  expect(
    within(dialog).getByRole("option", { name: /custom-chat/ }),
  ).toBeInTheDocument();
  view.rerender(
    <ModelPicker
      {...props}
      modelVendors={{
        "qwen-plus": { id: "16", name: "阿里百联大模型" },
        "custom-chat": { id: "42", name: "已更名厂商" },
      }}
    />,
  );
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(
    within(dialog).getByRole("button", { name: "已更名厂商" }),
  ).toHaveAttribute("aria-pressed", "true");
  fireEvent.change(within(dialog).getByRole("combobox"), {
    target: { value: "已更名" },
  });
  fireEvent.click(within(dialog).getByRole("option", { name: /custom-chat/ }));
  expect(change).toHaveBeenCalledWith("custom-chat");
});
