import { useEffect, useRef, useState } from "react";
import { Copy, Eye, EyeOff, KeyRound, Plus, RefreshCw, X } from "lucide-react";
import {
  amountToQuota,
  api,
  errorText,
  Group,
  Page,
  quotaAmount,
  Token,
} from "./api";
import { Notice } from "./App";

export function Tokens({
  active,
  perUnit,
}: {
  active: boolean;
  perUnit: number;
}) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [create, setCreate] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [key, setKey] = useState<{ id: number; value: string } | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const visibility = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  const load = async () => {
    const id = ++generation.current;
    setLoading(true);
    try {
      const value = await api.get<Page<Token>>("tokens", { page });
      if (alive.current && generation.current === id) {
        setTokens(value.items || []);
        setTotal(value.total || 0);
        setMessage("");
      }
    } catch (e) {
      if (alive.current && generation.current === id) setMessage(errorText(e));
    } finally {
      if (alive.current && generation.current === id) setLoading(false);
    }
  };
  useEffect(() => {
    visibility.current++;
    setKey(null);
    if (active) void load();
  }, [active, page]);
  useEffect(() => {
    if (!key) return;
    const timer = setTimeout(() => setKey(null), 60000);
    return () => clearTimeout(timer);
  }, [key]);
  const reveal = async (token: Token) => {
    if (key?.id === token.id) {
      setKey(null);
      return;
    }
    const visible = visibility.current;
    setPending(token.id);
    try {
      const result = await api.get<{ key: string }>("token_key", {
        id: token.id,
      });
      if (alive.current && visibility.current === visible)
        setKey({
          id: token.id,
          value: result.key.startsWith("sk-") ? result.key : `sk-${result.key}`,
        });
    } catch (e) {
      if (alive.current) setMessage(errorText(e));
    } finally {
      if (alive.current) setPending(null);
    }
  };
  const toggle = async (token: Token) => {
    setPending(token.id);
    try {
      await api.get("token_status", {
        id: token.id,
        status: token.status === 1 ? 2 : 1,
      });
      if (alive.current) {
        setKey(null);
        await load();
      }
    } catch (e) {
      if (alive.current) setMessage(errorText(e));
    } finally {
      if (alive.current) setPending(null);
    }
  };
  const copy = async () => {
    if (key)
      try {
        await navigator.clipboard.writeText(key.value);
        setMessage("令牌已复制，请妥善保管");
      } catch {
        setMessage("复制失败，请长按令牌手动复制");
      }
  };
  return (
    <div className="page tokens-page">
      <div className="page-heading heading-row">
        <div>
          <span className="eyebrow">YOUR CONNECTIONS</span>
          <h1>令牌管理</h1>
        </div>
        <button
          className="icon-button"
          aria-label="刷新令牌"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={19} className={loading ? "spin" : ""} />
        </button>
      </div>
      <p className="muted">为你的应用创建独立凭据，随时掌握使用范围。</p>
      <button className="primary full" onClick={() => setCreate(true)}>
        <Plus size={18} />
        创建令牌
      </button>
      <Notice text={message} />
      {!tokens.length && (
        <div className="empty-card">
          <KeyRound size={30} />
          <h2>{loading ? "正在读取…" : "还没有令牌"}</h2>
          <p>创建一个令牌，让你的工具连接元衡。</p>
        </div>
      )}
      <div className="token-list">
        {tokens.map((token) => (
          <article className="token-card" key={token.id}>
            <div className="token-title">
              <div className="token-icon">
                <KeyRound size={19} />
              </div>
              <strong>{token.name || "未命名令牌"}</strong>
              <span className={`badge ${token.status === 1 ? "enabled" : ""}`}>
                {(
                  {
                    1: "使用中",
                    2: "已停用",
                    3: "已过期",
                    4: "额度用尽",
                  } as Record<number, string>
                )[token.status] || "不可用"}
              </span>
            </div>
            <div className="token-meta">
              <span>
                分组 <b>{token.group || "跟随账号"}</b>
              </span>
              <span>
                剩余额度{" "}
                <b>
                  {token.unlimited_quota
                    ? "不限令牌额度"
                    : quotaAmount(token.remain_quota, perUnit)}
                </b>
              </span>
              <span>
                到期{" "}
                <b>
                  {token.expired_time === -1
                    ? "长期有效"
                    : new Date(token.expired_time * 1000).toLocaleDateString(
                        "zh-CN",
                      )}
                </b>
              </span>
            </div>
            {key?.id === token.id && (
              <div className="secret-box">
                <code>{key.value}</code>
                <button
                  className="icon-button"
                  aria-label="复制令牌"
                  onClick={() => void copy()}
                >
                  <Copy size={17} />
                </button>
              </div>
            )}
            <div className="token-actions">
              <button
                disabled={pending !== null}
                onClick={() => void reveal(token)}
              >
                {key?.id === token.id ? (
                  <EyeOff size={15} />
                ) : (
                  <Eye size={15} />
                )}{" "}
                {key?.id === token.id ? "隐藏令牌" : "查看令牌"}
              </button>
              <button
                disabled={pending !== null}
                onClick={() => void toggle(token)}
              >
                {token.status === 1 ? "停用" : "启用"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {total > 20 && (
        <div className="pagination">
          <button
            className="secondary"
            disabled={page === 1 || loading}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </button>
          <span>
            {page} / {Math.ceil(total / 20)}
          </span>
          <button
            className="secondary"
            disabled={page * 20 >= total || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      )}
      <p className="footnote">
        令牌只能访问账号已获授权的模型和分组。不限令牌额度仍会消耗账户余额。
      </p>
      {create && (
        <CreateToken
          perUnit={perUnit}
          close={() => setCreate(false)}
          done={() => {
            setCreate(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
function CreateToken({
  perUnit,
  close,
  done,
}: {
  perUnit: number;
  close: () => void;
  done: () => void;
}) {
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [groups, setGroups] = useState<Record<string, Group>>({});
  const [amount, setAmount] = useState("10");
  const [unlimited, setUnlimited] = useState(false);
  const [days, setDays] = useState("30");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let mounted = true;
    void api
      .get<Record<string, Group>>("groups")
      .then((value) => {
        if (mounted) {
          setGroups(value);
          setGroup(Object.keys(value)[0] || "");
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (mounted) setError(errorText(e));
      });
    return () => {
      mounted = false;
    };
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!name.trim() || name.trim().length > 50)
        throw new Error("令牌名称需要 1–50 个字符");
      if (!group || !Object.prototype.hasOwnProperty.call(groups, group))
        throw new Error("请选择可用分组");
      const limits = models
        .split(/[,，\n]/)
        .map((v) => v.trim())
        .filter(Boolean)
        .join(",");
      await api.get("token_create", {
        name: name.trim(),
        group,
        remain_quota: unlimited ? 0 : amountToQuota(amount, perUnit),
        unlimited_quota: unlimited,
        expired_time:
          days === "-1"
            ? -1
            : Math.floor(Date.now() / 1000) + Number(days) * 86400,
        model_limits_enabled: !!limits,
        model_limits: limits,
      });
      done();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sheet-backdrop">
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="创建令牌"
      >
        <div className="sheet-heading">
          <h2>创建令牌</h2>
          <button
            className="icon-button"
            aria-label="关闭创建令牌"
            disabled={busy}
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        <form onSubmit={submit}>
          <label>
            名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：我的编程工具"
              maxLength={50}
              required
            />
          </label>
          <label>
            分组
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              disabled={!loaded}
            >
              <option value="" disabled>
                {loaded ? "请选择分组" : "正在读取分组…"}
              </option>
              {Object.entries(groups).map(([id, v]) => (
                <option key={id} value={id}>
                  {v.desc || id}
                  {v.ratio !== undefined ? ` · ${v.ratio} 倍` : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="two-columns">
            <label>
              额度上限（美元）
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={unlimited}
                required={!unlimited}
              />
            </label>
            <label>
              有效期
              <select value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="7">7 天</option>
                <option value="30">30 天</option>
                <option value="90">90 天</option>
                <option value="-1">长期有效</option>
              </select>
            </label>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={unlimited}
              onChange={(e) => setUnlimited(e.target.checked)}
            />
            不限令牌额度（仍扣账户余额）
          </label>
          <label>
            限定模型（可选）
            <input
              value={models}
              onChange={(e) => setModels(e.target.value)}
              placeholder="多个模型名称用逗号分隔"
            />
          </label>
          <Notice text={error} />
          <button
            className="primary full"
            disabled={busy || !loaded || (!unlimited && !perUnit)}
          >
            {busy ? "正在创建…" : "创建令牌"}
          </button>
          {!perUnit && (
            <p className="footnote">暂未读取到额度单位，请稍后重新连接。</p>
          )}
        </form>
      </section>
    </div>
  );
}
