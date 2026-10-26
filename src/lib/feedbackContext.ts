import { setFeedbackScope } from "./errorFeedback";

export interface FeedbackContext {
  userId: string | null;
  view: string;
  tool: string;
  scope: number;
}

let current: FeedbackContext = {
  userId: null,
  view: "startup",
  tool: "unknown",
  scope: 0,
};
let accountKey = "";
const listeners = new Set<() => void>();
export const FEEDBACK_OPEN_EVENT = "yuanheng:open-error-feedback";

export function updateFeedbackContext(
  next: Omit<FeedbackContext, "scope">,
  baseUrl = "",
): void {
  const nextKey = `${baseUrl}:${next.userId ?? "signed-out"}`;
  const changed = accountKey !== nextKey;
  if (!changed && current.view === next.view && current.tool === next.tool)
    return;
  accountKey = nextKey;
  if (changed) setFeedbackScope(nextKey);
  current = { ...next, scope: current.scope + (changed ? 1 : 0) };
  listeners.forEach((listener) => listener());
}

export const getFeedbackContext = () => current;
export function subscribeFeedbackContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openErrorFeedback(errorId?: string): void {
  window.dispatchEvent(
    new CustomEvent(FEEDBACK_OPEN_EVENT, { detail: errorId }),
  );
}
