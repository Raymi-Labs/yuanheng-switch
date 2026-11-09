import { useEffect, useRef, useState } from "react";
import {
  yuanhengApi,
  type CodexProjectMapRepairResult,
} from "@/lib/api/yuanheng";
import { extractErrorMessage } from "@/utils/errorUtils";
import { dt } from "./desktopI18n";
import { registerCodexProjectCheck } from "@/lib/codexProjectCheck";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function CodexProjectRecovery() {
  const [preview, setPreview] = useState<CodexProjectMapRepairResult | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const alive = useRef(false);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const run = (apply: boolean): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const prior = previewRef.current;
    if (apply && !prior) return Promise.resolve();
    const operation = (async () => {
      setBusy(true);
      setMessage("");
      try {
        const result = await yuanhengApi.repairCodexProjectMap(
          apply ? prior!.fingerprint : undefined,
        );
        if (!alive.current) return;
        if (
          !result.projectsRestored &&
          !result.assignmentsRestored &&
          !result.applied
        ) {
          setPreview(null);
          return;
        }
        setPreview(result);
        if (result.applied) {
          setMessage(
            dt("本地项目映射已恢复，请重新打开 Codex。备份：{{path}}", {
              path: result.backupPath,
            }),
          );
        } else if (result.blockedReason) {
          setMessage(result.blockedReason);
        }
      } catch (error) {
        if (!alive.current) return;
        setPreview(null);
        // Missing/unsupported history is normal for many installations. Only
        // surface an error once the user is handling an actual recovery.
        if (prior)
          setMessage(
            extractErrorMessage(error) || dt("恢复 Codex 项目列表失败"),
          );
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
    inFlight.current = operation;
    void operation.finally(() => {
      inFlight.current = null;
    });
    return operation;
  };
  useEffect(() => {
    alive.current = true;
    const unregister = registerCodexProjectCheck(() => run(false));
    const onFocus = () => {
      if (previewRef.current && !previewRef.current.applied) void run(false);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      unregister();
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  if (!preview && !message) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          setPreview(null);
          setMessage("");
        }
      }}
    >
      <DialogContent className="max-w-lg" zIndex="alert">
        <DialogHeader>
          <DialogTitle>{dt("Codex 本地项目")}</DialogTitle>
          <DialogDescription>
            {dt("检测到可恢复的本地项目和会话归属。")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-6 text-sm">
          {preview &&
            !preview.applied &&
            (preview.projectsRestored > 0 ||
              preview.assignmentsRestored > 0) && (
              <div className="space-y-2 rounded-md border border-white/10 p-3">
                <p>
                  {dt("可补充 {{projects}} 个项目、{{sessions}} 条会话归属。", {
                    projects: preview.projectsRestored,
                    sessions: preview.assignmentsRestored,
                  })}
                </p>
                <p>
                  {dt(
                    "这会把历史登录的本地项目合并到当前列表。先退出 ChatGPT/Codex 及 CLI，再检查并恢复；云端项目和账号设置不迁移。",
                  )}
                </p>
                <button
                  type="button"
                  disabled={busy || !!preview.blockedReason}
                  onClick={() => void run(true)}
                  className="rounded-md border border-white/20 px-3 py-1 disabled:opacity-50"
                >
                  {dt("备份并恢复")}
                </button>
              </div>
            )}
          {message && (
            <p role="status" className="break-all">
              {message}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
