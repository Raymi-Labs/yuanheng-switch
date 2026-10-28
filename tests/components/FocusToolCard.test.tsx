import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { runToolLifecycleJob } from "@/lib/toolLifecycleState";
import { FocusToolCard } from "@/components/desktop/FocusToolCard";
import type {
  ModelSwitchBootstrapPhase,
  ModelSwitchCenterState,
} from "@/components/desktop/useModelSwitchCenter";

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

function createSwitcher(
  bootstrapPhase: ModelSwitchBootstrapPhase,
  retryBootstrap = vi.fn().mockResolvedValue(undefined),
): ModelSwitchCenterState {
  return {
    connection: {
      connected: true,
      baseUrl: "https://cn.meta-api.vip",
      userId: "1024",
      account: null,
      models: [],
      groups: [],
      modelGroups: {},
      reasoningLevels: {},
      announcement: null,
      lastSyncedAt: null,
    },
    terminalModels: [],
    modelMeta: {},
    bootstrapPhase,
    bootstrapRefreshing: false,
    inventoryRefreshFailed: false,
    retryBootstrap,
    rows: [],
    runnableRows: [],
    installedApps: new Set(),
    downloadDialog: <></>,
    models: {},
    groups: {},
    reasoning: {},
    pendingApps: new Set(),
    installingApps: new Set(),
    restartRequiredApps: new Set(),
    launchDirectories: {},
    launchDirectoryPendingApps: new Set(),
    statusMap: new Map(),
    activationMap: new Map(),
    activationRefreshing: false,
    preflightResults: {},
    preflightPending: false,
    codexBridge: {} as ModelSwitchCenterState["codexBridge"],
    codexAccountMode: {
      data: {
        mode: "unknown",
        officialLoginAvailable: false,
        yuanhengAvailable: false,
        restartRequired: false,
        message: null,
      },
    } as ModelSwitchCenterState["codexAccountMode"],
    codexModePending: false,
    refreshModels: vi.fn(),
    install: vi.fn(),
    chooseDesktopPath: vi.fn(),
    applyModel: vi.fn(),
    applyModelGroup: vi.fn(),
    applyGroup: vi.fn(),
    applyReasoning: vi.fn(),
    switchCodexMode: vi.fn(),
    chooseLaunchDirectory: vi.fn(),
    launch: vi.fn(),
  };
}

