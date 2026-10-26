import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  YuanhengConnectionStatus,
  YuanhengToolConfigureResult,
  YuanhengToolStatus,
} from "@/lib/api";
import { useModelSwitchCenter } from "@/components/desktop/useModelSwitchCenter";
import type { ToolVersionInfo } from "@/lib/api/settings";
import { createTestQueryClient } from "../utils/testQueryClient";

const invokeMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (_value: unknown) => {};
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const connected = (models: string[]): YuanhengConnectionStatus => ({
  connected: true,
  baseUrl: "https://cn.meta-api.vip",
  userId: "1024",
  account: null,
  models,
  groups: [],
  modelGroups: {},
  reasoningLevels: {},
  announcement: null,
  lastSyncedAt: 1,
});

const toolStatus = (
  app: YuanhengToolStatus["app"],
  model: string,
): YuanhengToolStatus => ({
  app,
  supported: true,
  configured: true,
  needsUpdate: false,
  model,
  reasoning: "auto",
  recommendedModel: model,
  message: null,
});

interface WrapperProps {
  children: ReactNode;
}

function createWrapper() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: WrapperProps) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
}

describe("useModelSwitchCenter", () => {
  let connection: YuanhengConnectionStatus;
  let statuses: YuanhengToolStatus[];
  let configureResolvers: Map<
    YuanhengToolStatus["app"],
    (value: YuanhengToolConfigureResult[]) => void
  >;

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    connection = connected(["model-a", "model-b"]);
    statuses = [
      toolStatus("claude", "model-a"),
      toolStatus("codex", "model-a"),
      toolStatus("chatgpt-desktop", "model-a"),
    ];
    configureResolvers = new Map();
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      (command: string, payload: Record<string, unknown> = {}) => {
        if (command === "get_yuanheng_connection") {
          return Promise.resolve(connection);
        }
        if (command === "get_yuanheng_tool_statuses") {
          return Promise.resolve(statuses);
        }
        if (command === "get_yuanheng_tool_activation_statuses") {
          return Promise.resolve(
            statuses.map((status) => ({
              app: status.app,
              configuredAt: 1,
              configWritten: status.configured,
              routeRequired: [
                "claude-desktop",
                "codex",
                "chatgpt-desktop",
              ].includes(status.app),
              routeReady: status.configured,
              requestReceived: false,
              requestSucceeded: false,
              lastRequestAt: null,
              lastStatusCode: null,
              lastModel: null,
              message: "等待第一条请求",
            })),
          );
        }
        if (command === "preflight_yuanheng_tool") {
          return Promise.resolve({
            app: payload.app,
            model: payload.model,
            group: payload.group ?? "default",
            status: "ok",
            sourceProtocol: "openai_chat",
            targetProtocol: "openai_responses",
            streamingSupported: true,
            toolCall: "unknown",
            reasoningSupported: true,
            imageInput: "unknown",
            checks: [],
            message: "兼容性预检通过，可以安全配置",
          });
        }
        if (command === "get_installed_tool_versions") {
          const tools = (payload.tools as string[] | undefined) ?? [];
          return Promise.resolve(
            tools.map((name) => ({
              name,
              version: "1.0.0",
              latest_version: "1.0.0",
              error: null,
              installed_but_broken: false,
              env_type: "macos",
              wsl_distro: null,
            })),
          );
        }
        if (command === "get_codex_session_bridge_status") {
          return Promise.resolve({
            running: false,
            endpoint: null,
            connectedTerminals: 0,
            appliedTerminals: 0,
            pendingTerminals: 0,
            model: null,
            reasoningEffort: null,
          });
        }
        if (command === "get_codex_account_mode") {
          return Promise.resolve({
            mode: "yuanheng",
            officialLoginAvailable: true,
            yuanhengAvailable: true,
            restartRequired: false,
            message: null,
          });
        }
        if (command === "switch_codex_account_mode") {
          return Promise.resolve({
            mode: payload.mode,
            officialLoginAvailable: true,
            yuanhengAvailable: true,
            restartRequired: true,
            message: "已切换",
          });
        }
        if (command === "get_tool_launch_cwd") {
          return Promise.resolve(null);
        }
        if (command === "pick_directory") {
          return Promise.resolve("/tmp/codex project");
        }
        if (command === "set_tool_launch_cwd") {
          return Promise.resolve(payload.cwd);
        }
        if (command === "configure_yuanheng_tools") {
          const app = (payload.apps as YuanhengToolStatus["app"][])[0];
          const model = (
            payload.models as
              | Partial<Record<YuanhengToolStatus["app"], string>>
              | undefined
          )?.[app];
          return new Promise<YuanhengToolConfigureResult[]>((resolve) => {
            configureResolvers.set(app, (value) => {
              const status = statuses.find((item) => item.app === app);
              if (status && model) {
                status.model = model;
                status.recommendedModel = model;
              }
              resolve(value);
            });
          });
        }
        return Promise.resolve(true);
      },
    );
  });

  it.each([true, false])(
    "applies the DSH model/group pair together and preserves both on failure: %s",
    async (success) => {
      connection = {
        ...connected(["deepseek-flash", "grok-4.7"]),
        groups: [
          { id: "enterprise", description: "", ratio: 1 },
          { id: "grok-standard", description: "", ratio: 0.25 },
        ],
        modelGroups: {
          "deepseek-flash": ["enterprise"],
          "grok-4.7": ["grok-standard"],
        },
      };
      statuses = [
        { ...toolStatus("dsh", "deepseek-flash"), group: "enterprise" },
      ];
      const original = invokeMock.getMockImplementation()!;
      invokeMock.mockImplementation(
        async (command: string, payload: Record<string, any> = {}) => {
          if (command === "preflight_yuanheng_tool")
            return {
              ...(await original(command, payload)),
              status: success ? "warning" : "error",
              requiresConfiguration: true,
              message: "preflight",
              checks: [],
            };
          if (command === "configure_yuanheng_tools") {
            statuses[0] = {
              ...statuses[0],
              model: payload.models.dsh,
              group: payload.groups.dsh,
            };
            return [
              {
                app: "dsh",
                configured: true,
                model: payload.models.dsh,
                warnings: [],
              },
            ];
          }
          return original(command, payload);
        },
      );
      const confirm = vi.spyOn(window, "confirm");
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });
      await waitFor(() => expect(result.current.groups.dsh).toBe("enterprise"));
      await act(async () =>
        result.current.applyModelGroup("dsh", "grok-4.7", "grok-standard"),
      );
      expect(confirm).not.toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith(
        "preflight_yuanheng_tool",
        expect.objectContaining({
          app: "dsh",
          model: "grok-4.7",
          group: "grok-standard",
        }),
      );
      if (success) {
        expect(invokeMock).toHaveBeenCalledWith(
          "configure_yuanheng_tools",
          expect.objectContaining({
            apps: ["dsh"],
            models: { dsh: "grok-4.7" },
            groups: { dsh: "grok-standard" },
          }),
        );
        expect(result.current.models.dsh).toBe("grok-4.7");
        expect(result.current.groups.dsh).toBe("grok-standard");
      } else {
        expect(
          invokeMock.mock.calls.some(
            ([command]) => command === "configure_yuanheng_tools",
          ),
        ).toBe(false);
        expect(result.current.models.dsh).toBe("deepseek-flash");
        expect(result.current.groups.dsh).toBe("enterprise");
      }
      confirm.mockRestore();
    },
  );

  it("does not apply a pending pair after the account changes", async () => {
    const original = invokeMock.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    invokeMock.mockImplementation(
      (command: string, payload: Record<string, any> = {}) =>
        command === "preflight_yuanheng_tool"
          ? new Promise((r) => {
              resolve = r;
            })
          : original(command, payload),
    );
    const { wrapper, queryClient } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });
    await waitFor(() => expect(result.current.models.codex).toBe("model-a"));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.applyModelGroup("codex", "model-b", "other");
    });
    await waitFor(() => expect(resolve).toBeDefined());
    connection = { ...connection, userId: "second-user" };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["yuanheng"] });
    });
    await waitFor(() =>
      expect(result.current.connection?.userId).toBe("second-user"),
    );
    await act(async () => {
      resolve({ status: "ok", checks: [] });
      await pending;
    });
    expect(configureResolvers.size).toBe(0);
  });

  it("installs DSH, verifies detection, configures the selected model and only then launches", async () => {
    statuses = [{ ...toolStatus("dsh", "model-a"), configured: false }];
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });
    await waitFor(() => expect(result.current.bootstrapPhase).toBe("ready"));
    let install!: Promise<void>;
    act(() => {
      install = result.current.install("dsh");
    });
    await waitFor(() => expect(configureResolvers.has("dsh")).toBe(true));
    expect(
      invokeMock.mock.calls.some(([command]) => command === "launch_tool"),
    ).toBe(false);
    await act(async () => {
      configureResolvers.get("dsh")!([
        {
          app: "dsh",
          configured: true,
          model: "model-a",
        } as YuanhengToolConfigureResult,
      ]);
      await install;
    });
    const calls = invokeMock.mock.calls.map(([command]) => command);
    expect(calls.indexOf("run_tool_lifecycle_action")).toBeLessThan(
      calls.indexOf("configure_yuanheng_tools"),
    );
    expect(calls.indexOf("configure_yuanheng_tools")).toBeLessThan(
      calls.indexOf("launch_tool"),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "run_tool_lifecycle_action",
      expect.objectContaining({ tools: ["dsh"], action: "install" }),
    );
  });

  it("keeps an installed DSH available but never launches after configuration fails", async () => {
    statuses = [{ ...toolStatus("dsh", "model-a"), configured: false }];
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });
    await waitFor(() => expect(result.current.bootstrapPhase).toBe("ready"));
    let install!: Promise<void>;
    act(() => {
      install = result.current.install("dsh");
    });
    await waitFor(() => expect(configureResolvers.has("dsh")).toBe(true));
    await act(async () => {
      configureResolvers.get("dsh")!([
        {
          app: "dsh",
          configured: false,
          error: "synthetic configuration failure",
        } as YuanhengToolConfigureResult,
      ]);
      await install;
    });
    expect(
      invokeMock.mock.calls.some(([command]) => command === "launch_tool"),
    ).toBe(false);
  });

  it("retains DSH after an account catalog network failure and revalidates before a manual launch", async () => {
    const group = "OpenAI · 独享账号";
    connection.groups = [{ id: group, description: "", ratio: 1 }];
    connection.modelGroups = { "model-a": [group] };
    statuses = [{ ...toolStatus("dsh", "model-a"), group, configured: false }];
    let installed = false;
    let preflightAttempts = 0;
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, payload = {}) => {
      if (command === "run_tool_lifecycle_action") {
        installed = true;
        return true;
      }
      if (command === "get_installed_tool_versions") {
        const versions: ToolVersionInfo[] = await base(command, payload);
        return versions.map((item) =>
          item.name === "dsh" && !installed ? { ...item, version: null } : item,
        );
      }
      if (command === "preflight_yuanheng_tool") {
        preflightAttempts += 1;
        const result = await base(command, payload);
        if (preflightAttempts === 1) {
          return {
            ...result,
            status: "error",
            checks: [
              {
                id: "account",
                status: "error",
                title: "账号或平台连接失败",
                message: "读取账号模型失败：连接超时，请检查网络后重试",
              },
            ],
            message: "兼容性预检未通过，已阻止写入配置",
          };
        }
        return { ...result, requiresConfiguration: true };
      }
      return base(command, payload);
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });
    await waitFor(() => expect(result.current.models.dsh).toBe("model-a"));
    expect(result.current.installedApps.has("dsh")).toBe(false);

    await act(async () => {
      await result.current.install("dsh");
    });

    expect(installed).toBe(true);
    expect(result.current.installedApps.has("dsh")).toBe(true);
    expect(result.current.runnableRows).toContain("dsh");
    expect(result.current.preflightResults.dsh?.status).toBe("error");
    expect(result.current.pendingApps.has("dsh")).toBe(false);
    expect(result.current.installingApps.has("dsh")).toBe(false);
    expect(preflightAttempts).toBe(1);
    expect(configureResolvers.size).toBe(0);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "launch_tool")).toBe(
      false,
    );

    let launch!: Promise<void>;
    act(() => {
      launch = result.current.launch("dsh");
    });
    await waitFor(() => expect(configureResolvers.has("dsh")).toBe(true));
    expect(preflightAttempts).toBe(2);
    expect(invokeMock).toHaveBeenCalledWith(
      "configure_yuanheng_tools",
      expect.objectContaining({
        apps: ["dsh"],
        models: { dsh: "model-a" },
        groups: { dsh: group },
      }),
    );
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "launch_tool")).toBe(
      false,
    );
    await act(async () => {
      configureResolvers.get("dsh")!([
        {
          app: "dsh",
          configured: true,
          model: "model-a",
          warnings: [],
          error: null,
        },
      ]);
      await launch;
    });
    expect(result.current.preflightResults.dsh?.status).toBe("ok");
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "launch_tool"),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.filter(
        ([cmd]) => cmd === "run_tool_lifecycle_action",
      ),
    ).toHaveLength(1);
  });

  it("detects an existing DSH without applying configuration or launching it", async () => {
    statuses = [{ ...toolStatus("dsh", "model-a"), configured: false }];
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });
    await waitFor(() => expect(result.current.bootstrapPhase).toBe("ready"));
    await act(async () => {
      await result.current.retryBootstrap();
    });

    expect(result.current.installedApps.has("dsh")).toBe(true);
    expect(result.current.runnableRows).toContain("dsh");
    expect(
      invokeMock.mock.calls.filter(([command]) =>
        [
          "preflight_yuanheng_tool",
          "configure_yuanheng_tools",
          "launch_tool",
          "run_tool_lifecycle_action",
        ].includes(command),
      ),
    ).toHaveLength(0);
  });

  it("does not configure or launch when the DSH installation is cancelled", async () => {
    statuses = [{ ...toolStatus("dsh", "model-a"), configured: false }];
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((command, payload) =>
      command === "run_tool_lifecycle_action"
        ? Promise.reject(
            new Error("[INSTALL_CANCELLED] synthetic cancellation"),
          )
        : base(command, payload),
    );
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });
    await waitFor(() => expect(result.current.bootstrapPhase).toBe("ready"));
    await act(async () => {
      await result.current.install("dsh");
    });
    expect(configureResolvers.size).toBe(0);
    expect(
      invokeMock.mock.calls.some(([command]) => command === "launch_tool"),
    ).toBe(false);
  });

  it("keeps the dashboard in loading state until local inventory resolves", async () => {
    const defaultImplementation = invokeMock.getMockImplementation();
    let resolveInventory!: (value: unknown[]) => void;
    const inventory = new Promise<unknown[]>((resolve) => {
      resolveInventory = resolve;
    });
    invokeMock.mockImplementation(
      (command: string, payload: Record<string, unknown> = {}) => {
        if (command === "get_installed_tool_versions") return inventory;
        return defaultImplementation?.(command, payload);
      },
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });

    await waitFor(() => {
      expect(result.current.bootstrapPhase).toBe("loading");
      expect(result.current.rows).toHaveLength(11);
      expect(result.current.runnableRows).toEqual([]);
    });

    await act(async () => {
      resolveInventory([]);
      await inventory;
    });

    await waitFor(() => {
      expect(result.current.bootstrapPhase).toBe("ready");
      expect(result.current.rows).toEqual([
        "claude",
        "claude-desktop",
        "codex",
        "chatgpt-desktop",
        "workbuddy",
        "dsh",
        "gemini",
        "grokbuild",
        "opencode",
        "openclaw",
        "hermes",
      ]);
      expect(result.current.runnableRows).toEqual([]);
    });
  });

  it("reports a detection error instead of an empty inventory", async () => {
    const defaultImplementation = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(
      (command: string, payload: Record<string, unknown> = {}) => {
        if (command === "get_installed_tool_versions") {
          return Promise.reject(new Error("probe failed"));
        }
        return defaultImplementation?.(command, payload);
      },
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });

    await waitFor(() => {
      expect(result.current.bootstrapPhase).toBe("error");
      expect(result.current.rows).toHaveLength(11);
      expect(result.current.runnableRows).toEqual([]);
    });
  });

  it("keeps every supported agent visible while focus only uses runnable tools", async () => {
    const defaultImplementation = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(
      (command: string, payload: Record<string, unknown> = {}) => {
        if (command === "get_installed_tool_versions") {
          return Promise.resolve([
            {
              name: "codex",
              version: "1.0.0",
              latest_version: "1.0.0",
              error: null,
              installed_but_broken: false,
              env_type: "windows",
              wsl_distro: null,
              install_path: null,
              detection_source: null,
              custom_path: null,
              custom_path_valid: true,
            },
          ]);
        }
        return defaultImplementation?.(command, payload);
      },
    );

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });

    await waitFor(() => {
      expect(result.current.rows).toHaveLength(11);
      expect(result.current.rows).toContain("workbuddy");
      expect(result.current.runnableRows).toEqual(["codex"]);
      expect(result.current.installedApps).toEqual(new Set(["codex"]));
    });
  });

  it("drops a stale model after the catalog refreshes", async () => {
    const { wrapper, queryClient } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });

    await waitFor(() => {
      expect(result.current.models.codex).toBe("model-a");
    });

    connection = connected(["model-b"]);
    statuses = [toolStatus("codex", "model-b")];
    act(() => {
      queryClient.setQueryData(["yuanheng", "connection"], connection);
      queryClient.setQueryData(
        [
          "yuanheng",
          "tools",
          connection.baseUrl,
          connection.userId,
          connection.connected,
        ],
        statuses,
      );
    });

    await waitFor(() => {
      expect(result.current.models.codex).toBe("model-b");
    });
  });

  it("tracks concurrent operations independently for each tool", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });

    await waitFor(() => {
      expect(result.current.rows).toEqual(
        expect.arrayContaining(["claude", "codex"]),
      );
      expect(result.current.models.codex).toBe("model-a");
    });

    let claudeRequest!: Promise<void>;
    let codexRequest!: Promise<void>;
    act(() => {
      claudeRequest = result.current.applyModel("claude", "model-b");
      codexRequest = result.current.applyModel("codex", "model-b");
    });

    await waitFor(() => {
      expect([...result.current.pendingApps]).toEqual(
        expect.arrayContaining(["claude", "codex"]),
      );
    });

    await act(async () => {
      configureResolvers.get("claude")?.([
        {
          app: "claude",
          configured: true,
          model: "model-b",
          warnings: [],
          error: null,
        },
      ]);
      await claudeRequest;
    });

    expect(result.current.pendingApps.has("claude")).toBe(false);
    expect(result.current.pendingApps.has("codex")).toBe(true);

    await act(async () => {
      configureResolvers.get("codex")?.([
        {
          app: "codex",
          configured: true,
          model: "model-b",
          warnings: [],
          error: null,
        },
      ]);
      await codexRequest;
    });

    expect(result.current.pendingApps.size).toBe(0);
  });

  it("blocks configuration when the compatibility preflight fails", async () => {
    const defaultImplementation = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(
      (command: string, payload: Record<string, unknown> = {}) => {
        if (command === "preflight_yuanheng_tool") {
          return Promise.resolve({
            app: payload.app,
            model: payload.model,
            group: payload.group ?? "default",
            status: "error",
            sourceProtocol: "openai_chat",
            targetProtocol: "openai_responses",
            streamingSupported: true,
            toolCall: "unknown",
            reasoningSupported: false,
            imageInput: "unsupported",
            checks: [
              {
                id: "model",
                status: "error",
                title: "模型已经失效",
                message: "当前账号目录中不存在该模型",
              },
            ],
            message: "兼容性预检未通过，已阻止写入配置",
          });
        }
        return defaultImplementation?.(command, payload);
      },
    );
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });

    await waitFor(() => expect(result.current.models.codex).toBe("model-a"));
    await act(async () => {
      await result.current.applyModel("codex", "model-b");
    });

    expect(result.current.models.codex).toBe("model-a");
    expect(result.current.preflightResults.codex?.status).toBe("error");
    expect(configureResolvers.has("codex")).toBe(false);
  });

  it("revalidates and repairs the actual tool credential on launch without changing its group", async () => {
    connection.modelGroups = { "model-a": ["custom-group", "default"] };
    connection.groups = [
      { id: "custom-group", description: "", ratio: 1 },
      { id: "default", description: "", ratio: 1 },
    ];
    statuses.find((item) => item.app === "chatgpt-desktop")!.group =
      "custom-group";
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(
      async (command: string, payload: Record<string, any> = {}) => {
        if (command === "preflight_yuanheng_tool") {
          return {
            ...(await original(command, payload)),
            status: "ok",
            requiresConfiguration: true,
          };
        }
        if (command === "configure_yuanheng_tools") {
          return [
            {
              app: "chatgpt-desktop",
              configured: true,
              model: "model-a",
              warnings: [],
              error: null,
            },
          ];
        }
        return original(command, payload);
      },
    );
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });
    await waitFor(() =>
      expect(result.current.groups["chatgpt-desktop"]).toBe("custom-group"),
    );
    await act(async () => {
      await result.current.launch("chatgpt-desktop");
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "configure_yuanheng_tools",
      expect.objectContaining({
        apps: ["chatgpt-desktop"],
        groups: { "chatgpt-desktop": "custom-group" },
        models: { "chatgpt-desktop": "model-a" },
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("launch_tool", {
      tool: "chatgpt-desktop",
      restart: true,
    });
  });

  it.each([true, false])(
    "confirms cross-group model switches from the workspace: %s",
    async (accepted) => {
      connection.modelGroups = {
        "model-a": ["premium"],
        "model-b": ["other-group"],
      };
      connection.groups = [
        { id: "premium", description: "", ratio: 1 },
        { id: "other-group", description: "", ratio: 0.2 },
      ];
      statuses.find((row) => row.app === "codex")!.group = "premium";
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(accepted);
      const original = invokeMock.getMockImplementation()!;
      invokeMock.mockImplementation((command, payload) => {
        if (command === "configure_yuanheng_tools")
          return Promise.resolve([
            {
              app: "codex",
              configured: true,
              model: "model-b",
              warnings: [],
              error: null,
            },
          ]);
        return original(command, payload);
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });
      await waitFor(() => expect(result.current.groups.codex).toBe("premium"));
      await act(async () => result.current.applyModel("codex", "model-b"));
      expect(confirm).toHaveBeenCalledOnce();
      if (accepted) {
        expect(invokeMock).toHaveBeenCalledWith(
          "preflight_yuanheng_tool",
          expect.objectContaining({ group: "other-group", model: "model-b" }),
        );
        expect(invokeMock).toHaveBeenCalledWith(
          "configure_yuanheng_tools",
          expect.objectContaining({ groups: { codex: "other-group" } }),
        );
      } else {
        expect(result.current.groups.codex).toBe("premium");
        expect(
          invokeMock.mock.calls.some(
            ([cmd]) => cmd === "configure_yuanheng_tools",
          ),
        ).toBe(false);
      }
      confirm.mockRestore();
    },
  );

  it("restarts Codex App after its model catalog configuration changes", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });

    await waitFor(() => {
      expect(result.current.rows).toContain("chatgpt-desktop");
      expect(result.current.models["chatgpt-desktop"]).toBe("model-a");
    });

    let configureRequest!: Promise<void>;
    act(() => {
      configureRequest = result.current.applyModel(
        "chatgpt-desktop",
        "model-b",
      );
    });
    await waitFor(() => {
      expect(configureResolvers.has("chatgpt-desktop")).toBe(true);
    });
    await act(async () => {
      configureResolvers.get("chatgpt-desktop")?.([
        {
          app: "chatgpt-desktop",
          configured: true,
          model: "model-b",
          warnings: [],
          error: null,
        },
      ]);
      await configureRequest;
    });

    expect(result.current.restartRequiredApps.has("chatgpt-desktop")).toBe(
      true,
    );

    await act(async () => {
      await result.current.launch("chatgpt-desktop");
    });

    expect(invokeMock).toHaveBeenCalledWith("launch_tool", {
      tool: "chatgpt-desktop",
      restart: true,
    });
    expect(result.current.restartRequiredApps.has("chatgpt-desktop")).toBe(
      false,
    );
  });

  it("persists and passes working directories for multiple CLI tools", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });

    await waitFor(() => {
      expect(result.current.rows).toContain("codex");
      expect(result.current.launchDirectories.codex).toBeUndefined();
    });

    await act(async () => {
      await result.current.chooseLaunchDirectory("codex");
    });

    expect(result.current.launchDirectories.codex).toBe("/tmp/codex project");
    expect(invokeMock).toHaveBeenCalledWith("set_tool_launch_cwd", {
      tool: "codex",
      cwd: "/tmp/codex project",
    });

    await act(async () => {
      await result.current.launch("codex");
    });

    expect(invokeMock).toHaveBeenCalledWith("launch_tool", {
      tool: "codex",
      restart: false,
      cwd: "/tmp/codex project",
    });

    await act(async () => {
      await result.current.chooseLaunchDirectory("claude");
    });

    expect(invokeMock).toHaveBeenCalledWith("set_tool_launch_cwd", {
      tool: "claude",
      cwd: "/tmp/codex project",
    });

    await act(async () => {
      await result.current.launch("claude");
    });

    expect(invokeMock).toHaveBeenCalledWith("launch_tool", {
      tool: "claude",
      restart: false,
      cwd: "/tmp/codex project",
    });
  });

  it("checks the selected mode again to repair historical providers", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });
    await waitFor(() =>
      expect(result.current.codexAccountMode.data?.mode).toBe("yuanheng"),
    );
    await act(async () => {
      await result.current.switchCodexMode("yuanheng");
    });
    expect(invokeMock).toHaveBeenCalledWith("switch_codex_account_mode", {
      mode: "yuanheng",
      expectedMode: "yuanheng",
    });
  });

  it("does not require a restart when checking an already healthy mode", async () => {
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, payload) => {
      const response = await original(command, payload);
      return command === "switch_codex_account_mode"
        ? { ...response, restartRequired: false }
        : response;
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });
    await waitFor(() =>
      expect(result.current.codexAccountMode.data?.mode).toBe("yuanheng"),
    );
    await act(async () => {
      await result.current.switchCodexMode("yuanheng");
    });
    expect(result.current.restartRequiredApps.size).toBe(0);
  });

  it("switches Codex to official mode without reapplying Yuanheng on launch", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useModelSwitchCenter(), { wrapper });

    await waitFor(() => {
      expect(result.current.codexAccountMode.data?.mode).toBe("yuanheng");
    });

    await act(async () => {
      await result.current.switchCodexMode("official");
    });

    expect(invokeMock).toHaveBeenCalledWith("switch_codex_account_mode", {
      mode: "official",
      expectedMode: "yuanheng",
    });
    await waitFor(() => {
      expect(result.current.restartRequiredApps.has("codex")).toBe(false);
      expect(result.current.restartRequiredApps.has("chatgpt-desktop")).toBe(
        true,
      );
    });

    invokeMock.mockClear();
    await act(async () => {
      await result.current.launch("codex");
    });

    expect(invokeMock).not.toHaveBeenCalledWith(
      "configure_yuanheng_tools",
      expect.anything(),
    );
    expect(invokeMock).toHaveBeenCalledWith("launch_tool", {
      tool: "codex",
      restart: false,
    });
  });
});
