import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, Loader2 } from "lucide-react";
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

  const { summary, targetProvider } = request;
  const targetLabel = getProviderLabel(targetProvider, t);
  const projectDirs = summary.directories.map((dir) => dir.projectDir);
  const single = summary.directories.length === 1;

  const finish = () => settleLaunchSync();

  const handleSync = async () => {
    setBusy("sync");
    try {
      const outcome = await sessionSyncApi.run(targetProvider, {
        projectDirs,
      });
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
      await sessionSyncApi.muteDirectories(targetProvider, projectDirs);
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
            {t("sessionSync.launchTitle", {
              defaultValue: "要把之前的聊天带到 {{target}} 吗？",
              target: targetLabel,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("sessionSync.launchDescription", {
              defaultValue:
                "其他客户端里有 {{count}} 次聊天还没带过来。带过来后可以在 {{target}} 里直接接着聊，原来的记录不会被改动。",
              count: summary.total,
              target: targetLabel,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[45vh] overflow-y-auto px-6 py-4">
          <PendingDirectoryList summary={summary} />
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => void handleMute()}
          >
            {busy === "mute" && <Loader2 className="size-4 animate-spin" />}
            {single
              ? t("sessionSync.muteProject", {
                  defaultValue: "这个项目不再提醒",
                })
              : t("sessionSync.muteProjects", {
                  defaultValue: "这些项目不再提醒",
                })}
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