describe("FocusToolCard", () => {
  it.each(["loading", "error", "ready"] as const)(
    "%s 状态仍能切换当前工具",
    async (phase) => {
      const onToolChange = vi.fn();
      render(
        <FocusToolCard
          switcher={createSwitcher(phase)}
          focusApp="claude"
          availableTools={["claude", "codex"]}
          onToolChange={onToolChange}
          onOpenTools={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("combobox", { name: "选择当前工具" }));
      fireEvent.click(await screen.findByRole("option", { name: "Codex" }));
      expect(onToolChange).toHaveBeenCalledWith("codex");
    },
  );

  it("加载期间保留焦点卡位置且不显示未安装结论", () => {
    render(
      <FocusToolCard
        switcher={createSwitcher("loading")}
        onOpenTools={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("正在检测本机工具")).toBeInTheDocument();
    expect(
      screen.queryByText("尚未检测到已安装的 AI 工具"),
    ).not.toBeInTheDocument();
  });

  it("没有可运行工具时显示安装引导", () => {
    const switcher = createSwitcher("ready");
    const onOpenTools = vi.fn();
    render(<FocusToolCard switcher={switcher} onOpenTools={onOpenTools} />);

    expect(screen.getByText("尚未检测到已安装的 AI 工具")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    expect(switcher.retryBootstrap).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "打开工具管理" }));
    expect(onOpenTools).toHaveBeenCalledTimes(1);
  });

  it.each(["dsh", "codex", "claude"] as const)(
    "直接安装选中的 %s，不跳转工具管理",
    (app) => {
      const switcher = createSwitcher("ready");
      const onOpenTools = vi.fn();
      render(
        <FocusToolCard
          switcher={switcher}
          focusApp={app}
          onOpenTools={onOpenTools}
        />,
      );
      fireEvent.click(
        screen.getByText(app === "dsh" ? "官方下载" : "安装与配置"),
      );
      expect(switcher.install).toHaveBeenCalledWith(app);
      expect(onOpenTools).not.toHaveBeenCalled();
    },
  );

  it("桌面工具明确显示官方下载入口并复用安装观察", () => {
    const switcher = createSwitcher("ready");
    render(
      <FocusToolCard
        switcher={switcher}
        focusApp="workbuddy"
        onOpenTools={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "打开 WorkBuddy 官方下载页" }),
    );
    expect(switcher.install).toHaveBeenCalledWith("workbuddy");
  });

  it.each(["installed", "error", "stale"])("%s 状态不触发重复安装", (state) => {
    const switcher = createSwitcher(state === "error" ? "error" : "ready");
    if (state === "installed") switcher.installedApps.add("dsh");
    if (state === "stale") switcher.inventoryRefreshFailed = true;
    const onOpenTools = vi.fn();
    render(
      <FocusToolCard
        switcher={switcher}
        focusApp="dsh"
        onOpenTools={onOpenTools}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开工具管理" }));
    expect(switcher.install).not.toHaveBeenCalled();
    expect(onOpenTools).toHaveBeenCalledOnce();
  });

  it("共享安装任务状态，阻止重复点击并支持取消、验证及失败后重试", async () => {
    const switcher = createSwitcher("ready");
    render(
      <FocusToolCard
        switcher={switcher}
        focusApp="dsh"
        onOpenTools={vi.fn()}
      />,
    );
    let finish!: () => void;
    let verify!: () => void;
    const cancel = vi.fn().mockResolvedValue(true);
    let job!: Promise<void>;
    act(() => {
      job = runToolLifecycleJob(
        ["dsh"],
        "install",
        (setCancel) => {
          setCancel(cancel);
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        () =>
          new Promise((resolve) => {
            verify = resolve;
          }),
      );
    });
    expect(
      screen.getByRole("button", { name: "正在安装，请稍候…" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新检测" })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消安装" }));
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      screen
        .getAllByRole("button", { name: "正在停止安装…" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    await act(async () => {
      finish();
    });
    expect(
      screen.getByRole("button", { name: "正在验证安装…" }),
    ).toBeDisabled();
    await act(async () => {
      verify();
      await job;
    });
    fireEvent.click(
      screen.getByRole("button", { name: "打开 DSH 官方下载页" }),
    );
    expect(switcher.install).toHaveBeenCalledOnce();
  });

  it("检测失败时提供重试而不是显示未安装", () => {
    const retryBootstrap = vi.fn().mockResolvedValue(undefined);
    render(
      <FocusToolCard
        switcher={createSwitcher("error", retryBootstrap)}
        onOpenTools={vi.fn()}
      />,
    );

    expect(screen.getByText("本机工具检测失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    expect(retryBootstrap).toHaveBeenCalledTimes(1);
  });

  it("为非 Codex CLI 提供独立工作目录入口", () => {
    const switcher = createSwitcher("ready");
    switcher.rows = ["claude"];
    switcher.runnableRows = ["claude"];
    switcher.installedApps = new Set(["claude"]);
    switcher.models = { claude: "claude-sonnet" };
    switcher.launchDirectories = { claude: "/tmp/claude-project" };
    switcher.statusMap = new Map([
      [
        "claude",
        {
          app: "claude",
          supported: true,
          configured: true,
          needsUpdate: false,
          model: "claude-sonnet",
          recommendedModel: "claude-sonnet",
          message: null,
        },
      ],
    ]);

    render(<FocusToolCard switcher={switcher} onOpenTools={vi.fn()} />);

    const directoryButton = screen.getByRole("button", {
      name: "选择 Claude 工作目录",
    });
    expect(directoryButton).toHaveTextContent("claude-project");
    fireEvent.click(directoryButton);
    expect(switcher.chooseLaunchDirectory).toHaveBeenCalledWith("claude");
  });

  it("官方模式隐藏元衡模型控件并允许切回中转", () => {
    const switcher = createSwitcher("ready");
    switcher.rows = ["codex"];
    switcher.runnableRows = ["codex"];
    switcher.installedApps = new Set(["codex"]);
    switcher.models = { codex: "gpt-5.6" };
    switcher.connection!.reasoningLevels = { "gpt-5.6": ["high"] };
    switcher.codexAccountMode = {
      data: {
        mode: "official",
        officialLoginAvailable: true,
        yuanhengAvailable: true,
        restartRequired: false,
        message: null,
      },
    } as ModelSwitchCenterState["codexAccountMode"];

    render(<FocusToolCard switcher={switcher} onOpenTools={vi.fn()} />);

    expect(screen.getByText("OpenAI 官方账号")).toBeInTheDocument();
    expect(screen.queryByText("1 · 模型供应商")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Codex 推理等级")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "元衡中转" }));
    expect(switcher.switchCodexMode).toHaveBeenCalledWith("yuanheng");
  });

  it("保留旧快照提示，检测期间禁止再次点击且仍显示当前工具", () => {
    const switcher = createSwitcher("ready");
    switcher.runnableRows = ["codex"];
    switcher.inventoryRefreshFailed = true;
    switcher.bootstrapRefreshing = true;
    const { rerender } = render(
      <FocusToolCard switcher={switcher} onOpenTools={vi.fn()} />,
    );
    expect(screen.getByText("当前工具")).toBeVisible();
    expect(screen.getByText(/仍显示上次本机快照/)).toBeVisible();
    const retry = screen.getByRole("button", { name: "重新检测" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(switcher.retryBootstrap).not.toHaveBeenCalled();
    switcher.bootstrapRefreshing = false;
    rerender(<FocusToolCard switcher={switcher} onOpenTools={vi.fn()} />);
    fireEvent.click(retry);
    expect(switcher.retryBootstrap).toHaveBeenCalledTimes(1);
  });
});
