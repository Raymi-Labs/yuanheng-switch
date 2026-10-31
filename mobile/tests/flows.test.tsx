import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "../src/App";
import { Images } from "../src/Images";
import { Models } from "../src/Models";
import { Redeem } from "../src/Redeem";
import { Tokens } from "../src/Tokens";
import { api } from "../src/api";

vi.mock("../src/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/api")>();
  return {
    ...original,
    api: {
      restore: vi.fn(),
      capabilities: vi.fn(),
      aiConsent: vi.fn(),
      login: vi.fn(),
      twoFactor: vi.fn(),
      logout: vi.fn(),
      get: vi.fn(),
      raw: vi.fn(),
      open: vi.fn(),
      cancel: vi.fn(),
      pricing: vi.fn(),
      tokenUpdate: vi.fn(),
      tokenDelete: vi.fn(),
      logs: vi.fn(),
      logStat: vi.fn(),
      healthGroups: vi.fn(),
      redemptions: vi.fn(),
      redemptionSummary: vi.fn(),
      createRedemption: vi.fn(),
      image: vi.fn(),
      saveImage: vi.fn(),
      galleryList: vi.fn(),
      gallerySave: vi.fn(),
      galleryDelete: vi.fn(),
    },
  };
});
const account = {
  id: 7,
  username: "测试用户",
  quota: 5000000,
  used_quota: 500000,
  group: "default",
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api.capabilities).mockResolvedValue({
    purchases: true,
    version: "0.1.0-alpha.1",
  });
  vi.mocked(api.aiConsent).mockResolvedValue();
  vi.mocked(api.galleryList).mockResolvedValue([]);
  vi.mocked(api.healthGroups).mockResolvedValue({ enabled: true, groups: [] });
  vi.mocked(api.get).mockImplementation(async (op) => {
    if (op === "status") return { quota_per_unit: 500000, price: 0.2 };
    if (op === "account") return account;
    if (op === "groups") return { default: { desc: "默认分组" } };
    if (op === "models") return ["test-model"];
    if (op === "tokens") return { items: [], total: 0 };
    return undefined;
  });
});
afterEach(cleanup);
it("removes purchase and console navigation from the iOS account and login screens", async () => {
  vi.mocked(api.capabilities).mockResolvedValue({
    purchases: false,
    version: "1.0.0",
  });
  vi.mocked(api.restore).mockResolvedValue(account);
  vi.mocked(api.logout).mockResolvedValue();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "我的" }));
  expect(
    screen.queryByRole("button", {
      name: /官网充值|使用兑换码|充值与支付记录|账号与安全设置|消费记录/,
    }),
  ).toBeNull();
  expect(screen.getAllByText("10.00").length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole("button", { name: "切换余额单位" })[0]);
  await waitFor(() =>
    expect(screen.getAllByText("2.00").length).toBeGreaterThan(0),
  );
  expect(screen.getByText("元衡移动端 · 1.0.0")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  await screen.findByRole("button", { name: "登录元衡" });
  expect(screen.queryByRole("button", { name: /前往官网注册/ })).toBeNull();
  expect(api.open).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "划转到账户余额" })).toBeNull();
});

it("requires explicit AI consent and removes AI entry points after withdrawal", async () => {
  vi.mocked(api.restore).mockResolvedValue(account);
  render(<App />);
  expect(
    await screen.findByRole("button", { name: "同意数据处理并继续" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("输入消息")).toBeNull();
  expect(api.aiConsent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "同意数据处理并继续" }));
  await screen.findByLabelText("输入消息");
  expect(api.aiConsent).toHaveBeenCalledWith(true, account.id);
  fireEvent.click(screen.getByRole("button", { name: "我的" }));
  fireEvent.click(screen.getByRole("button", { name: "撤回 AI 数据处理同意" }));
  await waitFor(() =>
    expect(api.aiConsent).toHaveBeenLastCalledWith(false, account.id),
  );
  await waitFor(() => expect(screen.queryByLabelText("输入消息")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "生图" }));
  expect(screen.queryByRole("button", { name: "生成图片" })).toBeNull();
});

