import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { registerCodexLoginGuide } from "@/lib/codexLoginGuide";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { dt } from "./desktopI18n";

interface LoginGuide {
  apiKey: string;
  group: string;
}

/** Mounted with an account key; all secret-bearing state dies on account change. */
export function CodexLoginGuide({ userId }: { userId: string }) {
  const [guide, setGuide] = useState<LoginGuide | null>(null);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const finishRef = useRef<() => void>(() => {});
  const copyGeneration = useRef(0);

  useEffect(() => {
    let disposed = false;
    let pending: Promise<void> | undefined;
    const unregister = registerCodexLoginGuide(() => {
      if (pending) return pending;
      pending = (async () => {
        try {
          const result = await invoke<LoginGuide | null>(
            "get_codex_login_guide",
            {
              userId,
            },
          );
          if (disposed || !result) return;
          await new Promise<void>((resolve) => {
            finishRef.current = resolve;
            setCopied(false);
            setGuide(result);
          });
        } catch {
          if (!disposed)
            toast.error(
              dt("配置已保存，登录指引读取失败，请重新应用配置查看。"),
            );
        } finally {
          pending = undefined;
        }
      })();
      return pending;
    });
    return () => {
      disposed = true;
      copyGeneration.current += 1;
      unregister();
      finishRef.current();
    };
  }, [userId]);

  const close = () => {
    copyGeneration.current += 1;
    setGuide(null);
    setCopying(false);
    setCopied(false);
    finishRef.current();
  };

  const copy = async () => {
    if (!guide || copying) return;
    const generation = copyGeneration.current;
    setCopying(true);
    try {
      await copyText(guide.apiKey);
      if (copyGeneration.current === generation) setCopied(true);
    } catch {
      if (copyGeneration.current === generation)
        toast.error(dt("复制失败，请手动选中复制。"));
    } finally {
      if (copyGeneration.current === generation) setCopying(false);
    }
  };

  if (!guide) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-lg" zIndex="alert">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5" />
            {dt("完成 Codex 首次登录")}
          </DialogTitle>
          <DialogDescription>
            {dt(
              "已为本次配置准备好平台令牌，无需再去平台创建。按下面步骤完成登录即可。",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 overflow-y-auto px-6 py-4 text-sm">
          <div className="space-y-3 rounded-xl border bg-muted/40 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{dt("平台令牌（API Key）")}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={copying}
                onClick={() => void copy()}
              >
                {copied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
                {copied ? dt("已复制") : dt("复制令牌")}
              </Button>
            </div>
            <code
              className="block select-text break-all rounded-lg bg-background p-3 text-xs"
              aria-label={dt("平台令牌（API Key）")}
            >
              {guide.apiKey}
            </code>
            <p className="text-xs text-muted-foreground">
              {dt("所选分组：{{group}}", { group: guide.group })}
            </p>
          </div>
          <ol className="list-decimal space-y-3 pl-5">
            <li>{dt("复制上方令牌，然后打开 Codex。")}</li>
            <li>
              {dt(
                "在登录页面选择 Sign in with an API key（使用 API Key 登录）；如果先显示其他登录方式，请展开后选择 API Key。",
              )}
            </li>
            <li>{dt("将令牌粘贴到 API Key 输入框，点击继续完成登录。")}</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            {dt(
              "若 Codex 已直接进入主界面，即可开始使用。需要再次查看令牌时，重新应用 Codex 配置即可。",
            )}
          </p>
        </div>
        <DialogFooter>
          <Button onClick={close}>
            {copied ? dt("已复制，继续") : dt("稍后登录")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
