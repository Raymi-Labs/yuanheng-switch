import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isMac, isWindows } from "@/lib/platform";
import { dt } from "./desktopI18n";

export const DSH_DESKTOP_DOWNLOADS = {
  windows: "https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe",
  apple: "https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg",
  intel: "https://download.deepseek.com/desktop/dsh-latest-macos-x64.dmg",
} as const;

/** A Mac's browser UA does not identify its chip, so ask instead of guessing. */
export function useDshDesktopDownload() {
  const [choice, setChoice] = useState<{ finish: (url?: string) => void }>();
  const choose = (signal: AbortSignal): Promise<string | undefined> => {
    if (signal.aborted) return Promise.resolve(undefined);
    if (isWindows()) return Promise.resolve(DSH_DESKTOP_DOWNLOADS.windows);
    if (!isMac())
      return Promise.reject(
        new Error(dt("DSH 官方桌面安装包目前支持 Windows 和 macOS。")),
      );
    return new Promise((resolve) => {
      const cancel = () => finish();
      const finish = (url?: string) => {
        signal.removeEventListener("abort", cancel);
        setChoice((current) =>
          current?.finish === finish ? undefined : current,
        );
        resolve(signal.aborted ? undefined : url);
      };
      signal.addEventListener("abort", cancel, { once: true });
      setChoice({ finish });
    });
  };
  const dialog = (
    <Dialog
      open={Boolean(choice)}
      onOpenChange={(open) => {
        if (!open) choice?.finish();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dt("选择 DSH 的 Mac 版本")}</DialogTitle>
          <DialogDescription>
            {dt("点击左上角苹果菜单 → 关于本机，查看芯片或处理器。")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Button onClick={() => choice?.finish(DSH_DESKTOP_DOWNLOADS.apple)}>
            {dt("Apple 芯片版（M 系列）")}
          </Button>
          <Button
            variant="outline"
            onClick={() => choice?.finish(DSH_DESKTOP_DOWNLOADS.intel)}
          >
            {dt("Intel 芯片版")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {dt("下载后打开 DMG，将 DSH 拖入“应用程序”；元衡会自动检测。")}
        </p>
        <Button variant="ghost" onClick={() => choice?.finish()}>
          {dt("取消")}
        </Button>
      </DialogContent>
    </Dialog>
  );
  return { choose, dialog };
}
