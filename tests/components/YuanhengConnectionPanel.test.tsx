import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { YuanhengConnectionPanel } from "@/components/desktop/YuanhengConnectionPanel";
import { server } from "../msw/server";
import { getYuanhengConnection } from "../msw/state";

const renderPanel = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <YuanhengConnectionPanel />
    </QueryClientProvider>,
  );
};

describe("YuanhengConnectionPanel", () => {
  it("密码可反复显示隐藏且不提交，注册确认密码独立切换并在换页后隐藏", async () => {
    let logins = 0;
    server.use(
      http.post("http://tauri.local/login_yuanheng", () => {
        logins += 1;
        return HttpResponse.error();
      }),
    );
    renderPanel();
    fireEvent.change(await screen.findByLabelText("用户名"), {
      target: { value: "tester" },
    });
    const password = screen.getByLabelText("密码");
    fireEvent.change(password, { target: { value: "password123" } });
    expect(password).toHaveAttribute("type", "password");
    const toggle = screen.getByRole("button", { name: "显示密码" });
    expect(toggle).toHaveAttribute("type", "button");
    fireEvent.click(toggle);
    expect(password).toHaveAttribute("type", "text");
    expect(password).toHaveValue("password123");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "隐藏密码" }));
    expect(password).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    expect(password).toHaveAttribute("type", "password");
    const confirmation = screen.getByLabelText("确认密码");
    fireEvent.change(confirmation, { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "显示确认密码" }));
    expect(confirmation).toHaveAttribute("type", "text");
    expect(confirmation).toHaveValue("password123");
    expect(password).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    expect(screen.getByLabelText("确认密码")).toHaveAttribute(
      "type",
      "password",
    );
    expect(logins).toBe(0);
  });

  it("旧条目拒绝后完成两步登录，不再要求恢复旧登录", async () => {
    let restores = 0;
    server.use(
      http.post("http://tauri.local/get_yuanheng_connection", () =>
        HttpResponse.text("YUANHENG_CREDENTIAL_ACCESS_REQUIRED: locked", {
          status: 500,
        }),
      ),
      http.post("http://tauri.local/restore_yuanheng_keychain_access", () => {
        restores += 1;
        return HttpResponse.text("unexpected restore", { status: 500 });
      }),
    );
    renderPanel();
    fireEvent.change(await screen.findByLabelText("用户名"), {
      target: { value: "twofactor" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "password123" },
    });
    const buttons = screen.getAllByRole("button", { name: "登录" });
    fireEvent.click(buttons[buttons.length - 1]);
    await screen.findByRole("heading", { name: "完成两步验证" });
    expect(
      screen.queryByRole("button", { name: "恢复本机登录" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("两步验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证并登录" }));
    await screen.findByText("元衡账号已登录 · 本机工具凭据已就绪");
    expect(restores).toBe(0);
  });

  it.each([false, true])(
    "旧条目被拒绝时仍可直接账号密码登录，临时会话提示=%s",
    async (sessionOnly) => {
      let restores = 0;
      let logins = 0;
      server.use(
        http.post("http://tauri.local/get_yuanheng_connection", () =>
          HttpResponse.text("YUANHENG_CREDENTIAL_ACCESS_REQUIRED: locked", {
            status: 500,
          }),
        ),
        http.post("http://tauri.local/restore_yuanheng_keychain_access", () => {
          restores += 1;
          return HttpResponse.text("must not restore", { status: 500 });
        }),
        http.post("http://tauri.local/login_yuanheng", async ({ request }) => {
          expect(await request.json()).toEqual({
            username: "fresh-user",
            password: "password123",
          });
          logins += 1;
          return HttpResponse.json({
            requiresTwoFactor: false,
            connection: {
              ...getYuanhengConnection(),
              connected: true,
              userId: "fresh-user",
              sessionOnly,
            },
          });
        }),
      );
      renderPanel();
      fireEvent.change(await screen.findByLabelText("用户名"), {
        target: { value: "fresh-user" },
      });
      fireEvent.change(screen.getByLabelText("密码"), {
        target: { value: "password123" },
      });
      const buttons = screen.getAllByRole("button", { name: "登录" });
      fireEvent.click(buttons[buttons.length - 1]);
      await screen.findByText("元衡账号已登录 · 本机工具凭据已就绪");
      expect(logins).toBe(1);
      expect(restores).toBe(0);
      expect(
        screen.queryByRole("button", { name: "恢复本机登录" }),
      ).not.toBeInTheDocument();
      expect(
        Boolean(
          screen.queryByText(
            "已登录；本次会话未保存在本机，关闭应用后需要重新登录。",
          ),
        ),
      ).toBe(sessionOnly);
    },
  );

  it("钥匙串被拒绝时仅点击恢复才请求授权，取消不重试", async () => {
    let restoreCalls = 0;
    server.use(
      http.post("http://tauri.local/get_yuanheng_connection", () =>
        HttpResponse.text("YUANHENG_CREDENTIAL_ACCESS_REQUIRED: locked", {
          status: 500,
        }),
      ),
      http.post("http://tauri.local/restore_yuanheng_keychain_access", () => {
        restoreCalls += 1;
        return HttpResponse.text("cancelled", { status: 500 });
      }),
    );
    renderPanel();
    const button = await screen.findByRole("button", { name: "恢复本机登录" });
    expect(restoreCalls).toBe(0);
    fireEvent.click(button);
    expect(
      await screen.findByText(
        "未恢复访问，原有登录信息已保留。可稍后再次点击恢复。",
      ),
    ).toBeInTheDocument();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(restoreCalls).toBe(1);
    expect(screen.getByLabelText("用户名")).toBeInTheDocument();
  });

  it("恢复期间禁用重复点击，成功后使用恢复账号进入已登录状态", async () => {
    let finish!: () => void;
    let restoreCalls = 0;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server.use(
      http.post("http://tauri.local/get_yuanheng_connection", () =>
        HttpResponse.text("YUANHENG_CREDENTIAL_ACCESS_REQUIRED: locked", {
          status: 500,
        }),
      ),
      http.post(
        "http://tauri.local/restore_yuanheng_keychain_access",
        async () => {
          restoreCalls += 1;
          await pending;
          return HttpResponse.json({
            ...getYuanhengConnection(),
            connected: true,
            userId: "recovered",
          });
        },
      ),
    );
    renderPanel();
    const button = await screen.findByRole("button", { name: "恢复本机登录" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    finish();
    expect(
      await screen.findByText("元衡账号已登录 · 本机工具凭据已就绪"),
    ).toBeInTheDocument();
    expect(restoreCalls).toBe(1);
    expect(
      screen.queryByRole("button", { name: "恢复本机登录" }),
    ).not.toBeInTheDocument();
  });

  it("普通错误不提供钥匙串授权入口", async () => {
    server.use(
      http.post("http://tauri.local/get_yuanheng_connection", () =>
        HttpResponse.text("database unavailable", { status: 500 }),
      ),
    );
    renderPanel();
    await screen.findByLabelText("用户名");
    expect(
      screen.queryByRole("button", { name: "恢复本机登录" }),
    ).not.toBeInTheDocument();
  });

  it("登录允许输入超过 20 位的已有用户名", async () => {
    renderPanel();

    const username = "account-name-longer-than-twenty-characters";
    const usernameInput = await screen.findByLabelText("用户名");
    fireEvent.change(usernameInput, { target: { value: username } });
    expect(usernameInput).toHaveValue(username);

    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "password123" },
    });
    const loginButtons = screen.getAllByRole("button", { name: "登录" });
    fireEvent.click(loginButtons[loginButtons.length - 1]);

    expect(
      await screen.findByText("元衡账号已登录 · 本机工具凭据已就绪"),
    ).toBeInTheDocument();
  });

  it("使用账号密码注册并自动登录", async () => {
    renderPanel();

    expect(await screen.findByLabelText("用户名")).toBeInTheDocument();
    expect(screen.queryByText("用户 ID")).not.toBeInTheDocument();
    expect(screen.queryByText("访问令牌")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "new-user" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "password123" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并登录" }));

    expect(
      await screen.findByText("元衡账号已登录 · 本机工具凭据已就绪"),
    ).toBeInTheDocument();
  });

  it("账号开启两步验证时进入验证码步骤", async () => {
    renderPanel();

    fireEvent.change(await screen.findByLabelText("用户名"), {
      target: { value: "twofactor" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "password123" },
    });
    const loginButtons = screen.getAllByRole("button", { name: "登录" });
    fireEvent.click(loginButtons[loginButtons.length - 1]);

    expect(
      await screen.findByRole("heading", { name: "完成两步验证" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("两步验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证并登录" }));

    await waitFor(() =>
      expect(
        screen.getByText("元衡账号已登录 · 本机工具凭据已就绪"),
      ).toBeInTheDocument(),
    );
  });

  it("退出登录只清理账号会话，不调用解除工具接管", async () => {
    let signOutCalls = 0;
    let disconnectCalls = 0;
    server.use(
      http.post("http://tauri.local/sign_out_yuanheng", () => {
        signOutCalls += 1;
        return HttpResponse.json(true);
      }),
      http.post("http://tauri.local/disconnect_yuanheng", () => {
        disconnectCalls += 1;
        return HttpResponse.json({ disconnected: true });
      }),
    );
    renderPanel();

    fireEvent.change(await screen.findByLabelText("用户名"), {
      target: { value: "signed-in-user" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "password123" },
    });
    const loginButtons = screen.getAllByRole("button", { name: "登录" });
    fireEvent.click(loginButtons[loginButtons.length - 1]);
    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));

    await waitFor(() => expect(signOutCalls).toBe(1));
    expect(disconnectCalls).toBe(0);
    expect(await screen.findByLabelText("用户名")).toBeInTheDocument();
  });
});
