import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { YuanhengAccessScreen } from "@/components/desktop/YuanhengAccessScreen";
import { YUANHENG_WEBSITE_URL } from "@/config/yuanhengBrand";
import { UpdateProvider, UPDATE_STORAGE_KEYS } from "@/contexts/UpdateContext";
import { UpdatePrompt } from "@/components/UpdatePrompt";
import { UpdateBadge } from "@/components/UpdateBadge";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "../utils/testQueryClient";

const {
  openExternalMock,
  checkMock,
  downloadPageMock,
  installMock,
  toastErrorMock,
} = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  checkMock: vi.fn(),
  downloadPageMock: vi.fn(),
  installMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  settingsApi: {
    openExternal: openExternalMock,
    checkUpdates: downloadPageMock,
    installUpdateAndRestart: installMock,
    isPortable: async () => false,
  },
}));

vi.mock("@/lib/updater", () => ({
  getCurrentVersion: async () => "0.1.69",
  checkForUpdate: checkMock,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: toastErrorMock } }));

vi.mock("@/components/desktop/YuanhengConnectionPanel", () => ({
  YuanhengConnectionPanel: () => <div>登录面板</div>,
}));

const available = {
  status: "available",
  info: {
    currentVersion: "0.1.69",
    availableVersion: "0.1.70",
    notes: "更新修复",
  },
};

function renderAccess(loading = false) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <UpdateProvider>
        <UpdateBadge />
        <YuanhengAccessScreen loading={loading} />
        <UpdatePrompt />
      </UpdateProvider>
    </QueryClientProvider>,
  );
}

describe("YuanhengAccessScreen", () => {
  beforeEach(() => {
    localStorage.clear();
    openExternalMock.mockReset().mockResolvedValue(undefined);
    downloadPageMock.mockReset().mockResolvedValue(undefined);
    checkMock.mockReset().mockResolvedValue(available);
    installMock.mockReset().mockResolvedValue(true);
    toastErrorMock.mockReset();
  });

  it("未登录时也能访问官网", async () => {
    renderAccess();

    fireEvent.click(screen.getByRole("button", { name: "访问元衡官网" }));

    await waitFor(() => {
      expect(openExternalMock).toHaveBeenCalledWith(YUANHENG_WEBSITE_URL);
    });
  });

  it.each([false, true])(
    "登录加载状态为 %s 时仍可主动更新，忽略和稍后提醒不阻断",
    async (loading) => {
      localStorage.setItem(UPDATE_STORAGE_KEYS.autoCheck, "false");
      localStorage.setItem(UPDATE_STORAGE_KEYS.ignoredVersion, "0.1.70");
      localStorage.setItem(
        UPDATE_STORAGE_KEYS.snoozeUntil,
        String(Date.now() + 86_400_000),
      );
      renderAccess(loading);
      expect(await screen.findByText("v0.1.69")).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "settings.checkForUpdates" }),
      );
      expect(
        await screen.findByRole("dialog", {
          name: "settings.updatePromptTitle",
        }),
      ).toBeInTheDocument();
      expect(checkMock).toHaveBeenCalledTimes(1);
      expect(installMock).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", { name: "settings.remindLater" }),
      );
      expect(
        screen.getAllByRole("button", { name: "settings.updateTo" }),
      ).toHaveLength(1);
      fireEvent.click(
        screen.getByRole("button", { name: "settings.updateTo" }),
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "settings.updateNow" }),
      );
      await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1));
      expect(
        screen.getByText(loading ? "正在检查登录状态…" : "登录面板"),
      ).toBeInTheDocument();
    },
  );

  it("检查中禁止重复请求，无更新时显示明确结果并保留登录面板", async () => {
    let resolveCheck!: (value: { status: string }) => void;
    checkMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );
    renderAccess();
    const button = screen.getByRole("button", {
      name: "settings.checkForUpdates",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(checkMock).toHaveBeenCalledTimes(1);
    await act(async () => resolveCheck({ status: "up-to-date" }));
    expect(await screen.findByText("settings.upToDate")).toBeInTheDocument();
    expect(screen.getByText("登录面板")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it("检查失败可打开官方下载页，打开失败仍保留重试检查", async () => {
    checkMock.mockRejectedValueOnce(new Error("offline"));
    downloadPageMock.mockRejectedValueOnce(new Error("browser unavailable"));
    renderAccess();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.checkForUpdates" }),
    );
    expect(
      await screen.findByText("settings.checkUpdateFailed"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.openDownloadPage" }),
    );
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "notifications.openLinkFailed",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings.openDownloadPage" }),
    );
    await waitFor(() => expect(downloadPageMock).toHaveBeenCalledTimes(2));
    fireEvent.click(
      screen.getByRole("button", { name: "settings.checkForUpdates" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("登录面板")).toBeInTheDocument();
  });
});
