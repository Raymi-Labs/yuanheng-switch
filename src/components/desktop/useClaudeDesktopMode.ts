import { useState } from "react";
import {
  useClaudeDesktopAccountMode,
  useSwitchClaudeDesktopAccountMode,
} from "@/lib/query/yuanheng";
import type { CodexAccountMode } from "@/lib/api/yuanheng";
import { markRestartRequired } from "./desktopRestartState";
import { extractErrorMessage } from "@/utils/errorUtils";
import { toast } from "sonner";
import { dt } from "./desktopI18n";

export function useClaudeDesktopMode() {
  const query = useClaudeDesktopAccountMode();
  const [setupRequested, setSetupRequested] = useState(false);
  const mutation = useSwitchClaudeDesktopAccountMode();
  const switchMode = async (mode: Exclude<CodexAccountMode, "unknown">) => {
    if (mutation.isPending) return;
    if (mode === "yuanheng" && query.data && !query.data.yuanhengAvailable) {
      setSetupRequested(true);
      return;
    }
    setSetupRequested(false);
    try {
      const result = await mutation.mutateAsync({
        mode,
        expectedMode: query.data?.mode,
      });
      if (result.restartRequired) markRestartRequired("claude-desktop", true);
      toast.success(
        dt(
          mode === "official"
            ? "已切换到 Claude 官方模式，请重启客户端并完成账号登录。"
            : "已恢复 Claude Desktop 元衡配置，请重启客户端。",
        ),
      );
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
  };
  return {
    refetch: query.refetch,
    setupRequested,
    data: query.data,
    pending: mutation.isPending,
    error: query.isError,
    switchMode,
  };
}
