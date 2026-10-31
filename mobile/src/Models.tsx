import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  MessageSquare,
  Search,
  X,
} from "lucide-react";
import {
  api,
  BalanceUnit,
  errorText,
  HealthGroup,
  Pricing,
  PricingModel,
  PricingVendor,
} from "./api";
import { Notice } from "./App";
import { ChoiceSheet } from "./ChoiceSheet";

const sortLabels = {
  default: "推荐排序",
  price: "价格从低到高",
  context: "上下文从大到小",
  latest: "最新发布",
} as const;
type SortKey = keyof typeof sortLabels;

const capabilityLabels: Record<string, string> = {
  function_calling: "函数调用",
  reasoning: "深度推理",
  streaming: "流式输出",
  vision: "视觉理解",
  web_search: "联网搜索",
  code_interpreter: "代码解释器",
  embedding: "向量嵌入",
};

function tags(value?: string): string[] {
  if (!value) return [];
  const raw = value.trim();
  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed))
        return parsed.filter((v): v is string => typeof v === "string");
    } catch {
      /* Fall through to plain text splitting. */
    }
  }
  return raw
    .split(/[,，、|/\s]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function compact(value?: number): string {
  if (!value || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return `${value}`;
}

// 价格与余额单位保持一致：⚡ 为站内计价单位，人民币 = ⚡ × 汇率（与余额换算相同）。
function money(value: number, unit: BalanceUnit, rate: number): string {
  if (!Number.isFinite(value)) return "—";
  if (unit === "cny") {
    const cny = Number.isFinite(rate) && rate > 0 ? rate : 0.2;
    return `¥${(value * cny).toFixed(4)}`;
  }
  return `⚡${value.toFixed(4)}`;
}

function releasedAt(model: PricingModel): number {
  const time = Date.parse(model.release_date || "");
  return Number.isFinite(time) ? time : 0;
}

function isTiered(model: PricingModel): boolean {
  return (model.billing_mode || "").includes("tier") && !!model.billing_expr;
}

type PriceInfo = {
  token: boolean;
  input: number;
  output: number;
  cache: number;
  perUse: number;
  perHour: number;
  dynamic: boolean;
};

// 与网页相同的换算口径：模型倍率 × 2 × 分组倍率。
function prices(model: PricingModel, ratio: number): PriceInfo {
  const dynamic = isTiered(model);
  const base = {
    token: false,
    input: 0,
    output: 0,
    cache: 0,
    perUse: 0,
    perHour: 0,
    dynamic,
  };
  if (model.quota_type === 1) {
    return { ...base, perUse: Number(model.model_price || 0) * ratio };
  }
  if (model.quota_type === 2) {
    return {
      ...base,
      perHour: Number(model.audio_duration_price || 0) * ratio,
    };
  }
  const input = Number(model.model_ratio || 0) * 2 * ratio;
  return {
    ...base,
    token: input > 0,
    input,
    output: input * Number(model.completion_ratio || 1),
    cache: input * Number(model.cache_ratio || 0),
  };
}

// 该模型实际可用的分组（与网页一致：排除 auto，按倍率从低到高）。
function modelGroups(
  model: PricingModel,
  ratios: Record<string, number>,
): string[] {
  return (model.enable_groups || [])
    .filter((id) => id !== "auto" && ratios[id] !== undefined)
    .sort((a, b) => ratios[a] - ratios[b]);
}

// 未指定分组时，按该模型可用分组中的最低倍率展示（与网页「全部分组」一致）。
function ratioOf(
  model: PricingModel,
  ratios: Record<string, number>,
  group: string,
): number {
  if (group) return Number(ratios[group] ?? 1) || 1;
  const values = (model.enable_groups || [])
    .map((id) => ratios[id])
    .filter((v): v is number => typeof v === "number");
  return values.length ? Math.min(...values) : 1;
}

function bestGroup(
  model: PricingModel,
  ratios: Record<string, number>,
): string {
  return modelGroups(model, ratios)[0] || "";
}

export function Models({
  defaultGroup,
  unit,
  price,
  onUse,
}: {
  defaultGroup: string;
  unit: BalanceUnit;
  price: number;
  onUse: (model: string, group: string) => void;
}) {
  const [data, setData] = useState<Pricing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [vendor, setVendor] = useState<number | null>(null);
  const [group, setGroup] = useState("");
  const [sort, setSort] = useState<SortKey>("default");
  const [picker, setPicker] = useState<"group" | "sort" | null>(null);
  const [selected, setSelected] = useState<PricingModel | null>(null);
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void api
      .pricing()
      .then((value) => {
        if (!mounted) return;
        setData(value);
        setError("");
        setLoading(false);
      })
      .catch((e) => {
        if (mounted) {
          setError(errorText(e));
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [attempt]);
  const vendors = useMemo<PricingVendor[]>(
    () => (Array.isArray(data?.vendors) ? data!.vendors! : []),
    [data],
  );
  const scopedModels = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (Array.isArray(data?.data) ? data!.data : []).filter((m) => {
      if (vendor !== null && m.vendor_id !== vendor) return false;
      if (!keyword) return true;
      return [m.model_name, m.display_name, m.description, m.tags, m.owner_by]
        .filter((v): v is string => typeof v === "string")
        .some((v) => v.toLowerCase().includes(keyword));
    });
  }, [data, vendor, query]);
  const groups = useMemo(() => {
    const ratios = data?.group_ratio || {};
    const available = new Set<string>();
    for (const m of scopedModels)
      for (const id of m.enable_groups || [])
        if (ratios[id] !== undefined) available.add(id);
    if (!available.size)
      return Object.keys(ratios).sort((a, b) => ratios[a] - ratios[b]);
    return [...available].sort((a, b) => ratios[a] - ratios[b]);
  }, [data, scopedModels]);
  const hasGroupData = scopedModels.some(
    (m) => (m.enable_groups || []).length > 0,
  );
  const initialized = useRef(false);
  useEffect(() => {
    if (!groups.length) return;
    setGroup((old) => {
      if (!initialized.current) {
        initialized.current = true;
        return groups.includes(defaultGroup) ? defaultGroup : "";
      }
      return old && groups.includes(old) ? old : "";
    });
  }, [groups, defaultGroup]);
  const ratios = useMemo(() => data?.group_ratio || {}, [data]);
  const ratio = group ? Number(ratios[group] ?? 1) || 1 : 0;
  const models = useMemo(() => {
    const list = scopedModels.filter(
      (m) => !hasGroupData || !group || (m.enable_groups || []).includes(group),
    );
    if (sort === "price")
      list.sort((a, b) => {
        const pa = prices(a, ratioOf(a, ratios, group));
        const pb = prices(b, ratioOf(b, ratios, group));
        const va =
          pa.input || pa.perUse || pa.perHour || Number.POSITIVE_INFINITY;
        const vb =
          pb.input || pb.perUse || pb.perHour || Number.POSITIVE_INFINITY;
        return va - vb;
      });
    if (sort === "context")
      list.sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
    if (sort === "latest") list.sort((a, b) => releasedAt(b) - releasedAt(a));
    return list;
  }, [scopedModels, hasGroupData, group, sort, ratios]);
  const vendorName = (id?: number) =>
    vendors.find((v) => v.id === id)?.name || "其他";
  const priceText = (value: number) => money(value, unit, price);
  return (
    <div className="page models-page">
      <div className="page-heading">
        <span className="eyebrow">MODEL GALLERY</span>
        <h1>模型广场</h1>
        <p className="muted">
          共 {Array.isArray(data?.data) ? data!.data.length : 0}{" "}
          个模型，价格按所选分组倍率换算。
        </p>
      </div>
      <div className="model-filters">
        <div className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索模型"
            placeholder="搜索模型名称、厂商或能力"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={80}
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
        <div className="chip-row" aria-label="厂商筛选">
          <button
            className={`chip ${vendor === null ? "active" : ""}`}
            onClick={() => setVendor(null)}
          >
            全部
          </button>
          {vendors.map((v) => (
            <button
              key={v.id}
              className={`chip ${vendor === v.id ? "active" : ""}`}
              onClick={() => setVendor(vendor === v.id ? null : v.id)}
            >
              {v.name}
            </button>
          ))}
        </div>
        <div className="filter-row">
          <button
            className="filter-button"
            aria-label="计价分组"
            onClick={() => setPicker("group")}
            disabled={!groups.length}
          >
            <span className="filter-label">
              <small>计价分组</small>
              <strong>
                {group ||
                  (loading
                    ? "读取中…"
                    : groups.length
                      ? "全部分组"
                      : "该品牌暂无分组")}
              </strong>
            </span>
            {!!group && groups.length > 0 && (
              <span className="filter-meta">{ratio}×</span>
            )}
            <ChevronDown size={15} />
          </button>
          <button
            className="filter-button"
            aria-label="排序方式"
            onClick={() => setPicker("sort")}
          >
            <span className="filter-label">
              <small>智能排序</small>
              <strong>{sortLabels[sort]}</strong>
            </span>
            <ChevronDown size={15} />
          </button>
        </div>
      </div>
      <Notice text={error} />
      {error && (
        <button
          className="secondary full"
          onClick={() => setAttempt((v) => v + 1)}
        >
          重新加载
        </button>
      )}
      {loading && (
        <div className="model-list">
          {[0, 1, 2, 3].map((i) => (
            <div className="model-card skeleton" key={i} aria-hidden="true">
              <span className="skeleton-line" />
              <span className="skeleton-line short" />
              <span className="skeleton-line" />
            </div>
          ))}
        </div>
      )}
      {!loading && !error && !models.length && (
        <div className="empty-card">
          <Search size={28} />
          <h2>没有匹配的模型</h2>
          <p>换个关键词或切换厂商试试。</p>
        </div>
      )}
      <div className="model-list">
        {!loading &&
          models.map((model) => {
            const p = prices(model, ratioOf(model, ratios, group));
            const items = tags(model.tags);
            const caps = Object.entries(model.capabilities || {})
              .filter(([key, on]) => on && capabilityLabels[key])
              .map(([key]) => capabilityLabels[key])
              .slice(0, 3);
            return (
              <button
                className="model-card"
                key={model.model_name}
                onClick={() => setSelected(model)}
              >
                <div className="model-head">
                  <ModelIcon model={model} />
                  <div className="model-name">
                    <strong>{model.display_name || model.model_name}</strong>
                    <small>
                      {vendorName(model.vendor_id)}
                      {model.model_name !== model.display_name && (
                        <> · {model.model_name}</>
                      )}
                    </small>
                  </div>
                  <span className="model-context">
                    {compact(model.context_length)}
                  </span>
                </div>
                {model.description && (
                  <p className="model-desc">{model.description}</p>
                )}
                <div className="model-tags">
                  {items.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                  {caps.map((c) => (
                    <span className="cap" key={c}>
                      {c}
                    </span>
                  ))}
                </div>
                <div className="price-row">
                  {p.token && (
                    <>
                      <span className="price-pair">
                        <b>{priceText(p.input)}</b>
                        <small>输入 / 百万 token</small>
                      </span>
                      <span className="price-pair">
                        <b>{priceText(p.output)}</b>
                        <small>输出 / 百万 token</small>
                      </span>
                    </>
                  )}
                  {!!p.perUse && (
                    <span className="price-pair">
                      <b>{priceText(p.perUse)}</b>
                      <small>每次调用</small>
                    </span>
                  )}
                  {!!p.perHour && (
                    <span className="price-pair">
                      <b>{priceText(p.perHour)}</b>
                      <small>每小时</small>
                    </span>
                  )}
                  {!p.token && !p.perUse && !p.perHour && (
                    <span className="price-tiered">价格以官网为准</span>
                  )}
                  {p.dynamic && (
                    <span className="price-tiered">阶梯计费 · 首档参考价</span>
                  )}
                </div>
              </button>
            );
          })}
      </div>
      {!loading && models.length > 0 && (
        <p className="footnote">
          价格与官网模型广场一致，单位随余额切换（{unit === "cny" ? "¥" : "⚡"}
          ）；实际扣费以控制台账单为准。
        </p>
      )}
      {picker === "group" && (
        <ChoiceSheet
          title="选择计价分组"
          subtitle={
            vendor !== null
              ? "仅显示该品牌可用的分组，倍率越低价格越便宜"
              : "倍率越低，模型价格越便宜"
          }
          searchable
          searchPlaceholder="搜索分组名称或说明"
          emptyText="该品牌暂无可用分组"
          close={() => setPicker(null)}
          onSelect={setGroup}
          choices={[
            {
              id: "",
              label: "全部分组",
              note: "每个模型显示其可用分组中的最低价格",
              active: group === "",
            },
            ...groups.map((id) => ({
              id,
              label: id,
              note: data?.usable_group?.[id],
              meta: `${data?.group_ratio?.[id] ?? 1}×`,
              active: id === group,
            })),
          ]}
        />
      )}
      {picker === "sort" && (
        <ChoiceSheet
          title="智能排序"
          subtitle="按你的习惯排列模型"
          close={() => setPicker(null)}
          onSelect={(id) => setSort(id as SortKey)}
          choices={(Object.keys(sortLabels) as SortKey[]).map((id) => ({
            id,
            label: sortLabels[id],
            note:
              id === "default"
                ? "按官网推荐顺序展示"
                : id === "price"
                  ? "优先展示当前分组下更便宜的模型"
                  : id === "latest"
                    ? "优先展示最近发布的模型"
                    : "优先展示能处理更长上下文的模型",
            active: id === sort,
          }))}
        />
      )}
      {selected && (
        <ModelDetail
          key={selected.model_name}
          model={selected}
          ratios={ratios}
          usableGroup={data?.usable_group || {}}
          initialGroup={group || bestGroup(selected, ratios)}
          unit={unit}
          price={price}
          close={() => setSelected(null)}
          onUse={(target) => {
            if (!target) return;
            onUse(selected.model_name, target);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function ModelIcon({ model }: { model: PricingModel }) {
  const [failed, setFailed] = useState(false);
  const src = model.icon
    ? model.icon.startsWith("http")
      ? model.icon
      : `https://meta-api.vip${model.icon.startsWith("/") ? "" : "/"}${model.icon}`
    : "";
  if (!src || failed)
    return (
      <span className="model-icon fallback">
        {(model.display_name || model.model_name).slice(0, 1).toUpperCase()}
      </span>
    );
  return (
    <img
      className="model-icon"
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function percent(value?: number | null): string {
  const num = Number(value);
  return value == null || !Number.isFinite(num) ? "—" : `${num.toFixed(2)}%`;
}

function duration(value?: number | null): string {
  const num = Number(value);
  if (value == null || !Number.isFinite(num)) return "—";
  return num < 1000 ? `${Math.round(num)} ms` : `${(num / 1000).toFixed(2)} s`;
}

function ModelDetail({
  model,
  ratios,
  usableGroup,
  initialGroup,
  unit,
  price,
  close,
  onUse,
}: {
  model: PricingModel;
  ratios: Record<string, number>;
  usableGroup: Record<string, string>;
  initialGroup: string;
  unit: BalanceUnit;
  price: number;
  close: () => void;
  onUse: (group: string) => void;
}) {
  const list = useMemo(() => modelGroups(model, ratios), [model, ratios]);
  const [current, setCurrent] = useState(() =>
    list.includes(initialGroup) ? initialGroup : list[0] || "",
  );
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [drag, setDrag] = useState(0);
  const [moved, setMoved] = useState(false);
  const dragging = useRef(false);
  const touchStart = useRef(0);
  const sheetRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number>();
  const dismiss = () => {
    if (closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(close, 220);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const onTouchStart = (e: React.TouchEvent) => {
    const sheet = sheetRef.current;
    if (closing || e.touches.length !== 1) return;
    // 标题区始终可下拉关闭：即使内容已滚动，从标题或拖拽条按下也能直接下滑关闭。
    const fromHeader = !!headerRef.current?.contains(e.target as Node);
    if (!fromHeader && sheet && sheet.scrollTop > 0) return;
    touchStart.current = e.touches[0].clientY;
    dragging.current = true;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!dragging.current) return;
    const dy = e.touches[0].clientY - touchStart.current;
    if (dy > 0 && !moved) setMoved(true);
    setDrag(dy > 0 ? dy : 0);
  };
  const onTouchEnd = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (drag > 96) dismiss();
    else setDrag(0);
  };
  const [health, setHealth] = useState<Record<string, HealthGroup>>({});
  useEffect(() => {
    let live = true;
    void api
      .healthGroups(model.model_name)
      .then((value) => {
        if (!live) return;
        const map: Record<string, HealthGroup> = {};
        for (const item of value.groups || []) map[item.group] = item;
        setHealth(map);
      })
      .catch(() => {
        /* 调用表现读取失败时仍展示价格对比。 */
      });
    return () => {
      live = false;
    };
  }, [model.model_name]);
  const priceText = (value: number) => money(value, unit, price);
  const p = prices(model, Number(ratios[current] ?? 1) || 1);
  const caps = Object.entries(model.capabilities || {})
    .filter(([key, on]) => on && capabilityLabels[key])
    .map(([key]) => capabilityLabels[key]);
  return (
    <div className={`sheet-backdrop${closing ? " closing" : ""}`}>
      <section
        ref={sheetRef}
        className={`sheet detail-sheet${moved ? " settled" : ""}${drag > 0 ? " dragging" : ""}`}
        style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={`${model.display_name || model.model_name} 详情`}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <div className="sheet-header" ref={headerRef}>
          <span className="sheet-grab" aria-hidden="true" />
          <div className="sheet-heading">
            <h2>{model.display_name || model.model_name}</h2>
            <button
              className="icon-button"
              aria-label="关闭详情"
              onClick={dismiss}
            >
              <X size={20} />
            </button>
          </div>
        </div>
        {model.description && (
          <p className="detail-desc">{model.description}</p>
        )}
        <button
          type="button"
          className="detail-price"
          aria-expanded={list.length > 1 ? groupsOpen : undefined}
          onClick={() => {
            if (list.length > 1) setGroupsOpen((v) => !v);
          }}
        >
          <span className="detail-price-head">
            <span className="muted">
              分组 {usableGroup[current] || current || "—"}
            </span>
            {list.length > 1 && (
              <small className="detail-price-toggle">
                {groupsOpen ? "收起" : `对比 ${list.length} 个分组`}
                <ChevronDown size={13} className="detail-groups-chevron" />
              </small>
            )}
          </span>
          <span className="price-row">
            {p.token && (
              <>
                <span className="price-pair">
                  <b>{priceText(p.input)}</b>
                  <small>输入 / 百万 token</small>
                </span>
                <span className="price-pair">
                  <b>{priceText(p.output)}</b>
                  <small>输出 / 百万 token</small>
                </span>
                {p.cache > 0 && (
                  <span className="price-pair">
                    <b>{priceText(p.cache)}</b>
                    <small>缓存命中 / 百万 token</small>
                  </span>
                )}
              </>
            )}
            {!!p.perUse && (
              <span className="price-pair">
                <b>{priceText(p.perUse)}</b>
                <small>每次调用</small>
              </span>
            )}
            {!!p.perHour && (
              <span className="price-pair">
                <b>{priceText(p.perHour)}</b>
                <small>每小时</small>
              </span>
            )}
            {!p.token && !p.perUse && !p.perHour && (
              <span className="price-tiered">价格以官网为准</span>
            )}
            {p.dynamic && (
              <span className="price-tiered">阶梯计费 · 首档参考价</span>
            )}
          </span>
        </button>
        {groupsOpen && list.length > 0 && (
          <div className="detail-groups">
            {list.map((id) => {
              const item = prices(model, Number(ratios[id] ?? 1) || 1);
              const stats = health[id];
              const active = id === current;
              return (
                <button
                  type="button"
                  key={id}
                  className={`detail-group-row${active ? " active" : ""}`}
                  aria-pressed={active}
                  onClick={() => setCurrent(id)}
                >
                  <div className="detail-group-top">
                    <strong>{usableGroup[id] || id}</strong>
                    <small>{Number(ratios[id] ?? 1)}×</small>
                  </div>
                  <div className="detail-group-price">
                    {item.token && (
                      <>
                        <span>输入 {priceText(item.input)}</span>
                        <span>补全 {priceText(item.output)}</span>
                      </>
                    )}
                    {!!item.perUse && (
                      <span>每次 {priceText(item.perUse)}</span>
                    )}
                    {!!item.perHour && (
                      <span>每小时 {priceText(item.perHour)}</span>
                    )}
                    {!item.token && !item.perUse && !item.perHour && (
                      <span>价格以官网为准</span>
                    )}
                  </div>
                  <div className="detail-group-metrics">
                    <span>
                      成功率 <b>{percent(stats?.success_rate)}</b>
                    </span>
                    <span>
                      平均首字 <b>{duration(stats?.avg_ttft_ms)}</b>
                    </span>
                    <span>
                      缓存命中 <b>{percent(stats?.cache_hit_rate)}</b>
                    </span>
                  </div>
                </button>
              );
            })}
            <p className="footnote">
              分组指标为平台近 24 小时统计；缓存命中率 = 成功请求的缓存读取
              Token ÷ 输入 Token。
            </p>
          </div>
        )}
        <div className="detail-grid">
          <div>
            <span>上下文</span>
            <b>{compact(model.context_length)}</b>
          </div>
          <div>
            <span>最大输出</span>
            <b>{compact(model.max_output_tokens)}</b>
          </div>
          <div>
            <span>输入模态</span>
            <b>{(model.input_modalities || ["text"]).join(" / ")}</b>
          </div>
          <div>
            <span>输出模态</span>
            <b>{(model.output_modalities || ["text"]).join(" / ")}</b>
          </div>
          {model.release_date && (
            <div>
              <span>发布日期</span>
              <b>{model.release_date}</b>
            </div>
          )}
          <div>
            <span>计费方式</span>
            <b>
              {isTiered(model)
                ? "阶梯计费"
                : model.quota_type === 1
                  ? "按次计费"
                  : model.quota_type === 2
                    ? "按音频时长计费"
                    : "按 token 计费"}
            </b>
          </div>
        </div>
        {!!caps.length && (
          <div className="model-tags">
            {caps.map((c) => (
              <span className="cap" key={c}>
                {c}
              </span>
            ))}
          </div>
        )}
        <Notice
          text={current ? "" : "该模型暂无可用分组，创建令牌后即可使用。"}
        />
        <button
          className="primary full"
          onClick={() => onUse(current)}
          disabled={!current}
        >
          <MessageSquare size={17} />
          用此模型对话
          <ArrowUpRight size={16} />
        </button>
        <p className="footnote">
          价格与官网模型广场一致，单位随余额切换（{unit === "cny" ? "¥" : "⚡"}
          ）。
        </p>
      </section>
    </div>
  );
}
