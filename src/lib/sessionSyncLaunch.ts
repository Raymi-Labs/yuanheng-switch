import { sessionSyncApi } from "@/lib/api/sessionSync";
import type { PendingSummary, ProjectSyncPreview } from "@/lib/api/sessionSync";

/**
 * 启动客户端前的一次性同步询问。
 *
 * `launchTool` 调用 {@link offerSessionSyncBeforeLaunch}；若有待同步内容，
 * 这里发布一个请求，由全局挂载的 `SessionSyncLaunchPrompt` 弹窗处理，
 * 用户选择后 Promise 才返回，启动随后继续。任何检测错误都不阻塞启动。
 */

/** 本仓库的工具 ID → 会话同步使用的客户端 ID（CLI 与桌面版共用本地数据） */
export const SESSION_SYNC_TARGET_BY_TOOL: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  "chatgpt-desktop": "codex",
  gemini: "gemini",
  grokbuild: "grokbuild",
  opencode: "opencode",
  dsh: "dsh",
};

export interface LaunchSyncRequest {
  tool: string;
  targetProvider: string;
  /** 待同步的聊天；为空表示只有项目分组要询问 */
  summary: PendingSummary | null;
  /** 待同步的项目分组（目前只有 Codex → DSH） */
  projects: ProjectSyncPreview | null;
  resolve: () => void;
}

/** 支持把项目分组带过去的目标客户端 */
const PROJECT_SYNC_TARGETS = new Set(["dsh"]);

type Listener = (request: LaunchSyncRequest | null) => void;

let current: LaunchSyncRequest | null = null;
const listeners = new Set<Listener>();

const publish = (request: LaunchSyncRequest | null) => {
  current = request;
  listeners.forEach((listener) => listener(request));
};

export const subscribeLaunchSync = (listener: Listener) => {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
};

/** 弹窗处理完毕（无论用户选什么）后调用，放行启动。 */
export const settleLaunchSync = () => {
  const request = current;
  publish(null);
  request?.resolve();
};

export async function offerSessionSyncBeforeLaunch(
  tool: string,
  projectDir?: string | null,
): Promise<void> {
  const targetProvider = SESSION_SYNC_TARGET_BY_TOOL[tool];
  if (!targetProvider) return;
  // 没有任何弹窗宿主（例如测试或无界面环境）时直接放行
  if (listeners.size === 0) return;
  if (current) return;
  const [summary, projects] = await Promise.all([
    sessionSyncApi
      .checkBeforeLaunch(targetProvider, projectDir)
      .then((value) => (value && value.total > 0 ? value : null))
      .catch(() => null),
    PROJECT_SYNC_TARGETS.has(targetProvider)
      ? sessionSyncApi
          .checkProjectsBeforeLaunch(targetProvider)
          .then((value) => (value && value.missing > 0 ? value : null))
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  if (!summary && !projects) return;
  await new Promise<void>((resolve) => {
    publish({ tool, targetProvider, summary, projects, resolve });
  });
}