it("opens the existing website for recharge without crediting the balance locally", async () => {
  vi.mocked(api.restore).mockResolvedValue(account);
  vi.mocked(api.open).mockResolvedValue();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "我的" }));
  fireEvent.click(screen.getByRole("button", { name: "官网充值" }));
  await waitFor(() => expect(api.open).toHaveBeenCalledWith("topup"));
  expect(screen.getAllByText("10.00").length).toBeGreaterThan(0);
  expect(screen.queryByText("充值成功")).toBeNull();
});
it("does not expose the app before two-factor authentication completes", async () => {
  vi.mocked(api.restore).mockResolvedValue(null);
  vi.mocked(api.login).mockResolvedValue({ requiresTwoFactor: true });
  vi.mocked(api.twoFactor).mockResolvedValue({ account });
  render(<App />);
  fireEvent.change(await screen.findByLabelText("账号"), {
    target: { value: "test" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录元衡" }));
  fireEvent.change(await screen.findByLabelText("两步验证码"), {
    target: { value: "123456" },
  });
  expect(screen.queryByRole("navigation")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "验证并登录" }));
  await screen.findByRole("navigation");
  expect(api.twoFactor).toHaveBeenCalledWith("123456");
});
it("does not announce a failed redemption as success", async () => {
  vi.mocked(api.raw).mockResolvedValue({
    success: false,
    message: "此兑换码已有人使用",
    data: {},
  });
  const refresh = vi.fn();
  render(<Redeem perUnit={500000} close={vi.fn()} refresh={refresh} />);
  fireEvent.change(screen.getByLabelText("兑换码"), {
    target: { value: "test-code" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认兑换" }));
  await screen.findByText("此兑换码已有人使用");
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.queryByText("兑换成功")).toBeNull();
});
it("distinguishes subscription issuance from credited wallet balance", async () => {
  vi.mocked(api.raw).mockResolvedValue({
    success: true,
    data: {
      benefit_type: "subscription",
      issuance_id: 2,
      plan_title: "测试套餐",
    },
  });
  render(<Redeem perUnit={500000} close={vi.fn()} refresh={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("兑换码"), {
    target: { value: "code" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认兑换" }));
  await screen.findByText("兑换码已核销");
  expect(screen.getByRole("button", { name: "前往官网领取权益" })).toBeTruthy();
  expect(screen.queryByText(/已增加额度/)).toBeNull();
});
it("converts token limits using server units and only offers authorized groups", async () => {
  render(<Tokens active perUnit={1000000} />);
  fireEvent.click(screen.getByRole("button", { name: "创建令牌" }));
  const brandPicker = screen.getByRole("button", { name: "选择模型品牌" });
  await waitFor(() =>
    expect((brandPicker as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(brandPicker);
  fireEvent.click(await screen.findByRole("button", { name: /^default/ }));
  fireEvent.click(screen.getByRole("button", { name: "选择分组" }));
  fireEvent.click(await screen.findByRole("button", { name: "默认分组" }));
  fireEvent.change(screen.getByLabelText("名称"), {
    target: { value: "手机工具" },
  });
  fireEvent.change(screen.getByLabelText("额度上限（美元）"), {
    target: { value: "2.5" },
  });
  const buttons = screen.getAllByRole("button", { name: "创建令牌" });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      "token_create",
      expect.objectContaining({
        name: "手机工具",
        group: "default",
        remain_quota: 2500000,
        unlimited_quota: false,
      }),
    ),
  );
});

it("discards a token secret returned after leaving the token tab", async () => {
  let resolveKey!: (value: unknown) => void;
  const token = {
    id: 1,
    name: "late key",
    status: 1,
    remain_quota: 1,
    expired_time: -1,
  };
  vi.mocked(api.get).mockImplementation(async (op) => {
    if (op === "tokens") return { items: [token], total: 1 };
    if (op === "token_key")
      return new Promise((resolve) => {
        resolveKey = resolve;
      });
    return {};
  });
  const view = render(<Tokens active perUnit={500000} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看令牌" }));
  view.rerender(<Tokens active={false} perUnit={500000} />);
  await act(async () => {
    resolveKey({ key: "test-late-secret" });
  });
  await act(async () => {
    view.rerender(<Tokens active perUnit={500000} />);
  });
  expect(screen.queryByText("sk-test-late-secret")).toBeNull();
});
it("keeps the login screen when an old balance request finishes after logout", async () => {
  let resolveAccount!: (value: unknown) => void;
  const original = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation((op, body) =>
    op === "account"
      ? new Promise((resolve) => {
          resolveAccount = resolve;
        })
      : original(op, body),
  );
  vi.mocked(api.restore).mockResolvedValue(account);
  vi.mocked(api.logout).mockResolvedValue();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "刷新余额" }));
  fireEvent.click(screen.getByRole("button", { name: "我的" }));
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  await screen.findByRole("button", { name: "登录元衡" });
  await act(async () => {
    resolveAccount({ ...account, quota: 999999 });
  });
  expect(screen.queryByRole("navigation")).toBeNull();
});

const pricing = {
  success: true,
  data: [
    {
      model_name: "claude-opus-5",
      display_name: "Claude Opus 5",
      description: "旗舰推理模型",
      tags: "推理,长文本",
      vendor_id: 1,
      quota_type: 0,
      model_ratio: 15,
      completion_ratio: 5,
      context_length: 200000,
      max_output_tokens: 32000,
      capabilities: { reasoning: true, streaming: true },
      billing_mode: "ratio",
      release_date: "2025-02-01",
      enable_groups: ["standard"],
    },
    {
      model_name: "gemini-3.1-flash-lite",
      display_name: "Gemini 3.1 Flash Lite",
      vendor_id: 2,
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 3,
      context_length: 1000000,
      release_date: "2026-06-01",
      enable_groups: ["standard", "vertex"],
    },
    {
      model_name: "flux-image",
      display_name: "FLUX 生图",
      vendor_id: 2,
      quota_type: 1,
      model_price: 1,
      enable_groups: ["vertex"],
    },
    {
      model_name: "tiered-model",
      display_name: "阶梯模型",
      vendor_id: 1,
      quota_type: 0,
      model_ratio: 2,
      billing_mode: "tiered_expr",
      enable_groups: ["standard"],
    },
  ],
  vendors: [
    { id: 1, name: "Anthropic" },
    { id: 2, name: "Google" },
  ],
  group_ratio: { standard: 0.7, vertex: 4 },
  usable_group: { standard: "标准分组", vertex: "Vertex 分组" },
};
it("shows website prices for the selected pricing group", async () => {
  vi.mocked(api.pricing).mockResolvedValue(pricing as never);
  const onUse = vi.fn();
  render(
    <Models defaultGroup="default" unit="quota" price={0.2} onUse={onUse} />,
  );
  await screen.findByText("Claude Opus 5");
  expect(screen.getByText("⚡21.0000")).toBeTruthy();
  expect(screen.getByText("⚡105.0000")).toBeTruthy();
  expect(screen.getByText("⚡1.4000")).toBeTruthy();
  expect(screen.getByText("⚡4.0000")).toBeTruthy();
  expect(screen.getByText("FLUX 生图")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "计价分组" }));
  fireEvent.click(await screen.findByRole("button", { name: /^vertex/ }));
  await waitFor(() => expect(screen.getByText("⚡8.0000")).toBeTruthy());
  expect(screen.getByText("⚡24.0000")).toBeTruthy();
  expect(screen.queryByText("Claude Opus 5")).toBeNull();
  fireEvent.change(screen.getByLabelText("搜索模型"), {
    target: { value: "gemini" },
  });
  expect(screen.queryByText("Claude Opus 5")).toBeNull();
  fireEvent.click(screen.getByText("Gemini 3.1 Flash Lite"));
  fireEvent.click(await screen.findByRole("button", { name: /用此模型对话/ }));
  expect(onUse).toHaveBeenCalledWith("gemini-3.1-flash-lite", "vertex");
});
it("limits pricing groups to the groups offered by the selected brand", async () => {
  vi.mocked(api.pricing).mockResolvedValue(pricing as never);
  render(
    <Models defaultGroup="default" unit="quota" price={0.2} onUse={vi.fn()} />,
  );
  await screen.findByText("Claude Opus 5");
  fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));
  await waitFor(() =>
    expect(screen.queryByText("Gemini 3.1 Flash Lite")).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "计价分组" }));
  await screen.findByRole("dialog", { name: "选择计价分组" });
  expect(screen.getByRole("button", { name: /^standard/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^vertex/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^standard/ }));
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  fireEvent.click(screen.getByRole("button", { name: "计价分组" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^vertex/ })).toBeTruthy(),
  );
});
it("shows model prices in yuan when the wallet shows CNY", async () => {
  vi.mocked(api.pricing).mockResolvedValue(pricing as never);
  render(
    <Models defaultGroup="default" unit="cny" price={0.2} onUse={vi.fn()} />,
  );
  await screen.findByText("Claude Opus 5");
  expect(screen.getByText("¥4.2000")).toBeTruthy();
  expect(screen.getByText("¥21.0000")).toBeTruthy();
});
it("sorts the gallery by newest release date", async () => {
  vi.mocked(api.pricing).mockResolvedValue(pricing as never);
  const { container } = render(
    <Models defaultGroup="default" unit="quota" price={0.2} onUse={vi.fn()} />,
  );
  await screen.findByText("Claude Opus 5");
  fireEvent.click(screen.getByRole("button", { name: "排序方式" }));
  fireEvent.click(await screen.findByRole("button", { name: /最新发布/ }));
  const names = [
    ...container.querySelectorAll(".model-card .model-name strong"),
  ].map((node) => node.textContent);
  expect(names[0]).toBe("Gemini 3.1 Flash Lite");
});
it("names the lowest-price group and compares pricing groups", async () => {
  vi.mocked(api.pricing).mockResolvedValue(pricing as never);
  vi.mocked(api.healthGroups).mockResolvedValue({
    enabled: true,
    groups: [
      {
        group: "standard",
        success_rate: 99.5,
        avg_ttft_ms: 850,
        cache_hit_rate: 42.123,
      },
      {
        group: "vertex",
        success_rate: 91.2,
        avg_ttft_ms: 2200,
        cache_hit_rate: 10,
      },
    ],
  });
  const onUse = vi.fn();
  render(<Models defaultGroup="" unit="quota" price={0.2} onUse={onUse} />);
  await screen.findByText("Gemini 3.1 Flash Lite");
  fireEvent.click(screen.getByText("Gemini 3.1 Flash Lite"));
  expect(await screen.findByText("分组 标准分组")).toBeTruthy();
  expect(screen.queryByText("Vertex 分组")).toBeNull();
  expect(screen.queryByText("99.50%")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /分组 标准分组/ }));
  await screen.findByText("99.50%");
  expect(screen.getByText("850 ms")).toBeTruthy();
  expect(screen.getByText("42.12%")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: /Vertex 分组/ }));
  await waitFor(() =>
    expect(screen.getByText("分组 Vertex 分组")).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: /用此模型对话/ }));
  expect(onUse).toHaveBeenCalledWith("gemini-3.1-flash-lite", "vertex");
});
it("opens the model gallery from the mobile navigation", async () => {
  vi.mocked(api.restore).mockResolvedValue(account);
  vi.mocked(api.pricing).mockResolvedValue(pricing as never);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "广场" }));
  await screen.findByText("Claude Opus 5");
  expect(api.pricing).toHaveBeenCalled();
});
it("edits and deletes a token without leaving the list", async () => {
  const token = {
    id: 1,
    name: "旧名字",
    group: "default",
    status: 1,
    remain_quota: 2500000,
    unlimited_quota: false,
    used_quota: 0,
    expired_time: -1,
  };
  vi.mocked(api.get).mockImplementation(async (op) => {
    if (op === "tokens") return { items: [token], total: 1 };
    if (op === "groups") return { default: { desc: "默认分组" } };
    if (op === "models") return ["test-model"];
    return {};
  });
  vi.mocked(api.tokenUpdate).mockResolvedValue(token);
  vi.mocked(api.tokenDelete).mockResolvedValue({});
  render(<Tokens active perUnit={500000} />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const name = await screen.findByLabelText("名称");
  expect((name as HTMLInputElement).value).toBe("旧名字");
  fireEvent.change(name, { target: { value: "新名字" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() =>
    expect(api.tokenUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        name: "新名字",
        group: "default",
        remain_quota: 2500000,
        expired_time: -1,
      }),
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(api.tokenDelete).toHaveBeenCalledWith(1));
});
it("filters the token list locally by name", async () => {
  const token = {
    id: 2,
    name: "工作密钥",
    group: "default",
    status: 1,
    remain_quota: 100,
    unlimited_quota: false,
    used_quota: 0,
    expired_time: -1,
  };
  vi.mocked(api.get).mockImplementation(async (op) => {
    if (op === "tokens") return { items: [token], total: 1 };
    return {};
  });
  render(<Tokens active perUnit={500000} />);
  await screen.findByText("工作密钥");
  fireEvent.change(screen.getByLabelText("搜索令牌"), {
    target: { value: "不存在" },
  });
  expect(screen.queryByText("工作密钥")).toBeNull();
  expect(screen.getByText("没有匹配的令牌")).toBeTruthy();
});
it("shows token quota in the balance unit picked in the header", async () => {
  const token = {
    id: 3,
    name: "计费密钥",
    group: "default",
    status: 1,
    remain_quota: 250000,
    unlimited_quota: false,
    used_quota: 250000,
    expired_time: -1,
  };
  vi.mocked(api.get).mockImplementation(async (op) => {
    if (op === "tokens") return { items: [token], total: 1 };
    return {};
  });
  const view = render(
    <Tokens active perUnit={500000} price={0.2} unit="quota" />,
  );
  await screen.findByText("计费密钥");
  expect(screen.getAllByText("0.50")).toHaveLength(2);
  view.rerender(<Tokens active perUnit={500000} price={0.2} unit="cny" />);
  expect(screen.getAllByText("0.10")).toHaveLength(2);
});
it("runs several image tasks at once and keeps reuse and favorites", async () => {
  let resolveFirst!: (value: { data: string; mime: string }) => void;
  let resolveSecond!: (value: { data: string; mime: string }) => void;
  vi.mocked(api.image)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
  vi.mocked(api.gallerySave).mockResolvedValue();
  vi.mocked(api.galleryDelete).mockResolvedValue();
  render(<Images userId={7} active refresh={async () => {}} />);
  const field = screen.getByLabelText("画面描述");
  fireEvent.change(field, { target: { value: "海边书店" } });
  fireEvent.click(screen.getByRole("button", { name: "生成图片" }));
  fireEvent.change(field, { target: { value: "山间小屋" } });
  fireEvent.click(screen.getByRole("button", { name: "生成图片" }));
  await waitFor(() => expect(api.image).toHaveBeenCalledTimes(2));
  await act(async () => {
    resolveFirst({ data: "QUFB", mime: "image/png" });
  });
  await act(async () => {
    resolveSecond({ data: "QkJC", mime: "image/png" });
  });
  expect(await screen.findByRole("tablist", { name: "生成图片" })).toBeTruthy();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "收藏" })[0]);
  await waitFor(() => expect(api.gallerySave).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.gallerySave).mock.calls[0][0]).toMatchObject({
    prompt: "山间小屋",
    model: "gpt-image-2",
    size: "1024x1024",
    result: { data: "QkJC", mime: "image/png" },
  });
  fireEvent.change(field, { target: { value: "临时内容" } });
  fireEvent.click(screen.getAllByRole("button", { name: "复用参数" })[0]);
  expect((screen.getByLabelText("画面描述") as HTMLTextAreaElement).value).toBe(
    "山间小屋",
  );
});
