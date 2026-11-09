import { useRef, useState } from "react";
import {
  yuanhengApi,
  type CodexProjectMapRepairResult,
} from "@/lib/api/yuanheng";
import { extractErrorMessage } from "@/utils/errorUtils";
import { dt } from "./desktopI18n";

export function CodexProjectRecovery() {
  const [preview, setPreview] = useState<CodexProjectMapRepairResult | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const run = async (apply: boolean) => {
    if (inFlight.current || (apply && !preview)) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await yuanhengApi.repairCodexProjectMap(
        apply ? preview!.fingerprint : undefined,
      );
      setPreview(result);
      if (result.applied) {
        setMessage(
          dt("本地项目映射已恢复，请重新打开 Codex。备份：{{path}}", {
            path: result.backupPath,
          }),
        );
        setPreview(null);
      } else if (result.blockedReason) {
        setMessage(result.blockedReason);
      } else if (!result.projectsRestored && !result.assignmentsRestored) {
        setMessage(dt("未发现可补充的本地项目或会话归属。"));
      }
    } catch (error) {
      setPreview(null);
      setMessage(extractErrorMessage(error) || dt("恢复 Codex 项目列表失败"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="relative mt-2 space-y-2 text-xs text-white/75">
      <p>
        {dt("项目消失可能与登录切换有关。可检查历史登录保存在本机的项目映射。")}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(false)}
        className="rounded-md border border-white/20 px-3 py-1 disabled:opacity-50"
      >
        {dt("检查本地项目")}
      </button>
      {preview &&
        (preview.projectsRestored > 0 || preview.assignmentsRestored > 0) && (
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
  );
}
