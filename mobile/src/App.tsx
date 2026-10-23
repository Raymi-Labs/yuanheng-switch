import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronRight,
  Image,
  KeyRound,
  LogOut,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Wallet,
} from "lucide-react";
import { Account, api, errorText, quotaAmount } from "./api";
import { Chat } from "./Chat";
import { Images } from "./Images";
import { Tokens } from "./Tokens";
import { Redeem } from "./Redeem";

type Tab = "chat" | "images" | "tokens" | "account";
const tabs = [
  { id: "chat", label: "聊天", icon: MessageSquare },
  { id: "images", label: "生图", icon: Image },
  { id: "tokens", label: "令牌", icon: KeyRound },
  { id: "account", label: "我的", icon: UserRound },
] as const;

export function Notice({ text }: { text: string }) {
  return text ? (
    <div className="notice" role="status">
      {text}
    </div>
  ) : null;
}
export function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [perUnit, setPerUnit] = useState(0);
  const [tab, setTab] = useState<Tab>("chat");
  const [refreshing, setRefreshing] = useState(false);
  const [purchases, setPurchases] = useState(false);
  const [version, setVersion] = useState("");
  const [aiConsent, setAiConsent] = useState(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const loadUnit = useCallback(async () => {
    try {
      const v = await api.get<{ quota_per_unit: number }>("status");
      if (
        mounted.current &&
        Number.isFinite(v.quota_per_unit) &&
        v.quota_per_unit > 0
      )
        setPerUnit(v.quota_per_unit);
    } catch {
      /* Keep unknown amounts hidden until a later refresh succeeds. */
    }
  }, []);
  const refresh = useCallback(async () => {
    void loadUnit();
    const current = epoch.current;
    setRefreshing(true);
    try {
      const next = await api.get<Account>("account");
      if (mounted.current && epoch.current === current) {
        setAccount((prev) => (prev?.id === next.id ? next : prev));
        setError("");
      }
    } catch (e) {
      if (mounted.current && epoch.current === current) setError(errorText(e));
    } finally {
      if (mounted.current && epoch.current === current) setRefreshing(false);
    }
  }, [loadUnit]);
  const restore = useCallback(async () => {
    const current = ++epoch.current;
    setLoading(true);
    setError("");
    void loadUnit();
    try {
      const next = await api.restore();
      if (mounted.current && epoch.current === current) setAccount(next);
    } catch (e) {
      if (mounted.current && epoch.current === current) setError(errorText(e));
    } finally {
      if (mounted.current && epoch.current === current) setLoading(false);
    }
  }, [loadUnit]);
  useEffect(() => {
    mounted.current = true;
    void api
      .capabilities()
      .then((value) => {
        if (mounted.current) {
          setPurchases(value.purchases);
          setVersion(value.version);
        }
      })
      .catch(() => {});
    void restore();
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [restore]);
  useEffect(() => {
    if (!account) return;
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", visible);
    };
  }, [account?.id, refresh]);
  const changeAiConsent = async (accepted: boolean) => {
    if (!account) return;
    const current = epoch.current;
    await api.aiConsent(accepted, account.id);
    if (mounted.current && epoch.current === current) setAiConsent(accepted);
  };
  const logout = async () => {
    try {
      await api.logout();
      epoch.current++;
      setAccount(null);
      setError("");
      setTab("chat");
      setAiConsent(false);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="app-shell">
      {loading ? (
        <div className="splash">
          <Brand />
          <p>正在读取登录状态…</p>
        </div>
      ) : !account ? (
        <Login
          purchases={purchases}
          error={error}
          onReset={logout}
          onRetry={restore}
          onLogin={(value) => {
            epoch.current++;
            setAccount(value);
            setError("");
            setAiConsent(false);
          }}
        />
      ) : (
        <>
          <header className="topbar">
            <Brand compact />
            <div className="topbar-right">
              <span className="balance-mini">
                {quotaAmount(account.quota, perUnit)}
              </span>
              <button
                className="icon-button"
                aria-label="刷新余额"
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                <RefreshCw size={17} className={refreshing ? "spin" : ""} />
              </button>
            </div>
          </header>
          <main className="main" key={account.id}>
            <Notice text={error} />
            <div hidden={tab !== "chat"} className="panel">
              {aiConsent ? (
                <Chat
                  userId={account.id}
                  defaultGroup={account.group}
                  refresh={refresh}
                />
              ) : (
                <AiConsent onAccept={() => changeAiConsent(true)} />
              )}
            </div>
            <div hidden={tab !== "images"} className="panel">
              {aiConsent ? (
                <Images active={tab === "images"} refresh={refresh} />
              ) : (
                <AiConsent onAccept={() => changeAiConsent(true)} />
              )}
            </div>
            <div hidden={tab !== "tokens"} className="panel">
              <Tokens active={tab === "tokens"} perUnit={perUnit} />
            </div>
            <div hidden={tab !== "account"} className="panel">
              <AccountPage
                account={account}
                perUnit={perUnit}
                refresh={refresh}
                logout={logout}
                purchases={purchases}
                version={version}
                aiConsent={aiConsent}
                revokeConsent={() => changeAiConsent(false)}
              />
            </div>
          </main>
          <nav className="bottom-nav" aria-label="主要功能">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
                aria-current={tab === id ? "page" : undefined}
              >
                <Icon size={22} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </>
      )}
    </div>
  );
}
function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "compact" : ""}`}>
      <span className="brand-symbol">元</span>
      <div>
        <strong>元衡</strong>
        {!compact && <small>让灵感，随时发生。</small>}
      </div>
    </div>
  );
}
function Login({
  purchases,
  error,
  onLogin,
  onReset,
  onRetry,
}: {
  purchases: boolean;
  error: string;
  onLogin: (a: Account) => void;
  onReset: () => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [twoFactor, setTwoFactor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = twoFactor
        ? await api.twoFactor(code)
        : await api.login(username.trim(), password);
      setPassword("");
      if ("requiresTwoFactor" in result && result.requiresTwoFactor)
        setTwoFactor(true);
      else if (result.account) onLogin(result.account);
      else throw new Error("登录未完成，请重试");
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const open = async (destination: "register" | "privacy" | "terms") => {
    try {
      await api.open(destination);
    } catch (e) {
      setMessage(errorText(e));
    }
  };
  return (
    <div className="login-page">
      <div className="login-art">
        <div className="orb orb-one" />
        <div className="orb orb-two" />
        <span className="eyebrow">YUANHENG · MOBILE</span>
        <h1>
          想法到这里，
          <br />
          就有了可能。
        </h1>
        <p>与 AI 对话，把灵感变成画面。</p>
      </div>
      <section className="login-card">
        <Brand />
        <h2>{twoFactor ? "验证你的身份" : "欢迎回来"}</h2>
        <p className="muted">
          {twoFactor ? "输入验证器代码或备用码" : "使用你的元衡账号登录"}
        </p>
        <form onSubmit={submit}>
          {twoFactor ? (
            <label>
              两步验证码
              <input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                required
                maxLength={64}
              />
            </label>
          ) : (
            <>
              <label>
                账号
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                  maxLength={254}
                  placeholder="用户名或邮箱"
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  placeholder="输入密码"
                />
              </label>
            </>
          )}
          <Notice text={message || error} />
          <button className="primary full" disabled={busy}>
            {busy ? "正在验证…" : twoFactor ? "验证并登录" : "登录元衡"}
            <ArrowUpRight size={18} />
          </button>
        </form>
        {twoFactor && (
          <button
            className="text-button"
            onClick={() => {
              setTwoFactor(false);
              setCode("");
            }}
          >
            返回账号登录
          </button>
        )}
        {purchases && (
          <button
            className="text-button full"
            onClick={() => void open("register")}
          >
            还没有账号？前往官网注册 <ChevronRight size={15} />
          </button>
        )}
        {error && (
          <div className="row">
            <button className="text-button" onClick={() => void onRetry()}>
              重新连接
            </button>
            <button className="text-button" onClick={() => void onReset()}>
              清除保存的登录状态
            </button>
          </div>
        )}
        <div className="legal">
          <ShieldCheck size={14} />
          <button onClick={() => void open("privacy")}>隐私政策</button>
          <span>·</span>
          <button onClick={() => void open("terms")}>用户协议</button>
        </div>
      </section>
    </div>
  );
}
function AccountPage({
  account,
  perUnit,
  refresh,
  logout,
  purchases,
  version,
  aiConsent,
  revokeConsent,
}: {
  account: Account;
  perUnit: number;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  purchases: boolean;
  version: string;
  aiConsent: boolean;
  revokeConsent: () => Promise<void>;
}) {
  const [redeem, setRedeem] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const open = async (
    destination: "topup" | "account" | "usage" | "privacy" | "terms",
  ) => {
    try {
      await api.open(destination);
      if (destination === "topup")
        setMessage(
          "已打开官网充值，返回后将刷新余额。浏览器可能需要重新登录。",
        );
    } catch (e) {
      setMessage(errorText(e));
    }
  };
  return (
    <div className="page account-page">
      <div className="page-heading">
        <span className="eyebrow">YOUR SPACE</span>
        <h1>我的元衡</h1>
      </div>
      <div className="profile">
        <div className="avatar">
          {(account.display_name || account.username).slice(0, 1)}
        </div>
        <div>
          <strong>{account.display_name || account.username}</strong>
          <p className="muted">账号 #{account.id}</p>
        </div>
      </div>
      <section className="wallet-card">
        <span>账户余额</span>
        <strong>{quotaAmount(account.quota, perUnit)}</strong>
        <p>累计用量 {quotaAmount(account.used_quota, perUnit)}</p>
        {purchases && (
          <div className="row">
            <button onClick={() => void open("topup")}>
              官网充值 <ArrowUpRight size={16} />
            </button>
            <button onClick={() => setRedeem(true)}>使用兑换码</button>
          </div>
        )}
      </section>
      <Notice text={message} />
      <div className="menu-list">
        {purchases && (
          <>
            <button onClick={() => void open("topup")}>
              <Wallet size={19} />
              充值与支付记录
              <ChevronRight size={17} />
            </button>
            <button onClick={() => void open("usage")}>
              <MessageSquare size={19} />
              消费记录
              <ChevronRight size={17} />
            </button>
            <button onClick={() => void open("account")}>
              <UserRound size={19} />
              账号与安全设置
              <ChevronRight size={17} />
            </button>
          </>
        )}
        <button onClick={() => void open("privacy")}>
          <ShieldCheck size={19} />
          隐私政策
          <ChevronRight size={17} />
        </button>
        <button
          disabled={!aiConsent || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await revokeConsent();
              setMessage(
                "已撤回 AI 数据处理同意，后续生成需重新同意。已发送的请求可能仍在服务端处理。",
              );
            } catch (e) {
              setMessage(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <ShieldCheck size={19} />
          {aiConsent ? "撤回 AI 数据处理同意" : "尚未同意 AI 数据处理"}
        </button>
      </div>
      <p className="footnote">
        余额和消费以元衡后台记录为准。聊天历史仅保存在当前设备，退出后按账号隔离。
      </p>
      <button className="secondary full" onClick={() => void logout()}>
        <LogOut size={17} />
        退出登录
      </button>
      <p className="version">元衡移动端{version && ` · ${version}`}</p>
      {purchases && redeem && (
        <Redeem
          perUnit={perUnit}
          close={() => setRedeem(false)}
          refresh={refresh}
        />
      )}
    </div>
  );
}

function AiConsent({ onAccept }: { onAccept: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <section className="page consent-page">
      <ShieldCheck size={32} />
      <h1>使用 AI 前，请了解数据如何处理</h1>
      <p>
        你发送的文字、对话上下文，以及主动选择并提交的参考图片，会通过元衡（meta-api.vip）转交给所选模型对应的第三方
        AI 服务，用于生成回复或图片。
      </p>
      <p>
        仅选择参考图片不会上传；点击发送或生成时才会提交内容。请勿提交未经授权的他人信息。生成结果可能不准确，请核实重要信息。
      </p>
      <p>你可以在“我的”撤回同意。未同意时仍可查看额度和管理令牌。</p>
      <button
        className="text-button"
        onClick={() =>
          void api.open("privacy").catch((e) => setMessage(errorText(e)))
        }
      >
        查看隐私政策
      </button>
      <Notice text={message} />
      <button
        className="primary full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onAccept();
          } catch (e) {
            setMessage(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "正在保存…" : "同意数据处理并继续"}
      </button>
    </section>
  );
}
