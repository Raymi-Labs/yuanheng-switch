import { act, render } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  UPDATE_REMIND_LATER_MS,
  UPDATE_STARTUP_DELAY_MS,
  UPDATE_STORAGE_KEYS,
  UpdateProvider,
  useUpdate,
  type UpdateDownloadProgress,
} from "@/contexts/UpdateContext";
import type { UpdateInfo } from "@/lib/updater";
import { emitTauriEvent } from "../msw/tauriMocks";

const {
  checkForUpdateMock,
  checkUpdatesMock,
  installUpdateAndRestartMock,
  isPortableMock,
} = vi.hoisted(() => ({
  checkForUpdateMock: vi.fn(),
  checkUpdatesMock: vi.fn(),
  installUpdateAndRestartMock: vi.fn(),
  isPortableMock: vi.fn(),
}));

vi.mock("@/lib/updater", () => ({
  checkForUpdate: checkForUpdateMock,
}));

vi.mock("@/lib/api", () => ({
  settingsApi: {
    checkUpdates: checkUpdatesMock,
    installUpdateAndRestart: installUpdateAndRestartMock,
    isPortable: isPortableMock,
  },
}));

const availableInfo: UpdateInfo = {
  currentVersion: "0.1.0",
  availableVersion: "0.2.0",
  notes: "New release",
};

let latestContext: ReturnType<typeof useUpdate>;

function ContextProbe() {
  latestContext = useUpdate();
  return <div data-testid="phase">{latestContext.phase}</div>;
}

function renderProvider() {
  return render(
    <UpdateProvider>
      <ContextProbe />
    </UpdateProvider>,
  );
}

