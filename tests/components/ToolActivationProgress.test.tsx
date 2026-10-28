import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolActivationProgress } from "@/components/desktop/ToolActivationProgress";

describe("ToolActivationProgress", () => {
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
      screen.getByText("配置与路由已就绪，等待工具发出第一条请求"),
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
      screen.getByText("工具分组凭据被拒绝，请重新配置"),
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
