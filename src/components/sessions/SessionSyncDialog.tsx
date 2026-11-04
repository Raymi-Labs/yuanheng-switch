import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, Loader2 } from "lucide-react";
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
import { sessionSyncApi } from "@/lib/api";
import type { PendingSummary, SessionSyncOutcome } from "@/lib/api/sessionSync";
import { useRunSessionSyncMutation } from "@/lib/query/sessionSync";
import { extractErrorMessage } from "@/utils/errorUtils";
import { getProviderLabel } from "./utils";
import { PendingDirectoryList } from "./PendingDirectoryList";

interface SessionSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 同步目标客户端 */
  targetProvider: string;
  /** 只同步某个目录；为空表示全部目录 */
  projectDir?: string | null;
  onFinished?: (outcome: SessionSyncOutcome) => void;
}

/**
 * 一键把其他客户端的聊天带到目标客户端。
 * 会话页手动入口与启动前检测共用此弹窗。
 */
export function SessionSyncDialog({
  open,
  onOpenChange,
  targetProvider,
  projectDir,
  onFinished,
}: SessionSyncDialogProps) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<PendingSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const runSync = useRunSessionSyncMutation();
  const targetLabel = getProviderLabel(targetProvider, t);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setSummary(null);
    sessionSyncApi
      .check(targetProvider, { projectDir: projectDir ?? null })
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(
            t("sessionSync.checkFailed", {
              defaultValue: "检查聊天记录失败：{{error}}",
              error: extractErrorMessage(error),
            }),
          );
          onOpenChange(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, targetProvider, projectDir, onOpenChange, t]);

  const handleSync = async () => {
    try {
      const outcome = await runSync.mutateAsync({
        targetProvider,
        scope: { projectDir: projectDir ?? null },
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
      onFinished?.(outcome);
      onOpenChange(false);
    } catch (error) {
      toast.error(
        t("sessionSync.runFailed", {
          defaultValue: "同步失败：{{error}}",
          error: extractErrorMessage(error),
        }),
      );
    }
  };

  const total = summary?.total ?? 0;
  const divergedTotal =
    summary?.directories.reduce(
      (sum, dir) => sum + dir.sources.reduce((s, src) => s + src.diverged, 0),
      0,
    ) ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="size-4" />
            {t("sessionSync.title", {
              defaultValue: "把聊天记录带到 {{target}}",
              target: targetLabel,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("sessionSync.description", {
              defaultValue:
                "带过来之后，可以在 {{target}} 的历史记录里直接接着聊。原来的记录不会被改动。",
              target: targetLabel,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("sessionSync.checking", {
                defaultValue: "正在查看其他客户端的聊天…",
              })}
            </div>
          ) : total === 0 ? (
            <p className="text-sm text-muted-foreground">
              {divergedTotal > 0
                ? t("sessionSync.onlyDiverged", {
                    defaultValue:
                      "有 {{count}} 次聊天两边都有新内容，为避免覆盖已暂停同步。",
                    count: divergedTotal,
                  })
                : t("sessionSync.nothing", {
                    defaultValue: "已经是最新的，没有需要带过来的聊天。",
                  })}
            </p>
          ) : (
            <PendingDirectoryList summary={summary!} />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel", { defaultValue: "取消" })}
          </Button>
          <Button
            onClick={() => void handleSync()}
            disabled={loading || total === 0 || runSync.isPending}
            className="gap-1.5"
          >
            {runSync.isPending && <Loader2 className="size-4 animate-spin" />}
            {t("sessionSync.confirm", {
              defaultValue: "全部带过来（{{count}} 次）",
              count: total,
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
