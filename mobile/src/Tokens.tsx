import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  amountToQuota,
  api,
  BalanceUnit,
  errorText,
  Group,
  Page,
  Token,
} from "./api";
import { Money, Notice } from "./App";
import { ChoiceSheet } from "./ChoiceSheet";

const statusLabels: Record<number, string> = {
  1: "使用中",
  2: "已停用",
  3: "已过期",
  4: "额度用尽",
};
const statusFilters = [
  { value: 0, label: "全部" },
  { value: 1, label: "使用中" },
  { value: 2, label: "已停用" },
  { value: 3, label: "已过期" },
  { value: 4, label: "额度用尽" },
];
const quickAmounts = ["1", "5", "10", "20", "50", "100"];
const brandOf = (id: string) => {
  const index = id.indexOf("·");
  return index > 0 ? id.slice(0, index).trim() : id.trim();
};

export function Tokens({
  active,
  perUnit,
  price = 0.2,
  unit = "quota",
}: {
  active: boolean;
  perUnit: number;
  price?: number;
  unit?: BalanceUnit;
}) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState<
    { mode: "create" } | { mode: "edit"; token: Token } | null
  >(null);
  const [pending, setPending] = useState<number | null>(null);
  const [key, setKey] = useState<{ id: number; value: string } | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(0);
  const [confirm, setConfirm] = useState<number | null>(null);
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
      const value = await api.get<Page<Token>>("tokens", {
        page: 1,
        size: 100,
      });
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
    setConfirm(null);
    if (active) void load();
  }, [active]);
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
  const remove = async (token: Token) => {
    setPending(token.id);
    try {
      await api.tokenDelete(token.id);
      if (alive.current) {
        if (key?.id === token.id) setKey(null);
        setConfirm(null);
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
  const keyword = query.trim().toLowerCase();
  const visible = tokens.filter((token) => {
    if (status && token.status !== status) return false;
    if (!keyword) return true;
    return [token.name, token.group, token.model_limits, token.allow_ips]
      .filter((v): v is string => typeof v === "string")
      .some((v) => v.toLowerCase().includes(keyword));
  });
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
      <button
        className="primary full"
        onClick={() => setForm({ mode: "create" })}
      >
        <Plus size={18} />
        创建令牌
      </button>
      <div className="token-toolbar">
        <div className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索令牌"
            placeholder="搜索名称、分组或模型"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={60}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="清除搜索"
              onClick={() => setQuery("")}
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className="chip-row" aria-label="状态筛选">
          {statusFilters.map((item) => (
            <button
              key={item.value}
              className={`chip ${status === item.value ? "active" : ""}`}
              onClick={() => setStatus(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <Notice text={message} />
      {!tokens.length && (
        <div className="empty-card">
          <KeyRound size={30} />
          <h2>{loading ? "正在读取…" : "还没有令牌"}</h2>
          <p>创建一个令牌，让你的工具连接元衡。</p>
        </div>
      )}
      {!!tokens.length && !visible.length && (
        <div className="empty-card">
          <Search size={28} />
          <h2>没有匹配的令牌</h2>
          <p>换个关键词或状态筛选试试。</p>
        </div>
      )}
      <div className="token-list">
        {visible.map((token) => (
          <article className="token-card" key={token.id}>
            <div className="token-title">
              <div className="token-icon">
                <KeyRound size={19} />
              </div>
              <strong>{token.name || "未命名令牌"}</strong>
              <span className={`badge ${token.status === 1 ? "enabled" : ""}`}>
                {statusLabels[token.status] || "不可用"}
              </span>
            </div>
            <div className="token-meta">
              <span>
                分组 <b>{token.group || "跟随账号"}</b>
              </span>
              <span>
                剩余额度{" "}
                <b>
                  {token.unlimited_quota ? (
                    "不限令牌额度"
                  ) : (
                    <Money
                      value={token.remain_quota}
                      perUnit={perUnit}
                      price={price}
                      unit={unit}
                      icon={12}
                    />
                  )}
                </b>
              </span>
              <span>
                已用{" "}
                <b>
                  <Money
                    value={token.used_quota}
                    perUnit={perUnit}
                    price={price}
                    unit={unit}
                    icon={12}
                  />
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
              {token.model_limits_enabled && token.model_limits && (
                <span>
                  限定模型 <b>{token.model_limits}</b>
                </span>
              )}
              {token.allow_ips && (
                <span>
                  IP 白名单 <b>{token.allow_ips}</b>
                </span>
              )}
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
            {confirm === token.id && (
              <div className="token-confirm">
                <span>删除后无法恢复，确认删除该令牌？</span>
                <button
                  className="text-button danger"
                  disabled={pending !== null}
                  onClick={() => void remove(token)}
                >
                  确认删除
                </button>
                <button
                  className="text-button"
                  disabled={pending !== null}
                  onClick={() => setConfirm(null)}
                >
                  取消
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
                onClick={() => setForm({ mode: "edit", token })}
              >
                <Pencil size={15} />
                编辑
              </button>
              <button
                disabled={pending !== null}
                onClick={() => void toggle(token)}
              >
                {token.status === 1 ? "停用" : "启用"}
              </button>
              <button
                className="danger"
                disabled={pending !== null}
                onClick={() => setConfirm(token.id)}
              >
                <Trash2 size={15} />
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
      {total > 100 && (
        <p className="footnote">共 {total} 个令牌，当前仅显示前 100 个。</p>
      )}
      <p className="footnote">
        令牌只能访问账号已获授权的模型和分组。不限令牌额度仍会消耗账户余额。
      </p>
      {form && (
        <TokenForm
          perUnit={perUnit}
          token={form.mode === "edit" ? form.token : undefined}
          close={() => setForm(null)}
          done={() => {
            setForm(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function TokenForm({
  perUnit,
  token,
  close,
  done,
}: {
  perUnit: number;
  token?: Token;
  close: () => void;
  done: () => void;
}) {
  const editing = !!token;
  const [name, setName] = useState(token?.name || "");
  const [group, setGroup] = useState(token?.group || "");
  const [brand, setBrand] = useState(token?.group ? brandOf(token.group) : "");
  const [groups, setGroups] = useState<Record<string, Group>>({});
  const [picker, setPicker] = useState<"brand" | "group" | null>(null);
  const [amount, setAmount] = useState(() =>
    token && !token.unlimited_quota && perUnit > 0
      ? String(Number((token.remain_quota / perUnit).toFixed(6)))
      : "10",
  );
  const [unlimited, setUnlimited] = useState(token?.unlimited_quota || false);
  const [expiry, setExpiry] = useState(() =>
    !token || token.expired_time === -1 ? (token ? "-1" : "30") : "custom",
  );
  const [customDate, setCustomDate] = useState(() =>
    token && token.expired_time > 0
      ? new Date(token.expired_time * 1000).toISOString().slice(0, 10)
      : "",
  );
  const [models, setModels] = useState<string[]>(() =>
    token?.model_limits_enabled && token.model_limits
      ? token.model_limits.split(",").filter(Boolean)
      : [],
  );
  const [catalog, setCatalog] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState("");
  const [allowIps, setAllowIps] = useState(token?.allow_ips || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let mounted = true;
    void api
      .get<Record<string, Group>>("groups")
      .then((value) => {
        if (!mounted) return;
        const extra =
          token?.group && !value[token.group]
            ? { [token.group]: {} as Group }
            : {};
        const next = { ...value, ...extra };
        setGroups(next);
        setGroup((old) => {
          if (old && next[old]) return old;
          const first = Object.keys(next)[0] || "";
          setBrand(first ? brandOf(first) : "");
          return first;
        });
        setLoaded(true);
      })
      .catch((e) => {
        if (mounted) setError(errorText(e));
      });
    return () => {
      mounted = false;
    };
  }, []);
  const brands = useMemo(() => {
    const map = new Map<string, string[]>();
    Object.keys(groups).forEach((id) => {
      const name = brandOf(id);
      map.set(name, [...(map.get(name) || []), id]);
    });
    return Array.from(map, ([name, ids]) => ({ name, ids }));
  }, [groups]);
  const brandGroups = brands.find((v) => v.name === brand)?.ids || [];
  const chooseBrand = (name: string) => {
    setBrand(name);
    const ids = brands.find((v) => v.name === name)?.ids || [];
    setGroup(ids[0] || "");
  };
  useEffect(() => {
    if (!group) return;
    let mounted = true;
    void api
      .get<string[]>("models", { group })
      .then((value) => {
        if (mounted) setCatalog(Array.isArray(value) ? value : []);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [group]);
  const expireAt = () => {
    if (expiry === "-1") return -1;
    if (expiry === "custom") {
      if (!customDate) throw new Error("请选择到期日期");
      const ts = Math.floor(
        new Date(`${customDate}T23:59:59`).getTime() / 1000,
      );
      if (!Number.isFinite(ts) || ts * 1000 <= Date.now())
        throw new Error("到期时间需晚于当前时间");
      return ts;
    }
    return Math.floor(Date.now() / 1000) + Number(expiry) * 86400;
  };
  const toggleModel = (model: string) =>
    setModels((old) =>
      old.includes(model) ? old.filter((v) => v !== model) : [...old, model],
    );
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!name.trim() || name.trim().length > 50)
        throw new Error("令牌名称需要 1–50 个字符");
      if (!group) throw new Error("请选择可用分组");
      const payload: Record<string, unknown> = {
        name: name.trim(),
        group,
        remain_quota: unlimited ? 0 : amountToQuota(amount, perUnit),
        unlimited_quota: unlimited,
        expired_time: expireAt(),
        model_limits_enabled: models.length > 0,
        model_limits: models.join(","),
      };
      if (editing) {
        await api.tokenUpdate({
          id: token!.id,
          ...payload,
          allow_ips: allowIps.trim(),
        });
      } else {
        if (allowIps.trim()) payload.allow_ips = allowIps.trim();
        await api.get("token_create", payload);
      }
      done();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const keyword = modelQuery.trim().toLowerCase();
  const visibleModels = catalog.filter(
    (m) => !keyword || m.toLowerCase().includes(keyword),
  );
  return (
    <div className="sheet-backdrop">
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "编辑令牌" : "创建令牌"}
      >
        <div className="sheet-heading">
          <h2>{editing ? "编辑令牌" : "创建令牌"}</h2>
          <button
            className="icon-button"
            aria-label={editing ? "关闭编辑令牌" : "关闭创建令牌"}
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
          <div className="two-columns">
            <div className="field">
              <span className="field-label">模型品牌</span>
              <button
                type="button"
                className="picker-button"
                aria-label="选择模型品牌"
                disabled={!loaded}
                onClick={() => setPicker("brand")}
              >
                <span className="picker-label">
                  {brand || (loaded ? "请选择品牌" : "正在读取…")}
                </span>
                <ChevronDown size={15} />
              </button>
            </div>
            <div className="field">
              <span className="field-label">分组</span>
              <button
                type="button"
                className="picker-button"
                aria-label="选择分组"
                disabled={!loaded || !brand}
                onClick={() => setPicker("group")}
              >
                <span className="picker-label">
                  {groups[group]?.desc || group || "先选品牌"}
                </span>
                {groups[group]?.ratio !== undefined && (
                  <small>{groups[group].ratio} 倍</small>
                )}
                <ChevronDown size={15} />
              </button>
            </div>
          </div>
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
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              >
                <option value="7">7 天</option>
                <option value="30">30 天</option>
                <option value="90">90 天</option>
                <option value="365">1 年</option>
                <option value="-1">长期有效</option>
                <option value="custom">自定义日期</option>
              </select>
            </label>
          </div>
          <div className="chip-row amount-chips" aria-label="快捷额度">
            {quickAmounts.map((value) => (
              <button
                key={value}
                type="button"
                className={`chip ${amount === value && !unlimited ? "active" : ""}`}
                disabled={unlimited}
                onClick={() => setAmount(value)}
              >
                ${value}
              </button>
            ))}
          </div>
          {expiry === "custom" && (
            <label>
              到期日期
              <input
                type="date"
                value={customDate}
                min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                onChange={(e) => setCustomDate(e.target.value)}
                required
              />
            </label>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={unlimited}
              onChange={(e) => setUnlimited(e.target.checked)}
            />
            不限令牌额度（仍扣账户余额）
          </label>
          <div className="field">
            <span className="field-label">
              限定模型（可选）
              <small>
                {models.length ? `已选 ${models.length} 个` : "不选则不限"}
              </small>
            </span>
            <div className="search-box compact">
              <Search size={15} />
              <input
                aria-label="搜索可选模型"
                placeholder="搜索模型名称"
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
                maxLength={60}
              />
            </div>
            <div className="model-picker">
              {!catalog.length && (
                <p className="muted">
                  {group ? "正在读取模型…" : "选择分组后可限定模型"}
                </p>
              )}
              {visibleModels.map((model) => (
                <label className="pick" key={model}>
                  <input
                    type="checkbox"
                    checked={models.includes(model)}
                    onChange={() => toggleModel(model)}
                  />
                  <span>{model}</span>
                </label>
              ))}
            </div>
            {!!models.length && (
              <button
                type="button"
                className="text-button"
                onClick={() => setModels([])}
              >
                清空已选模型
              </button>
            )}
          </div>
          <label>
            IP 白名单（可选）
            <input
              value={allowIps}
              onChange={(e) => setAllowIps(e.target.value)}
              placeholder="每行或逗号分隔，留空表示不限制"
              maxLength={500}
            />
          </label>
          <Notice text={error} />
          <button
            className="primary full"
            disabled={busy || !loaded || (!unlimited && !perUnit)}
          >
            {busy
              ? editing
                ? "正在保存…"
                : "正在创建…"
              : editing
                ? "保存修改"
                : "创建令牌"}
          </button>
          {!perUnit && (
            <p className="footnote">暂未读取到额度单位，请稍后重新连接。</p>
          )}
        </form>
        {picker === "brand" && (
          <ChoiceSheet
            title="选择模型品牌"
            subtitle="先选品牌，再选分组"
            choices={brands.map((item) => ({
              id: item.name,
              label: item.name,
              meta: `${item.ids.length} 个分组`,
              active: item.name === brand,
            }))}
            searchable={brands.length > 6}
            close={() => setPicker(null)}
            onSelect={(id) => chooseBrand(id)}
          />
        )}
        {picker === "group" && (
          <ChoiceSheet
            title={`${brand} 分组`}
            subtitle="分组决定可用模型与计费倍率"
            choices={brandGroups.map((id) => ({
              id,
              label: groups[id]?.desc || id,
              meta:
                groups[id]?.ratio !== undefined
                  ? `${groups[id].ratio} 倍`
                  : undefined,
              active: id === group,
            }))}
            close={() => setPicker(null)}
            onSelect={(id) => setGroup(id)}
          />
        )}
      </section>
    </div>
  );
}
