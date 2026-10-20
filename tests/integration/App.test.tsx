import { Suspense, type ComponentType } from "react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
  act,
} from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getConfiguredToolCalls,
  getConfiguredToolGroupCalls,
  getConfiguredToolReasoningCalls,
  getLaunchedToolCalls,
  getLaunchedToolRequests,
  getRestartedToolCalls,
  resetProviderState,
  setSettings,
  setYuanhengConnection as setConnectionState,
  setYuanhengToolStatus as setToolState,
} from "../msw/state";
import { emitTauriEvent } from "../msw/tauriMocks";
import { server } from "../msw/server";
import i18n from "@/i18n";
import {
  UpdateProvider,
  UPDATE_STORAGE_KEYS,
  useUpdate,
} from "@/contexts/UpdateContext";
import { UpdatePrompt } from "@/components/UpdatePrompt";

// Successful setup fixtures must include the group catalog required by live
// configuration; an absent catalog is not proof of permission to change groups.
const setYuanhengConnection = (
  input: Parameters<typeof setConnectionState>[0],
) =>
  setConnectionState({
    ...input,
    groups: input.groups ?? [{ id: "default", description: "", ratio: 1 }],
    modelGroups:
      input.modelGroups ??
      Object.fromEntries(
        (input.models ?? []).map((model) => [model, ["default"]]),
      ),
  });
const setYuanhengToolStatus = (
  app: Parameters<typeof setToolState>[0],
  input: Parameters<typeof setToolState>[1],
) => setToolState(app, { group: "default", ...input });

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/components/providers/ProviderList", () => ({
  ProviderList: ({
    providers,
    currentProviderId,
    onSwitch,
    onEdit,
    onConfigureUsage,
    onOpenWebsite,
  }: any) => (
    <div>
      <div data-testid="provider-list">{JSON.stringify(providers)}</div>
      <div data-testid="current-provider">{currentProviderId}</div>
      <button onClick={() => onSwitch(providers[currentProviderId])}>
        switch
      </button>
      <button onClick={() => onEdit(providers[currentProviderId])}>edit</button>
      <button onClick={() => onConfigureUsage(providers[currentProviderId])}>
        usage
      </button>
      <button onClick={() => onOpenWebsite("https://example.com")}>
        open-website
      </button>
    </div>
  ),
}));

vi.mock("@/components/providers/EditProviderDialog", () => ({
  EditProviderDialog: ({ open, provider, onSubmit, onOpenChange }: any) =>
    open ? (
      <div data-testid="edit-provider-dialog">
        <button
          onClick={() =>
            onSubmit({
              provider: {
                ...provider,
                name: `${provider.name}-edited`,
              },
              originalId: provider.id,
            })
          }
        >
          confirm-edit
        </button>
        <button onClick={() => onOpenChange(false)}>close-edit</button>
      </div>
    ) : null,
}));

vi.mock("@/components/UsageScriptModal", () => ({
  default: ({ isOpen, provider, onSave, onClose }: any) =>
    isOpen ? (
      <div data-testid="usage-modal">
        <span data-testid="usage-provider">{provider?.id}</span>
        <button onClick={() => onSave("script-code")}>save-script</button>
        <button onClick={() => onClose()}>close-usage</button>
      </div>
    ) : null,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <button onClick={() => onConfirm()}>confirm-delete</button>
        <button onClick={() => onCancel()}>cancel-delete</button>
      </div>
    ) : null,
}));

