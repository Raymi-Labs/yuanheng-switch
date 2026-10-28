import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { YuanhengConnectionStatus } from "@/lib/api/yuanheng";
import { TraeSetupGuide } from "@/components/desktop/TraeSetupGuide";
import { TRAE_EDITIONS } from "@/lib/traeSetup";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
  open: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copy }));
vi.mock("@/components/desktop/TraeInstallationActions", () => ({
  TraeInstallationActions: () => null,
}));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return {
    ...actual,
    settingsApi: { ...actual.settingsApi, openExternal: mocks.open },
  };
});
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
vi.mock("@/components/desktop/desktopI18n", () => ({
  dt: (key: string, values: Record<string, unknown> = {}) =>
    key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? "")),
}));
vi.mock("@/components/desktop/ToolModelPicker", () => ({
  ToolModelPicker: ({
    onChange,
    disabled,
    models,
  }: {
    onChange: (pair: { model: string; group: string }) => void;
    disabled: boolean;
    models: string[];
  }) => (
    <button
      disabled={disabled}
      onClick={() => onChange({ model: models[0], group: "premium" })}
    >
      选择测试模型
    </button>
  ),
}));

const connection = (): YuanhengConnectionStatus => ({
  connected: true,
  baseUrl: "https://meta-api.vip",
  userId: "synthetic-user",
  account: null,
  models: ["astra"],
  terminalModels: ["astra"],
  groups: [{ id: "premium", description: "", ratio: 1 }],
  modelGroups: { astra: ["premium"] },
  reasoningLevels: {},
  announcement: null,
  lastSyncedAt: 1,
});
const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "配置 TRAE" }));
const choose = () =>
  fireEvent.click(screen.getByRole("button", { name: "选择测试模型" }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.copy.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue(undefined);
});

