import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "../src/App";
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
  vi.mocked(api.get).mockImplementation(async (op) => {
    if (op === "status") return { quota_per_unit: 500000 };
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
  expect(screen.getAllByText("$10.00").length).toBeGreaterThan(0);
  expect(screen.getByText("元衡移动端 · 1.0.0")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  await screen.findByRole("button", { name: "登录元衡" });
  expect(screen.queryByRole("button", { name: /前往官网注册/ })).toBeNull();
  expect(api.open).not.toHaveBeenCalled();
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
  expect(screen.getAllByText("$10.00").length).toBeGreaterThan(0);
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
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "默认分组" })).toBeTruthy(),
  );
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
