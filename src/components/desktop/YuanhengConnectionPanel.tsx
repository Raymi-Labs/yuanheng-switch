import { useState } from "react";
import {
  CheckCircle2,
  Cloud,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isCredentialAccessRequired } from "@/lib/api/yuanheng";
import type { YuanhengAuthResult } from "@/lib/api/yuanheng";
import {
  useLoginYuanheng,
  useRefreshYuanheng,
  useRegisterYuanheng,
  useSignOutYuanheng,
  useVerifyYuanhengTwoFactor,
  useYuanhengConnection,
  useRestoreYuanhengKeychainAccess,
} from "@/lib/query/yuanheng";

import { extractErrorMessage } from "@/utils/errorUtils";
import { cn } from "@/lib/utils";
import { dt } from "./desktopI18n";
import { useYuanhengPulse } from "@/hooks/useYuanhengPulse";

const MAX_LOGIN_USERNAME_LENGTH = 254;
const MAX_REGISTER_USERNAME_LENGTH = 20;

interface YuanhengConnectionPanelProps {
  compact?: boolean;
  onConnected?: () => void;
}

export function YuanhengConnectionPanel({
  compact = false,
  onConnected,
}: YuanhengConnectionPanelProps) {
  const {
    data: status,
    isLoading,
    error: connectionError,
  } = useYuanhengConnection();
  const restoreAccess = useRestoreYuanhengKeychainAccess();
  const login = useLoginYuanheng();
  const register = useRegisterYuanheng();
  const verifyTwoFactor = useVerifyYuanhengTwoFactor();
  const refresh = useRefreshYuanheng();
  const signOut = useSignOutYuanheng();
  const { isOpening: isOpeningPulse, openPulse } = useYuanhengPulse();
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [requiresTwoFactor, setRequiresTwoFactor] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState("");

  const finishAuthentication = (result: YuanhengAuthResult) => {
    setPassword("");
    setConfirmPassword("");
    if (result.requiresTwoFactor) {
      setRequiresTwoFactor(true);
      toast.success(dt("账号密码验证通过，请完成两步验证"));
      return;
    }
    setUsername("");
    setTwoFactorCode("");
    setRequiresTwoFactor(false);
    const message =
      authMode === "register" ? dt("注册并登录成功") : dt("登录成功");
    if (result.connection?.sessionOnly) {
      toast.success(message, {
        description: dt(
          "已登录；本次会话未保存在本机，关闭应用后需要重新登录。",
        ),
        duration: 8000,
      });
    } else {
      toast.success(message);
    }
    onConnected?.();
  };

  const handleAuthenticate = async () => {
    const normalizedUsername = username.trim();
    const usernameLimit =
      authMode === "login"
        ? MAX_LOGIN_USERNAME_LENGTH
        : MAX_REGISTER_USERNAME_LENGTH;
    if (
      !normalizedUsername ||
      Array.from(normalizedUsername).length > usernameLimit
    ) {
      toast.error(
        authMode === "login"
          ? dt("登录账号不能为空且不能超过 254 个字符")
          : dt("用户名不能为空且不能超过 20 个字符"),
      );
      return;
    }
    if (password.length < 8 || password.length > 20) {
      toast.error(dt("密码长度必须为 8 到 20 个字符"));
      return;
    }
    if (authMode === "register" && password !== confirmPassword) {
      toast.error(dt("两次输入的密码不一致"));
      return;
    }
    try {
      const result = await (
        authMode === "register" ? register : login
      ).mutateAsync({
        username: normalizedUsername,
        password,
      });
      finishAuthentication(result);
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          (authMode === "register" ? dt("注册失败") : dt("登录失败")),
      );
    }
  };

  const handleTwoFactor = async () => {
    if (!twoFactorCode.trim()) {
      toast.error(dt("请输入两步验证码或备用码"));
      return;
    }
    try {
      const result = await verifyTwoFactor.mutateAsync(twoFactorCode.trim());
      finishAuthentication(result);
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("两步验证失败"));
    }
  };

  const switchAuthMode = (mode: "login" | "register") => {
    setAuthMode(mode);
    setPassword("");
    setConfirmPassword("");
  };

  const handleRefresh = async () => {
    try {
      await refresh.mutateAsync();
      toast.success(dt("元衡数据已同步"));
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("同步失败"));
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut.mutateAsync();
      toast.success(dt("已退出元衡账号，本机工具配置保持不变"));
    } catch (error) {
      toast.error(extractErrorMessage(error) || dt("退出登录失败"));
    }
  };

  const needsCredentialAccess = [
    connectionError,
    login.error,
    register.error,
    verifyTwoFactor.error,
  ].some(isCredentialAccessRequired);
  const handleRestoreAccess = async () => {
    try {
      const restored = await restoreAccess.mutateAsync();
      login.reset();
      register.reset();
      verifyTwoFactor.reset();
      toast.success(
        restored.connected
          ? dt("本机登录已恢复")
          : dt("凭据访问已恢复，请重新登录"),
      );
      if (restored.connected) onConnected?.();
    } catch {
      // A denial is not a logout, and must never trigger another authorization.
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-36 items-center justify-center rounded-2xl border bg-card">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!status?.connected) {
    const authPending =
      login.isPending || register.isPending || restoreAccess.isPending;
    return (
      <section
        className={cn(
          "relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.07] via-card to-[#d69554]/[0.08]",
          compact ? "p-3.5" : "p-5",
        )}
      >
        <div className="pointer-events-none absolute -right-12 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
        <div
          className={cn(
            "relative",
            compact ? "space-y-3" : "grid gap-6 md:grid-cols-[1fr_1.05fr]",
          )}
        >
          <div>
            <div
              className={cn(
                "flex items-center justify-center bg-primary/10 text-primary",
                compact ? "h-8 w-8 rounded-lg" : "h-10 w-10 rounded-xl",
              )}
            >
              <Cloud className={compact ? "h-4 w-4" : "h-5 w-5"} />
            </div>
            <p
              className={cn(
                "font-semibold uppercase tracking-[0.18em] text-primary",
                compact ? "mt-2.5 text-[9px]" : "mt-4 text-[11px]",
              )}
            >
              {dt("元衡 API")}
            </p>
            <h2
              className={cn(
                "font-display mt-1 font-semibold",
                compact ? "text-lg" : "text-xl",
              )}
            >
              {requiresTwoFactor ? dt("完成两步验证") : dt("登录你的元衡账号")}
            </h2>
            <p
              className={cn(
                "mt-1.5 max-w-lg text-muted-foreground",
                compact ? "text-[11px] leading-4" : "text-[13px] leading-5",
              )}
            >
              {requiresTwoFactor
                ? dt("输入认证器验证码或备用码，验证成功后即可继续。")
                : dt(
                    "直接使用账号密码登录或注册。密码不会保存在本机，登录后客户端会自动创建或复用本机专用工具凭据。",
                  )}
            </p>
            {!requiresTwoFactor && (
              <p
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300",
                  compact
                    ? "mt-2 px-2 py-0.5 text-[9px]"
                    : "mt-3 px-2.5 py-1 text-[10px]",
                )}
              >
                <ShieldCheck className="h-3 w-3" />{" "}
                {dt("账号密码仅用于本次认证")}
              </p>
            )}
          </div>
          <div
            className={cn(
              "relative rounded-xl border bg-background/80 shadow-sm",
              compact ? "p-3" : "p-4",
            )}
          >
            {needsCredentialAccess && !requiresTwoFactor && (
              <div
                role="alert"
                className="mb-3 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] leading-5"
              >
                <p className="font-medium">{dt("本机登录信息需要恢复访问")}</p>
                <p>
                  {dt(
                    "macOS 暂时无法读取旧登录信息。你可以直接使用账号密码重新登录，无需恢复旧条目；也可以点击下方按钮，按系统提示恢复原来的登录。",
                  )}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={authPending || verifyTwoFactor.isPending}
                  onClick={() => void handleRestoreAccess()}
                >
                  {restoreAccess.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  {dt("恢复本机登录")}
                </Button>
                {restoreAccess.isError && (
                  <p>
                    {dt("未恢复访问，原有登录信息已保留。可稍后再次点击恢复。")}
                  </p>
                )}
              </div>
            )}
            {requiresTwoFactor ? (
              <form
                className={compact ? "space-y-2.5" : "space-y-3"}
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleTwoFactor();
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="yuanheng-two-factor" className="text-[12px]">
                    {dt("两步验证码")}
                  </Label>
                  <Input
                    id="yuanheng-two-factor"
                    autoFocus
                    autoComplete="one-time-code"
                    value={twoFactorCode}
                    onChange={(event) => setTwoFactorCode(event.target.value)}
                    placeholder={dt("6 位验证码或备用码")}
                    className={compact ? "h-8 text-[12px]" : "h-9"}
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={
                    !twoFactorCode.trim() ||
                    verifyTwoFactor.isPending ||
                    restoreAccess.isPending
                  }
                >
                  {verifyTwoFactor.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-4 w-4" />
                  )}
                  {dt("验证并登录")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-[12px]"
                  disabled={verifyTwoFactor.isPending}
                  onClick={() => {
                    setRequiresTwoFactor(false);
                    setTwoFactorCode("");
                  }}
                >
                  {dt("返回账号登录")}
                </Button>
              </form>
            ) : (
              <form
                className={compact ? "space-y-2.5" : "space-y-3"}
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleAuthenticate();
                }}
              >
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/65 p-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={authMode === "login" ? "secondary" : "ghost"}
                    className={cn("text-[12px]", compact ? "h-7" : "h-8")}
                    aria-pressed={authMode === "login"}
                    onClick={() => switchAuthMode("login")}
                  >
                    {dt("登录")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={authMode === "register" ? "secondary" : "ghost"}
                    className={cn("text-[12px]", compact ? "h-7" : "h-8")}
                    aria-pressed={authMode === "register"}
                    onClick={() => switchAuthMode("register")}
                  >
                    {dt("注册")}
                  </Button>
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="yuanheng-username"
                    className={compact ? "text-[11px]" : "text-[12px]"}
                  >
                    {dt("用户名")}
                  </Label>
                  <Input
                    id="yuanheng-username"
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder={dt("输入元衡用户名")}
                    maxLength={
                      authMode === "login"
                        ? MAX_LOGIN_USERNAME_LENGTH
                        : MAX_REGISTER_USERNAME_LENGTH
                    }
                    className={compact ? "h-8 text-[12px]" : "h-9"}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="yuanheng-password"
                    className={compact ? "text-[11px]" : "text-[12px]"}
                  >
                    {dt("密码")}
                  </Label>
                  <Input
                    id="yuanheng-password"
                    type="password"
                    autoComplete={
                      authMode === "register"
                        ? "new-password"
                        : "current-password"
                    }
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={dt("8 到 20 个字符")}
                    className={compact ? "h-8 text-[12px]" : "h-9"}
                  />
                </div>
                {authMode === "register" && (
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="yuanheng-confirm-password"
                      className={compact ? "text-[11px]" : "text-[12px]"}
                    >
                      {dt("确认密码")}
                    </Label>
                    <Input
                      id="yuanheng-confirm-password"
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) =>
                        setConfirmPassword(event.target.value)
                      }
                      placeholder={dt("再次输入密码")}
                      className={compact ? "h-8 text-[12px]" : "h-9"}
                    />
                  </div>
                )}
                <Button
                  type="submit"
                  className={cn("w-full", compact && "h-8 text-[12px]")}
                  disabled={!username.trim() || !password || authPending}
                >
                  {authPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : authMode === "register" ? (
                    <UserPlus className="h-4 w-4" />
                  ) : (
                    <LogIn className="h-4 w-4" />
                  )}
                  {authMode === "register" ? dt("注册并登录") : dt("登录")}
                </Button>
              </form>
            )}
          </div>
        </div>
      </section>
    );
  }

  const accountName =
    status.account?.displayName ||
    status.account?.username ||
    dt("用户 {{v0}}", { v0: status.userId });
  return (
    <section className="overflow-hidden rounded-2xl border border-emerald-500/20 bg-card">
      <div className="flex flex-wrap items-center gap-4 border-b border-border/70 bg-emerald-500/[0.055] px-5 py-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-display truncate text-base font-semibold">
              {accountName}
            </h2>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
              {status.account?.group || "default"}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {dt("元衡账号已登录 · 本机工具凭据已就绪")}
          </p>
          {status.sessionOnly && (
            <p
              className="mt-1 text-xs text-amber-700 dark:text-amber-300"
              role="status"
            >
              {dt("已登录；本次会话未保存在本机，关闭应用后需要重新登录。")}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleRefresh()}
          disabled={refresh.isPending}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", refresh.isPending && "animate-spin")}
          />
          {dt("同步")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void openPulse()}
          disabled={isOpeningPulse}
          title={dt("在隔离窗口打开元衡脉冲")}
        >
          <Sparkles
            className={cn("h-3.5 w-3.5", isOpeningPulse && "animate-pulse")}
          />
          {dt("脉冲控制台")}
        </Button>
        {!compact && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => void handleSignOut()}
            disabled={signOut.isPending}
          >
            <LogOut className="h-3.5 w-3.5" />
            {dt("退出登录")}
          </Button>
        )}
      </div>
    </section>
  );
}
