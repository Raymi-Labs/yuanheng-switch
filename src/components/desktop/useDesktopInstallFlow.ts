import { useEffect, useRef, useState } from "react";

import { useDshDesktopDownload } from "./useDshDesktopDownload";
import { toast } from "@/lib/toast";
import { dt } from "./desktopI18n";

import { settingsApi } from "@/lib/api";
import type { ToolVersionInfo } from "@/lib/api/settings";
import type { YuanhengToolId } from "@/lib/api/yuanheng";
import { ensureClaudeWorkspaceReady } from "@/lib/claudeWorkspaceSetup";

const OFFICIAL_DOWNLOAD_HOSTS = new Set([
  "claude.ai",
  "www.deepseek.com",
  "download.deepseek.com",
  "openai.com",
  "www.openai.com",
  "codebuddy.cn",
  "www.codebuddy.cn",
  "www.accio.com",
  "www.trae.ai",
  "www.trae.cn",
]);
const POLL_INTERVAL_MS = 3_000;
const INSTALL_MONITOR_TIMEOUT_MS = 5 * 60_000;

function assertOfficialDownloadUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    !OFFICIAL_DOWNLOAD_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("下载地址不是受信任的官方 HTTPS 域名");
  }
}

export type DesktopInstallMonitorResult =
  | { status: "detected"; tool: ToolVersionInfo }
  | { status: "timeout" }
  | { status: "cancelled" };

// Assisted desktop apps share installation observation, not model readiness.
type DesktopInstallTool = YuanhengToolId | "trae" | "trae-cn";

/** Stop observing an IPC without pretending to cancel its shared backend work. */
function observe<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const stop = () => resolve(undefined);
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(signal.aborted ? undefined : value);
      },
      (error) => {
        signal.removeEventListener("abort", stop);
        if (signal.aborted) resolve(undefined);
        else reject(error);
      },
    );
  });
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, POLL_INTERVAL_MS);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

/** Opening a web page is not a download task. Observe local installation only. */
export function useDesktopInstallFlow() {
  const dshDownload = useDshDesktopDownload();
  const [monitoringApps, setMonitoringApps] = useState<Set<DesktopInstallTool>>(
    () => new Set(),
  );
  const monitors = useRef(new Map<DesktopInstallTool, AbortController>());

  useEffect(
    () => () => {
      for (const controller of monitors.current.values()) controller.abort();
      monitors.current.clear();
    },
    [],
  );

  const stop = (app: DesktopInstallTool) => {
    monitors.current.get(app)?.abort();
    monitors.current.delete(app);
    setMonitoringApps((current) => {
      const next = new Set(current);
      next.delete(app);
      return next;
    });
  };
  const stopAll = () => {
    for (const controller of monitors.current.values()) controller.abort();
    monitors.current.clear();
    setMonitoringApps(new Set());
  };

  const openAndMonitor = async (
    app: DesktopInstallTool,
    versionTarget: string,
    downloadUrl: string,
  ): Promise<DesktopInstallMonitorResult> => {
    assertOfficialDownloadUrl(downloadUrl);
    monitors.current.get(app)?.abort();
    const controller = new AbortController();
    monitors.current.set(app, controller);
    setMonitoringApps((current) => new Set(current).add(app));
    let timedOut = false;
    let timeout: number | undefined;
    const stopped = (): DesktopInstallMonitorResult => ({
      status: timedOut ? "timeout" : "cancelled",
    });
    try {
      if (app === "accio-work") {
        // Tauri replaces window.confirm with an async IPC. Track this wait in
        // the same observer so a late approval after unmount cannot open a URL.
        const accepted = await observe(
          Promise.resolve(
            window.confirm(
              "将打开 Accio 官方下载页。官方 macOS 安装器可能上报设备标识哈希和电脑名称（可能包含姓名）。安装后元衡会检查版本和官方签名，不兼容时会明确提示；安装成功不代表已接通元衡。是否继续？",
            ),
          ),
          controller.signal,
        );
        if (!accepted || controller.signal.aborted) return stopped();
      }
      if (app === "dsh") {
        const selected = await dshDownload.choose(controller.signal);
        if (!selected || controller.signal.aborted) return stopped();
        downloadUrl = selected;
        assertOfficialDownloadUrl(downloadUrl);
      }
      if (app === "claude-desktop") {
        await observe(ensureClaudeWorkspaceReady(), controller.signal);
        if (controller.signal.aborted) return stopped();
      }
      // The five-minute browser/install observation budget starts after system
      // preparation. Stopping this observer never cancels Windows servicing.
      timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, INSTALL_MONITOR_TIMEOUT_MS);
      await observe(settingsApi.openExternal(downloadUrl), controller.signal);
      if (app === "dsh" && !controller.signal.aborted) {
        toast.info(
          dt("已打开 DSH 官方安装包，完成安装后将自动检测、配置并启动桌面端。"),
        );
      }
      while (!controller.signal.aborted) {
        const tools = await observe(
          settingsApi.getInstalledToolVersions([versionTarget]),
          controller.signal,
        );
        if (controller.signal.aborted) return stopped();
        const tool = tools?.[0];
        if (tool?.version || tool?.install_path)
          return { status: "detected", tool };
        await pause(controller.signal);
      }
      return stopped();
    } finally {
      window.clearTimeout(timeout);
      if (monitors.current.get(app) === controller) {
        monitors.current.delete(app);
        setMonitoringApps((current) => {
          const next = new Set(current);
          next.delete(app);
          return next;
        });
      }
    }
  };
  return {
    monitoringApps,
    openAndMonitor,
    stop,
    stopAll,
    downloadDialog: dshDownload.dialog,
  };
}
