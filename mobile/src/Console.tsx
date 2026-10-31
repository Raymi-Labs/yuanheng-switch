import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  KeyRound,
  LayoutDashboard,
  RefreshCw,
  ScrollText,
  X,
} from "lucide-react";
import { api, BalanceUnit, errorText, LogStat, UsageLog } from "./api";
import { Money, Notice } from "./App";
import { Tokens } from "./Tokens";

const views = [
  { id: "dashboard", label: "数据看板", icon: LayoutDashboard },
  { id: "tokens", label: "令牌管理", icon: KeyRound },
  { id: "logs", label: "使用日志", icon: ScrollText },
] as const;
const periods = [
  { id: "today", label: "今日", days: 1 },
  { id: "7d", label: "近 7 天", days: 7 },
  { id: "30d", label: "近 30 天", days: 30 },
] as const;
const logFilters = [
  { value: 0, label: "全部" },
  { value: 2, label: "消费" },
  { value: 1, label: "充值" },
  { value: 4, label: "系统" },
];
const logLabels: Record<number, string> = {
  1: "充值",
  2: "消费",
  3: "管理",
  4: "系统",
};

type View = (typeof views)[number]["id"];
type Period = (typeof periods)[number]["id"];
type Wallet = { perUnit: number; price: number; unit: BalanceUnit };

