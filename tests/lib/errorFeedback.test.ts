import {
  clearFeedbackErrors,
  getFeedbackErrors,
  recordFeedbackError,
  sanitizeFeedbackText,
  setFeedbackScope,
  subscribeFeedbackErrors,
} from "@/lib/errorFeedback";
import { reportFrontendError } from "@/lib/frontendLogger";

vi.mock("@tauri-apps/plugin-log", () => ({
  error: vi.fn(() => Promise.resolve()),
}));

describe("error feedback", () => {
  beforeEach(() => {
    clearFeedbackErrors();
    setFeedbackScope("test-account");
  });

  it("keeps the newest ten bounded immutable messages with stable snapshots", () => {
    const original = getFeedbackErrors();
    expect(getFeedbackErrors()).toBe(original);
    for (let index = 0; index < 12; index += 1) {
      recordFeedbackError("x".repeat(100), `${index}: ${"y".repeat(3_000)}`);
    }

    const snapshot = getFeedbackErrors();
    expect(snapshot).toHaveLength(10);
    expect(snapshot[0].message).toHaveLength(2_000);
    expect(snapshot[0].source).toHaveLength(64);
    expect(snapshot[0].message).toMatch(/^11:/);
    expect(snapshot[9].message).toMatch(/^2:/);
    expect(new Set(snapshot.map((item) => item.id)).size).toBe(10);
    expect(
      snapshot.every((item) => !Number.isNaN(Date.parse(item.occurredAt))),
    ).toBe(true);
    expect(getFeedbackErrors()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(original).toHaveLength(0);
  });

  it("notifies subscribers only on changes and clears when account scope changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFeedbackErrors(listener);
    const entry = recordFeedbackError("models", "catalog unavailable");
    const snapshot = getFeedbackErrors();
    expect(listener).toHaveBeenCalledTimes(1);

    setFeedbackScope("test-account");
    expect(getFeedbackErrors()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    setFeedbackScope("https://private.example|another-account");
    expect(getFeedbackErrors()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(entry)).not.toContain("test-account");

    unsubscribe();
    recordFeedbackError("models", "second failure");
    expect(listener).toHaveBeenCalledTimes(2);
    setFeedbackScope("signed-out");
    expect(getFeedbackErrors()).toHaveLength(0);
  });

  it("redacts credentials, URL credentials/query/fragment, email and user paths", () => {
    const safe = sanitizeFeedbackText(
      "读取账号模型失败 https://alice:password@example.test/api/user/models?group=private-group&api_key=secret#private-fragment\n" +
        "Authorization: Bearer bearer-secret\n" +
        "Cookie: session=cookie-secret; name=private\n" +
        'api_key: "secret with spaces"\n' +
        "support@private.example\n" +
        "file:///Users/private-user/Documents/private.txt\n" +
        "/home/private-linux/.config/account.json\n" +
        "C:\\Users\\Private User\\.config\\account.json\n" +
        "request sk-ant-api03-a-secret-key",
    );
    expect(safe).toContain("读取账号模型失败");
    expect(safe).toContain("https://example.test/api/user/models");
    for (const secret of [
      "alice",
      "password",
      "private-group",
      "secret#",
      "private-fragment",
      "bearer-secret",
      "cookie-secret",
      "secret with spaces",
      "support@private.example",
      "private-user",
      "private-linux",
      "Private User",
      "account.json",
      "sk-ant-api03-a-secret-key",
    ])
      expect(safe).not.toContain(secret);
  });

  it("redacts nested and malformed secret containers without keeping their payload", () => {
    const json = JSON.stringify({
      apiKeys: ["first-secret", { value: "nested-secret" }],
      auth: { credentials: ["another-secret"] },
      code: 403,
      message: "permission denied",
      stack: "private-stack",
    });
    const safe = sanitizeFeedbackText(json);
    expect(safe).toContain("403");
    expect(safe).toContain("permission denied");
    for (const secret of [
      "first-secret",
      "nested-secret",
      "another-secret",
      "private-stack",
    ]) {
      expect(safe).not.toContain(secret);
    }
    const prefixed = sanitizeFeedbackText(
      'Failure: {"tokens":[{"value":"nested-secret"}],"remaining":"payload"}',
    );
    expect(prefixed).toContain("Failure");
    expect(prefixed).not.toContain("nested-secret");
    expect(prefixed).not.toContain("payload");
    const escaped = sanitizeFeedbackText(
      'Failure: {\\"tokens\\":[\\"hidden-secret\\"]}',
    );
    expect(escaped).not.toContain("hidden-secret");
  });

  it("redacts known standalone tokens and private key blocks before truncation", () => {
    const safe = sanitizeFeedbackText(
      "ghp_abcdefghijk123 github_pat_abcdefgh123 AIzaABCDEFGHIJK12345 " +
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl\n" +
        "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    );
    expect(safe).not.toContain("abcdefgh");
    expect(safe).not.toContain("ABCDEFGHIJK");
    expect(safe).not.toContain("eyJ");
    expect(safe).not.toContain("private-material");
    expect(sanitizeFeedbackText(`api_key=${"secret".repeat(4_000)}`)).toBe(
      "[oversized text omitted]",
    );
    expect(sanitizeFeedbackText("hello", 3)).toBe("hel");
  });

  it("keeps already sanitized credentials stable and handles escaped Windows paths", () => {
    const safe = sanitizeFeedbackText(
      'failed api_key="credential"; retry at https://example.test/api?token=private#fragment',
    );
    expect(sanitizeFeedbackText(safe)).toBe(safe);
    expect(
      sanitizeFeedbackText(
        "failed at C:\\\\Users\\\\private-user\\\\secret-file",
      ),
    ).not.toContain("private-user");
  });

  it("records frontend failures without their stack, details or rejected object payload", () => {
    const failure = new Error("request failed token=private-token");
    failure.stack = "private-stack-contents";
    reportFrontendError("window.error", failure, "private-detail-location");
    const message = getFeedbackErrors()[0];
    expect(message.source).toBe("window.error");
    expect(message.message).toContain("request failed");
    expect(JSON.stringify(message)).not.toMatch(
      /private-(?:token|stack|detail)/,
    );

    recordFeedbackError("unhandledrejection", {
      message: "failed",
      stack: "secret-stack",
      body: "private-prompt",
    });
    expect(getFeedbackErrors()[0].message).toBe("failed");
    recordFeedbackError("unhandledrejection", { token: "private-token" });
    expect(getFeedbackErrors()[0].message).toBe("[non-text error omitted]");
    const getter = vi.fn(() => "private-getter-value");
    recordFeedbackError(
      "unhandledrejection",
      Object.defineProperty({}, "message", { get: getter }),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("cannot create a new error loop through a failed observer", () => {
    const unsubscribe = subscribeFeedbackErrors(() => {
      throw new Error("observer failed");
    });
    expect(() => recordFeedbackError("test", "original error")).not.toThrow();
    expect(getFeedbackErrors()).toHaveLength(1);
    unsubscribe();
  });

  it("normalizes native-compatible sources and omits unsupported control characters", () => {
    expect(recordFeedbackError("", " ").source).toBe("unknown");
    expect(recordFeedbackError("账号/models", "failed").source).toBe("unknown");
    expect(recordFeedbackError("window.error_2-3", "failed").source).toBe(
      "window.error_2-3",
    );
    expect(
      recordFeedbackError("source", "\u0000\u0007\u001B\u007F\u0085").message,
    ).toBe("[empty error]");
    expect(sanitizeFeedbackText("a\u0007b\tc\nd\re\u009Ff")).toBe(
      "ab\tc\nd\ref",
    );
  });
});
