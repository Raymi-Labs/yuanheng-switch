import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server";
import {
  RELEASE_NOTES_CACHE_KEY,
  RELEASE_NOTES_SEEN_KEY,
  releaseNoteIdentity,
} from "@/lib/desktopReleaseNotes";
import { openAnnouncementCenter } from "@/lib/announcementCenter";
import {
  announcementToPlainText,
  PlatformAnnouncementCenter,
  DesktopAnnouncementCenter,
  summarizeAnnouncement,
  getAnnouncementIdentity,
} from "@/components/desktop/PlatformAnnouncementCenter";
import { setYuanhengAnnouncements } from "../msw/state";
import { createTestQueryClient } from "../utils/testQueryClient";
import bundledFeed from "@/data/desktop-release-notes.json";

const [currentRelease, previousRelease] = bundledFeed.releases;
function futureVersion(increment: number): string {
  const [major, minor, patch] = currentRelease.version.split(".").map(Number);
  return `${major}.${minor}.${patch + increment}`;
}

function renderCenter() {
  const client = createTestQueryClient();
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, retryDelay: 0 },
  });
  return render(
    <QueryClientProvider client={client}>
      <PlatformAnnouncementCenter />
      <DesktopAnnouncementCenter />
    </QueryClientProvider>,
  );
}