export function Console({ active, ...props }: Wallet & { active: boolean }) {
  const [view, setView] = useState<View>("dashboard");
  return (
    <div className="console-page">
      <div className="console-tabs" role="tablist" aria-label="控制台分栏">
        {views.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            className={view === id ? "active" : ""}
            onClick={() => setView(id)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      {view === "dashboard" && <Dashboard {...props} active={active} />}
      <div hidden={view !== "tokens"}>
        <Tokens
          active={view === "tokens" && active}
          perUnit={props.perUnit}
          price={props.price}
          unit={props.unit}
        />
      </div>
      {view === "logs" && <Logs {...props} active={active} />}
    </div>
  );
}

function Dashboard({
  perUnit,
  price,
  unit,
  active,
}: Wallet & { active: boolean }) {
  const [period, setPeriod] = useState<Period>("7d");
  const [stat, setStat] = useState<LogStat | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = async () => {
    const id = ++generation.current;
    setLoading(true);
    try {
      const end = Math.floor(Date.now() / 1000);
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const days = periods.find((v) => v.id === period)?.days || 1;
      const start =
        period === "today"
          ? Math.floor(midnight.getTime() / 1000)
          : end - days * 86400;
      const value = await api.logStat(start, end);
      if (generation.current === id) {
        setStat(value);
        setError("");
      }
    } catch (e) {
      if (generation.current === id) setError(errorText(e));
    } finally {
      if (generation.current === id) setLoading(false);
    }
  };
  useEffect(() => {
    if (!active) return;
    void load();
    return () => {
      generation.current++;
    };
  }, [period, active]);
  const label = periods.find((v) => v.id === period)?.label || "近 7 天";
  const rate = (value?: number) =>
    Number.isFinite(value)
      ? (value as number).toLocaleString("en-US", {
          maximumFractionDigits: 1,
        })
      : "0";
  return (
    <div className="page dashboard-page">
      <div className="page-heading heading-row">
        <div>
          <span className="eyebrow">USAGE OVERVIEW</span>
          <h1>数据看板</h1>
        </div>
        <button
          className="icon-button"
          aria-label="刷新看板"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={19} className={loading ? "spin" : ""} />
        </button>
      </div>
      <div className="chip-row" aria-label="统计时段">
        {periods.map((item) => (
          <button
            key={item.id}
            className={`chip ${period === item.id ? "active" : ""}`}
            onClick={() => setPeriod(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <Notice text={error} />
      <section className="stat-hero">
        <span>{label}已消耗</span>
        <strong>
          <Money
            value={stat?.quota || 0}
            perUnit={perUnit}
            price={price}
            unit={unit}
            icon={24}
          />
        </strong>
        <small>统计来自使用日志，刚产生的消费可能略有延迟。</small>
      </section>
      <div className="stat-grid">
        <div className="stat-card">
          <span>请求速率</span>
          <strong>{rate(stat?.rpm)}</strong>
          <small>每分钟请求（RPM）</small>
        </div>
        <div className="stat-card">
          <span>Token 速率</span>
          <strong>{rate(stat?.tpm)}</strong>
          <small>每分钟 Token（TPM）</small>
        </div>
      </div>
      <p className="footnote">需要查看每条调用的明细，请切换到「使用日志」。</p>
    </div>
  );
}

function Logs({ perUnit, price, unit, active }: Wallet & { active: boolean }) {
  const [type, setType] = useState(0);
  const [items, setItems] = useState<UsageLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<UsageLog | null>(null);
  const generation = useRef(0);
  const load = async (nextPage: number) => {
    const id = ++generation.current;
    setLoading(true);
    try {
      const value = await api.logs({ page: nextPage, size: 30, type });
      if (generation.current !== id) return;
      const list = Array.isArray(value.items) ? value.items : [];
      setItems((old) => (nextPage === 1 ? list : [...old, ...list]));
      setTotal(value.total || 0);
      setPage(nextPage);
      setError("");
    } catch (e) {
      if (generation.current === id) setError(errorText(e));
    } finally {
      if (generation.current === id) setLoading(false);
    }
  };
  useEffect(() => {
    if (!active) return;
    setItems([]);
    setTotal(0);
    void load(1);
    return () => {
      generation.current++;
    };
  }, [type, active]);
  return (
    <div className="page logs-page">
      <div className="page-heading heading-row">
        <div>
          <span className="eyebrow">USAGE LOGS</span>
          <h1>使用日志</h1>
        </div>
        <button
          className="icon-button"
          aria-label="刷新日志"
          disabled={loading}
          onClick={() => void load(1)}
        >
          <RefreshCw size={19} className={loading ? "spin" : ""} />
        </button>
      </div>
      <div className="chip-row" aria-label="日志类型">
        {logFilters.map((item) => (
          <button
            key={item.value}
            className={`chip ${type === item.value ? "active" : ""}`}
            onClick={() => setType(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <Notice text={error} />
      {!items.length && (
        <div className="empty-card">
          <ScrollText size={30} />
          <h2>{loading ? "正在读取…" : "暂无使用记录"}</h2>
          <p>开始调用模型后，这里会展示每一次消费明细。</p>
        </div>
      )}
      <div className="log-list">
        {items.map((log) => (
          <button
            type="button"
            className="log-item"
            key={log.id}
            onClick={() => setDetail(log)}
          >
            <div className="log-main">
              <div className="log-top">
                <strong>
                  {log.type === 2
                    ? log.model_name || "模型调用"
                    : logLabels[log.type] || "记录"}
                </strong>
                <span className="log-type">
                  {logLabels[log.type] || "记录"}
                </span>
              </div>
              {log.type === 2 ? (
                <p className="log-meta">
                  {log.token_name ? `令牌 ${log.token_name} · ` : ""}
                  {log.prompt_tokens || 0} + {log.completion_tokens || 0} tokens
                  {Number.isFinite(log.use_time)
                    ? ` · ${(log.use_time as number).toFixed(1)}s`
                    : ""}
                </p>
              ) : (
                <p className="log-meta">{log.content || "—"}</p>
              )}
              <p className="log-time">{formatTime(log.created_at)}</p>
            </div>
            {log.quota > 0 && (
              <span className="log-quota">
                <Money
                  value={log.quota}
                  perUnit={perUnit}
                  price={price}
                  unit={unit}
                  icon={12}
                />
              </span>
            )}
            <ChevronRight size={15} className="log-arrow" />
          </button>
        ))}
      </div>
      {items.length < total && (
        <button
          className="text-button load-more"
          disabled={loading}
          onClick={() => void load(page + 1)}
        >
          {loading ? "正在读取…" : `加载更多（${items.length}/${total}）`}
        </button>
      )}
      {detail && (
        <LogDetailSheet
          log={detail}
          perUnit={perUnit}
          price={price}
          unit={unit}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

// 与网页一致：消费类日志可以点开查看本次调用的完整明细。
function LogDetailSheet({
  log,
  perUnit,
  price,
  unit,
  onClose,
}: Wallet & { log: UsageLog; onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<number>();
  const close = () => {
    if (closing) return;
    setClosing(true);
    timer.current = window.setTimeout(onClose, 220);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const other = useMemo(() => parseOther(log.other), [log.other]);
  const cacheTokens = number(other.cache_tokens);
  const input = log.prompt_tokens || 0;
  const output = log.completion_tokens || 0;
  const frt = number(other.frt);
  const groupRatio = number(other.group_ratio);
  const tier = typeof other.matched_tier === "string" ? other.matched_tier : "";
  const path = typeof other.request_path === "string" ? other.request_path : "";
  const stream = other.stream_status as { status?: string } | undefined;
  const responseModel = other.response_model as
    | { returned_model?: string }
    | undefined;
  return (
    <div className={`sheet-backdrop${closing ? " closing" : ""}`}>
      <section
        className="sheet detail-sheet log-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="日志详情"
      >
        <div className="sheet-header">
          <span className="sheet-grab" aria-hidden="true" />
          <div className="sheet-heading">
            <h2>
              {log.type === 2
                ? log.model_name || "模型调用"
                : logLabels[log.type] || "记录详情"}
            </h2>
            <button
              className="icon-button"
              aria-label="关闭详情"
              onClick={close}
            >
              <X size={20} />
            </button>
          </div>
        </div>
        <dl className="log-detail">
          <Row label="时间">{formatFullTime(log.created_at)}</Row>
          <Row label="类型">{logLabels[log.type] || "记录"}</Row>
          {log.token_name && <Row label="令牌">{log.token_name}</Row>}
          {log.group && <Row label="分组">{log.group}</Row>}
          {groupRatio > 0 && <Row label="分组倍率">{groupRatio}</Row>}
          {tier && <Row label="计费时段">{tier}</Row>}
          {path && <Row label="调用接口">{path}</Row>}
          {log.type === 2 && (
            <>
              <Row label="输入 tokens">{input.toLocaleString("zh-CN")}</Row>
              <Row label="输出 tokens">{output.toLocaleString("zh-CN")}</Row>
              {cacheTokens > 0 && (
                <Row label="缓存命中 tokens">
                  {cacheTokens.toLocaleString("zh-CN")}
                  {input > 0
                    ? ` · ${Math.min(100, Math.round((cacheTokens / input) * 100))}%`
                    : ""}
                </Row>
              )}
            </>
          )}
          {frt > 0 && <Row label="首字延迟">{(frt / 1000).toFixed(2)}s</Row>}
          {Number.isFinite(log.use_time) && (
            <Row label="总用时">{(log.use_time as number).toFixed(1)}s</Row>
          )}
          {log.type === 2 && (
            <Row label="流式调用">{log.is_stream ? "是" : "否"}</Row>
          )}
          {stream?.status && (
            <Row label="调用状态">
              {stream.status === "ok" ? "正常" : stream.status}
            </Row>
          )}
          {responseModel?.returned_model &&
            responseModel.returned_model !== log.model_name && (
              <Row label="实际返回模型">{responseModel.returned_model}</Row>
            )}
          {log.channel_name || log.channel ? (
            <Row label="渠道">{log.channel_name || log.channel}</Row>
          ) : null}
          <Row label="额度">
            <Money
              value={log.quota}
              perUnit={perUnit}
              price={price}
              unit={unit}
              icon={12}
            />
          </Row>
          {log.request_id && <Row label="请求 ID">{log.request_id}</Row>}
        </dl>
        {log.content && <p className="log-detail-content">{log.content}</p>}
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="log-detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function parseOther(value?: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatFullTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return new Date(value * 1000).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return new Date(value * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
