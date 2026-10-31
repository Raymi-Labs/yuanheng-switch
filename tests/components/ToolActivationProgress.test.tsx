import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolActivationProgress } from "@/components/desktop/ToolActivationProgress";
vi.mock("@/components/desktop/ToolDiagnosticDialog", () => ({
  ToolDiagnosticDialog: () => <button>诊断与报告</button>,
}));

describe("ToolActivationProgress", () => {
  it("refreshes on demand and identifies failed refreshes as stale", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = render(<ToolActivationProgress onRefresh={refresh} />);
    expect(screen.getByText("等待状态检查")).toBeInTheDocument();
    expect(screen.queryByText("无需本地路由")).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    view.rerender(<ToolActivationProgress onRefresh={refresh} refreshing />);
    expect(screen.getByRole("button", { name: "检查中…" })).toBeDisabled();
    view.rerender(<ToolActivationProgress onRefresh={refresh} refreshFailed />);
    expect(screen.getByRole("status")).toHaveTextContent("状态刷新失败");
    expect(screen.getByRole("button", { name: "诊断与报告" })).toBeEnabled();
  });
  it.each(["codex", "claude-desktop", "chatgpt-desktop"] as const)(
    "does not claim %s is currently ready when its route stopped",
    (app) => {
      render(
        <ToolActivationProgress
          activation={{
            app,
            configuredAt: 1,
            configWritten: true,
            routeRequired: true,
            routeReady: false,
            requestReceived: true,
            requestSucceeded: true,
            lastStatusCode: 200,
            lastRequestAt: 1,
            lastModel: "example",
            message: "",
          }}
        />,
      );
      expect(screen.queryByText("客户端已就绪")).not.toBeInTheDocument();
      expect(screen.queryByText("模型调用成功")).not.toBeInTheDocument();
      expect(screen.getByText("本地连接尚未就绪")).toBeInTheDocument();
    },
  );
  it("does not label incomplete HTTP 200 as a completed Codex request", () => {
    render(
      <ToolActivationProgress
        activation={{
          app: "codex",
          configuredAt: 1,
          configWritten: true,
          routeRequired: true,
          routeReady: true,
          requestReceived: true,
          requestSucceeded: false,
          lastStatusCode: 200,
          lastRequestAt: 1,
          lastModel: "example",
          message: "",
        }}
      />,
    );
    expect(screen.getByText("请求完成情况待确认")).toBeInTheDocument();
    expect(screen.queryByText("调用失败（HTTP 200）")).not.toBeInTheDocument();
  });
  it("does not treat previous Accio replies as a currently connected app", () => {
    render(
      <ToolActivationProgress
        activation={{
          app: "accio-work",
          configuredAt: 1,
          configWritten: true,
          routeRequired: true,
          routeReady: false,
          requestReceived: true,
          requestSucceeded: true,
          lastStatusCode: 200,
          lastRequestAt: 1,
          lastModel: "sol",
          message: "请从元衡启动",
        }}
      />,
    );
    expect(screen.getByText("配置已保存")).toBeInTheDocument();
    expect(screen.queryByText("模型调用成功")).not.toBeInTheDocument();
    expect(screen.queryByText("客户端已就绪")).not.toBeInTheDocument();
  });

  it("reports unknown Accio output instead of claiming HTTP 200 means success", () => {
    render(
      <ToolActivationProgress
        activation={{
          app: "accio-work",
          configuredAt: 1,
          configWritten: true,
          routeRequired: true,
          routeReady: true,
          requestReceived: true,
          requestSucceeded: false,
          lastStatusCode: 200,
          lastRequestAt: 1,
          lastModel: "sol",
          message: "尚未确认",
        }}
      />,
    );
    expect(screen.getByText("尚未确认模型输出")).toBeInTheDocument();
    expect(screen.queryByText("调用失败（HTTP 200）")).not.toBeInTheDocument();
    expect(screen.queryByText("模型调用成功")).not.toBeInTheDocument();
  });
  it("shows the verified activation chain while waiting for the first request", () => {
    render(
      <ToolActivationProgress
        activation={{
          app: "codex",
          configuredAt: 1,
          configWritten: true,
          routeRequired: true,
          routeReady: true,
          requestReceived: false,
          requestSucceeded: false,
          lastRequestAt: null,
          lastStatusCode: null,
          lastModel: null,
          message: "配置与路由已就绪，等待工具发出第一条请求",
        }}
        preflight={{
          app: "codex",
          model: "gpt-5.6-sol",
          group: "premium",
          status: "ok",
          sourceProtocol: "openai_responses",
          targetProtocol: "openai_responses",
          streamingSupported: true,
          toolCall: "unknown",
          reasoningSupported: true,
          imageInput: "unknown",
          checks: [],
          message: "兼容性预检通过，可以安全配置",
        }}
      />,
    );

    expect(screen.getByText("预检通过")).toBeInTheDocument();
    expect(screen.getByText("配置已写入")).toBeInTheDocument();
    expect(screen.getByText("路由已启动")).toBeInTheDocument();
    expect(screen.getByText("等待请求记录")).toBeInTheDocument();
    expect(screen.getByText("等待调用验证")).toBeInTheDocument();
    expect(screen.queryByText("客户端已就绪")).not.toBeInTheDocument();
    expect(screen.queryByText("已收到请求")).not.toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeNull();
    expect(
      screen.getByText("本地配置已就绪，等待实际请求"),
    ).toBeInTheDocument();
  });

  it("shows 401 and recovery instructions even in a compact card without a config timestamp", () => {
    render(
      <ToolActivationProgress
        compact
        activation={{
          app: "chatgpt-desktop",
          configuredAt: null,
          configWritten: true,
          routeRequired: true,
          routeReady: true,
          requestReceived: true,
          requestSucceeded: false,
          lastStatusCode: 401,
          lastRequestAt: 1,
          lastModel: "test-model",
          message: "工具分组凭据被拒绝，请重新配置",
        }}
      />,
    );
    expect(screen.getByText("调用失败（HTTP 401）")).toBeInTheDocument();
    expect(
      screen.getByText(/请检查当前分组的模型权限与凭据/),
    ).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("does not claim request success for tools outside the local route", () => {
    render(
      <ToolActivationProgress
        activation={{
          app: "opencode",
          configuredAt: 1,
          configWritten: true,
          routeRequired: false,
          routeReady: true,
          requestReceived: false,
          requestSucceeded: false,
          lastRequestAt: null,
          lastStatusCode: null,
          lastModel: null,
          message: "该工具请求不可观测",
        }}
      />,
    );

    expect(screen.getByText("请求不可观测")).toBeInTheDocument();
  });
});
