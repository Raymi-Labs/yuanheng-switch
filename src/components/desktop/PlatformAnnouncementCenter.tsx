import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, Megaphone, X } from "lucide-react";
import type { YuanhengAnnouncement, YuanhengAnnouncementType } from "@/lib/api";
import { useYuanhengAnnouncements } from "@/lib/query/yuanheng";
import { useDesktopReleaseNotes } from "@/lib/query/desktopReleaseNotes";
import {
  RELEASE_NOTES_SEEN_KEY,
  releaseNoteIdentity,
} from "@/lib/desktopReleaseNotes";
import {
  OPEN_ANNOUNCEMENTS_EVENT,
  RELEASE_ANNOUNCEMENT_READ_EVENT,
  PLATFORM_ANNOUNCEMENT_READ_EVENT,
  openAnnouncementCenter,
  type AnnouncementCategory,
  type AnnouncementRequest,
} from "@/lib/announcementCenter";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { desktopLocale, dt } from "./desktopI18n";

const DISMISSED_ANNOUNCEMENT_KEY =
  "yuanheng.dashboard.announcement-dismissed.v2";
const SUMMARY_LIMIT = 128;

const TYPE_META: Record<
  YuanhengAnnouncementType,
  {
    label: string;
    badgeClass: string;
  }
