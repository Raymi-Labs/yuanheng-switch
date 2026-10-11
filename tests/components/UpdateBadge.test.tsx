import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateBadge } from "@/components/UpdateBadge";
import {
  UpdateProvider,
  UPDATE_STORAGE_KEYS,
  useUpdate,
} from "@/contexts/UpdateContext";
import { emitTauriEvent } from "../msw/tauriMocks";

const { checkMock, installMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  installMock: vi.fn(),
}));

vi.mock("@/lib/updater", () => ({ checkForUpdate: checkMock }));
vi.mock("@/lib/api", () => ({
  settingsApi: {
    isPortable: async () => false,
    installUpdateAndRestart: installMock,
  },
}));

let update: ReturnType<typeof useUpdate>;
function BadgeProbe() {
  update = useUpdate();
  return <UpdateBadge />;
}

const available = {
  status: "available",
  info: { currentVersion: "0.1.71", availableVersion: "0.1.72" },
};

describe("UpdateBadge", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(UPDATE_STORAGE_KEYS.autoCheck, "false");
    checkMock.mockReset().mockResolvedValue(available);
    installMock.mockReset().mockResolvedValue(true);
  });

  function renderBadge() {
    render(
      <UpdateProvider>
        <BadgeProbe />
      </UpdateProvider>,
    );
  }

  it("只有确认有新版本时显示文字按钮与红点，确认最新后一起消失", async () => {
    renderBadge();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await act(async () => {
      await update.checkUpdate({ showPrompt: false });
    });
    expect(
      screen.getByRole("button", { name: "settings.updateTo" }),
    ).toBeVisible();
    expect(screen.getByTestId("update-notification-dot")).toBeVisible();
    fireEvent.click(screen.getByRole("button"));
    expect(update.isPromptOpen).toBe(true);
    expect(installMock).not.toHaveBeenCalled();

    checkMock.mockResolvedValue({ status: "up-to-date" });
    await act(async () => {
      await update.checkUpdate({ showPrompt: false });
    });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("update-notification-dot"),
    ).not.toBeInTheDocument();
  });

  it.each(["ignored", "snoozed"])(
    "%s 只抑制自动弹窗，按钮保留并可主动重新打开",
    async (preference) => {
      if (preference === "ignored") {
        localStorage.setItem(UPDATE_STORAGE_KEYS.ignoredVersion, "0.1.72");
      } else {
        localStorage.setItem(
          UPDATE_STORAGE_KEYS.snoozeUntil,
          String(Date.now() + 86400000),
        );
      }
      renderBadge();
      await act(async () => {
        await update.checkUpdate({ showPrompt: true, forcePrompt: false });
      });
      expect(update.isPromptOpen).toBe(false);
      fireEvent.click(screen.getByRole("button"));
      expect(update.isPromptOpen).toBe(true);
      expect(update.isDismissed).toBe(false);
      expect(
        localStorage.getItem(UPDATE_STORAGE_KEYS.ignoredVersion),
      ).toBeNull();
      expect(localStorage.getItem(UPDATE_STORAGE_KEYS.snoozeUntil)).toBeNull();
      act(() => update.ignoreUpdate());
      expect(screen.getByRole("button")).toBeVisible();
      expect(screen.getByTestId("update-notification-dot")).toBeVisible();
    },
  );

  it("检查失败不伪装成无更新，也不丢失已知版本的入口", async () => {
    renderBadge();
    checkMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(update.checkUpdate()).rejects.toThrow("offline");
    });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await act(async () => {
      await update.checkUpdate({ showPrompt: false });
    });
    checkMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(update.checkUpdate()).rejects.toThrow("offline");
    });
    expect(screen.getByRole("button")).toBeEnabled();
    fireEvent.click(screen.getByRole("button"));
    expect(update.isPromptOpen).toBe(true);
  });

  it("下载和安装时显示状态并禁用，失败后重新允许打开重试", async () => {
    let rejectInstall!: (error: Error) => void;
    installMock.mockReturnValue(
      new Promise((_, reject) => {
        rejectInstall = reject;
      }),
    );
    renderBadge();
    await act(async () => {
      await update.checkUpdate({ showPrompt: false });
    });
    let installation!: Promise<boolean>;
    await act(async () => {
      installation = update.startUpdate();
    });
    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("button", { name: "settings.downloadingUpdate" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button"));
    expect(update.isPromptOpen).toBe(false);
    act(() =>
      emitTauriEvent("update-download-progress", {
        downloaded: 100,
        total: 100,
      }),
    );
    expect(
      screen.getByRole("button", { name: "settings.installingUpdate" }),
    ).toBeDisabled();
    await act(async () => {
      rejectInstall(new Error("download failed"));
      await expect(installation).rejects.toThrow("download failed");
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.updateTo" }));
    expect(update.isPromptOpen).toBe(true);
    expect(installMock).toHaveBeenCalledTimes(1);
  });
});
