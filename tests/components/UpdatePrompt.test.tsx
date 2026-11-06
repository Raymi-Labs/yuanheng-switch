import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePrompt } from "@/components/UpdatePrompt";
import type {
  UpdateDownloadProgress,
  UpdatePhase,
} from "@/contexts/UpdateContext";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "../utils/testQueryClient";
import { OPEN_ANNOUNCEMENTS_EVENT } from "@/lib/announcementCenter";
import { DesktopAnnouncementCenter } from "@/components/desktop/PlatformAnnouncementCenter";

function renderPrompt(includeCenter = false) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <UpdatePrompt />
      {includeCenter && <DesktopAnnouncementCenter />}
    </QueryClientProvider>,
  );
}

const { openExternalMock, updateContextMock, releaseNotesMock } = vi.hoisted(
  () => ({
    releaseNotesMock: vi.fn(),
    openExternalMock: vi.fn(),
    updateContextMock: {
      updateInfo: {
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        notes: "Fixes and improvements",
      },
      isPromptOpen: true,
      isPortable: false,
      isChecking: false,
      isUpdating: false,
      phase: "available" as UpdatePhase,
      progress: null as UpdateDownloadProgress | null,
      error: null as string | null,
      startUpdate: vi.fn(),
      remindLater: vi.fn(),
      ignoreUpdate: vi.fn(),
    },
  }),
);

vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => updateContextMock,
}));

// Keep synthetic updater versions independent of whichever release is bundled.
vi.mock("@/lib/query/desktopReleaseNotes", () => ({
  useDesktopReleaseNotes: releaseNotesMock,
}));

vi.mock("@/lib/api", () => ({
  settingsApi: {
    openExternal: openExternalMock,
  },
}));

describe("UpdatePrompt", () => {
  beforeEach(() => {
    updateContextMock.isPromptOpen = true;
    updateContextMock.isPortable = false;
    updateContextMock.isChecking = false;
    updateContextMock.isUpdating = false;
    updateContextMock.phase = "available";
    updateContextMock.progress = null;
    updateContextMock.error = null;
    updateContextMock.startUpdate.mockReset().mockResolvedValue(true);
    updateContextMock.remindLater.mockReset();
    updateContextMock.ignoreUpdate.mockReset();
    openExternalMock.mockReset();
    releaseNotesMock
      .mockReset()
      .mockReturnValue({
        data: [],
        isFetching: false,
        isError: false,
        refetch: vi.fn(),
      });
  });

  it("展示版本、更新日志和三个更新决策", () => {
    renderPrompt();

    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    expect(screen.getByText("v0.2.0")).toBeInTheDocument();
    expect(screen.getByText("Fixes and improvements")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "settings.ignoreThisVersion" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings.remindLater" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "settings.updateNow" }));

    expect(updateContextMock.ignoreUpdate).toHaveBeenCalledTimes(1);
    expect(updateContextMock.remindLater).toHaveBeenCalledTimes(1);
    expect(updateContextMock.startUpdate).toHaveBeenCalledTimes(1);
  });

  it("匹配版本的公告优先于更新接口简述", () => {
    releaseNotesMock.mockReturnValue({
      data: [
        {
          version: "0.2.0",
          publishedAt: "2026-01-01T00:00:00Z",
          content: "Synthetic matching release announcement",
        },
      ],
    });
    renderPrompt();
    expect(
      screen.getByText("Synthetic matching release announcement"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Fixes and improvements"),
    ).not.toBeInTheDocument();
  });

  it("下载中展示百分比并锁定决策按钮", () => {
    updateContextMock.isUpdating = true;
    updateContextMock.phase = "downloading";
    updateContextMock.progress = {
      downloaded: 5 * 1024 * 1024,
      total: 10 * 1024 * 1024,
    };

    renderPrompt();

    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("5.0 MB / 10.0 MB")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "settings.updateNow" }),
    ).not.toBeInTheDocument();
  });

  it("正在复查版本时禁用安装按钮，避免无反馈的重复提交", () => {
    updateContextMock.isChecking = true;
    renderPrompt();
    const button = screen.getByRole("button", { name: "settings.checking" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(updateContextMock.startUpdate).not.toHaveBeenCalled();
  });

  it("安装失败后显示错误和重试入口", () => {
    updateContextMock.phase = "error";
    updateContextMock.error = "signature invalid";

    renderPrompt();

    expect(screen.getByText("signature invalid")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.retryUpdate" }),
    );
    expect(updateContextMock.startUpdate).toHaveBeenCalledTimes(1);
  });

  it("便携版使用打开下载页文案", () => {
    updateContextMock.isPortable = true;
    renderPrompt();

    fireEvent.click(
      screen.getByRole("button", { name: "settings.openDownloadPage" }),
    );
    expect(updateContextMock.startUpdate).toHaveBeenCalledTimes(1);
  });

  it("更新日志打开内部公告中心，不调用外部浏览器", () => {
    const onOpen = vi.fn();
    window.addEventListener(OPEN_ANNOUNCEMENTS_EVENT, onOpen);
    try {
      renderPrompt();
      fireEvent.click(
        screen.getByRole("button", { name: "settings.releaseNotes" }),
      );
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(openExternalMock).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(OPEN_ANNOUNCEMENTS_EVENT, onOpen);
    }
  });

  it("关闭内部公告不改变更新决定，也不关闭原更新弹窗", () => {
    renderPrompt(true);
    fireEvent.click(
      screen.getByRole("button", { name: "settings.releaseNotes" }),
    );
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "关闭公告中心" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "settings.updateNow" }),
    ).toBeInTheDocument();
    expect(updateContextMock.remindLater).not.toHaveBeenCalled();
    expect(updateContextMock.ignoreUpdate).not.toHaveBeenCalled();
    expect(updateContextMock.startUpdate).not.toHaveBeenCalled();
  });
});
