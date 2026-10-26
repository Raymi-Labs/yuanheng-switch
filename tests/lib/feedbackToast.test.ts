import { toast } from "@/lib/toast";
import { clearFeedbackErrors, getFeedbackErrors } from "@/lib/errorFeedback";
import {
  FEEDBACK_OPEN_EVENT,
  updateFeedbackContext,
} from "@/lib/feedbackContext";

const sonner = vi.hoisted(() => {
  const callable = vi.fn();
  return Object.assign(callable, {
    error: vi.fn(() => "error-toast-id"),
    success: vi.fn(() => "success-toast-id"),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    promise: vi.fn(),
    custom: vi.fn(),
    getHistory: vi.fn(),
    getToasts: vi.fn(),
  });
});

vi.mock("sonner", () => ({ toast: sonner }));

function setAccount(userId: string) {
  updateFeedbackContext(
    { userId, view: "workspace", tool: "dsh" },
    "https://meta-api.vip",
  );
}

describe("feedback toast adapter", () => {
  beforeEach(() => {
    setAccount("42");
    clearFeedbackErrors();
    sonner.mockClear();
    sonner.error.mockClear();
    sonner.success.mockClear();
    sonner.dismiss.mockClear();
  });

  it("retains Sonner's API and only captures errors", () => {
    toast("plain notification");
    expect(sonner).toHaveBeenCalledWith("plain notification");
    expect(toast.success("saved")).toBe("success-toast-id");
    toast.dismiss("old-toast");
    expect(sonner.success).toHaveBeenCalledWith("saved");
    expect(sonner.dismiss).toHaveBeenCalledWith("old-toast");
    expect(getFeedbackErrors()).toHaveLength(0);
    expect(toast.promise).toBe(sonner.promise);
    expect(toast.getHistory).toBe(sonner.getHistory);
  });

  it("adds a report action pointing at the sanitized captured error", () => {
    const handler = vi.fn();
    window.addEventListener(FEEDBACK_OPEN_EVENT, handler);
    try {
      const title = "Request failed api_key=private-secret";
      expect(
        toast.error(title, { description: "try again", id: "failure" }),
      ).toBe("error-toast-id");
      const entry = getFeedbackErrors()[0];
      expect(entry.message).toContain("try again");
      expect(entry.message).not.toContain("private-secret");
      const [message, options] = sonner.error.mock.calls[0] as unknown as [
        string,
        {
          id: string;
          duration: number;
          action: { label: string; onClick: () => void };
        },
      ];
      expect(message).toBe(title);
      expect(options.id).toBe("failure");
      expect(options.duration).toBe(8000);
      expect(options.action.label).toBe("反馈此问题");
      expect(handler).not.toHaveBeenCalled();
      options.action.onClick();
      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe(entry.id);
    } finally {
      window.removeEventListener(FEEDBACK_OPEN_EVENT, handler);
    }
  });

  it("preserves existing actions and durations, using only an unused action slot", () => {
    const action = { label: "Retry", onClick: vi.fn() };
    const cancel = { label: "Dismiss", onClick: vi.fn() };
    toast.error("failed", { action, duration: 0 });
    let options = (
      sonner.error.mock.calls[0] as unknown as [
        unknown,
        Record<string, unknown>,
      ]
    )[1];
    expect(options.action).toBe(action);
    expect(options.duration).toBe(0);
    expect(options.cancel).toEqual(
      expect.objectContaining({ label: "反馈此问题" }),
    );
    toast.error("failed again", { action, cancel });
    options = (
      sonner.error.mock.calls[1] as unknown as [
        unknown,
        Record<string, unknown>,
      ]
    )[1];
    expect(options.action).toBe(action);
    expect(options.cancel).toBe(cancel);
  });

  it("preserves complete Unicode characters at the native request length boundary", () => {
    toast.error(`${"x".repeat(1999)}😀尾部`);
    const message = getFeedbackErrors()[0].message;
    expect(Array.from(message)).toHaveLength(2000);
    expect(message).toBe(`${"x".repeat(1999)}😀`);
    // A lone surrogate is serialized as an escape rejected by Rust serde_json.
    expect(JSON.stringify(message)).not.toMatch(
      /\\u[dD][89aAbB][0-9a-fA-F]{2}/,
    );
  });

  it("does not reattach an old account's error when its stale toast is clicked", () => {
    const handler = vi.fn();
    window.addEventListener(FEEDBACK_OPEN_EVENT, handler);
    try {
      toast.error("private old-account error");
      const options = (
        sonner.error.mock.calls[0] as unknown as [
          unknown,
          { action: { onClick: () => void } },
        ]
      )[1];
      setAccount("43");
      expect(getFeedbackErrors()).toHaveLength(0);
      options.action.onClick();
      expect((handler.mock.calls[0][0] as CustomEvent).detail).toBeNull();
    } finally {
      window.removeEventListener(FEEDBACK_OPEN_EVENT, handler);
    }
  });
});