describe("TRAE assisted setup", () => {
  it("switches edition sources while preserving a protocol both editions support", async () => {
    render(<TraeSetupGuide connection={connection()} />);
    open();
    choose();
    const pick = (label: string, name: string) => {
      fireEvent.click(screen.getByRole("combobox", { name: label }));
      fireEvent.click(screen.getByRole("option", { name }));
    };
    pick("TRAE 版本", "国际版");
    pick("TRAE API 格式", "OpenAI Responses API");
    expect(
      screen.getByText("https://meta-api.vip/v1/responses"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "TRAE 官方说明" }));
    await waitFor(() =>
      expect(mocks.open).toHaveBeenLastCalledWith(
        TRAE_EDITIONS.international.docsUrl,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "TRAE 版本" })).toBeEnabled(),
    );
    pick("TRAE 版本", "国内版");
    expect(
      screen.getByText("https://meta-api.vip/v1/responses"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "TRAE API 格式" }));
    expect(
      screen.queryByRole("option", { name: "OpenAI Responses API" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("option", {
        name: "OpenAI Chat Completions",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "TRAE 官方说明" }));
    await waitFor(() =>
      expect(mocks.open).toHaveBeenLastCalledWith(TRAE_EDITIONS.china.docsUrl),
    );
  });
  it("exposes steps while disconnected without claiming configured or initiating requests", () => {
    render(<TraeSetupGuide />);
    open();
    expect(screen.getByText(/请先连接元衡账号/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "复制 Custom Request URL" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/复制参数不代表已接通/)).toBeInTheDocument();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("copies only public form fields and explains group binding and manual completion", async () => {
    render(<TraeSetupGuide connection={connection()} />);
    open();
    choose();
    expect(screen.getByText(/Full URL（完整地址）开关/)).toBeInTheDocument();
    expect(
      screen.getByText(/实际路由和计费以所填令牌为准/),
    ).toBeInTheDocument();
    expect(screen.getByText(/不读取或提交密钥/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "复制 Custom Request URL" }),
    );
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("已复制"));
    expect(mocks.copy).toHaveBeenLastCalledWith(
      "https://meta-api.vip/v1/chat/completions",
    );
    fireEvent.click(screen.getByRole("button", { name: "复制 Model ID" }));
    await waitFor(() => expect(mocks.copy).toHaveBeenLastCalledWith("astra"));
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("does not impose GPT-6 settings on every selected model", () => {
    render(<TraeSetupGuide connection={connection()} />);
    open();
    choose();
    expect(
      screen.queryByText(/模型系列选择 GPT-6系列/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/按服务商支持的值调整后再测试/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "使用 Responses 配置" }),
    ).not.toBeInTheDocument();
  });

  it("offers the verified Astra route on explicit selection without writing configuration", () => {
    const value = {
      ...connection(),
      models: ["gpt-6-astra"],
      terminalModels: ["gpt-6-astra"],
      modelGroups: { "gpt-6-astra": ["premium"] },
    };
    const view = render(<TraeSetupGuide connection={value} />);
    open();
    expect(
      screen.queryByText(/已在 TRAE 国内版 3.4.9/),
    ).not.toBeInTheDocument();
    choose();
    expect(screen.getByText(/保留原条目以便对照/)).toBeInTheDocument();
    expect(
      screen.getByText("https://meta-api.vip/v1/chat/completions"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "使用 Responses 配置" }),
    );
    expect(
      screen.getByText("https://meta-api.vip/v1/responses"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/连接检查成功不代表实际任务使用了新参数/),
    ).toBeInTheDocument();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.copy).not.toHaveBeenCalled();
    view.rerender(
      <TraeSetupGuide
        connection={{ ...value, modelGroups: { "gpt-6-astra": [] } }}
      />,
    );
    expect(
      screen.queryByText(/已在 TRAE 国内版 3.4.9/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "复制 Model ID" }),
    ).not.toBeInTheDocument();
  });

  it("opens only explicit official pages and the current origin token page on click", async () => {
    const value = { ...connection(), baseUrl: "https://cn.meta-api.vip/v1" };
    render(<TraeSetupGuide connection={value} />);
    open();
    choose();
    for (const [name, url] of [
      ["TRAE 官方下载", TRAE_EDITIONS.china.downloadUrl],
      ["TRAE 官方说明", TRAE_EDITIONS.china.docsUrl],
      ["打开元衡令牌管理", "https://cn.meta-api.vip/console/token"],
    ]) {
      const button = screen.getByRole("button", { name });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
      await waitFor(() => expect(mocks.open).toHaveBeenLastCalledWith(url));
    }
  });

  it("invalidates stale catalog choices immediately", () => {
    const value = connection();
    const view = render(<TraeSetupGuide connection={value} />);
    open();
    choose();
    expect(
      screen.getByRole("button", { name: "复制 Model ID" }),
    ).toBeInTheDocument();
    view.rerender(
      <TraeSetupGuide connection={{ ...value, modelGroups: { astra: [] } }} />,
    );
    expect(
      screen.queryByRole("button", { name: "复制 Model ID" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "该分组与模型组合已不可用",
    );
  });

  it.each([
    { userId: "another-user" },
    { connected: false },
    { baseUrl: "https://cn.meta-api.vip" },
  ])("clears old selections on identity change: %j", (patch) => {
    const value = connection();
    const view = render(<TraeSetupGuide connection={value} />);
    open();
    choose();
    view.rerender(<TraeSetupGuide connection={{ ...value, ...patch }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    open();
    expect(
      screen.queryByRole("button", { name: "复制 Model ID" }),
    ).not.toBeInTheDocument();
  });

  it("handles clipboard and browser failures without echoing native details", async () => {
    mocks.copy.mockRejectedValue(new Error("synthetic secret and user path"));
    mocks.open.mockRejectedValue(new Error("another synthetic secret"));
    render(<TraeSetupGuide connection={connection()} />);
    open();
    choose();
    fireEvent.click(screen.getByRole("button", { name: "复制 Model ID" }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenLastCalledWith(
        "复制失败，请手动选中复制。",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "TRAE 官方下载" }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenLastCalledWith("打开失败，请重试。"),
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("blocks double submission and ignores late feedback after account replacement", async () => {
    let finish!: () => void;
    mocks.copy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const value = connection();
    const view = render(<TraeSetupGuide connection={value} />);
    open();
    choose();
    const button = screen.getByRole("button", { name: "复制 Model ID" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.copy).toHaveBeenCalledTimes(1);
    view.rerender(
      <TraeSetupGuide connection={{ ...value, userId: "new-user" }} />,
    );
    await act(async () => {
      finish();
    });
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
