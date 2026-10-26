import { invoke } from "@tauri-apps/api/core";

export interface DesktopFeedbackError {
  occurredAt: string;
  source: string;
  message: string;
}

export interface DesktopFeedbackRequest {
  /** Reuse this UUID when retrying the same report after an uncertain result. */
  reportId: string;
  description: string;
  context: { view: string; tool: string };
  errors: DesktopFeedbackError[];
}

export interface DesktopFeedbackReceipt {
  id: number;
  status: "pending" | "in_progress" | "resolved";
  /** Unix timestamp in seconds. */
  createdAt: number;
}

export const desktopFeedbackApi = {
  /** Native code supplies the app version/platform and current account session. */
  submit: (request: DesktopFeedbackRequest, expectedUserId: string) =>
    invoke<DesktopFeedbackReceipt>("submit_desktop_feedback", {
      request,
      expectedUserId,
    }),
};
