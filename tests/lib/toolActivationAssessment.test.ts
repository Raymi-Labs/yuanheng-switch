import { describe, expect, it } from "vitest";
import type { YuanhengToolActivationStatus } from "@/lib/api";
import { assessToolActivation } from "@/lib/toolActivationAssessment";

const ready: YuanhengToolActivationStatus = {
  app: "codex",
  configWritten: true,
  configuredAt: 1,
  routeRequired: true,
  routeReady: true,
  requestReceived: true,
  requestSucceeded: true,
  lastStatusCode: 200,
  lastRequestAt: 2,
  lastModel: "example",
  message: "",
};

describe("evidence based tool guidance", () => {
  it("requires current configuration, route and completed evidence for success", () => {
    expect(assessToolActivation(ready).ok).toBe(true);
    for (const change of [
      { configWritten: false },
      { routeReady: false },
      { routeRequired: false },
      { requestReceived: false },
      { requestSucceeded: false },
      { configuredAt: null },
      { lastStatusCode: 500 },
    ])
      expect(assessToolActivation({ ...ready, ...change }).ok).toBe(false);
    expect(assessToolActivation(ready, true).ok).toBe(false);
    expect(assessToolActivation().ok).toBe(false);
  });
  it.each([
    [401, "请求被拒绝"],
    [403, "请求被拒绝"],
    [402, "请核对账户额度"],
    [429, "请求受到限制"],
    [408, "请求等待超时"],
    [504, "请求等待超时"],
    [500, "请求处理异常"],
    [503, "请求处理异常"],
    [400, "请求尚未成功"],
    [null, "请求尚未成功"],
    [200, "请求完成情况待确认"],
  ])("handles HTTP %s without inferring fault ownership", (code, title) => {
    expect(
      assessToolActivation({
        ...ready,
        requestSucceeded: false,
        lastStatusCode: code,
      }).title,
    ).toBe(title);
  });
  it("never includes untrusted errors, model names or credentials in its advice", () => {
    const result = assessToolActivation({
      ...ready,
      requestSucceeded: false,
      lastStatusCode: 403,
      message: "secret-user-token",
      lastModel: "private-account",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret-user-token|private-account/,
    );
    expect(result.message).toContain("不能仅凭状态码认定账号封禁");
  });
});
