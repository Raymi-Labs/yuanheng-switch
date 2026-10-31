import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { YuanhengConnectionStatus, YuanhengToolStatus } from "@/lib/api";
import { ToolSetupGrid } from "@/components/desktop/ToolSetupGrid";
import { CompactSelectPicker } from "@/components/desktop/CompactSelectPicker";
import {
  pickPreferredGroup,
  resolveToolSetupSelection,
} from "@/components/desktop/toolSetupSelection";

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

const mocks = vi.hoisted(() => ({
  connection: undefined as YuanhengConnectionStatus | undefined,
  statuses: undefined as YuanhengToolStatus[] | undefined,
  configure: vi.fn(),
  preflight: vi.fn(),
  launch: vi.fn(),
  error: vi.fn(),
  changed: vi.fn(),
}));
vi.mock("@/lib/query/yuanheng", () => ({
  useYuanhengConnection: () => ({ data: mocks.connection }),
  useYuanhengToolStatuses: () => ({ data: mocks.statuses, refetch: vi.fn() }),
  useYuanhengToolActivationStatuses: () => ({ data: [], refetch: vi.fn() }),
  useConfigureYuanhengTools: () => ({
    mutateAsync: mocks.configure,
    isPending: false,
  }),
  usePreflightYuanhengTool: () => ({ mutateAsync: mocks.preflight }),
  useRefreshYuanheng: () => ({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  }),
  useCodexAccountMode: () => ({ data: { mode: "yuanheng" } }),
}));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return {
    ...actual,
    yuanhengApi: { ...actual.yuanhengApi, launchTool: mocks.launch },
  };
});
vi.mock("@/lib/query/toolInventory", () => ({
  useToolInventory: () => ({
    data: [
      "claude",
      "codex",
      "gemini",
      "chatgpt-desktop",
      "grok",
      "accio-work",
    ].map((name) => ({ name, version: "test" })),
    refetch: vi.fn(),
  }),
}));
vi.mock("@/components/desktop/AccioReleaseNotice", () => ({
  AccioReleaseNotice: () => <p>official version</p>,
}));
vi.mock("@/components/desktop/useDesktopInstallFlow", () => ({
  useDesktopInstallFlow: () => ({
    monitoringApps: new Set(),
    stop: vi.fn(),
    stopAll: vi.fn(),
  }),
}));
vi.mock("@/components/desktop/useToolLaunchDirectories", () => ({
  useToolLaunchDirectories: () => ({ directories: {}, pendingApps: new Set() }),
  launchDirectoryLabel: () => "",
}));
vi.mock("@/components/desktop/desktopI18n", () => ({
  dt: (key: string, values: Record<string, unknown> = {}) =>
    key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? "")),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: mocks.error, info: vi.fn() },
}));

const status = (
  app: YuanhengToolStatus["app"],
  group = "premium",
): YuanhengToolStatus => ({
  app,
  group,
  model: "model-a",
  recommendedModel: "model-a",
  configured: true,
  supported: true,
  needsUpdate: false,
  reasoning: "auto",
  message: null,
});
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.connection = {
    connected: true,
    userId: "test-user",
    baseUrl: "https://example.test",
    account: null,
    models: ["model-a", "model-b"],
    groups: [
      { id: "cheap", description: "", ratio: 0.1 },
      { id: "premium", description: "", ratio: 1 },
    ],
    modelGroups: {
      "model-a": ["cheap", "premium"],
      "model-b": ["cheap", "premium"],
    },
    reasoningLevels: {},
    announcement: null,
    lastSyncedAt: 1,
  };
  mocks.statuses = [
    status("claude"),
    status("codex", "cheap"),
    status("gemini"),
  ];
  mocks.preflight.mockResolvedValue({
    status: "ok",
    checks: [],
    requiresConfiguration: false,
  });
  mocks.configure.mockImplementation(async ({ apps, models, groups }: any) => {
    mocks.statuses = mocks.statuses!.map((row) =>
      apps.includes(row.app)
        ? { ...row, group: groups[row.app], model: models[row.app] }
        : row,
    );
    return apps.map((app: string) => ({
      app,
      configured: true,
      model: models[app],
    }));
  });
  mocks.launch.mockResolvedValue(undefined);
});
const chooseGroup = async (
  app = "Claude",
  name = "cheap",
  model = "model-a",
) => {
  fireEvent.click(screen.getByLabelText(`${app} 分组与模型`));
  fireEvent.click(
    await screen.findByRole("option", { name: new RegExp(`^${name} `) }),
  );
  expect(mocks.configure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("option", { name: model }));
};

