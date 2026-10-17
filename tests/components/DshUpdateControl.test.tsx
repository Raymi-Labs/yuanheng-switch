import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DshUpdateControl } from "@/components/desktop/DshUpdateControl";
import { settingsApi, type ToolVersionInfo } from "@/lib/api/settings";
import { cancelToolInstall } from "@/lib/toolLifecycleState";
import { toast } from "sonner";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (_value: unknown) => {};
  },
  invoke,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
const row = (extra: Partial<ToolVersionInfo> = {}): ToolVersionInfo => ({
  name: "dsh",
  version: "0.2.0-rc.2",
  latest_version: "0.3.0",
  error: null,
  installed_but_broken: false,
  env_type: "macos",
  wsl_distro: null,
  install_path: "/managed/dsh",
  detection_source: "managed",
  custom_path: null,
  custom_path_valid: false,
  ...extra,
});
function mount(copies = 1) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      {Array.from({ length: copies }, (_, i) => (
        <DshUpdateControl key={i} />
      ))}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  invoke.mockReset();
  vi.clearAllMocks();
});

describe("DSH official updates", () => {
  it.each(["0.3.0", "0.3.0-rc.10"])(
    "offers newer official version %s",
    async (latest) => {
      vi.spyOn(settingsApi, "getToolVersions").mockResolvedValue([
        row({ latest_version: latest }),
      ]);
      mount();
      expect(
        await screen.findByText(`官方 latest：${latest}`),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "更新 DSH" })).toBeEnabled();
    },
  );

  it.each(["0.2.0-rc.2", "0.2.0-rc.1"])(
    "never proposes a downgrade to %s",
    async (latest) => {
      vi.spyOn(settingsApi, "getToolVersions").mockResolvedValue([
        row({ latest_version: latest }),
      ]);
      mount();
      expect(await screen.findByText("当前版本无需更新")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "更新 DSH" }),
      ).not.toBeInTheDocument();
    },
  );

  it.each(["custom", "automatic"] as const)(
    "leaves %s installations with their original updater",
    async (source) => {
      vi.spyOn(settingsApi, "getToolVersions").mockResolvedValue([
        row({ detection_source: source }),
      ]);
      mount();
      expect(
        await screen.findByText(
          "此 DSH 来自自选路径或外部安装，请通过原渠道更新。",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "更新 DSH" }),
      ).not.toBeInTheDocument();
    },
  );

  it("does not call a failed lookup up-to-date and supports retry", async () => {
    const query = vi
      .spyOn(settingsApi, "getToolVersions")
      .mockResolvedValueOnce([row({ latest_version: null, error: "offline" })])
      .mockResolvedValue([row()]);
    mount();
    expect(
      await screen.findByText("无法检查 DSH 官方版本，请稍后重试。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("当前版本无需更新")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(
      await screen.findByRole("button", { name: "更新 DSH" }),
    ).toBeEnabled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("shares one update across views, verifies it and refreshes the version", async () => {
    let complete!: () => void;
    let installed = "0.2.0-rc.2";
    invoke.mockImplementation(async (command, payload) => {
      if (command === "get_tool_versions") return [row({ version: installed })];
      if (command === "native_tool_install_supported") return true;
      if (command === "run_tool_lifecycle_action") {
        expect(payload.action).toBe("update");
        return new Promise<void>((resolve) => {
          complete = () => {
            installed = "0.3.0";
            resolve();
          };
        });
      }
      if (command === "get_installed_tool_versions")
        return [row({ version: installed })];
      throw new Error(`Unexpected ${command}`);
    });
    mount(2);
    const buttons = await screen.findAllByRole("button", { name: "更新 DSH" });
    fireEvent.click(buttons[0]);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "取消更新" })).toHaveLength(
        2,
      ),
    );
    buttons.forEach((button) => expect(button).toBeDisabled());
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "run_tool_lifecycle_action",
      ),
    ).toHaveLength(1);
    await act(async () => complete());
    await waitFor(() =>
      expect(screen.getAllByText("当前版本 0.3.0")).toHaveLength(2),
    );
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(
      invoke.mock.calls.some(
        ([command]) => command === "get_installed_tool_versions",
      ),
    ).toBe(true);
  });

  it.each(["cancel", "failure"])(
    "retains the old version after %s and allows retry",
    async (mode) => {
      let reject!: (error: Error) => void;
      let operationId = "";
      invoke.mockImplementation(async (command, payload) => {
        if (command === "get_tool_versions") return [row()];
        if (command === "native_tool_install_supported") return true;
        if (command === "run_tool_lifecycle_action") {
          operationId = payload.operationId;
          return new Promise<void>((_, fail) => {
            reject = fail;
          });
        }
        if (command === "cancel_tool_installation") {
          expect(payload.operationId).toBe(operationId);
          reject(new Error("[INSTALL_CANCELLED]"));
          return true;
        }
        throw new Error(`Unexpected ${command}`);
      });
      mount();
      fireEvent.click(await screen.findByRole("button", { name: "更新 DSH" }));
      await screen.findByRole("button", { name: "取消更新" });
      await act(async () => {
        if (mode === "cancel") await cancelToolInstall("dsh");
        else reject(new Error("DSH 下载失败，原安装未替换"));
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "更新 DSH" })).toBeEnabled(),
      );
      expect(screen.getByText("当前版本 0.2.0-rc.2")).toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
      expect(
        mode === "cancel" ? toast.info : toast.error,
      ).toHaveBeenCalledTimes(1);
    },
  );
});
