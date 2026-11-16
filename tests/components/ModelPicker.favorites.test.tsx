import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "@/components/desktop/ModelPicker";
import { MODEL_FAVORITES_KEY } from "@/components/desktop/useModelFavorites";

vi.mock("@/components/desktop/desktopI18n", () => ({
  dt: (s: string, vars: Record<string, unknown> = {}) =>
    s.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? "")),
}));
Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});
const models = ["gpt-test", "gpt-other", "claude-test", "gemini-test"];
function open(label = "模型") {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  return screen.getByRole("dialog");
}
function close(dialog: HTMLElement) {
  fireEvent.keyDown(dialog, { key: "Escape" });
}
function favoriteGroup(dialog: HTMLElement) {
  return within(dialog)
    .getByText("常用收藏")
    .closest("[cmdk-group]") as HTMLElement;
}

describe("local model favorites", () => {
  beforeEach(() => localStorage.clear());

  it("pins favorites once after current, persists on remount, and never applies configuration", () => {
    const change = vi.fn();
    const refresh = vi.fn();
    const props = {
      label: "模型",
      models,
      value: "claude-test",
      onChange: change,
      onRefresh: refresh,
    };
    const view = render(<ModelPicker {...props} />);
    let dialog = open();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "收藏模型 gemini-test" }),
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(change).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((item) => item.getAttribute("data-value")),
    ).toEqual(["claude-test", "gemini-test", "gpt-test", "gpt-other"]);
    expect(within(favoriteGroup(dialog)).getAllByRole("option")).toHaveLength(
      1,
    );
    view.unmount();
    render(<ModelPicker {...props} />);
    dialog = open();
    expect(
      within(dialog).getByRole("button", { name: "取消收藏模型 gemini-test" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "取消收藏模型 gemini-test" }),
    );
    expect(within(dialog).queryByText("常用收藏")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(MODEL_FAVORITES_KEY)!)).toEqual({
      models: [],
      vendors: [],
    });
  });

  it("combines vendor favorites with search and vendor filters without duplicates", () => {
    render(
      <ModelPicker
        label="模型"
        models={models}
        value="gpt-test"
        onChange={vi.fn()}
      />,
    );
    const dialog = open();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "收藏厂商 OpenAI" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "收藏模型 gpt-other" }),
    );
    expect(within(favoriteGroup(dialog)).getAllByRole("option")).toHaveLength(
      1,
    );
    expect(within(dialog).getAllByRole("option")).toHaveLength(4);
    fireEvent.click(within(dialog).getByRole("button", { name: "Google" }));
    expect(within(dialog).queryByText("常用收藏")).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("option")).toHaveLength(1);
    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "gpt" },
    });
    expect(within(dialog).getByRole("status")).toHaveTextContent("没有找到");
    fireEvent.click(within(dialog).getByRole("button", { name: "清除筛选" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "取消收藏厂商 OpenAI" }),
    );
    expect(within(favoriteGroup(dialog)).getAllByRole("option")).toHaveLength(
      1,
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "取消收藏模型 gpt-other" }),
    );
    expect(within(dialog).queryByText("常用收藏")).not.toBeInTheDocument();
  });

  it("shares preferences between mounted pickers and handles storage changes/clear", () => {
    render(
      <>
        <ModelPicker label="一" models={models} onChange={vi.fn()} />
        <ModelPicker label="二" models={models} onChange={vi.fn()} />
      </>,
    );
    let dialog = open("一");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "收藏模型 gemini-test" }),
    );
    close(dialog);
    dialog = open("二");
    expect(
      within(dialog).getByRole("button", { name: "取消收藏模型 gemini-test" }),
    ).toBeInTheDocument();
    act(() => {
      localStorage.setItem(
        MODEL_FAVORITES_KEY,
        JSON.stringify({ models: ["claude-test"], vendors: [] }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: MODEL_FAVORITES_KEY }),
      );
    });
    expect(
      within(favoriteGroup(dialog)).getByText("claude-test"),
    ).toBeInTheDocument();
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(within(dialog).queryByText("常用收藏")).not.toBeInTheDocument();
  });

  it("never resurrects catalog entries or enables unavailable models, including refreshed account catalogs", () => {
    localStorage.setItem(
      MODEL_FAVORITES_KEY,
      JSON.stringify({ models: ["gpt-test", "missing"], vendors: ["google"] }),
    );
    const change = vi.fn();
    const props = {
      label: "模型",
      models,
      value: "missing",
      onChange: change,
      modelMeta: { "gpt-test": { available: false } },
    };
    const view = render(<ModelPicker {...props} />);
    const dialog = open();
    const disabled = within(dialog).getByRole("option", { name: /gpt-test/ });
    expect(disabled).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(disabled);
    expect(change).not.toHaveBeenCalled();
    expect(within(dialog).queryByText("missing")).not.toBeInTheDocument();
    view.rerender(<ModelPicker {...props} models={["claude-test"]} />);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getAllByRole("option")).toHaveLength(1);
    expect(within(dialog).queryByText("常用收藏")).not.toBeInTheDocument();
    view.rerender(<ModelPicker {...props} disabled />);
    expect(
      within(dialog).getByRole("button", { name: "收藏模型 claude-test" }),
    ).toBeDisabled();
    fireEvent.click(within(dialog).getByText("claude-test"));
    expect(change).not.toHaveBeenCalled();
  });

  it.each([
    "not-json",
    "null",
    '{"models":[1,null,"gemini-test","gemini-test"],"vendors":{}}',
  ])("recovers malformed storage: %s", (stored) => {
    localStorage.setItem(MODEL_FAVORITES_KEY, stored);
    render(<ModelPicker label="模型" models={models} onChange={vi.fn()} />);
    const dialog = open();
    expect(within(dialog).getAllByRole("option")).toHaveLength(4);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "收藏模型 claude-test" }),
    );
    const saved = JSON.parse(localStorage.getItem(MODEL_FAVORITES_KEY)!);
    expect(saved.models).toContain("claude-test");
    expect(saved.models.every((id: unknown) => typeof id === "string")).toBe(
      true,
    );
  });

  it("reports denied storage without breaking selection or pretending favorites were saved", () => {
    const read = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    try {
      const change = vi.fn();
      render(<ModelPicker label="模型" models={models} onChange={change} />);
      const dialog = open();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "收藏模型 gemini-test" }),
      );
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "无法保存收藏",
      );
      expect(within(dialog).queryByText("常用收藏")).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByText("gemini-test"));
      expect(change).toHaveBeenCalledWith("gemini-test");
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it("supports Enter/Space on stars without selecting a model; search keyboard selection still works", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(<ModelPicker label="模型" models={models} onChange={change} />);
    const dialog = open();
    within(dialog)
      .getByRole("button", { name: "收藏模型 gemini-test" })
      .focus();
    await user.keyboard("{Enter}");
    expect(
      within(dialog).getByRole("button", { name: "取消收藏模型 gemini-test" }),
    ).toHaveFocus();
    await user.keyboard(" ");
    expect(
      within(dialog).getByRole("button", { name: "收藏模型 gemini-test" }),
    ).toHaveFocus();
    expect(change).not.toHaveBeenCalled();
    const star = within(dialog).getByRole("button", {
      name: "收藏厂商 Google",
    });
    star.focus();
    await user.keyboard("{Enter}");
    expect(change).not.toHaveBeenCalled();
    expect(
      within(dialog).getByRole("button", { name: "取消收藏厂商 Google" }),
    ).toHaveFocus();
    await user.keyboard(" ");
    expect(
      within(dialog).getByRole("button", { name: "收藏厂商 Google" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(change).not.toHaveBeenCalled();
    const input = within(dialog).getByRole("combobox");
    await user.click(input);
    await user.type(input, "gemini");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(change).toHaveBeenCalledWith("gemini-test");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

it("migrates merged Google favorites on toggle without reviving old cloud ids", () => {
  localStorage.setItem(
    MODEL_FAVORITES_KEY,
    JSON.stringify({ models: [], vendors: ["cloud:19", "google"] }),
  );
  const change = vi.fn();
  render(
    <ModelPicker
      label="模型"
      models={["gemini-local", "custom-google"]}
      modelVendors={{ "custom-google": { id: "19", name: "Google" } }}
      onChange={change}
    />,
  );
  const dialog = open();
  expect(
    within(dialog).getAllByRole("button", { name: "Google" }),
  ).toHaveLength(1);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "取消收藏厂商 Google" }),
  );
  expect(
    JSON.parse(localStorage.getItem(MODEL_FAVORITES_KEY)!).vendors,
  ).toEqual([]);
  expect(
    within(dialog).getByRole("button", { name: "收藏厂商 Google" }),
  ).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(within(dialog).getByRole("button", { name: "Google" }));
  expect(within(dialog).getAllByRole("option")).toHaveLength(2);
  expect(change).not.toHaveBeenCalled();
});