describe("tool group restoration", () => {
  it("blocks unknown Accio in individual and batch controls", () => {
    mocks.statuses = [
      ...mocks.statuses!,
      {
        ...status("accio-work"),
        accioCompatibility: {
          installedVersion: "99.0.0",
          supportedVersions: ["0.37.1"],
          state: "unverified_version",
        },
      },
    ];
    render(<ToolSetupGrid />);
    expect(screen.getByRole("button", { name: /配置 Accio/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /启动 Accio/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /选择 Accio/ })).toBeDisabled();
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("shows unsupported Accio without offering configuration, installation or launch", () => {
    mocks.statuses = [
      ...mocks.statuses!,
      { ...status("accio-work"), supported: false, configured: false },
    ];
    render(<ToolSetupGrid />);
    expect(
      screen.getByRole("heading", { name: "Accio Work（实验性）" }),
    ).toBeVisible();
    expect(screen.getByText(/暂不支持元衡配置和启动/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /启动 Accio/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /配置 Accio/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Accio.*官方下载/ }),
    ).not.toBeInTheDocument();
  });
  it("TRAE uses the shared picker without entering managed batch configuration", async () => {
    mocks.connection = {
      ...mocks.connection!,
      baseUrl: "https://meta-api.vip",
    };
    render(<ToolSetupGrid />);
    const assisted = screen.getByRole("button", { name: "TRAE 辅助配置" });
    const traeCard = assisted.closest("article");
    const workbuddyCard = screen
      .getByRole("heading", { name: "WorkBuddy" })
      .closest("article");
    expect(traeCard).not.toBeNull();
    expect(workbuddyCard).not.toBeNull();
    expect(traeCard?.parentElement).toBe(workbuddyCard?.parentElement);
    expect(workbuddyCard?.nextElementSibling).toBe(traeCard);
    expect(
      screen.queryByRole("button", { name: "选择 TRAE" }),
    ).not.toBeInTheDocument();
    fireEvent.click(assisted);
    await chooseGroup("TRAE", "premium", "model-a");
    expect(
      screen.getByText("https://meta-api.vip/v1/chat/completions"),
    ).toBeInTheDocument();
    expect(screen.getByText(/所选分组：premium/)).toBeInTheDocument();
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("restores independent saved groups and launch does not overwrite them", async () => {
    render(<ToolSetupGrid />);
    expect(screen.getByLabelText("Claude 分组与模型")).toHaveTextContent(
      "premium",
    );
    expect(screen.getByLabelText("Codex 分组与模型")).toHaveTextContent(
      "cheap",
    );
    expect(screen.getByLabelText("Gemini 分组与模型")).toHaveTextContent(
      "premium",
    );
    fireEvent.click(screen.getByLabelText("启动 Claude"));
    await waitFor(() => expect(mocks.launch).toHaveBeenCalled());
    expect(mocks.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ group: "premium" }),
    );
    expect(mocks.configure).not.toHaveBeenCalled();
  });
  it("does not initialize defaults before saved statuses arrive", async () => {
    const saved = mocks.statuses;
    mocks.statuses = undefined;
    const ui = render(<ToolSetupGrid />);
    expect(mocks.configure).not.toHaveBeenCalled();
    mocks.statuses = saved;
    ui.rerender(<ToolSetupGrid />);
    expect(await screen.findByLabelText("Claude 分组与模型")).toHaveTextContent(
      "premium",
    );
  });
  it("survives connection arriving after statuses and a page remount", () => {
    const saved = mocks.connection;
    mocks.connection = undefined;
    const ui = render(<ToolSetupGrid />);
    mocks.connection = saved;
    ui.rerender(<ToolSetupGrid />);
    expect(screen.getByLabelText("Claude 分组与模型")).toHaveTextContent(
      "premium",
    );
    ui.unmount();
    render(<ToolSetupGrid />);
    expect(screen.getByLabelText("Claude 分组与模型")).toHaveTextContent(
      "premium",
    );
  });
  it("refresh follows persisted changes but cannot overwrite a user draft", async () => {
    const ui = render(<ToolSetupGrid />);
    mocks.statuses = [status("claude", "cheap")];
    ui.rerender(<ToolSetupGrid />);
    expect(screen.getByLabelText("Claude 分组与模型")).toHaveTextContent(
      "cheap",
    );
    await chooseGroup("Claude", "premium");
    mocks.connection = { ...mocks.connection!, lastSyncedAt: 2 };
    ui.rerender(<ToolSetupGrid />);
    expect(screen.getByLabelText("Claude 分组与模型")).toHaveTextContent(
      "premium",
    );
    expect(mocks.configure).not.toHaveBeenCalled();
  });
  it("preserves group on model change and sends the same snapshot to preflight/save", async () => {
    render(<ToolSetupGrid />);
    await chooseGroup("Claude", "premium", "model-b");
    fireEvent.click(screen.getByLabelText("配置 Claude"));
    await waitFor(() =>
      expect(mocks.configure).toHaveBeenCalledWith(
        expect.objectContaining({
          models: { claude: "model-b" },
          groups: { claude: "premium" },
        }),
      ),
    );
    expect(mocks.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ model: "model-b", group: "premium" }),
    );
  });
  it("missing/partial catalog preserves original value; failed preflight never reconfigures", async () => {
    const ui = render(<ToolSetupGrid />);
    mocks.connection = {
      ...mocks.connection!,
      modelGroups: { "model-a": ["cheap"] },
    };
    mocks.preflight.mockResolvedValue({
      status: "error",
      message: "not available",
      checks: [],
    });
    ui.rerender(<ToolSetupGrid />);
    expect(screen.getByLabelText("Claude 分组与模型")).toHaveTextContent(
      "premium",
    );
    expect(screen.getAllByText(/已保留原配置/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText("启动 Claude"));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("saves explicit group choice and restores it on reopen", async () => {
    const ui = render(<ToolSetupGrid />);
    await chooseGroup();
    fireEvent.click(screen.getByLabelText("配置 Claude"));
    await waitFor(() => expect(mocks.configure).toHaveBeenCalled());
    ui.unmount();
    render(<ToolSetupGrid />);
    expect(screen.getByLabelText("Claude 分组与模型")).toHaveTextContent(
      "cheap",
    );
  });
  it("locks preflight against duplicate submissions and group edits", async () => {
    let resolve!: (value: unknown) => void;
    mocks.preflight.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(<ToolSetupGrid />);
    fireEvent.click(screen.getByLabelText("配置 Claude"));
    fireEvent.click(screen.getByLabelText("配置 Claude"));
    expect(screen.getByLabelText("Claude 分组与模型")).toBeDisabled();
    expect(mocks.preflight).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ status: "ok", checks: [] }));
    expect(mocks.configure).toHaveBeenCalledTimes(1);
  });
  it("account switch clears drafts and cancels pending preflight follow-up", async () => {
    let resolve!: (value: unknown) => void;
    mocks.preflight.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const ui = render(<ToolSetupGrid />);
    await chooseGroup();
    fireEvent.click(screen.getByLabelText("配置 Claude"));
    mocks.connection = { ...mocks.connection!, userId: "second-user" };
    mocks.statuses = [status("claude")];
    ui.rerender(<ToolSetupGrid />);
    expect(screen.getByLabelText("Claude 分组与模型")).toHaveTextContent(
      "premium",
    );
    await act(async () => resolve({ status: "ok", checks: [] }));
    expect(mocks.configure).not.toHaveBeenCalled();
  });
  it("new tools alone may select a default, saved models never become recommendations", () => {
    expect(
      resolveToolSetupSelection(
        mocks.connection,
        { ...status("claude"), configured: false, model: null, group: null },
        {},
      ).group,
    ).toBe("cheap");
    expect(
      resolveToolSetupSelection(mocks.connection, status("claude"), {}).group,
    ).toBe("premium");
    expect(
      resolveToolSetupSelection(
        mocks.connection,
        { ...status("claude"), model: "removed" },
        {},
      ).model,
    ).toBe("removed");
    expect(pickPreferredGroup(mocks.connection, "model-a", "missing")).toBe(
      "missing",
    );
    expect(
      resolveToolSetupSelection(mocks.connection, undefined, {}).group,
    ).toBeUndefined();
  });
  it("compact selectors never disguise a missing nonempty selection as the first option", () => {
    render(
      <CompactSelectPicker
        label="group-test"
        value="premium"
        options={[{ value: "cheap", label: "cheap" }]}
        onChange={mocks.changed}
      />,
    );
    expect(screen.getByLabelText("group-test")).toHaveTextContent("premium");
    expect(mocks.changed).not.toHaveBeenCalled();
  });
  it("batch configuration retains each saved group", async () => {
    render(<ToolSetupGrid />);
    fireEvent.click(screen.getByRole("button", { name: "一键配置所选工具" }));
    await waitFor(() =>
      expect(mocks.configure).toHaveBeenCalledWith(
        expect.objectContaining({
          groups: { claude: "premium", codex: "cheap", gemini: "premium" },
        }),
      ),
    );
  });
  it.each([true, false])(
    "Codex applies an explicit pair or restores both values on failure: %s",
    async (success) => {
      const confirm = vi.spyOn(window, "confirm");
      mocks.statuses = [status("codex", "premium")];
      mocks.connection!.modelGroups["model-b"] = ["cheap"];
      if (!success)
        mocks.preflight.mockResolvedValue({
          status: "error",
          checks: [],
          message: "network failure",
        });
      render(<ToolSetupGrid />);
      await chooseGroup("Codex", "cheap", "model-b");
      expect(confirm).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(mocks.preflight).toHaveBeenCalledWith(
          expect.objectContaining({ group: "cheap", model: "model-b" }),
        ),
      );
      if (success) {
        await waitFor(() =>
          expect(mocks.configure).toHaveBeenCalledWith(
            expect.objectContaining({
              groups: { codex: "cheap" },
              models: { codex: "model-b" },
            }),
          ),
        );
      } else {
        await waitFor(() =>
          expect(mocks.error).toHaveBeenCalledWith("network failure"),
        );
        expect(mocks.configure).not.toHaveBeenCalled();
        expect(screen.getByLabelText("Codex 分组与模型")).toHaveTextContent(
          "premium / model-a",
        );
      }
      confirm.mockRestore();
    },
  );
});
