import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import i18n from "i18next";
import { ErrorFeedbackDialog } from "@/components/desktop/ErrorFeedbackDialog";
import {
  clearFeedbackErrors,
  getFeedbackErrors,
  recordFeedbackError,
} from "@/lib/errorFeedback";
import {
  openErrorFeedback,
  updateFeedbackContext,
} from "@/lib/feedbackContext";
import type { DesktopFeedbackReceipt } from "@/lib/api/desktopFeedback";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  copy: vi.fn(),
  version: vi.fn(),
}));

vi.mock("@/lib/api/desktopFeedback", () => ({
  desktopFeedbackApi: { submit: mocks.submit },
}));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copy }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.version }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function setAccount(userId: string | null) {
  updateFeedbackContext(
    { userId, view: userId ? "workspace" : "login", tool: "dsh" },
    "https://meta-api.vip",
  );
}

function open(errorId?: string) {
  act(() => openErrorFeedback(errorId));
}

function describeProblem(value: string) {
  fireEvent.change(screen.getByLabelText("feedback.description"), {
    target: { value },
  });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "feedback.submit" }));
}

function receipt(id: number): DesktopFeedbackReceipt {
  return { id, status: "pending", createdAt: 1793000000 };
}

describe("ErrorFeedbackDialog", () => {
  beforeEach(() => {
    mocks.submit.mockReset();
    mocks.copy.mockReset().mockResolvedValue(undefined);
    mocks.version.mockReset().mockResolvedValue("0.1.107");
    i18n.addResourceBundle("zh", "translation", {
      feedback: { received: "反馈已收到 #{{id}}" },
    });
    setAccount("42");
    clearFeedbackErrors();
  });

  it("previews only sanitized selected errors and waits for a platform receipt", async () => {
    recordFeedbackError("notification", "another unrelated failure");
    const selected = recordFeedbackError(
      "notification",
      "读取账号模型失败 https://meta-api.vip/api/user/models?group=private-group",
    );
    const pending = deferred<DesktopFeedbackReceipt>();
    mocks.submit.mockReturnValue(pending.promise);
    render(<ErrorFeedbackDialog />);
    open(selected.id);
    await waitFor(() => expect(mocks.version).toHaveBeenCalledTimes(1));
    expect(mocks.submit).not.toHaveBeenCalled();
    describeProblem("刷新模型失败，Authorization: Bearer sk-private-secret");

    const preview = screen.getByTestId("feedback-preview");
    expect(preview.textContent).not.toContain("private-group");
    expect(preview.textContent).not.toContain("sk-private-secret");
    expect(preview.textContent).not.toContain("another unrelated failure");
    const content = JSON.parse(preview.textContent ?? "{}");
    submit();
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    const [request, expectedUserId] = mocks.submit.mock.calls[0];
    expect(expectedUserId).toBe("42");
    expect(request).toEqual({
      reportId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      description: content.description,
      context: content.context,
      errors: content.errors,
    });
    expect(request.errors).toHaveLength(1);
    expect(request.errors[0]).not.toHaveProperty("id");
    expect(
      screen.getByRole("button", { name: "feedback.submitting" }),
    ).toBeDisabled();
    expect(screen.queryByText(/反馈已收到/)).not.toBeInTheDocument();
    await act(async () => pending.resolve(receipt(17)));
    expect(screen.getByText("反馈已收到 #17")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("feedback.description"),
    ).not.toBeInTheDocument();
  });

  it("retains an uncertain report ID for retries, blocks duplicates and uses a new ID after edits", async () => {
    const first = deferred<DesktopFeedbackReceipt>();
    mocks.submit.mockReturnValueOnce(first.promise);
    render(<ErrorFeedbackDialog />);
    open();
    describeProblem("同一份问题描述");
    submit();
    fireEvent.click(
      screen.getByRole("button", { name: "feedback.submitting" }),
    );
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    await act(async () =>
      first.reject("网络中断，token=private-server-secret"),
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "private-server-secret",
    );
    expect(screen.getByLabelText("feedback.description")).toHaveValue(
      "同一份问题描述",
    );

    mocks.submit.mockRejectedValueOnce("still offline");
    submit();
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "feedback.submit" }),
      ).toBeEnabled(),
    );
    expect(mocks.submit.mock.calls[1][0]).toEqual(
      mocks.submit.mock.calls[0][0],
    );

    describeProblem("补充了新的复现步骤");
    mocks.submit.mockResolvedValueOnce(receipt(18));
    submit();
    await screen.findByText("反馈已收到 #18");
    expect(mocks.submit.mock.calls[2][0].reportId).not.toBe(
      mocks.submit.mock.calls[0][0].reportId,
    );
  });

  it("clears private drafts on account changes and ignores a previous account's late result", async () => {
    recordFeedbackError("notification", "old account failure");
    const previous = deferred<DesktopFeedbackReceipt>();
    const current = deferred<DesktopFeedbackReceipt>();
    mocks.submit
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    render(<ErrorFeedbackDialog />);
    open();
    describeProblem("旧账号的描述");
    submit();

    act(() => setAccount("43"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(getFeedbackErrors()).toHaveLength(0);
    open();
    expect(screen.getByLabelText("feedback.description")).toHaveValue("");
    expect(screen.getByTestId("feedback-preview")).not.toHaveTextContent(
      "old account failure",
    );
    describeProblem("新账号的问题");
    submit();
    expect(mocks.submit.mock.calls[1][1]).toBe("43");
    await act(async () => previous.resolve(receipt(99)));
    expect(screen.queryByText("反馈已收到 #99")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "feedback.submitting" }),
    ).toBeDisabled();
    await act(async () => current.resolve(receipt(100)));
    expect(screen.getByText("反馈已收到 #100")).toBeInTheDocument();
  });

  it("allows signed-out users to copy a report without submitting or requiring app providers", async () => {
    setAccount(null);
    recordFeedbackError("window.error", "startup failure");
    render(<ErrorFeedbackDialog />);
    open();
    describeProblem("登录失败");
    expect(
      screen.getByRole("button", { name: "feedback.submit" }),
    ).toBeDisabled();
    expect(screen.getByText("feedback.loginRequired")).toBeInTheDocument();
    const previewAtClick = screen.getByTestId("feedback-preview").textContent;
    fireEvent.click(screen.getByRole("button", { name: "feedback.copy" }));
    await screen.findByText("feedback.copied");
    expect(mocks.copy).toHaveBeenCalledWith(previewAtClick);
    expect(mocks.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "feedback.close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
