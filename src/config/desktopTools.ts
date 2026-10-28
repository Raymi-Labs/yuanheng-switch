import type { AppId, YuanhengToolId } from "@/lib/api";
import { APP_ICON_MAP } from "./appConfig";

export const DESKTOP_TOOLS: YuanhengToolId[] = [
  "claude",
  "claude-desktop",
  "codex",
  "chatgpt-desktop",
  "workbuddy",
  "dsh",
  ...(import.meta.env.VITE_ENABLE_ACCIO_WORK === "1"
    ? ["accio-work" as const]
    : []),
  "gemini",
  "grokbuild",
  "opencode",
  "openclaw",
  "hermes",
];

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