describe("PlatformAnnouncementCenter", () => {
  beforeEach(() => {
    localStorage.removeItem("yuanheng.dashboard.announcement-dismissed.v2");
    localStorage.removeItem(RELEASE_NOTES_CACHE_KEY);
    localStorage.removeItem(RELEASE_NOTES_SEEN_KEY);
    setYuanhengAnnouncements({
      enabled: true,
      source: "platform",
      announcements: [],
    });
  });

  it("清理平台 Markdown 和旧版 HTML 后生成摘要", () => {
    expect(
      summarizeAnnouncement(
        "【分组调整】\n\n- `vip` 改为 **OpenAI · 优质**\n- 旧令牌需手动修改",
      ),
    ).toBe("【分组调整】 · • vip 改为 OpenAI · 优质");
    expect(
      announcementToPlainText(
        "<style>.notice{color:red}</style><h1>平台公告</h1><p>服务已恢复。</p>",
      ),
    ).toBe("平台公告\n服务已恢复。");
  });

  it("无需登录即可展示平台最新公告并查看历史", async () => {
    setYuanhengAnnouncements({
      enabled: true,
      source: "platform",
      announcements: [
        {
          id: "34",
          content:
            "【平台分组名称调整说明】\n\n历史令牌仍显示旧分组，需要手动修改。",
          extra: "以创建令牌页面实时显示为准。",
          publishDate: "2026-07-28T02:41:25.745Z",
          type: "warning",
        },
        {
          id: "33",
          content: "【Grok 4.5 模型上线公告】\n\n模型现已正式上线。",
          extra: null,
          publishDate: "2026-07-26T17:31:00.956Z",
          type: "success",
        },
      ],
    });

    renderCenter();

    await waitFor(() =>
      expect(localStorage.getItem(RELEASE_NOTES_CACHE_KEY)).not.toBeNull(),
    );
    expect(
      screen.queryByText("历史令牌仍显示旧分组，需要手动修改。"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
    fireEvent.click(screen.getByRole("button", { name: /平台通知/ }));
    await screen.findByText("以创建令牌页面实时显示为准。");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText("与元衡平台公告中心同步，每分钟自动检查更新"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("以创建令牌页面实时显示为准。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Grok 4\.5 模型上线公告/));
    expect(
      screen.getByText("【Grok 4.5 模型上线公告】 模型现已正式上线。"),
    ).toBeInTheDocument();
  });

  it("标记已读后保留公告中心入口", async () => {
    setYuanhengAnnouncements({
      enabled: true,
      source: "platform",
      announcements: [
        {
          id: "34",
          content: "平台公告内容",
          extra: null,
          publishDate: "2026-07-28T02:41:25.745Z",
          type: "default",
        },
      ],
    });

    renderCenter();
    fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
    fireEvent.click(screen.getByRole("button", { name: /平台通知/ }));
    await screen.findAllByText("平台公告内容");
    fireEvent.click(screen.getByRole("button", { name: "关闭公告中心" }));
    expect(
      screen.getByRole("button", { name: "公告中心" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("announcement-notification-dot"),
    ).not.toBeInTheDocument();
  });

  it("旧清单或已是最新版仍可查看两版公告，不自动弹窗", async () => {
    renderCenter();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText("仅展示最近两次客户端更新，不累计历史记录。"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getAllByText(`v${currentRelease.version}`),
    ).toHaveLength(2);
    expect(
      within(dialog).getByText(`v${previousRelease.version}`),
    ).toBeInTheDocument();
    expect(
      new Set(
        within(dialog)
          .getAllByText(/^v\d+\.\d+\.\d+$/)
          .map((node) => node.textContent),
      ),
    ).toEqual(
      new Set([`v${currentRelease.version}`, `v${previousRelease.version}`]),
    );
    const pane = dialog.querySelector("article")!.parentElement!;
    pane.scrollTop = 100;
    fireEvent.click(within(dialog).getByText(`v${previousRelease.version}`));
    expect(pane.scrollTop).toBe(0);
    expect(dialog.querySelector("article")).toHaveTextContent(
      previousRelease.content.replace(/\s+/g, " "),
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭公告中心" }));
    expect(
      screen.getByRole("button", { name: /公告中心/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("announcement-notification-dot"),
    ).not.toBeInTheDocument();
  });

  it("服务端返回更多版本也只展示两次，正文不会执行 HTML 或创建外部链接", async () => {
    server.use(
      http.post("http://tauri.local/get_desktop_release_notes", () =>
        HttpResponse.json(
          [futureVersion(2), futureVersion(1), currentRelease.version].map(
            (version) => ({
              version,
              publishedAt: "2026-09-06T00:00:00Z",
              content: `公告 ${version}\n<img src="https://evil.test/track"><script>alert(1)</script>`,
            }),
          ),
        ),
      ),
    );
    renderCenter();
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(RELEASE_NOTES_CACHE_KEY)!)[0].version,
      ).toBe(futureVersion(2)),
    );
    fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(`v${futureVersion(1)}`),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText(`v${currentRelease.version}`),
    ).not.toBeInTheDocument();
    expect(dialog.querySelector("img, script, a")).toBeNull();
    expect(
      JSON.parse(localStorage.getItem(RELEASE_NOTES_CACHE_KEY)!),
    ).toHaveLength(2);
  });

  it("关于和更新弹窗共用内部窗口，网络错误仍展示本地公告", async () => {
    server.use(
      http.post("http://tauri.local/get_desktop_release_notes", () =>
        HttpResponse.json({ error: "offline" }, { status: 503 }),
      ),
    );
    renderCenter();
    act(() => openAnnouncementCenter("updates"));
    expect(
      await screen.findByText("暂时无法同步，正在显示本地保存的最近两次更新。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getAllByText(`v${currentRelease.version}`).length,
    ).toBeGreaterThan(0);
  });

  it("已读标记不累计历史，存储写入失败也不会阻止阅读", async () => {
    renderCenter();
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("full");
      });
    try {
      fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
      fireEvent.click(screen.getByRole("button", { name: "关闭公告中心" }));
      expect(
        screen.queryByTestId("announcement-notification-dot"),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
      await waitFor(() =>
        expect(screen.getByRole("dialog")).toBeInTheDocument(),
      );
    } finally {
      write.mockRestore();
    }
  });

  it("本机存储完全禁用时，公告区和内部窗口仍可用", () => {
    const read = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("disabled");
      });
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("disabled");
      });
    try {
      renderCenter();
      fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it("缓存尚未过期时，手动打开仍会刷新刚发布的最近两版", async () => {
    let latest = 1;
    server.use(
      http.post("http://tauri.local/get_desktop_release_notes", () =>
        HttpResponse.json(
          [latest, latest - 1].map((version) => ({
            version: futureVersion(version),
            publishedAt: "2026-09-06T00:00:00Z",
            content: `版本 ${futureVersion(version)} 的更新说明`,
          })),
        ),
      ),
    );
    renderCenter();
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(RELEASE_NOTES_CACHE_KEY)!)[0].version,
      ).toBe(futureVersion(1)),
    );
    latest = 2;
    fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
    const dialog = screen.getByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getAllByText(`v${futureVersion(2)}`)).toHaveLength(
        2,
      ),
    );
    expect(
      within(dialog).getByText(`v${futureVersion(1)}`),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText(`v${currentRelease.version}`),
    ).not.toBeInTheDocument();
  });
  it("分类独立已读，刷新保留，平台正文变化后再次提醒", async () => {
    const notice = {
      id: "34",
      content: "第一版公告",
      extra: null,
      publishDate: "2026-10-13T00:00:00Z",
      type: "default" as const,
    };
    setYuanhengAnnouncements({
      enabled: true,
      source: "platform",
      announcements: [notice],
    });
    const first = renderCenter();
    fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
    fireEvent.click(screen.getByRole("button", { name: "关闭公告中心" }));
    await waitFor(() =>
      expect(
        screen.getByTestId("announcement-notification-dot"),
      ).toBeInTheDocument(),
    );
    // Only platform remains unread, so the bell opens that category directly.
    fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
    await screen.findAllByText("第一版公告");
    fireEvent.click(screen.getByRole("button", { name: "关闭公告中心" }));
    expect(localStorage.getItem(RELEASE_NOTES_SEEN_KEY)).toBe(
      releaseNoteIdentity(currentRelease),
    );
    expect(
      localStorage.getItem("yuanheng.dashboard.announcement-dismissed.v2"),
    ).toBe(getAnnouncementIdentity(notice));
    first.unmount();
    const second = renderCenter();
    await waitFor(() =>
      expect(
        screen.queryByTestId("announcement-notification-dot"),
      ).not.toBeInTheDocument(),
    );
    second.unmount();
    setYuanhengAnnouncements({
      enabled: true,
      source: "platform",
      announcements: [{ ...notice, content: "更新后的公告" }],
    });
    renderCenter();
    await screen.findByTestId("announcement-notification-dot");
    fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
    await screen.findAllByText("更新后的公告");
  });
  it("平台同步失败留在窗口内提示，并可直接重试", async () => {
    let offline = true;
    server.use(
      http.post("http://tauri.local/get_yuanheng_announcements", () =>
        offline
          ? HttpResponse.json({ error: "offline" }, { status: 503 })
          : HttpResponse.json({
              enabled: true,
              source: "platform",
              announcements: [],
            }),
      ),
    );
    renderCenter();
    expect(screen.queryByText("平台公告暂时同步失败")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /公告中心/ }));
    fireEvent.click(screen.getByRole("button", { name: /平台通知/ }));
    await screen.findByText("平台公告暂时同步失败");
    offline = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("已同步，暂无公告");
  });
});