describe("UpdateProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00.000Z"));
    localStorage.clear();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    checkForUpdateMock.mockResolvedValue({
      status: "available",
      info: availableInfo,
    });
    checkUpdatesMock.mockResolvedValue(undefined);
    installUpdateAndRestartMock.mockResolvedValue(true);
    isPortableMock.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
  });

  it("启动后自动检查并打开新版本提示", async () => {
    renderProvider();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY_MS);
    });

    expect(checkForUpdateMock).toHaveBeenCalledWith({ timeout: 30000 });
    expect(latestContext.hasUpdate).toBe(true);
    expect(latestContext.phase).toBe("available");
    expect(latestContext.isPromptOpen).toBe(true);
    expect(
      localStorage.getItem(UPDATE_STORAGE_KEYS.lastCheckAt),
    ).not.toBeNull();
  });

  it("自动检查尊重忽略版本，手动检查可重新显示", async () => {
    localStorage.setItem(UPDATE_STORAGE_KEYS.ignoredVersion, "0.2.0");
    renderProvider();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY_MS);
    });

    expect(latestContext.hasUpdate).toBe(true);
    expect(latestContext.isDismissed).toBe(true);
    expect(latestContext.isPromptOpen).toBe(false);

    await act(async () => {
      await latestContext.checkUpdate();
    });

    expect(latestContext.isDismissed).toBe(false);
    expect(latestContext.isPromptOpen).toBe(true);
    expect(localStorage.getItem(UPDATE_STORAGE_KEYS.ignoredVersion)).toBeNull();
  });

  it("稍后提醒保存 24 小时，并支持关闭自动检查", async () => {
    renderProvider();
    await act(async () => {
      await latestContext.checkUpdate();
      latestContext.remindLater();
    });

    expect(latestContext.isPromptOpen).toBe(false);
    expect(Number(localStorage.getItem(UPDATE_STORAGE_KEYS.snoozeUntil))).toBe(
      Date.now() + UPDATE_REMIND_LATER_MS,
    );

    act(() => latestContext.setAutoCheckEnabled(false));
    expect(latestContext.autoCheckEnabled).toBe(false);
    expect(localStorage.getItem(UPDATE_STORAGE_KEYS.autoCheck)).toBe("false");
  });

  it("接收下载进度并进入安装阶段", async () => {
    let finishInstall: ((value: boolean) => void) | undefined;
    installUpdateAndRestartMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishInstall = resolve;
      }),
    );
    renderProvider();
    await act(async () => {
      await latestContext.checkUpdate();
    });

    let updatePromise: Promise<boolean>;
    await act(async () => {
      updatePromise = latestContext.startUpdate();
      await Promise.resolve();
    });
    expect(latestContext.phase).toBe("downloading");

    act(() => {
      emitTauriEvent("update-download-progress", {
        downloaded: 75,
        total: 100,
      } satisfies UpdateDownloadProgress);
    });
    expect(latestContext.progress).toEqual({ downloaded: 75, total: 100 });

    await act(async () => {
      finishInstall?.(true);
      await updatePromise;
    });
    expect(latestContext.phase).toBe("installing");
  });

  it("签名完成前保持下载阶段，切源重下不会提前安装", async () => {
    let finishInstall: ((value: boolean) => void) | undefined;
    installUpdateAndRestartMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishInstall = resolve;
      }),
    );
    renderProvider();
    await act(async () => {
      await latestContext.checkUpdate();
    });
    let updatePromise: Promise<boolean>;
    await act(async () => {
      updatePromise = latestContext.startUpdate();
      await Promise.resolve();
    });
    act(() => {
      emitTauriEvent("update-download-progress", {
        downloaded: 100,
        total: 100,
        phase: "downloading",
      });
    });
    expect(latestContext.phase).toBe("downloading");
    act(() => {
      emitTauriEvent("update-download-progress", {
        downloaded: 0,
        total: null,
        phase: "downloading",
      });
    });
    expect(latestContext.phase).toBe("downloading");
    expect(latestContext.progress?.downloaded).toBe(0);
    act(() => {
      emitTauriEvent("update-download-progress", {
        downloaded: 100,
        total: 100,
        phase: "installing",
      });
    });
    expect(latestContext.phase).toBe("installing");
    await act(async () => {
      finishInstall?.(true);
      await updatePromise;
    });
  });

  it.each([new Error("download failed"), "download failed"])(
    "安装失败时保留更新信息并允许重试（%s）",
    async (error) => {
      installUpdateAndRestartMock.mockRejectedValue(error);
      renderProvider();
      await act(async () => {
        await latestContext.checkUpdate();
      });

      await act(async () => {
        await expect(latestContext.startUpdate()).rejects.toBe(error);
      });

      expect(latestContext.phase).toBe("error");
      expect(latestContext.error).toBe("download failed");
      expect(latestContext.updateInfo).toEqual(availableInfo);
      expect(latestContext.isPromptOpen).toBe(true);
      installUpdateAndRestartMock.mockResolvedValue(false);
      await act(async () => {
        await latestContext.startUpdate();
      });
      expect(installUpdateAndRestartMock).toHaveBeenCalledTimes(2);
      expect(latestContext.phase).toBe("idle");
    },
  );

  it("登录页主动安装期间启动自动检查和重复安装不打断下载或重启", async () => {
    let finishInstall!: (value: boolean) => void;
    installUpdateAndRestartMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishInstall = resolve;
      }),
    );
    renderProvider();
    await act(async () => {
      await latestContext.checkUpdate();
    });
    let installing!: Promise<boolean>;
    await act(async () => {
      installing = latestContext.startUpdate();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY_MS);
      expect(await latestContext.startUpdate()).toBe(false);
    });
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1);
    expect(installUpdateAndRestartMock).toHaveBeenCalledTimes(1);
    expect(latestContext.phase).toBe("downloading");
    await act(async () => {
      finishInstall(true);
      await installing;
    });
    await act(async () => {
      await latestContext.checkUpdate();
    });
    expect(latestContext.phase).toBe("installing");
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("便携版打开下载页而不执行原地安装", async () => {
    isPortableMock.mockResolvedValue(true);
    renderProvider();
    await act(async () => {
      await Promise.resolve();
    });
    expect(latestContext.isPortable).toBe(true);

    await act(async () => {
      await latestContext.checkUpdate();
    });
    await act(async () => {
      await latestContext.startUpdate();
    });

    expect(checkUpdatesMock).toHaveBeenCalledTimes(1);
    expect(installUpdateAndRestartMock).not.toHaveBeenCalled();
    expect(latestContext.isPromptOpen).toBe(false);
  });
});
