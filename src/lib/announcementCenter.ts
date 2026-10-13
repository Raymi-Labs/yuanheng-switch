export type AnnouncementCategory = "updates" | "platform";
export const OPEN_ANNOUNCEMENTS_EVENT = "yuanheng:open-announcements";
export const PLATFORM_ANNOUNCEMENT_READ_EVENT = "yuanheng:platform-notice-read";
export const RELEASE_ANNOUNCEMENT_READ_EVENT = "yuanheng:release-note-read";

export interface AnnouncementRequest {
  category: AnnouncementCategory;
}

/** Only local UI state is dispatched; no URL, credential or external navigation. */
export function openAnnouncementCenter(
  category: AnnouncementCategory = "updates",
): void {
  window.dispatchEvent(
    new CustomEvent<AnnouncementRequest>(OPEN_ANNOUNCEMENTS_EVENT, {
      detail: { category },
    }),
  );
}