vi.mock("@/components/AppSwitcher", () => ({
  AppSwitcher: ({ activeApp, onSwitch }: any) => (
    <div data-testid="app-switcher">
      <span>{activeApp}</span>
      <button onClick={() => onSwitch("claude")}>switch-claude</button>
      <button onClick={() => onSwitch("codex")}>switch-codex</button>
      <button onClick={() => onSwitch("openclaw")}>switch-openclaw</button>
    </div>
  ),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.69" }));

vi.mock("@/components/mcp/McpPanel", () => ({
  default: ({ open, onOpenChange }: any) =>
    open ? (
      <div data-testid="mcp-panel">
        <button onClick={() => onOpenChange(false)}>close-mcp</button>
      </div>
    ) : (
      <button onClick={() => onOpenChange(true)}>open-mcp</button>
    ),
}));

let appUpdate: ReturnType<typeof useUpdate>;
function UpdateProbe() {
  appUpdate = useUpdate();
  return null;
}

const renderApp = (
  AppComponent: ComponentType,
  includeUpdatePrompt = false,
) => {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <UpdateProvider>
        <UpdateProbe />
        <Suspense fallback={<div data-testid="loading">loading</div>}>
          <AppComponent />
        </Suspense>
        {includeUpdatePrompt && <UpdatePrompt />}
      </UpdateProvider>
    </QueryClientProvider>,
  );
};

const dismissOnboarding = async () => {
  const onboarding = await screen.findByRole(
    "dialog",
    { name: "首次配置" },
    { timeout: 10_000 },
  );
  fireEvent.click(within(onboarding).getByRole("button", { name: "稍后配置" }));
  await waitFor(
    () =>
      expect(
        screen.queryByRole("dialog", { name: "首次配置" }),
      ).not.toBeInTheDocument(),
    { timeout: 10_000 },
  );
};

describe("App integration with MSW", { timeout: 15_000 }, () => {
  it.each([false, true])(
    "登录状态为 %s 时更新入口都在全局第一行，忽略后仍可打开，无更新时消失",
    async (connected) => {
      setSettings({ firstRunNoticeConfirmed: true });
      setYuanhengConnection({ connected });
      localStorage.setItem(UPDATE_STORAGE_KEYS.autoCheck, "false");
      server.use(
        http.post("http://tauri.local/check_desktop_update", () =>
          HttpResponse.json({
            currentVersion: "0.1.71",
            availableVersion: "0.1.72",
            notes: "顶部更新入口",
          }),
        ),
        http.post("http://tauri.local/get_desktop_release_notes", () =>
          HttpResponse.json(null),
        ),
      );
      const { default: App } = await import("@/App");
      renderApp(App, true);
      if (connected) {
        await screen.findByRole("heading", { name: "工作台" });
      } else {
        await screen.findByLabelText("用户名");
      }
      expect(
        screen.queryByTestId("update-notification-dot"),
      ).not.toBeInTheDocument();
      const initialTopBarHeight =
        screen.queryByTestId("app-top-bar")?.style.height;
      await act(async () => {
        await appUpdate.checkUpdate({ showPrompt: false });
      });
      const topBar = screen.getByTestId("app-top-bar");
      expect(topBar).toHaveStyle({ height: "36px" });
      expect(
        within(topBar).getByTestId("update-notification-dot"),
      ).toBeVisible();
      fireEvent.click(
        within(topBar).getByRole("button", {
          name: i18n.t("settings.updateTo", { version: "0.1.72" }),
        }),
      );
      expect(
        screen.getByRole("dialog", {
          name: i18n.t("settings.updatePromptTitle"),
        }),
      ).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", {
          name: i18n.t("settings.ignoreThisVersion"),
        }),
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.click(
        within(topBar).getByRole("button", {
          name: i18n.t("settings.updateTo", { version: "0.1.72" }),
        }),
      );
      expect(screen.getByRole("dialog")).toBeVisible();
      server.use(
        http.post("http://tauri.local/check_desktop_update", () =>
          HttpResponse.json(null),
        ),
      );
      await act(async () => {
        await appUpdate.checkUpdate({ showPrompt: false });
      });
      expect(
        screen.queryByTestId("update-notification-dot"),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("app-top-bar")?.style.height).toBe(
        initialTopBarHeight,
      );
    },
  );

  it.each([false, true])(
    "旧凭据拒绝且两步验证为 %s 时可更新，不读取恢复凭据",
    async (twoFactor) => {
      let installs = 0;
      let restores = 0;
      localStorage.setItem(UPDATE_STORAGE_KEYS.autoCheck, "false");
      server.use(
        http.post("http://tauri.local/get_yuanheng_connection", () =>
          HttpResponse.text("YUANHENG_CREDENTIAL_ACCESS_REQUIRED: locked", {
            status: 500,
          }),
        ),
        http.post("http://tauri.local/login_yuanheng", () =>
          HttpResponse.json({ requiresTwoFactor: true, connection: null }),
        ),
        http.post("http://tauri.local/restore_yuanheng_keychain_access", () => {
          restores++;
          return HttpResponse.json(null);
        }),
        http.post("http://tauri.local/check_desktop_update", () =>
          HttpResponse.json({
            currentVersion: "0.1.69",
            availableVersion: "0.1.70",
            notes: "登录页可升级",
          }),
        ),
        http.post("http://tauri.local/get_desktop_release_notes", () =>
          HttpResponse.json(null),
        ),
        http.post("http://tauri.local/install_update_and_restart", () => {
          installs++;
          return HttpResponse.json(true);
        }),
      );
      const { default: App } = await import("@/App");
      renderApp(App, true);
      fireEvent.change(await screen.findByLabelText("用户名"), {
        target: { value: "synthetic-user" },
      });
      if (twoFactor) {
        fireEvent.change(screen.getByLabelText("密码"), {
          target: { value: "synthetic-password" },
        });
        const buttons = screen.getAllByRole("button", { name: "登录" });
        fireEvent.click(buttons[buttons.length - 1]);
        fireEvent.change(await screen.findByLabelText("两步验证码"), {
          target: { value: "123456" },
        });
      }
      fireEvent.click(
        screen.getByRole("button", {
          name: i18n.t("settings.checkForUpdates"),
        }),
      );
      expect(
        await screen.findByRole("dialog", {
          name: i18n.t("settings.updatePromptTitle"),
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText(twoFactor ? "两步验证码" : "用户名"),
      ).toHaveValue(twoFactor ? "123456" : "synthetic-user");
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("settings.updateNow") }),
      );
      await waitFor(() => expect(installs).toBe(1));
      expect(restores).toBe(0);
      expect(
        screen.queryByRole("heading", { name: "工具管理" }),
      ).not.toBeInTheDocument();
    },
  );

  it("启动旧凭据不可读时直接账号密码登录进入工作台，不调用恢复", async () => {
    let signedIn = false;
    let restores = 0;
    const connection = {
      connected: true,
      userId: "fresh-user",
      baseUrl: "https://meta-api.vip",
      sessionOnly: true,
      account: {
        username: "fresh-user",
        displayName: "Fresh User",
        group: "default",
        remainingUsd: 10,
        usedUsd: 0,
      },
      models: [],
      groups: [],
      modelGroups: {},
      reasoningLevels: {},
      announcement: null,
      lastSyncedAt: null,
    };
    server.use(
      http.post("http://tauri.local/get_yuanheng_connection", () =>
        signedIn
          ? HttpResponse.json(connection)
          : HttpResponse.text("YUANHENG_CREDENTIAL_ACCESS_REQUIRED: locked", {
              status: 500,
            }),
      ),
      http.post("http://tauri.local/restore_yuanheng_keychain_access", () => {
        restores += 1;
        return HttpResponse.text("unexpected restore", { status: 500 });
      }),
      http.post("http://tauri.local/login_yuanheng", () => {
        signedIn = true;
        setYuanhengConnection(connection);
        return HttpResponse.json({ requiresTwoFactor: false, connection });
      }),
    );
    const { default: App } = await import("@/App");
    renderApp(App);
    fireEvent.change(await screen.findByLabelText("用户名"), {
      target: { value: "fresh-user" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "password123" },
    });
    const buttons = screen.getAllByRole("button", { name: "登录" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() =>
      expect(screen.queryByLabelText("密码")).not.toBeInTheDocument(),
    );
    expect(signedIn).toBe(true);
    expect(restores).toBe(0);
    expect(toastSuccessMock).toHaveBeenCalledWith("登录成功", {
      description: "已登录；本次会话未保存在本机，关闭应用后需要重新登录。",
      duration: 8000,
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("启动钥匙串被拒绝后稳定显示恢复入口，不因登录面板挂载循环读取", async () => {
    let reads = 0;
    let restores = 0;
    server.use(
      http.post("http://tauri.local/get_yuanheng_connection", () => {
        reads += 1;
        return HttpResponse.text(
          "YUANHENG_CREDENTIAL_ACCESS_REQUIRED: locked",
          { status: 500 },
        );
      }),
      http.post("http://tauri.local/restore_yuanheng_keychain_access", () => {
        restores += 1;
        return HttpResponse.text("cancelled", { status: 500 });
      }),
    );
    const { default: App } = await import("@/App");
    renderApp(App);
    const restore = await screen.findByRole("button", { name: "恢复本机登录" });
    expect(reads).toBe(1);
    expect(restores).toBe(0);
    fireEvent.click(restore);
    expect(
      await screen.findByText(
        "未恢复访问，原有登录信息已保留。可稍后再次点击恢复。",
      ),
    ).toBeInTheDocument();
    expect(reads).toBe(1);
    expect(restores).toBe(1);
  });

  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    resetProviderState();
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      account: {
        username: "mock-user",
        displayName: "Mock User",
        group: "default",
        remainingUsd: 102560.36,
        usedUsd: 99,
      },
    });
    localStorage.clear();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("帮助关闭保留子页面，Escape 不触发后台返回", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    const user = userEvent.setup();
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByRole("heading", { name: "工作台" });
    await user.click(screen.getByRole("button", { name: "能力中心" }));
    await user.click(
      screen.getByText("连接文件、数据库和外部服务").closest("button")!,
    );
    const heading = await screen.findByRole("heading", {
      name: i18n.t("desktop.views.mcp"),
    });
    await user.click(screen.getByRole("button", { name: "帮助" }));
    expect(screen.getByRole("dialog", { name: "使用说明" })).toBeVisible();
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "使用说明" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: i18n.t("desktop.views.mcp") }),
    ).toBe(heading);
    expect(screen.getByRole("button", { name: "帮助" })).toHaveFocus();
  });

  it("旧说明页面回退工作台，快捷搜索打开帮助而不持久化新页面", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    localStorage.setItem("yuanheng-desktop-last-view", "guide");
    const user = userEvent.setup();
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByRole("heading", { name: "工作台" });
    await user.click(screen.getByRole("button", { name: "工具管理" }));
    expect(localStorage.getItem("yuanheng-desktop-last-view")).toBe("tools");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.type(
      screen.getByPlaceholderText("搜索页面、工具或操作..."),
      "help",
    );
    await user.click(screen.getByRole("option", { name: /使用说明/ }));
    expect(
      await screen.findByRole("dialog", { name: "使用说明" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "快捷操作" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "使用说明" }),
      ).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem("yuanheng-desktop-last-view")).toBe("tools");
    expect(screen.getByRole("button", { name: "工具管理" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "帮助" })).toHaveFocus();
  });

  it("renders the access screen in English", async () => {
    setSettings({ firstRunNoticeConfirmed: true, language: "en" });
    setYuanhengConnection({ connected: false });
    await i18n.changeLanguage("en");

    const { default: App } = await import("@/App");
    renderApp(App);

    expect(
      await screen.findByRole("heading", { name: "Sign In to YuanHeng" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("登录你的元衡账号")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Visit YuanHeng Website" }),
    ).toBeInTheDocument();
  });

  it("requires login before showing the workspace", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({ connected: false });

    const { default: App } = await import("@/App");
    renderApp(App);

    expect(
      await screen.findByRole("heading", { name: "登录你的元衡账号" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "工作台" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "首次配置" }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "new-user" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "password123" },
    });
    const loginButtons = screen.getAllByRole("button", { name: "登录" });
    fireEvent.click(loginButtons[loginButtons.length - 1]);

    expect(
      await screen.findByRole("button", { name: "账号与余额" }),
    ).toHaveTextContent("new-user");
    expect(
      screen.getByRole("button", { name: "账号与余额" }),
    ).toHaveTextContent("$10.00");
    expect(
      await screen.findByRole("heading", { name: "工作台" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "账号与余额" }));
    expect(
      await screen.findByRole("heading", { name: "连接与路由" }),
    ).toBeInTheDocument();
  });

  it("renders the tool-first desktop workspace without projects or provider management", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    await dismissOnboarding();

    expect(
      await screen.findByRole("heading", {
        name: "工作台",
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "连接与配置检查" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "工具管理" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "项目" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-list")).not.toBeInTheDocument();
    expect(screen.queryByText("添加供应商")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "能力中心" }));
    expect(
      await screen.findByRole("heading", { name: "能力中心" }),
    ).toBeInTheDocument();

    emitTauriEvent("provider-switched", {
      appType: "codex",
      providerId: "codex-2",
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("keeps the Skill Market inside Skills as a second tab", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    const { default: App } = await import("@/App");
    renderApp(App);

    await screen.findByRole("heading", { name: "工作台" });
    fireEvent.click(screen.getByRole("button", { name: "能力中心" }));
    const skillsCardDescription =
      await screen.findByText("给 AI 工具安装可复用的专业能力");
    fireEvent.click(skillsCardDescription.closest("button")!);

    expect(await screen.findByTestId("skills-hub")).toBeInTheDocument();
    const installedTab = screen.getByTestId("skills-tab-installed");
    const marketTab = screen.getByTestId("skills-tab-market");
    expect(installedTab).toHaveTextContent("skills.market.installedTab");
    expect(marketTab).toHaveTextContent("skills.market.marketTab");
    expect(installedTab).toHaveAttribute("aria-selected", "true");
    expect(marketTab).toHaveAttribute("aria-selected", "false");

    fireEvent.click(marketTab);
    expect(marketTab).toHaveAttribute("aria-selected", "true");
    expect(
      await screen.findByRole("heading", { name: "skills.market.title" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("skills.market.installTarget"),
    ).toBeInTheDocument();
  });

  it("shows toast when auto sync fails in background", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    await dismissOnboarding();

    expect(() => {
      emitTauriEvent("webdav-sync-status-updated", null);
    }).not.toThrow();
    expect(toastErrorMock).not.toHaveBeenCalled();

    emitTauriEvent("webdav-sync-status-updated", {
      source: "auto",
      status: "error",
      error: "network timeout",
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });

    toastErrorMock.mockReset();
    expect(() => {
      emitTauriEvent("s3-sync-status-updated", null);
    }).not.toThrow();
    expect(toastErrorMock).not.toHaveBeenCalled();

    emitTauriEvent("s3-sync-status-updated", {
      source: "auto",
      status: "error",
      error: "s3 timeout",
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
  });

  it("configures a selected tool through Yuanheng before launching it", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["claude-sonnet-4-6", "gemini-3-pro", "gpt-5.6"],
    });

    const { default: App } = await import("@/App");
    renderApp(App);

    expect(
      await screen.findByRole("heading", {
        name: "工作台",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "工具管理" }));
    await screen.findByRole("heading", { name: "工具管理" });

    expect(
      await screen.findByLabelText("Codex 分组与模型"),
    ).toBeInTheDocument();
    expect(
      await screen.findByLabelText("Claude Desktop 分组与模型"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "配置 Codex" }));
    await waitFor(() => expect(getConfiguredToolCalls()).toEqual([["codex"]]));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "启动 Codex" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "启动 Codex" }));
    await waitFor(() => expect(getLaunchedToolCalls()).toEqual(["codex"]));
  });

  it("chooses and reuses a Codex working directory when launching", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    localStorage.setItem("yuanheng-switch-last-app", "codex");
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["gpt-5.6"],
    });
    setYuanhengToolStatus("codex", {
      configured: true,
      model: "gpt-5.6",
      recommendedModel: "gpt-5.6",
    });

    const { default: App } = await import("@/App");
    renderApp(App);

    await screen.findByRole("heading", { name: "工作台" });
    const directoryButton = await screen.findByRole("button", {
      name: "选择 Codex 工作目录",
    });
    expect(directoryButton).toHaveTextContent("用户主目录");

    fireEvent.click(directoryButton);
    await waitFor(() =>
      expect(directoryButton).toHaveTextContent("selected-dir"),
    );

    const focusCard = directoryButton.closest("section");
    expect(focusCard).not.toBeNull();
    fireEvent.click(
      within(focusCard!).getByRole("button", { name: "启动 Codex" }),
    );
    await waitFor(() =>
      expect(getLaunchedToolRequests()).toContainEqual({
        app: "codex",
        cwd: "/mock/selected-dir",
      }),
    );
  });

  it("chooses a separate working directory for another CLI from tool management", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["claude-sonnet"],
    });
    setYuanhengToolStatus("claude", {
      configured: true,
      model: "claude-sonnet",
      recommendedModel: "claude-sonnet",
    });

    const { default: App } = await import("@/App");
    renderApp(App);

    await screen.findByRole("heading", { name: "工作台" });
    fireEvent.click(screen.getByRole("button", { name: "工具管理" }));

    const directoryButton = await screen.findByRole("button", {
      name: "选择 Claude 工作目录",
    });
    fireEvent.click(directoryButton);
    await waitFor(() =>
      expect(directoryButton).toHaveTextContent("selected-dir"),
    );

    const toolCard = directoryButton.closest("article");
    expect(toolCard).not.toBeNull();
    fireEvent.click(
      within(toolCard!).getByRole("button", { name: "启动 Claude" }),
    );
    await waitFor(() =>
      expect(getLaunchedToolRequests()).toContainEqual({
        app: "claude",
        cwd: "/mock/selected-dir",
      }),
    );
  });

  it("applies a Codex model selection immediately for the next turn", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["gpt-5.6", "k3"],
      reasoningLevels: { k3: ["low", "medium", "high", "xhigh"] },
    });

    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByRole("heading", { name: "工作台" });
    fireEvent.click(screen.getByRole("button", { name: "工具管理" }));

    fireEvent.click(await screen.findByLabelText("Codex 模型供应商"));
    fireEvent.click(await screen.findByRole("option", { name: "月之暗面" }));
    fireEvent.click(screen.getByLabelText("Codex 分组与模型"));
    fireEvent.change(screen.getByPlaceholderText("搜索分组或模型…"), {
      target: { value: "k3" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /^default / }));
    fireEvent.click(await screen.findByRole("option", { name: "k3" }));

    await waitFor(() => expect(getConfiguredToolCalls()).toEqual([["codex"]]));
    expect(getConfiguredToolReasoningCalls()).toEqual([{ codex: "auto" }]);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Codex 已切换到 k3，下一条消息生效",
    );
  });

  it("shows when connected Codex terminals are waiting for the next message", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    localStorage.setItem("yuanheng-switch-last-app", "codex");
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["k3"],
      account: {
        username: "tester",
        displayName: "Tester",
        group: "auto",
        remainingUsd: 12.47,
        usedUsd: 7.53,
      },
    });
    setYuanhengToolStatus("codex", {
      configured: true,
      model: "k3",
    });
    server.use(
      http.post("http://tauri.local/get_codex_session_bridge_status", () =>
        HttpResponse.json({
          running: true,
          endpoint: "ws://127.0.0.1:63536",
          connectedTerminals: 1,
          appliedTerminals: 0,
          pendingTerminals: 1,
          model: "k3",
          reasoningEffort: "high",
        }),
      ),
    );

    const { default: App } = await import("@/App");
    renderApp(App);

    expect(
      await screen.findByText("待 1 个终端下一条消息应用"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "快捷控制台" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "启动 Codex" })).toHaveLength(
      1,
    );
    // 首页模块：当前工具卡、今日统计带
    expect(screen.getByText("当前工具")).toBeInTheDocument();
    expect(screen.queryByText("快捷切换")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "选择当前工具" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/模型供应商$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/分组与模型$/)).toBeInTheDocument();
    expect(screen.getByText("今日请求")).toBeInTheDocument();
    expect(screen.getByText("缓存命中率")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText("12.5 万")).toBeInTheDocument();
    expect(screen.getByText("≈ ⚡️3.45")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("keeps OpenClaw as the home focus tool", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    localStorage.setItem("yuanheng-switch-last-app", "openclaw");
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["gpt-5.6"],
    });

    const { default: App } = await import("@/App");
    renderApp(App);

    const currentTool = await screen.findByText("当前工具");
    expect(currentTool.parentElement).toHaveTextContent("OpenClaw");
    expect(currentTool.parentElement).not.toHaveTextContent("Claude");
  });

  it("summarizes HTML announcements instead of rendering CSS source", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      announcement:
        "<style>*{box-sizing:border-box}.notice{color:red}</style><div><h1>平台公告</h1><p>内部测试与加群福利。</p></div>",
    });

    const { default: App } = await import("@/App");
    renderApp(App);

    expect(
      await screen.findByRole("button", { name: /公告中心/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("平台公告 · 内部测试与加群福利。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/box-sizing/)).not.toBeInTheDocument();
  });

  it("updates token group and reasoning directly from the workspace", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    localStorage.setItem("yuanheng-switch-last-app", "codex");
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["gpt-5.6-sol"],
      groups: [
        { id: "svip", description: "SVIP", ratio: 0.5 },
        { id: "vip", description: "VIP", ratio: 0.8 },
      ],
      modelGroups: { "gpt-5.6-sol": ["svip", "vip"] },
      reasoningLevels: {
        "gpt-5.6-sol": ["low", "medium", "high"],
      },
    });
    setYuanhengToolStatus("codex", {
      configured: true,
      model: "gpt-5.6-sol",
      group: "svip",
      reasoning: "medium",
    });

    const { default: App } = await import("@/App");
    renderApp(App);

    const groupPicker = await screen.findByLabelText("Codex 分组与模型");
    const reasoningPicker = await screen.findByLabelText("Codex 推理等级");

    fireEvent.click(groupPicker);
    const callsBeforeFavorite = getConfiguredToolGroupCalls().length;
    const groupBeforeFavorite = groupPicker.textContent;
    fireEvent.click(
      await screen.findByRole("button", { name: /^(取消)?收藏分组 vip$/ }),
    );
    expect(getConfiguredToolGroupCalls()).toHaveLength(callsBeforeFavorite);
    expect(groupPicker.textContent).toBe(groupBeforeFavorite);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("option", { name: /^vip 0.8x/ }));
    fireEvent.click(screen.getByRole("option", { name: "gpt-5.6-sol" }));
    await waitFor(() =>
      expect(getConfiguredToolGroupCalls()).toContainEqual({ codex: "vip" }),
    );

    await waitFor(() => expect(reasoningPicker).toBeEnabled());
    fireEvent.click(reasoningPicker);
    fireEvent.click(await screen.findByRole("option", { name: "高" }));
    await waitFor(() =>
      expect(getConfiguredToolReasoningCalls()).toContainEqual({
        codex: "high",
      }),
    );
  });

  it("filters the current tool models by provider before switching", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    localStorage.setItem("yuanheng-switch-last-app", "codex");
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["claude-sonnet-5", "gpt-5.6"],
      groups: [
        { id: "svip", description: "SVIP", ratio: 0.5 },
        { id: "vip", description: "VIP", ratio: 0.8 },
      ],
      modelGroups: {
        "claude-sonnet-5": ["svip", "vip"],
        "gpt-5.6": ["svip", "vip"],
      },
    });
    setYuanhengToolStatus("codex", {
      configured: true,
      model: "gpt-5.6",
      group: "svip",
    });

    const { default: App } = await import("@/App");
    renderApp(App);

    const vendorPicker = await screen.findByLabelText("Codex 模型供应商");
    expect(vendorPicker.tagName).toBe("BUTTON");
    expect(vendorPicker).toHaveTextContent("OpenAI");
    fireEvent.click(vendorPicker);
    fireEvent.click(await screen.findByRole("option", { name: /^Anthropic$/ }));

    const modelPicker = await screen.findByLabelText("Codex 分组与模型");
    fireEvent.click(modelPicker);
    fireEvent.click(await screen.findByRole("option", { name: /^svip / }));
    fireEvent.click(
      await screen.findByRole("option", { name: /claude-sonnet-5/ }),
    );

    await waitFor(() =>
      expect(getConfiguredToolCalls()).toContainEqual(["codex"]),
    );
    const groupPicker = await screen.findByLabelText("Codex 分组与模型");
    expect(groupPicker.tagName).toBe("BUTTON");
    fireEvent.click(groupPicker);
    const callsBeforeFavorite = getConfiguredToolGroupCalls().length;
    const groupBeforeFavorite = groupPicker.textContent;
    fireEvent.click(
      await screen.findByRole("button", { name: /^(取消)?收藏分组 vip$/ }),
    );
    expect(getConfiguredToolGroupCalls()).toHaveLength(callsBeforeFavorite);
    expect(groupPicker.textContent).toBe(groupBeforeFavorite);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("option", { name: /^vip 0.8x/ }));
    fireEvent.click(screen.getByRole("option", { name: "claude-sonnet-5" }));
    await waitFor(() =>
      expect(getConfiguredToolGroupCalls()).toContainEqual({ codex: "vip" }),
    );
  });

  it("offers the Claude Desktop download when the app is not installed", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    let openedUrl = "";
    server.use(
      http.post(
        "http://tauri.local/get_installed_tool_versions",
        async ({ request }) => {
          const { tools = [] } = (await request.json()) as { tools?: string[] };
          return HttpResponse.json(
            tools.map((name) => ({
              name,
              version: name === "claude-desktop" ? null : "1.0.0",
              latest_version: null,
              error: name === "claude-desktop" ? "not installed" : null,
              installed_but_broken: false,
              env_type: "macos",
              wsl_distro: null,
            })),
          );
        },
      ),
      http.post("http://tauri.local/open_external", async ({ request }) => {
        const { url } = (await request.json()) as { url: string };
        openedUrl = url;
        return HttpResponse.json(true);
      }),
    );

    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByRole("heading", { name: "工作台" });
    fireEvent.click(screen.getByRole("button", { name: "工具管理" }));

    const title = await screen.findByRole("heading", {
      name: "Claude Desktop",
    });
    const card = title.closest("article");
    expect(card).not.toBeNull();
    expect(
      within(card!).queryByLabelText("Claude Desktop 分组与模型"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(card!).getByRole("button", {
        name: "打开 Claude Desktop 官方下载页",
      }),
    );
    await waitFor(() => expect(openedUrl).toBe("https://claude.ai/download"));
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "已打开 Claude Desktop 官方下载页，安装完成后请刷新检测",
    );
  });

  it.each(["tools", "home"] as const)(
    "installs and configures DSH from %s before launching its local Web UI",
    async (entry) => {
      localStorage.setItem("yuanheng-switch-last-app", "dsh");
      setSettings({ firstRunNoticeConfirmed: true });
      setYuanhengConnection({ connected: true, models: ["gpt-5.6"] });
      setYuanhengToolStatus("dsh", {
        supported: true,
        configured: false,
        recommendedModel: "gpt-5.6",
      });
      let installed = false;
      server.use(
        http.post("http://tauri.local/native_tool_install_supported", () =>
          HttpResponse.json(true),
        ),
        http.post(
          "http://tauri.local/run_tool_lifecycle_action",
          async ({ request }) => {
            const payload = (await request.json()) as {
              tools: string[];
              action: string;
            };
            expect(payload.tools).toEqual(["dsh"]);
            expect(payload.action).toBe("install");
            expect(getConfiguredToolCalls()).toHaveLength(0);
            installed = true;
            return HttpResponse.json(null);
          },
        ),
        http.post(
          "http://tauri.local/get_installed_tool_versions",
          async ({ request }) => {
            const { tools = [] } = (await request.json()) as {
              tools: string[];
            };
            return HttpResponse.json(
              tools.map((name) => ({
                name,
                version: name === "dsh" && !installed ? null : "0.2.0-rc.2",
                latest_version: null,
                error: null,
                installed_but_broken: false,
                env_type: "macos",
                wsl_distro: null,
              })),
            );
          },
        ),
      );
      const { default: App } = await import("@/App");
      renderApp(App);
      await screen.findByRole("heading", { name: "工作台" });
      if (entry === "tools") {
        fireEvent.click(screen.getByRole("button", { name: "工具管理" }));
      }
      fireEvent.click(
        await screen.findByRole("button", { name: "一键安装 DSH" }),
      );
      expect(
        screen.getByRole("heading", {
          name: entry === "home" ? "工作台" : "工具管理",
        }),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(getConfiguredToolCalls()).toContainEqual(["dsh"]),
      );
      await waitFor(() => expect(getLaunchedToolCalls()).toContain("dsh"));
      expect(toastErrorMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["chatgpt-desktop", "Codex Desktop"],
    ["workbuddy", "WorkBuddy"],
    ["dsh", "DSH"],
  ] as const)(
    "selects and restores %s from the current tool card",
    async (app, label) => {
      setSettings({ firstRunNoticeConfirmed: true });
      setYuanhengConnection({ connected: true, models: ["gpt-5.6"] });
      setYuanhengToolStatus(app, {
        supported: true,
        configured: true,
        model: "gpt-5.6",
      });
      const { default: App } = await import("@/App");
      const first = renderApp(App);
      await screen.findByRole("heading", { name: "工作台" });
      await screen.findByRole("button", { name: "启动 Claude" });
      fireEvent.click(screen.getByRole("combobox", { name: "选择当前工具" }));
      fireEvent.click(await screen.findByRole("option", { name: label }));
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "选择当前工具" }),
        ).toHaveTextContent(label),
      );
      expect(localStorage.getItem("yuanheng-switch-last-app")).toBe(app);
      expect(
        (await screen.findAllByRole("button", { name: `启动 ${label}` }))[0],
      ).toBeInTheDocument();
      if (app === "workbuddy")
        expect(screen.getAllByRole("img", { name: label })[0]).toHaveAttribute(
          "src",
          expect.stringContaining("workbuddy.jpg"),
        );
      first.unmount();
      renderApp(App);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "选择当前工具" }),
        ).toHaveTextContent(label),
      );
      expect(
        (await screen.findAllByRole("button", { name: `启动 ${label}` }))[0],
      ).toBeInTheDocument();
    },
  );

  it("keeps an unavailable selected desktop tool instead of configuring another tool", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({ connected: true, models: ["gpt-5.6"] });
    setYuanhengToolStatus("claude", {
      supported: true,
      configured: true,
      model: "gpt-5.6",
    });
    setYuanhengToolStatus("workbuddy", { supported: false });
    localStorage.setItem("yuanheng-switch-last-app", "workbuddy");
    const { default: App } = await import("@/App");
    renderApp(App);
    expect(
      await screen.findByRole("heading", { name: "WorkBuddy" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开工具管理" }),
    ).toBeInTheDocument();
    expect(getConfiguredToolCalls()).toEqual([]);
  });

  it("configures Codex Desktop and WorkBuddy as desktop apps", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["gpt-5.6", "k3"],
      reasoningLevels: {
        "gpt-5.6": ["low", "medium", "high", "xhigh"],
        k3: ["minimal", "low", "medium", "high", "xhigh"],
      },
    });

    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByRole("heading", {
      name: "工作台",
    });
    fireEvent.click(screen.getByRole("button", { name: "工具管理" }));

    fireEvent.click(await screen.findByLabelText("Codex Desktop 模型供应商"));
    fireEvent.click(await screen.findByRole("option", { name: "月之暗面" }));
    fireEvent.click(screen.getByLabelText("Codex Desktop 分组与模型"));
    fireEvent.change(screen.getByPlaceholderText("搜索分组或模型…"), {
      target: { value: "k3" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /^default / }));
    fireEvent.click(await screen.findByRole("option", { name: "k3" }));
    expect(screen.getByLabelText("Codex Desktop 分组与模型")).toHaveTextContent(
      "k3",
    );

    fireEvent.click(screen.getByRole("button", { name: "配置 Codex Desktop" }));
    await waitFor(() =>
      expect(getConfiguredToolCalls()).toEqual([["chatgpt-desktop"]]),
    );
    fireEvent.click(screen.getByRole("button", { name: "启动 Codex Desktop" }));
    await waitFor(() =>
      expect(getRestartedToolCalls()).toEqual(["chatgpt-desktop"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "配置 WorkBuddy" }));
    await waitFor(() =>
      expect(getConfiguredToolCalls()).toEqual([
        ["chatgpt-desktop"],
        ["workbuddy"],
      ]),
    );
  });

  it.each(["home", "tools"] as const)(
    "selects a DSH Grok group/model pair without carrying over the enterprise group in %s",
    async (entry) => {
      setSettings({ firstRunNoticeConfirmed: true });
      localStorage.setItem("yuanheng-switch-last-app", "dsh");
      setYuanhengConnection({
        connected: true,
        userId: "1024",
        models: ["deepseek-flash", "grok-4.7"],
        groups: [
          { id: "企业专属", description: "", ratio: 1 },
          { id: "Grok 标准", description: "", ratio: 0.25 },
        ],
        modelGroups: {
          "deepseek-flash": ["企业专属"],
          "grok-4.7": ["Grok 标准"],
        },
      });
      setYuanhengToolStatus("dsh", {
        supported: true,
        configured: true,
        model: "deepseek-flash",
        group: "企业专属",
      });
      const { default: App } = await import("@/App");
      renderApp(App);
      await screen.findByRole("heading", { name: "工作台" });
      if (entry === "tools")
        fireEvent.click(screen.getByRole("button", { name: "工具管理" }));
      fireEvent.click(await screen.findByLabelText("DSH 模型供应商"));
      fireEvent.click(await screen.findByRole("option", { name: "xAI" }));
      fireEvent.click(screen.getByLabelText("DSH 分组与模型"));
      expect(
        screen.queryByRole("option", { name: /企业专属/ }),
      ).not.toBeInTheDocument();
      fireEvent.click(
        await screen.findByRole("option", { name: /^Grok 标准 / }),
      );
      expect(getConfiguredToolCalls()).toHaveLength(0);
      fireEvent.click(screen.getByRole("option", { name: "grok-4.7" }));
      if (entry === "tools") {
        expect(getConfiguredToolCalls()).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: "配置 DSH" }));
      }
      await waitFor(() =>
        expect(getConfiguredToolGroupCalls()).toEqual([{ dsh: "Grok 标准" }]),
      );
      expect(getConfiguredToolCalls()).toEqual([["dsh"]]);
    },
  );

  it("configures DSH before launching its local Web surface", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({ connected: true, models: ["gpt-5.6"] });
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByRole("heading", { name: "工作台" });
    fireEvent.click(screen.getByRole("button", { name: "工具管理" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "启动 DSH Web" }),
    );
    await waitFor(() => expect(getConfiguredToolCalls()).toEqual([["dsh"]]));
    await waitFor(() => expect(getLaunchedToolCalls()).toContain("dsh-web"));
  });

  it("searches the live model catalog and launches Claude with the selection", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["claude-sonnet-4-6", "deepseek-v3.2", "gpt-5.6"],
    });

    const { default: App } = await import("@/App");
    renderApp(App);

    await screen.findByRole("heading", {
      name: "工作台",
    });
    fireEvent.click(screen.getByRole("button", { name: "工具管理" }));
    await screen.findByRole("heading", { name: "工具管理" });

    fireEvent.click(await screen.findByLabelText("Claude 模型供应商"));
    fireEvent.click(await screen.findByRole("option", { name: "DeepSeek" }));
    fireEvent.click(screen.getByLabelText("Claude 分组与模型"));
    fireEvent.change(screen.getByPlaceholderText("搜索分组或模型…"), {
      target: { value: "deepseek" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /^default / }));
    fireEvent.click(
      await screen.findByRole("option", { name: "deepseek-v3.2" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "启动 Claude" }));

    await waitFor(() => expect(getConfiguredToolCalls()).toEqual([["claude"]]));
    await waitFor(() => expect(getLaunchedToolCalls()).toEqual(["claude"]));
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Claude 已使用 deepseek-v3.2 启动",
    );
  });

  it("maps non-Claude website models into Claude Desktop", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["deepseek-v4-pro", "gpt-5.4", "k3"],
      reasoningLevels: {
        "deepseek-v4-pro": [],
        "gpt-5.4": ["low", "medium", "high", "xhigh"],
        k3: ["minimal", "low", "medium", "high", "xhigh"],
      },
    });

    const { default: App } = await import("@/App");
    renderApp(App);

    await screen.findByRole("heading", {
      name: "工作台",
    });
    fireEvent.click(screen.getByRole("button", { name: "工具管理" }));
    fireEvent.click(await screen.findByLabelText("Claude Desktop 模型供应商"));
    fireEvent.click(await screen.findByRole("option", { name: "月之暗面" }));
    fireEvent.click(screen.getByLabelText("Claude Desktop 分组与模型"));
    fireEvent.change(screen.getByPlaceholderText("搜索分组或模型…"), {
      target: { value: "k3" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /^default / }));
    fireEvent.click(await screen.findByRole("option", { name: "k3" }));
    const reasoningPicker = screen.getByLabelText("Claude Desktop 推理等级");
    fireEvent.click(reasoningPicker);
    expect(await screen.findByRole("option", { name: "极简" })).toBeVisible();
    expect(screen.getByRole("option", { name: "超高" })).toBeVisible();
    fireEvent.click(screen.getByRole("option", { name: "高" }));
    fireEvent.click(
      screen.getByRole("button", { name: "配置 Claude Desktop" }),
    );

    await waitFor(() =>
      expect(getConfiguredToolCalls()).toEqual([["claude-desktop"]]),
    );
    expect(getConfiguredToolReasoningCalls()).toEqual([
      { "claude-desktop": "high" },
    ]);
    expect(getRestartedToolCalls()).toEqual([]);

    fireEvent.click(
      screen.getByRole("button", { name: "启动 Claude Desktop" }),
    );
    await waitFor(() =>
      expect(getRestartedToolCalls()).toEqual(["claude-desktop"]),
    );
  });

  it("selects a token group for models outside the default group", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      account: {
        username: "nanashi",
        displayName: "Nana",
        group: "default",
        remainingUsd: 100,
        usedUsd: 10,
      },
      models: ["gpt-5.6-sol"],
      groups: [
        { id: "svip", description: "SVIP", ratio: 0.5 },
        { id: "vip", description: "VIP", ratio: 0.5 },
      ],
      modelGroups: { "gpt-5.6-sol": ["svip", "vip"] },
    });

    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByRole("heading", {
      name: "工作台",
    });
    fireEvent.click(screen.getByRole("button", { name: "工具管理" }));

    const groupPicker = await screen.findByLabelText("Claude 分组与模型");
    expect(screen.getByLabelText("Claude 分组与模型")).toHaveTextContent(
      "gpt-5.6-sol",
    );
    fireEvent.click(groupPicker);
    const callsBeforeFavorite = getConfiguredToolGroupCalls().length;
    const groupBeforeFavorite = groupPicker.textContent;
    fireEvent.click(
      await screen.findByRole("button", { name: /^(取消)?收藏分组 vip$/ }),
    );
    expect(getConfiguredToolGroupCalls()).toHaveLength(callsBeforeFavorite);
    expect(groupPicker.textContent).toBe(groupBeforeFavorite);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("option", { name: /^vip 0.5x/ }));
    fireEvent.click(screen.getByRole("option", { name: "gpt-5.6-sol" }));
    fireEvent.click(screen.getByRole("button", { name: "配置 Claude" }));

    await waitFor(() =>
      expect(getConfiguredToolGroupCalls()).toContainEqual({ claude: "vip" }),
    );
  });

  it("shows stalled Claude Desktop download details and opens the app", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    setYuanhengConnection({
      connected: true,
      userId: "1024",
      models: ["claude-sonnet-4-6"],
    });
    setYuanhengToolStatus("claude-desktop", {
      runtimeStatus: {
        state: "stalled",
        title: "Claude 组件下载已停滞",
        message:
          "当前已下载 13.1 MB。打开 Claude Desktop 可继续下载；如仍无变化，请检查网络。",
        downloadedBytes: 13_770_104,
        updatedAt: 1_722_000_000,
      },
    });

    const { default: App } = await import("@/App");
    renderApp(App);

    await screen.findByRole("heading", {
      name: "工作台",
    });
    fireEvent.click(screen.getByRole("button", { name: "工具管理" }));
    expect(
      await screen.findByText("Claude 组件下载已停滞"),
    ).toBeInTheDocument();
    expect(screen.getByText(/当前已下载 13.1 MB/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "打开 Claude Desktop" }),
    );
    await waitFor(() =>
      expect(getLaunchedToolCalls()).toContain("claude-desktop"),
    );
  });

  it("rejects legacy provider deep links without opening an import dialog", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByRole("heading", {
      name: "工作台",
    });

    emitTauriEvent("deeplink-import", {
      version: "v1",
      resource: "provider",
      app: "claude",
      name: "Legacy Provider",
    });

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "deeplink.providerImportRemoved",
        expect.objectContaining({
          description: "deeplink.providerImportRemovedDescription",
        }),
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
