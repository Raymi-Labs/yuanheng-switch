import { invoke } from "@tauri-apps/api/core";
import type { YuanhengConnectionStatus } from "./yuanheng";
export interface BrowserLoginAttempt {
  attemptId: string;
  displayCode: string;
  expiresIn: number;
}
export const browserLoginApi = {
  providers: () => invoke<string[]>("get_yuanheng_browser_login_providers"),
  start: (provider: string) =>
    invoke<BrowserLoginAttempt>("start_yuanheng_browser_login", { provider }),
  poll: (attemptId: string) =>
    invoke<{ status: string; connection: YuanhengConnectionStatus | null }>(
      "poll_yuanheng_browser_login",
      { attemptId },
    ),
  cancel: (attemptId?: string) =>
    invoke<void>("cancel_yuanheng_browser_login", {
      attemptId: attemptId ?? null,
    }),
};
