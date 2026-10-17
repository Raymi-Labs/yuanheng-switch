import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  isToolLifecycleBusy,
  runToolLifecycleJob,
  useToolLifecycleState,
  useToolInstallProgress,
  cancelToolInstall,
} from "@/lib/toolLifecycleState";
import { settingsApi } from "@/lib/api/settings";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage = (_value: unknown) => {};
  },
}));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("shared tool installation lifecycle", () => {
  it("routes IPC progress only to its active job and clears the callback on failure", async () => {
    let channel!: { onmessage: (value: unknown) => void };
    let rejectExecution!: (value: Error) => void;
    invoke.mockImplementation(async (command, payload) => {
      if (command === "native_tool_install_supported") return true;
      if (command === "run_tool_lifecycle_action") {
        channel = payload.progress;
        return new Promise<void>((_, reject) => {
          rejectExecution = reject;
        });
      }
    });
    const view = renderHook(useToolInstallProgress);
    let task!: Promise<void>;
    act(() => {
      task = settingsApi.runToolLifecycleAction(["dsh"], "install");
    });
    const failed = expect(task).rejects.toThrow("download failed");
    await act(async () => {
      await Promise.resolve();
    });
    const stale = channel.onmessage;
    act(() =>
      channel.onmessage({
        stage: "download",
        downloadedBytes: 40,
        totalBytes: 100,
        activity: true,
      }),
    );
    expect(view.result.current.get("dsh")?.downloadedBytes).toBe(40);
    await act(async () => {
      rejectExecution(new Error("download failed"));
      await failed;
    });
    expect(view.result.current.size).toBe(0);
    const next = deferred();
    let retry!: Promise<void>;
    act(() => {
      retry = runToolLifecycleJob(["dsh"], "install", () => next.promise);
    });
    act(() => stale({ stage: "download", downloadedBytes: 99 }));
    expect(view.result.current.get("dsh")?.stage).toBe("preparing");
    await act(async () => {
      next.resolve();
      await retry;
    });
    view.unmount();
  });

  it("cancels by operation ID and does not verify or report success after cancellation", async () => {
    let rejectExecution!: (error: Error) => void;
    let operationId = "";
    invoke.mockImplementation(async (command, payload) => {
      if (command === "native_tool_install_supported") return true;
      if (command === "run_tool_lifecycle_action") {
        operationId = payload.operationId;
        return new Promise<void>((_, reject) => {
          rejectExecution = reject;
        });
      }
      if (command === "cancel_tool_installation") {
        expect(payload.operationId).toBe(operationId);
        rejectExecution(new Error("[INSTALL_CANCELLED] stopped"));
        return true;
      }
      throw new Error("Unexpected verification after cancellation");
    });
    const task = settingsApi.runToolLifecycleAction(["claude"], "install");
    const rejection = expect(task).rejects.toThrow("[INSTALL_CANCELLED]");
    await Promise.resolve();
    await Promise.resolve();
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await cancelToolInstall("claude")).toBe(true);
    await rejection;
    expect(isToolLifecycleBusy("claude")).toBe(false);
    expect(
      invoke.mock.calls.some(
        ([command]) => command === "get_installed_tool_versions",
      ),
    ).toBe(false);
  });

  it("publishes immediately across views, blocks re-entry and holds the lock through verification", async () => {
    const command = deferred();
    const verification = deferred();
    const view = renderHook(useToolLifecycleState);
    const secondView = renderHook(useToolLifecycleState);
    let task!: Promise<void>;
    act(() => {
      task = runToolLifecycleJob(
        ["claude"],
        "install",
        () => command.promise,
        () => verification.promise,
      );
    });
    expect(view.result.current.get("claude")).toBe("installing");
    expect(secondView.result.current.get("claude")).toBe("installing");
    const duplicate = vi.fn();
    await expect(
      runToolLifecycleJob(["claude"], "update", duplicate),
    ).rejects.toThrow("正在安装");
    expect(duplicate).not.toHaveBeenCalled();
    await act(async () => {
      command.resolve();
      await command.promise;
    });
    expect(view.result.current.get("claude")).toBe("verifying");
    await act(async () => {
      verification.resolve();
      await task;
    });
    expect(view.result.current.size).toBe(0);
    view.unmount();
    secondView.unmount();
  });

  it.each(["execute", "verify"])(
    "clears failed %s jobs and permits retry",
    async (stage) => {
      const fail = () => Promise.reject(new Error("failed"));
      await expect(
        runToolLifecycleJob(
          ["codex"],
          "install",
          stage === "execute" ? fail : async () => {},
          stage === "verify" ? fail : undefined,
        ),
      ).rejects.toThrow("failed");
      expect(isToolLifecycleBusy("codex")).toBe(false);
      await runToolLifecycleJob(["codex"], "install", async () => {});
      expect(isToolLifecycleBusy("codex")).toBe(false);
    },
  );

  it("does not report successful installation just because the command exits successfully", async () => {
    invoke.mockImplementation(async (command) =>
      command === "get_installed_tool_versions"
        ? [{ name: "claude", version: null, installed_but_broken: true }]
        : undefined,
    );
    await expect(
      settingsApi.runToolLifecycleAction(["claude"], "install"),
    ).rejects.toThrow("尚无法运行");
    expect(isToolLifecycleBusy("claude")).toBe(false);
    invoke.mockImplementation(async (command) =>
      command === "get_installed_tool_versions"
        ? [{ name: "claude", version: "1.0", installed_but_broken: false }]
        : undefined,
    );
    await expect(
      settingsApi.runToolLifecycleAction(["claude"], "install"),
    ).resolves.toBeUndefined();
  });

  it("rejects missing or partial version results instead of guessing success", async () => {
    invoke.mockImplementation(async (command) =>
      command === "get_installed_tool_versions"
        ? [{ name: "claude", version: "1.0" }]
        : undefined,
    );
    await expect(
      settingsApi.runToolLifecycleAction(["claude", "codex"], "install"),
    ).rejects.toThrow("尚无法运行");
    expect(isToolLifecycleBusy("claude")).toBe(false);
    expect(isToolLifecycleBusy("codex")).toBe(false);
  });
});
