import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, FolderTree, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { sessionSyncApi } from "@/lib/api/sessionSync";
import { invalidateSessionSync } from "@/lib/query/sessionSync";
import {
  settleLaunchSync,
  subscribeLaunchSync,
  type LaunchSyncRequest,
} from "@/lib/sessionSyncLaunch";
import { extractErrorMessage } from "@/utils/errorUtils";
import { PendingDirectoryList } from "./PendingDirectoryList";
import { getProviderLabel } from "./utils";

type Busy = null | "sync" | "mute";

/**
 * 启动客户端前的同步询问。全局挂载一次；无请求时不渲染任何东西。
 * 一个弹窗同时覆盖"聊天记录"和"项目分组"，一个主按钮把两者都带过去。
 * 无论用户选哪个按钮、同步成功与否，最后都会放行启动。
 */
export function SessionSyncLaunchPrompt() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [request, setRequest] = useState<LaunchSyncRequest | null>(null);
  const [busy, setBusy] = useState<Busy>(null);

  useEffect(() => subscribeLaunchSync(setRequest), []);
  useEffect(() => {
    if (!request) setBusy(null);
  }, [request]);

  if (!request) return null;

  const { summary, projects, targetProvider } = request;
  const targetLabel = getProviderLabel(targetProvider, t);
  const sourceLabel = projects
    ? getProviderLabel(projects.sourceProvider, t)
    : "";
  const projectDirs = summary?.directories.map((dir) => dir.projectDir) ?? [];
  const single = (summary?.directories.length ?? 0) === 1;

  const finish = () => settleLaunchSync();

  const syncProjects = async () => {
    if (!projects) return;
    const outcome = await sessionSyncApi.syncProjects(
      projects.sourceProvider,
      targetProvider,
    );
    if (outcome.blockedReason) {
      toast.error(outcome.blockedReason);
      return;
    }
    toast.success(
      t("sessionSync.projectsDone", {
        defaultValue: "已在 {{target}} 里整理好 {{count}} 个项目分组",
        count: outcome.created + outcome.updated,
        target: targetLabel,
      }),
    );
  };

  const syncChats = async () => {
    if (!summary) return;
    const outcome = await sessionSyncApi.run(targetProvider, { projectDirs });
    const done = outcome.synced + outcome.updated;
    if (outcome.failed > 0) {
      toast.error(
        t("sessionSync.partialFailed", {
          defaultValue: "已带过来 {{done}} 次聊天，{{failed}} 次没成功",
          done,
          failed: outcome.failed,
        }),
      );
    } else {
      toast.success(
        t("sessionSync.done", {
          defaultValue: "已把 {{count}} 次聊天带到 {{target}}",
          count: done,
          target: targetLabel,
        }),
      );
    }
  };

  const handleSync = async () => {
    setBusy("sync");
    try {
      // 先带聊天，再整理分组：分组会把刚带过去的聊天一并归进对应项目
      await syncChats();
      await syncProjects();
    } catch (error) {
      toast.error(
        t("sessionSync.runFailedContinue", {
          defaultValue: "同步没有完成，先为你直接启动：{{error}}",
          error: extractErrorMessage(error),
        }),
      );
    } finally {
      void invalidateSessionSync(queryClient);
      finish();
    }
  };

  const handleMute = async () => {
    setBusy("mute");
    try {
      if (summary) {
        await sessionSyncApi.muteDirectories(targetProvider, projectDirs);
      }
      if (projects) {
        await sessionSyncApi.muteProjectSync(targetProvider);
      }
      toast.success(
        t("sessionSync.mutedHint", {
          defaultValue: "以后启动不再询问；需要时可在「会话与用量」里手动同步",
        }),
      );
    } catch (error) {
      toast.error(extractErrorMessage(error));
    } finally {
      finish();
    }
  };

  const title = summary
    ? t("sessionSync.launchTitle", {
        defaultValue: "要把之前的聊天带到 {{target}} 吗？",
        target: targetLabel,
      })
    : t("sessionSync.launchProjectsTitle", {
        defaultValue: "要把项目分组带到 {{target}} 吗？",
        target: targetLabel,
      });

  const muteLabel =
    summary && !single
      ? t("sessionSync.muteProjects", { defaultValue: "这些项目不再提醒" })
      : summary
        ? t("sessionSync.muteProject", { defaultValue: "这个项目不再提醒" })
        : t("sessionSync.muteProjectGroups", { defaultValue: "不再提醒" });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) finish();
      }}
    >
      <DialogContent className="max-w-md" zIndex="alert">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="size-4" />
            {title}
          </DialogTitle>
          <DialogDescription>
            {summary
              ? t("sessionSync.launchDescription", {
                  defaultValue:
                    "其他客户端里有 {{count}} 次聊天还没带过来。带过来后可以在 {{target}} 里直接接着聊，原来的记录不会被改动。",
                  count: summary.total,
                  target: targetLabel,
                })
              : t("sessionSync.launchProjectsDescription", {
                  defaultValue:
                    "{{source}} 里分好的项目，{{target}} 里还没有。带过去后，{{target}} 左侧会按同样的项目分组显示聊天。",
                  source: sourceLabel,
                  target: targetLabel,
                })}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[45vh] space-y-4 overflow-y-auto px-6 py-4">
          {summary && <PendingDirectoryList summary={summary} />}
          {projects && (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <FolderTree className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                {t("sessionSync.projectsLine", {
                  defaultValue:
                    "同时把 {{source}} 的 {{count}} 个项目分组带到 {{target}}",
                  source: sourceLabel,
                  count: projects.missing,
                  target: targetLabel,
                })}
              </span>
            </div>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => void handleMute()}
          >
            {busy === "mute" && <Loader2 className="size-4 animate-spin" />}
            {muteLabel}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" disabled={busy !== null} onClick={finish}>
              {t("sessionSync.launchSkip", { defaultValue: "直接启动" })}
            </Button>
            <Button
              disabled={busy !== null}
              onClick={() => void handleSync()}
              className="gap-1.5"
            >
              {busy === "sync" && <Loader2 className="size-4 animate-spin" />}
              {busy === "sync"
                ? t("sessionSync.syncing", { defaultValue: "正在带过来…" })
                : t("sessionSync.launchConfirm", {
                    defaultValue: "带过来并启动",
                  })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
