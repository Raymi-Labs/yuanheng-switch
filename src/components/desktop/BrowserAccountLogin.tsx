import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  browserLoginApi,
  type BrowserLoginAttempt,
} from "@/lib/api/browser-login";
import { yuanhengKeys } from "@/lib/query/yuanheng";
import { dt } from "./desktopI18n";
import { extractErrorMessage } from "@/utils/errorUtils";
import type { YuanhengConnectionStatus } from "@/lib/api/yuanheng";

export function BrowserAccountLogin({
  disabled = false,
  onConnected,
}: {
  disabled?: boolean;
  onConnected: (connection: YuanhengConnectionStatus) => void;
}) {
  const client = useQueryClient();
  const [attempt, setAttempt] = useState<BrowserLoginAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const id = useRef<string>();
  const locked = useRef(false);
  const mounted = useRef(true);
  const complete = useRef(onConnected);
  complete.current = onConnected;
  const cancel = () => {
    const active = !!id.current || locked.current;
    generation.current++;
    const current = id.current;
    id.current = undefined;
    setAttempt(null);
    setBusy(false);
    locked.current = false;
    if (active) void browserLoginApi.cancel(current).catch(() => {});
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      const current = id.current;
      id.current = undefined;
      if (current || locked.current)
        void browserLoginApi.cancel(current).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled]);
  useEffect(() => {
    if (!attempt) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expires = Date.now() + attempt.expiresIn * 1000;
    const poll = async () => {
      if (stopped) return;
      if (Date.now() >= expires) {
        cancel();
        setError(dt("浏览器授权已过期，请重新发起"));
        return;
      }
      try {
        const result = await browserLoginApi.poll(attempt.attemptId);
        if (stopped || id.current !== attempt.attemptId) return;
        if (result.status === "complete" && result.connection) {
          id.current = undefined;
          setAttempt(null);
          setBusy(false);
          if (mounted.current) complete.current(result.connection);
          await client.invalidateQueries({ queryKey: yuanhengKeys.connection });
          await client.invalidateQueries({ queryKey: yuanhengKeys.tools });
          return;
        }
        timer = setTimeout(poll, 3000);
      } catch (e) {
        if (!stopped) {
          cancel();
          setError(extractErrorMessage(e) || dt("浏览器登录未完成，请重试"));
        }
      }
    };
    timer = setTimeout(poll, 3000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [attempt, client]);
  const start = async (provider: string) => {
    if (disabled || locked.current || attempt) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const gen = ++generation.current;
    try {
      const providers = await browserLoginApi.providers();
      if (gen !== generation.current || !mounted.current) return;
      if (!providers.includes(provider))
        throw new Error(dt("网站未开启此登录方式，或尚未部署客户端授权接口"));
      const value = await browserLoginApi.start(provider);
      if (gen !== generation.current || !mounted.current) {
        await browserLoginApi.cancel(value.attemptId);
        return;
      }
      id.current = value.attemptId;
      setAttempt(value);
    } catch (e) {
      if (gen === generation.current && mounted.current)
        setError(extractErrorMessage(e) || dt("浏览器登录未完成，请重试"));
    } finally {
      if (gen === generation.current && mounted.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section className="mb-4 space-y-2 border-b pb-4">
      <p className="text-xs text-muted-foreground">
        {dt("使用网站账号登录，第三方密码仅在系统浏览器输入")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || busy || !!attempt}
          onClick={() => void start("github")}
        >
          {dt("通过 GitHub 登录")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || busy || !!attempt}
          onClick={() => void start("google")}
        >
          {dt("通过 Google 登录")}
        </Button>
      </div>
      {(attempt || busy) && (
        <div role="status" className="space-y-2 text-sm">
          {attempt ? (
            <>
              <p>
                {dt(
                  "请在浏览器核对账号与授权码，再批准本机登录。五分钟内有效。",
                )}
              </p>
              <strong className="font-mono text-lg tracking-widest">
                {attempt.displayCode}
              </strong>
            </>
          ) : (
            <p>{dt("正在准备浏览器授权…")}</p>
          )}
          <Button type="button" variant="ghost" onClick={cancel}>
            {dt("取消浏览器登录")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive break-words">
          {dt(error)}
        </p>
      )}
    </section>
  );
}
