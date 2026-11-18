import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSidebar } from "@/components/desktop/DesktopSidebar";

const { openExternalMock, openTopupMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  openTopupMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  settingsApi: {
    openExternal: openExternalMock,
  },
  yuanhengApi: {
    openTopup: openTopupMock,
  },
}));

describe("DesktopSidebar", () => {
  it.each([undefined, null, NaN, 0, -1, 10])(
    "余额 %s 不将未知值显示为零",
    (remainingUsd) => {
      render(
        <DesktopSidebar
          view="home"
          onNavigate={vi.fn()}
          proxyRunning={false}
          helpOpen={false}
          onHelpOpenChange={vi.fn()}
          connection={
            {
              connected: true,
              userId: "1",
              account:
                remainingUsd === undefined
                  ? undefined
                  : { username: "test", remainingUsd },
              baseUrl: "https://example.test",
              models: [],
              groups: [],
            } as any
          }
        />,
      );
      if (typeof remainingUsd === "number" && Number.isFinite(remainingUsd))
        expect(
          screen.getByText(`$${remainingUsd.toFixed(2)}`),
        ).toBeInTheDocument();
      else {
        expect(screen.getByText("余额暂未同步")).toBeInTheDocument();
        expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
      }
    },
  );
  beforeEach(() => {
    openExternalMock.mockReset().mockResolvedValue(undefined);
    openTopupMock.mockReset().mockResolvedValue(true);
  });

  it("在侧边栏底部提供官网入口", async () => {
    render(
      <DesktopSidebar
        view="home"
        onNavigate={vi.fn()}
        proxyRunning={false}
        helpOpen={false}
        onHelpOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "访问元衡官网" }));

    await waitFor(() => {
      expect(openExternalMock).toHaveBeenCalledWith("https://meta-api.com");
    });
  });

  it("已登录时可直接打开充值窗口", async () => {
    render(
      <DesktopSidebar
        view="home"
        onNavigate={vi.fn()}
        proxyRunning={false}
        helpOpen={false}
        onHelpOpenChange={vi.fn()}
        connection={{
          connected: true,
          baseUrl: "https://cn.meta-api.vip",
          userId: "1024",
          account: {
            username: "tester",
            displayName: "测试用户",
            group: "default",
            remainingUsd: 10,
            usedUsd: 1,
          },
          models: [],
          groups: [],
          modelGroups: {},
          reasoningLevels: {},
          announcement: null,
          lastSyncedAt: null,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "充值" }));

    await waitFor(() => {
      expect(openTopupMock).toHaveBeenCalledTimes(1);
    });
  });

  it("提供声音克隆入口并支持导航", () => {
    const onNavigate = vi.fn();
    render(
      <DesktopSidebar
        view="home"
        onNavigate={onNavigate}
        proxyRunning={false}
        helpOpen={false}
        onHelpOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "声音克隆" }));
    expect(onNavigate).toHaveBeenCalledWith("voiceClone");
    const buttons = screen.getAllByRole("button");
    const voice = screen.getByRole("button", { name: "声音克隆" });
    const media = screen.getByRole("button", { name: "图片与视频" });
    expect(buttons.indexOf(media)).toBe(buttons.indexOf(voice) + 1);
    fireEvent.click(media);
    expect(onNavigate).toHaveBeenLastCalledWith("mediaStudio");
  });

  it("帮助位于主导航外，打开说明不导航，关闭后恢复入口焦点", async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    function Sidebar() {
      const [open, setOpen] = useState(false);
      return (
        <DesktopSidebar
          view="tools"
          onNavigate={onNavigate}
          proxyRunning={false}
          helpOpen={open}
          onHelpOpenChange={setOpen}
        />
      );
    }
    render(<Sidebar />);
    const help = screen.getByRole("button", { name: "帮助" });
    expect(help.closest("nav")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "使用说明" }),
    ).not.toBeInTheDocument();
    await user.click(help);
    expect(screen.getByRole("dialog", { name: "使用说明" })).toBeVisible();
    expect(
      screen.getByText("使用说明随客户端更新，可离线查看。"),
    ).toBeVisible();
    expect(onNavigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "关闭帮助" }));
    await waitFor(() => expect(help).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
