import { invoke } from "@tauri-apps/api/core";
import { isWindows } from "@/lib/platform";

export type WorkspacePhase =
  | "not_required"
  | "needs_preparation"
  | "preparing"
  | "restart_required"
  | "ready"
  | "firmware_required"
  | "unknown"
  | "cancelled"
  | "failed";
export interface WorkspacePreparation {
  phase: WorkspacePhase;
  message: string;
}
/** Configuration is saved; callers must not roll the picker back as if it failed. */
export class ClaudeWorkspaceDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeWorkspaceDeferredError";
  }
}
export interface SetupSnapshot {
  state: WorkspacePreparation | null;
  busy: boolean;
  visible: boolean;
  resumeRequested: boolean;
  suppressStartupReminder: boolean;
}
const STORAGE_KEY = "yuanheng.claudeWorkspacePreparation.v1";
const REMINDER_KEY = "yuanheng.claudeWorkspacePreparation.suppressReminder.v1";
function readReminderPreference(): boolean {
  try {
    return localStorage.getItem(REMINDER_KEY) === "true";
  } catch {
    return false;
  }
}
const listeners = new Set<() => void>();
let snapshot: SetupSnapshot = {
  state: null,
  busy: false,
  visible: false,
  resumeRequested: false,
  suppressStartupReminder: readReminderPreference(),
};
let flight: Promise<void> | null = null;
let refreshFlight: Promise<WorkspacePreparation> | null = null;
function publish(patch: Partial<SetupSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((f) => f());
}
function remember(pending: boolean) {
  // No account, paths, credentials, model or group choices in the resume marker.
  try {
    if (pending) localStorage.setItem(STORAGE_KEY, "pending");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Backend boot marker remains authoritative. */
  }
}
function validate(value: WorkspacePreparation): WorkspacePreparation {
  if (
    !value ||
    ![
      "not_required",
      "needs_preparation",
      "preparing",
      "restart_required",
      "ready",
      "firmware_required",
      "unknown",
      "cancelled",
      "failed",
    ].includes(value.phase) ||
    typeof value.message !== "string"
  )
    throw new Error("环境检查返回未知结果，未继续安装。");
  return value;
}
export const claudeWorkspaceSetup = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot: () => snapshot,
  dismiss() {
    publish({ visible: false });
  },
  show() {
    publish({ visible: true });
  },
  setSuppressStartupReminder(suppress: boolean): boolean {
    // A display preference only: keep the pending intent and native safety checks.
    try {
      if (suppress) localStorage.setItem(REMINDER_KEY, "true");
      else localStorage.removeItem(REMINDER_KEY);
    } catch {
      return false;
    }
    publish({ suppressStartupReminder: suppress });
    return true;
  },
  resumePending() {
    if (!isWindows() || snapshot.suppressStartupReminder) return false;
    try {
      return localStorage.getItem(STORAGE_KEY) === "pending";
    } catch {
      return false;
    }
  },
  requestContinue() {
    publish({ visible: false, resumeRequested: true });
  },
  consumeContinue() {
    if (!snapshot.resumeRequested) return false;
    publish({ resumeRequested: false });
    return true;
  },
};

export function refreshClaudeWorkspace(): Promise<WorkspacePreparation> {
  if (refreshFlight) return refreshFlight;
  refreshFlight = invoke<WorkspacePreparation>(
    "get_claude_workspace_preparation",
  )
    .then(validate)
    .then((state) => {
      publish({ state });
      return state;
    })
    .catch(() => {
      const state: WorkspacePreparation = {
        phase: "unknown",
        message: "未能完成环境检查，请重新检查；没有自动修改系统。",
      };
      publish({ state });
      return state;
    })
    .finally(() => {
      refreshFlight = null;
    });
  return refreshFlight;
}

/** One shared intent across install/configure/launch. No automatic UAC on mount. */
export function ensureClaudeWorkspaceReady(): Promise<void> {
  if (!isWindows()) return Promise.resolve();
  if (flight) return flight;
  flight = prepare().finally(() => {
    flight = null;
    publish({ busy: false });
  });
  return flight;
}

async function prepare() {
  remember(true);
  publish({ busy: true, visible: true });
  let state = await refreshClaudeWorkspace();
  if (state.phase === "needs_preparation") {
    if (
      !window.confirm(
        "为 Claude 准备 Windows 虚拟机平台？\n接下来会出现 Windows 管理员授权。只启用必要组件，不修改代理或防火墙；可能需要重启，请先保存工作。元衡不会自动重启。",
      )
    ) {
      state = {
        phase: "cancelled",
        message: "已取消本次环境准备。没有提交系统修改，可稍后继续。",
      };
      publish({ state });
      throw new Error(state.message);
    }
    publish({
      state: {
        phase: "preparing",
        message:
          "请在 Windows 管理员授权窗口中确认；系统组件准备期间请勿重复点击。",
      },
    });
    try {
      state = validate(
        await invoke<WorkspacePreparation>("prepare_claude_workspace", {
          confirmed: true,
        }),
      );
    } catch {
      state = {
        phase: "unknown",
        message: "组件准备结果尚未确认，请重新检查；不要重复执行系统安装。",
      };
    }
    publish({ state });
  }
  const deadline = Date.now() + 10 * 60_000;
  while (state.phase === "preparing" && Date.now() < deadline) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 2000));
    state = await refreshClaudeWorkspace();
  }
  if (state.phase === "ready" || state.phase === "not_required") {
    remember(false);
    publish({ state, visible: false });
    return;
  }
  if (state.phase === "preparing") {
    state = {
      phase: "preparing",
      message:
        "Windows 组件准备耗时较长，已停止自动等待，但没有终止系统安装。稍后点击重新检查；不要重复安装。",
    };
    publish({ state });
  }
  throw new Error(state.message);
}
