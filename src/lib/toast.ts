import { toast as sonnerToast } from "sonner";
import i18n from "i18next";
import { recordFeedbackError } from "./errorFeedback";
import { getFeedbackContext, openErrorFeedback } from "./feedbackContext";

// Keep Sonner's callable API and existing actions. Only errors gain a report action.
const error: typeof sonnerToast.error = (message, options) => {
  const text = [message, options?.description]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const entry = recordFeedbackError("notification", text || "[non-text error]");
  const scope = getFeedbackContext().scope;
  const action = {
    label: i18n.t("feedback.reportError", { defaultValue: "反馈此问题" }),
    onClick: () =>
      openErrorFeedback(
        getFeedbackContext().scope === scope ? entry.id : undefined,
      ),
  };
  return sonnerToast.error(message, {
    ...options,
    duration: options?.duration ?? 8000,
    ...(options?.action
      ? options.cancel
        ? {}
        : { cancel: action }
      : { action }),
  });
};

export const toast = Object.assign(
  (...args: Parameters<typeof sonnerToast>) => sonnerToast(...args),
  sonnerToast,
  { error },
);
