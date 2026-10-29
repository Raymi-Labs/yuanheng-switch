import type { AppId, YuanhengToolId } from "@/lib/api";
import { APP_ICON_MAP } from "./appConfig";

export const DESKTOP_TOOLS: YuanhengToolId[] = [
  "claude",
  "claude-desktop",
  "codex",
  "chatgpt-desktop",
  "workbuddy",
  "dsh",
  "accio-work",
  "gemini",
  "grokbuild",
  "opencode",
  "openclaw",
  "hermes",
];

/** Display entries include assisted tools; managed configuration still uses DESKTOP_TOOLS. */
export function withAssistedTools(
  tools: readonly YuanhengToolId[],
): (YuanhengToolId | "trae")[] {
  const entries: (YuanhengToolId | "trae")[] = [...tools];
  const after = tools.indexOf("workbuddy");
  entries.splice(after < 0 ? entries.length : after + 1, 0, "trae");
  return entries;
}

export const isCoreApp = (app: YuanhengToolId): app is AppId =>
  app !== "chatgpt-desktop" &&
  app !== "workbuddy" &&
  app !== "dsh" &&
  app !== "accio-work";

export const isDesktopApp = (app: YuanhengToolId) =>
  app === "claude-desktop" ||
  app === "chatgpt-desktop" ||
  app === "workbuddy" ||
  app === "accio-work" ||
  app === "dsh";

// Accio's controlled launcher requires the user to close the existing app;
// it does not stop a running session or replace that process's gateway.
export const canRestartDesktopApp = (app: YuanhengToolId) =>
  isDesktopApp(app) && app !== "accio-work";

export const toolLabel = (app: YuanhengToolId) => {
  if (app === "chatgpt-desktop") return "Codex Desktop";
  if (app === "dsh") return "DSH";
  if (app === "accio-work") return "Accio Work（实验性）";
  if (app === "workbuddy") return "WorkBuddy";
  return APP_ICON_MAP[app].label;
};

export const toolIcon = (app: YuanhengToolId): string =>
  app === "codex" || app === "chatgpt-desktop"
    ? "openai"
    : app === "dsh"
      ? "deepseek"
      : app === "claude-desktop"
        ? "claude"
        : app;
