import { useEffect, useRef, useState } from "react";
import { Copy, Ticket, X } from "lucide-react";
import {
  amountToQuota,
  api,
  balanceText,
  BalanceUnit,
  errorText,
  RedemptionCode,
  RedemptionSummary,
} from "./api";
import { Money, Notice } from "./App";
import {
  readRedemptionAttempt,
  prepareRedemptionAttempt,
  clearRedemptionAttempt,
  lockRedemption,
  type RedemptionAttempt,
} from "./redemptionAttempt";

const statusLabels: Record<number, string> = {
  1: "未使用",
  2: "已禁用",
  3: "已使用",
};

export function Redemptions({
  userId,
  perUnit,
  price,
  unit,
  quotaLimit,
  close,
  refresh,
}: {
  userId: number;
  perUnit: number;
  price: number;
  unit: BalanceUnit;
  quotaLimit: number;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [summary, setSummary] = useState<RedemptionSummary | null>(null);
  const [codes, setCodes] = useState<RedemptionCode[]>([]);
  const [amount, setAmount] = useState("");
  const [created, setCreated] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<RedemptionAttempt | null>(null);
  const [storageError, setStorageError] = useState("");
  const locked = useRef(false);
  const alive = useRef(true);
  const load = async () => {
    setLoading(true);
    try {
      const [nextSummary, list] = await Promise.all([
        api.redemptionSummary(),
        api.redemptions(1, 20),
      ]);
      if (!alive.current) return;
      setSummary(nextSummary);
      setCodes(Array.isArray(list.items) ? list.items : []);
      setError("");
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    try {
      setPending(readRedemptionAttempt(userId));
    } catch (e) {
      setStorageError(errorText(e));
    }
    void load();
    return () => {
      alive.current = false;
    };
  }, [userId]);
  const money = (value: number) =>
    `${balanceText(value, perUnit, unit, price)}${unit === "cny" ? " 元" : " ⚡"}`;
  const minimum = summary?.minimum_quota || 0;
  const minAmount = perUnit > 0 && minimum > 0 ? minimum / perUnit : 0;
  const quick = minAmount
    ? [1, 5, 10, 50].map((n) => String(Math.round(minAmount * n)))
    : [];
  const submit = async () => {
    if (locked.current || storageError) return;
    locked.current = true;
    let unlock: (() => void) | undefined;
    setError("");
    setMessage("");
    setBusy(true);
    try {
      unlock = lockRedemption(userId);
      const previous = readRedemptionAttempt(userId);
      const quota = previous?.quota ?? amountToQuota(amount, perUnit);
      if (!previous) {
        if (!summary) throw new Error("暂时无法读取兑换码额度规则，请稍后重试");
        if (quota < summary.minimum_quota)
          throw new Error(`兑换码额度不能低于 ${money(summary.minimum_quota)}`);
        if (
          summary.daily_create_limit > 0 &&
          summary.daily_created_count >= summary.daily_create_limit
        )
          throw new Error("今日创建次数已达上限，请明天再试");
        if (
          summary.daily_quota_limit > 0 &&
          summary.daily_created_quota + quota > summary.daily_quota_limit
        )
          throw new Error(
            `今日可创建额度不足，剩余 ${money(summary.daily_quota_limit - summary.daily_created_quota)}`,
          );
        if (
          summary.active_limit > 0 &&
          summary.active_count >= summary.active_limit
        )
          throw new Error("未使用的兑换码已达上限，请先使用或等待过期");
        if (quota > quotaLimit)
          throw new Error(`可用额度不足，最多可创建 ${money(quotaLimit)}`);
      }
      const attempt = prepareRedemptionAttempt(userId, quota);
      setPending(attempt);
      const result = await api.createRedemption(
        quota,
        attempt.requestId,
        userId,
      );
      if (!alive.current) return;
      const key = result.redemption?.key || "";
      if (!key) throw new Error("返回结果缺少兑换码，请继续确认原操作");
      setCreated(key);
      clearRedemptionAttempt(userId, attempt.requestId);
      setPending(null);
      setAmount("");
      setMessage(key ? "兑换码已创建，请复制保存" : "兑换码已创建");
      await load();
      await refresh();
    } catch (e) {
      if (alive.current)
        setError(
          `${errorText(e)}；若结果未确认，请重试原操作或先核对平台记录。`,
        );
    } finally {
      unlock?.();
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("兑换码已复制");
    } catch {
      setMessage("复制失败，请长按兑换码手动复制");
    }
  };
  return (
    <div className="sheet-backdrop">
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="钱包兑换码"
      >
        <div className="sheet-heading">
          <div>
            <h2>钱包兑换码</h2>
            <p className="choice-subtitle">
              使用余额创建兑换码，可赠与他人到「使用兑换码」兑换。
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭兑换码"
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        <Notice text={storageError || error || message} />
        {pending && (
          <p className="notice">
            存在待确认操作：{money(pending.quota)}
            。关闭页面后仍会保留，确认时沿用原请求编号，不新建操作。
          </p>
        )}
        <div className="code-stats">
          <span>
            今日已创建 <b>{summary?.daily_created_count ?? 0}</b> /{" "}
            {summary?.daily_create_limit || "不限"}
          </span>
          <span>
            今日已转赠{" "}
            <b>{summary ? money(summary.daily_created_quota) : "—"}</b> /{" "}
            {summary?.daily_quota_limit
              ? money(summary.daily_quota_limit)
              : "不限"}
          </span>
          <span>
            未使用 <b>{summary?.active_count ?? 0}</b> /{" "}
            {summary?.active_limit || "不限"}
          </span>
        </div>
        <label>
          兑换码面额
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={minAmount ? `最低 ${minAmount} 额度` : "输入额度"}
            maxLength={20}
            disabled={busy || !!pending || !!storageError}
          />
        </label>
        {!!quick.length && (
          <div className="chip-row amount-chips" aria-label="快捷面额">
            {quick.map((value) => (
              <button
                key={value}
                type="button"
                className={`chip ${amount === value ? "active" : ""}`}
                disabled={busy || !!pending || !!storageError}
                onClick={() => setAmount(value)}
              >
                {value}
              </button>
            ))}
          </div>
        )}
        <button
          className="primary full"
          disabled={
            busy || !!storageError || (!pending && (!amount || !perUnit))
          }
          onClick={() => void submit()}
        >
          {busy ? "正在处理…" : pending ? "确认原操作结果" : "创建兑换码"}
        </button>
        {pending && (
          <button
            className="text-button"
            disabled={busy || !!storageError}
            onClick={() => {
              if (
                !window.confirm(
                  "请先到平台记录确认原操作结果。清除后再次创建属于新操作，可能再次扣额度。确定已核对吗？",
                )
              )
                return;
              try {
                clearRedemptionAttempt(userId, pending.requestId);
                setPending(null);
                setError("");
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            已核对平台记录，开始新操作
          </button>
        )}
        {created && (
          <div className="secret-box">
            <code>{created}</code>
            <button
              className="icon-button"
              aria-label="复制兑换码"
              onClick={() => void copy(created)}
            >
              <Copy size={17} />
            </button>
          </div>
        )}
        <div className="code-list">
          {!codes.length && (
            <div className="empty-card">
              <Ticket size={28} />
              <h2>{loading ? "正在读取…" : "还没有兑换码"}</h2>
              <p>创建后可以复制赠与他人。</p>
            </div>
          )}
          {codes.map((code) => (
            <article className="code-card" key={code.id}>
              <div className="code-main">
                <code>{code.key}</code>
                <p className="log-time">
                  {new Date(code.created_time * 1000).toLocaleString("zh-CN", {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              <span className={`badge ${code.status === 1 ? "enabled" : ""}`}>
                {statusLabels[code.status] || "未知"}
              </span>
              <strong className="code-quota">
                <Money
                  value={code.quota}
                  perUnit={perUnit}
                  price={price}
                  unit={unit}
                  icon={12}
                />
              </strong>
              <button
                className="icon-button"
                aria-label="复制兑换码"
                onClick={() => void copy(code.key)}
              >
                <Copy size={16} />
              </button>
            </article>
          ))}
        </div>
        <p className="footnote">
          兑换码创建后立即从账户余额扣除对应额度，未使用时不会自动退回。
        </p>
      </section>
    </div>
  );
}