> = {
  default: {
    label: "公告",
    badgeClass:
      "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  },
  ongoing: {
    label: "进行中",
    badgeClass:
      "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300",
  },
  success: {
    label: "已上线",
    badgeClass:
      "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  },
  warning: {
    label: "重要提醒",
    badgeClass:
      "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300",
  },
  error: {
    label: "紧急通知",
    badgeClass:
      "border-red-200 bg-red-100 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300",
  },
};

function htmlToPlainText(raw: string): string {
  if (typeof DOMParser === "undefined" || !/<[a-z][\s\S]*>/i.test(raw)) {
    return raw;
  }

  const document = new DOMParser().parseFromString(raw, "text/html");
  document
    .querySelectorAll("style, script, noscript, template")
    .forEach((node) => node.remove());
  document.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  document
    .querySelectorAll("h1, h2, h3, h4, p, li, section, article")
    .forEach((node) => node.append("\n"));
  return document.body.textContent ?? "";
}

export function announcementToPlainText(raw: string): string {
  return htmlToPlainText(raw)
    .replace(/\[([^\]]+)]\([^\s)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function summarizeAnnouncement(raw: string): string {
  const text = announcementToPlainText(raw);
  if (!text) return "";
  const parts = text
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const summary = parts.slice(0, 2).join(" · ");
  return summary.length > SUMMARY_LIMIT
    ? `${summary.slice(0, SUMMARY_LIMIT).trim()}…`
    : summary;
}

function contentFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function getAnnouncementIdentity(
  announcement: YuanhengAnnouncement,
): string {
  return [
    announcement.id,
    announcement.publishDate,
    contentFingerprint(
      [announcement.content, announcement.extra ?? "", announcement.type].join(
        "\n",
      ),
    ),
  ].join(":");
}

function formatAnnouncementDate(value: string): string {
  if (!value) return dt("平台同步");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return dt("平台同步");
  return new Intl.DateTimeFormat(desktopLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function AnnouncementDialog({
  open,
  onOpenChange,
  announcements,
  initialAnnouncementId,
  category,
  onCategoryChange,
  statusMessage,
  unread,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  announcements: YuanhengAnnouncement[];
  initialAnnouncementId?: string;
  category: AnnouncementCategory;
  onCategoryChange: (category: AnnouncementCategory) => void;
  statusMessage?: string;
  unread: Record<AnnouncementCategory, boolean>;
  onRetry?: () => void;
}) {
  const [selectedId, setSelectedId] = useState(
    initialAnnouncementId ?? announcements[0]?.id ?? "",
  );

  useEffect(() => {
    if (open) {
      setSelectedId(initialAnnouncementId ?? announcements[0]?.id ?? "");
    }
  }, [announcements, initialAnnouncementId, open]);

  const selected =
    announcements.find((announcement) => announcement.id === selectedId) ??
    announcements[0];
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [selected?.id, category]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        zIndex="top"
        closeOnInteractOutside
        className="max-h-[78vh] max-w-[860px] overflow-hidden p-0"
      >
        <DialogHeader className="relative pr-14">
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-4.5 w-4.5 text-primary" />
            {dt("公告中心")}
          </DialogTitle>
          <DialogDescription>
            {category === "updates"
              ? dt("仅展示最近两次客户端更新，不累计历史记录。")
              : dt("与元衡平台公告中心同步，每分钟自动检查更新")}
          </DialogDescription>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={dt("关闭公告中心")}
            className="absolute right-5 top-5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </DialogHeader>

        <div className="flex shrink-0 gap-2 border-b px-5 pb-3">
          {(["updates", "platform"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={category === item}
              onClick={() => onCategoryChange(item)}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold",
                category === item
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {dt(item === "updates" ? "客户端更新" : "平台通知")}
              {unread[item] && (
                <span
                  aria-label={dt("未读公告")}
                  className="h-1.5 w-1.5 rounded-full bg-red-500"
                />
              )}
            </button>
          ))}
        </div>
        {statusMessage && (
          <p
            role="status"
            className="shrink-0 px-5 py-2 text-xs text-muted-foreground"
          >
            {statusMessage}
            {onRetry && (
              <button
                type="button"
                className="ml-2 font-semibold text-primary underline underline-offset-2"
                onClick={onRetry}
              >
                {dt("重试")}
              </button>
            )}
          </p>
        )}
        <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[270px_minmax(0,1fr)]">
          <div className="max-h-[58vh] overflow-y-auto border-b border-border-default bg-muted/15 p-2 md:border-b-0 md:border-r">
            {announcements.map((announcement) => {
              const meta = TYPE_META[announcement.type];
              const active = announcement.id === selected?.id;
              return (
                <button
                  key={getAnnouncementIdentity(announcement)}
                  type="button"
                  onClick={() => setSelectedId(announcement.id)}
                  className={cn(
                    "mb-1.5 w-full rounded-xl border px-3 py-2.5 text-left transition-colors last:mb-0",
                    active
                      ? "border-primary/25 bg-primary/[0.07]"
                      : "border-transparent hover:border-border-default hover:bg-background",
                  )}
                >
                  <span className="mb-1.5 flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        "rounded-full border px-1.5 py-0.5 text-[9px] font-semibold",
                        meta.badgeClass,
                      )}
                    >
                      {category === "updates"
                        ? `v${announcement.id}`
                        : dt(meta.label)}
                    </span>
                    <span className="text-[9px] text-muted-foreground">
                      {formatAnnouncementDate(announcement.publishDate)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[11px] font-medium leading-5 text-foreground">
                    {category === "updates"
                      ? announcement.content.split("\n")[0]
                      : summarizeAnnouncement(announcement.content)}
                  </span>
                </button>
              );
            })}
          </div>

          <div
            ref={detailRef}
            className="min-h-[320px] max-h-[58vh] overflow-y-auto px-6 py-5"
          >
            {selected && (
              <article>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                      TYPE_META[selected.type].badgeClass,
                    )}
                  >
                    {category === "updates"
                      ? `v${selected.id}`
                      : dt(TYPE_META[selected.type].label)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {formatAnnouncementDate(selected.publishDate)}
                  </span>
                </div>
                <div className="whitespace-pre-wrap break-words text-[12.5px] leading-6 text-foreground/90 [overflow-wrap:anywhere]">
                  {category === "updates"
                    ? selected.content
                    : announcementToPlainText(selected.content)}
                </div>
                {selected.extra && (
                  <div className="mt-5 rounded-xl border border-border-default bg-muted/25 px-4 py-3 text-[11px] leading-5 text-muted-foreground">
                    {announcementToPlainText(selected.extra)}
                  </div>
                )}
              </article>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function readSeen(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function markRead(key: string, eventName: string, identity: string): void {
  try {
    localStorage.setItem(key, identity);
  } catch {
    // Reading remains available when storage is disabled.
  }
  window.dispatchEvent(new CustomEvent(eventName, { detail: identity }));
}

function useSeen(key: string, eventName: string) {
  const [seen, setSeen] = useState(() => readSeen(key));
  useEffect(() => {
    const onRead = (event: Event) => {
      const identity: unknown = (event as CustomEvent).detail;
      if (typeof identity === "string") setSeen(identity);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setSeen(readSeen(key));
    };
    window.addEventListener(eventName, onRead);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(eventName, onRead);
      window.removeEventListener("storage", onStorage);
    };
  }, [key, eventName]);
  return seen;
}

function useAnnouncementUnread(
  releaseIdentity?: string,
  platformIdentity?: string,
) {
  const releaseSeen = useSeen(
    RELEASE_NOTES_SEEN_KEY,
    RELEASE_ANNOUNCEMENT_READ_EVENT,
  );
  const platformSeen = useSeen(
    DISMISSED_ANNOUNCEMENT_KEY,
    PLATFORM_ANNOUNCEMENT_READ_EVENT,
  );
  return {
    updates: Boolean(releaseIdentity && releaseIdentity !== releaseSeen),
    platform: Boolean(platformIdentity && platformIdentity !== platformSeen),
  };
}

/** Compact entry shared by every signed-in page; feeds keep their existing cadence. */
export function PlatformAnnouncementCenter() {
  const { data: releases } = useDesktopReleaseNotes();
  const { data: platform } = useYuanhengAnnouncements();
  const latestPlatform = platform?.enabled
    ? platform.announcements[0]
    : undefined;
  const unread = useAnnouncementUnread(
    releases[0] ? releaseNoteIdentity(releases[0]) : undefined,
    latestPlatform ? getAnnouncementIdentity(latestPlatform) : undefined,
  );
  const hasUnread = unread.updates || unread.platform;
  return (
    <button
      type="button"
      aria-label={dt(hasUnread ? "公告中心，有未读公告" : "公告中心")}
      title={dt("公告中心")}
      aria-haspopup="dialog"
      className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() =>
        openAnnouncementCenter(
          unread.updates ? "updates" : unread.platform ? "platform" : "updates",
        )
      }
    >
      <Bell className="h-4 w-4" />
      {hasUnread && (
        <span
          aria-hidden="true"
          data-testid="announcement-notification-dot"
          className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-background"
        />
      )}
    </button>
  );
}

/** One global host lets the workspace, About and updater share the same viewer. */
export function DesktopAnnouncementCenter() {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<AnnouncementCategory>("updates");
  const releaseQuery = useDesktopReleaseNotes(open);
  const platformQuery = useYuanhengAnnouncements(
    open && category === "platform",
  );
  const releases = releaseQuery.data;
  const latestPlatform = platformQuery.data?.enabled
    ? platformQuery.data.announcements[0]
    : undefined;
  const releaseIdentity = releases[0]
    ? releaseNoteIdentity(releases[0])
    : undefined;
  const platformIdentity = latestPlatform
    ? getAnnouncementIdentity(latestPlatform)
    : undefined;
  const unread = useAnnouncementUnread(releaseIdentity, platformIdentity);
  const triggerRef = useRef<HTMLElement | null>(null);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const releaseAnnouncements = useMemo<YuanhengAnnouncement[]>(
    () =>
      releases.map((note) => ({
        id: note.version,
        content: note.content,
        publishDate: note.publishedAt,
        type: "success",
        extra: null,
      })),
    [releases],
  );

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<AnnouncementRequest>).detail;
      if (detail?.category !== "updates" && detail?.category !== "platform")
        return;
      triggerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setCategory(detail.category);
      setOpen(true);
      if (detail.category === "updates") {
        // An update may have just been published while the workspace cache is fresh.
        // Keep the local view usable, but explicitly refresh on this user action.
        void releaseQuery.refetch({ cancelRefetch: false });
      }
    };
    window.addEventListener(OPEN_ANNOUNCEMENTS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ANNOUNCEMENTS_EVENT, onOpen);
  }, [releaseQuery.refetch]);
  useEffect(() => {
    if (!open) return;
    if (category === "updates" && releaseIdentity) {
      markRead(
        RELEASE_NOTES_SEEN_KEY,
        RELEASE_ANNOUNCEMENT_READ_EVENT,
        releaseIdentity,
      );
    } else if (category === "platform" && platformIdentity) {
      markRead(
        DISMISSED_ANNOUNCEMENT_KEY,
        PLATFORM_ANNOUNCEMENT_READ_EVENT,
        platformIdentity,
      );
    }
  }, [open, category, releaseIdentity, platformIdentity]);

  const announcements =
    category === "updates"
      ? releaseAnnouncements
      : (platformQuery.data?.announcements ?? []);
  const statusMessage =
    category === "updates"
      ? releaseQuery.isError
        ? dt("暂时无法同步，正在显示本地保存的最近两次更新。")
        : undefined
      : platformQuery.isError
        ? dt("平台公告暂时同步失败")
        : platformQuery.isLoading
          ? dt("正在同步平台公告…")
          : announcements.length === 0
            ? dt("已同步，暂无公告")
            : undefined;

  return (
    <AnnouncementDialog
      open={open}
      onOpenChange={changeOpen}
      announcements={announcements}
      category={category}
      onCategoryChange={(next) => {
        setCategory(next);
        if (next === "updates") {
          void releaseQuery.refetch({ cancelRefetch: false });
        }
      }}
      statusMessage={statusMessage}
      unread={unread}
      onRetry={
        (category === "updates" ? releaseQuery.isError : platformQuery.isError)
          ? () => {
              void (category === "updates"
                ? releaseQuery.refetch()
                : platformQuery.refetch());
            }
          : undefined
      }
    />
  );
}
