import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  History,
  Plus,
  Square,
  Trash2,
  X,
  Info,
} from "lucide-react";
import {
  api,
  randomId,
  Conversation,
  errorText,
  Group,
  Message,
  PricingModel,
  readConversations,
  saveConversations,
} from "./api";
import { Notice } from "./App";
import { ChoiceSheet } from "./ChoiceSheet";
import {
  ChatSnapshot,
  ServiceTier,
  tierName,
  validateCapability,
} from "./serviceTiers";
import { useServiceTiers } from "./useServiceTiers";

const nonChat =
  /image|dall-e|flux|imagen|seedream|embedding|rerank|tts|whisper|voice|audio|video|sora|veo/i;
const chatEndpoints = new Set([
  "openai",
  "openai-response",
  "anthropic",
  "gemini",
]);

function isChatModel(model: PricingModel): boolean {
  if (nonChat.test(model.model_name)) return false;
  const types = model.supported_endpoint_types || [];
  return !types.length || types.some((t) => chatEndpoints.has(t));
}

export function Chat({
  userId,
  defaultGroup,
  refresh,
  preset,
  onPresetUsed,
  active = true,
}: {
  userId: number;
  defaultGroup: string;
  refresh: () => Promise<void>;
  preset?: { model: string; group: string } | null;
  onPresetUsed?: () => void;
  active?: boolean;
}) {
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    readConversations(userId),
  );
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      const id = localStorage.getItem(`yuanheng-chat-active:${userId}`);
      return conversations.some((c) => c.id === id) ? id : null;
    } catch {
      return null;
    }
  });
  const initial = conversations.find((c) => c.id === selected);
  const [serviceTier, setServiceTier] = useState<ServiceTier>(
    initial?.serviceTier ?? "default",
  );
  const [tierInfo, setTierInfo] = useState(false);
  const [catalog, setCatalog] = useState<PricingModel[]>([]);
  const [groups, setGroups] = useState<Record<string, Group>>({});
  const [model, setModel] = useState(initial?.model ?? "");
  const [group, setGroup] = useState(initial?.group ?? defaultGroup);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState(false);
  const [picker, setPicker] = useState<"model" | "group" | "speed" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const currentTask = useRef<string | null>(null);
  const alive = useRef(true);
  const catalogVersion = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const conversation = conversations.find((c) => c.id === selected);
  const messages = conversation?.messages || [];
  const capability = useServiceTiers(userId, model, group, active, selected);
  const tierOption = capability.data?.tiers.find((t) => t.id === serviceTier);
  const tierBlocked = serviceTier !== "default" && !tierOption;
  const selectConfig = (next: {
    model?: string;
    group?: string;
    serviceTier?: ServiceTier;
  }) => {
    if (next.model !== undefined) setModel(next.model);
    if (next.group !== undefined) setGroup(next.group);
    if (next.serviceTier !== undefined) setServiceTier(next.serviceTier);
    const id = selected ?? randomId();
    if (!selected) setSelected(id);
    setConversations((old) =>
      old.some((c) => c.id === id)
        ? old.map((c) => (c.id === id ? { ...c, ...next } : c))
        : [
            {
              id,
              title: "新对话",
              model,
              group,
              serviceTier,
              messages: [],
              updatedAt: Date.now(),
              ...next,
            },
            ...old,
          ],
    );
  };
  useEffect(() => {
    try {
      if (selected)
        localStorage.setItem(`yuanheng-chat-active:${userId}`, selected);
      else localStorage.removeItem(`yuanheng-chat-active:${userId}`);
    } catch {}
  }, [selected, userId]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (currentTask.current) void api.cancel(currentTask.current);
    };
  }, []);
  useEffect(() => {
    try {
      saveConversations(userId, conversations);
    } catch {
      setError("设备存储已满，本次聊天无法保存，请删除旧会话。");
    }
  }, [userId, conversations]);
  const load = useCallback(async () => {
    const version = ++catalogVersion.current;
    setLoading(true);
    try {
      const [pricing, ownGroups] = await Promise.all([
        api.pricing(),
        api.get<Record<string, Group>>("groups").catch(() => null),
      ]);
      if (!alive.current || catalogVersion.current !== version) return;
      const ratios = pricing.group_ratio || {};
      const nextGroups: Record<string, Group> =
        ownGroups ||
        Object.fromEntries(
          Object.entries(ratios).map(([id, ratio]) => [id, { ratio }]),
        );
      const usable = new Set(Object.keys(nextGroups));
      const list = (Array.isArray(pricing.data) ? pricing.data : [])
        .filter(isChatModel)
        .map((m) => ({
          ...m,
          enable_groups: (m.enable_groups || [])
            .filter((g) => usable.has(g))
            .sort(
              (a, b) =>
                (nextGroups[a]?.ratio ?? ratios[a] ?? 99) -
                (nextGroups[b]?.ratio ?? ratios[b] ?? 99),
            ),
        }))
        .filter((m) => (m.enable_groups as string[]).length > 0);
      setCatalog(list);
      setGroups(nextGroups);
      setModel((old) =>
        serviceTier !== "default" && old
          ? old
          : list.some((m) => m.model_name === old)
            ? old
            : list.find((m) => m.enable_groups?.includes(defaultGroup))
                ?.model_name ||
              list[0]?.model_name ||
              "",
      );
      setError("");
    } catch (e) {
      if (alive.current && catalogVersion.current === version)
        setError(errorText(e));
    } finally {
      if (alive.current && catalogVersion.current === version)
        setLoading(false);
    }
  }, [defaultGroup, serviceTier]);
  useEffect(() => {
    void load();
    return () => {
      catalogVersion.current++;
    };
  }, [load]);
  const current = useMemo(
    () => catalog.find((m) => m.model_name === model),
    [catalog, model],
  );
  const groupChoices = current?.enable_groups || [];
  useEffect(() => {
    if (!current) return;
    if (groupChoices.includes(group)) return;
    if (serviceTier !== "default") return;
    setGroup(
      groupChoices.includes(defaultGroup)
        ? defaultGroup
        : groupChoices[0] || group,
    );
  }, [current, group, defaultGroup, groupChoices, serviceTier]);
  useEffect(() => {
    if (!preset) return;
    const entry = catalog.find((m) => m.model_name === preset.model);
    if (!entry) {
      if (catalog.length) onPresetUsed?.();
      return;
    }
    const ids = entry.enable_groups || [];
    setModel(preset.model);
    setGroup((old) =>
      ids.includes(preset.group)
        ? preset.group
        : ids.includes(old)
          ? old
          : ids[0] || old,
    );
    onPresetUsed?.();
  }, [preset, catalog, onPresetUsed]);
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);
  const newChat = () => {
    if (busy) return;
    setSelected(null);
    setServiceTier("default");
    setText("");
    setError("");
    setHistory(false);
  };
  const submit = async (retry?: ChatSnapshot) => {
    if (
      currentTask.current ||
      busy ||
      (!retry && (!text.trim() || !model || loading || tierBlocked))
    )
      return;
    const snapshot: ChatSnapshot = retry ?? {
      model,
      group,
      serviceTier,
      multiplier: tierOption?.multiplier ?? 1,
      messages: [
        ...messages
          .filter((m) => !m.error && m.content)
          .map(({ role, content }) => ({ role, content })),
        { role: "user", content: text.trim() },
      ],
    };
    const id = selected || randomId();
    const task = randomId();
    const answerId = randomId();
    const request: Message[] = retry
      ? snapshot.messages.map((m) => ({ ...m, id: randomId() }))
      : [
          ...messages.filter((m) => !m.error && m.content),
          { id: randomId(), role: "user", content: text.trim() },
        ];
    const next: Conversation = {
      id,
      title:
        conversation?.title && conversation.title !== "新对话"
          ? conversation.title
          : snapshot.messages.at(-1)?.content.slice(0, 30) || "新对话",
      model,
      group,
      serviceTier,
      updatedAt: Date.now(),
      messages: [
        ...request,
        { id: answerId, role: "assistant", content: "", request: snapshot },
      ],
    };
    setConversations((old) =>
      [next, ...old.filter((c) => c.id !== id)].slice(0, 30),
    );
    setSelected(id);
    setText("");
    setBusy(true);
    setError("");
    currentTask.current = task;
    const update = (patch: Partial<Message>) => {
      if (!alive.current || currentTask.current !== task) return;
      setConversations((old) =>
        old.map((c) =>
          c.id === id
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === answerId ? { ...m, ...patch } : m,
                ),
              }
            : c,
        ),
      );
    };
    try {
      if (snapshot.serviceTier !== "default") {
        const caps = await api.serviceTiers(
          snapshot.model,
          snapshot.group,
          userId,
        );
        const match = validateCapability(
          caps,
          snapshot.model,
          snapshot.group,
        ).tiers.find((t) => t.id === snapshot.serviceTier);
        if (!match || match.multiplier !== snapshot.multiplier)
          throw Error(
            `当前模型或分组不支持 ${tierName(snapshot.serviceTier)}，或倍率已变化，请重新选择`,
          );
      }
      if (!alive.current || currentTask.current !== task) return;
      await api.chat(
        task,
        snapshot.model,
        snapshot.group,
        request,
        (content, reasoning) => update({ content, reasoning }),
        snapshot,
        userId,
      );
    } catch (e) {
      update({ error: errorText(e) });
    } finally {
      if (alive.current && currentTask.current === task) {
        currentTask.current = null;
        setBusy(false);
        void refresh();
      }
    }
  };
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    void submit();
  };
  const stop = async () => {
    if (currentTask.current)
      try {
        const task = currentTask.current;
        setConversations((old) =>
          old.map((c) =>
            c.id === selected
              ? {
                  ...c,
                  messages: c.messages.map((m, i) =>
                    i === c.messages.length - 1 && m.role === "assistant"
                      ? { ...m, error: "已停止等待；费用以服务端记录为准" }
                      : m,
                  ),
                }
              : c,
          ),
        );
        currentTask.current = null;
        setBusy(false);
        await api.cancel(task);
      } catch (e) {
        setError(errorText(e));
      }
  };
  const copy = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(message.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError("复制失败，请长按文字复制");
    }
  };
  return (
    <section className="chat-page">
      <div className="chat-heading">
        <div>
          <h1>聊聊你的想法</h1>
        </div>
        <div className="row">
          <button
            className="icon-button"
            aria-label="聊天历史"
            onClick={() => setHistory(true)}
          >
            <History size={20} />
          </button>
          <button
            className="icon-button"
            aria-label="新建对话"
            onClick={newChat}
            disabled={busy}
          >
            <Plus size={22} />
          </button>
        </div>
      </div>
      <div className="model-bar">
        <button
          className="picker-button"
          aria-label="选择模型"
          onClick={() => setPicker("model")}
          disabled={busy || loading || !catalog.length}
        >
          <span className="picker-label">
            {model || (loading ? "正在读取模型…" : "选择模型")}
          </span>
          <ChevronDown size={14} />
        </button>
        <button
          className="picker-button group-picker"
          aria-label="选择分组"
          onClick={() => setPicker("group")}
          disabled={busy || loading || !groupChoices.length}
        >
          <span className="picker-label">{group || "选择分组"}</span>
          {groups[group]?.ratio !== undefined && (
            <small>{groups[group].ratio}×</small>
          )}
          <ChevronDown size={14} />
        </button>
      </div>
      <div className="speed-controls">
        {capability.error && serviceTier === "default" && (
          <button
            type="button"
            className="text-button"
            onClick={capability.reload}
          >
            重试速度查询
          </button>
        )}
        <button
          type="button"
          className="picker-button"
          aria-label="选择速度"
          disabled={busy || !model || !group}
          onClick={() => setPicker("speed")}
        >
          速度：{tierName(serviceTier)}
          {tierOption && serviceTier !== "default"
            ? ` ×${tierOption.multiplier}`
            : ""}
          <ChevronDown size={14} />
        </button>
        <span className="speed-help">
          <button
            type="button"
            className="icon-button"
            aria-label="速度计费说明"
            aria-expanded={tierInfo}
            aria-describedby={tierInfo ? "speed-help-text" : undefined}
            onClick={() => setTierInfo((v) => !v)}
            onBlur={() => setTierInfo(false)}
          >
            <Info size={16} />
          </button>
          {tierInfo && (
            <span role="tooltip" id="speed-help-text">
              倍率相对当前模型与分组标准档计费，不是速度保证。缓存和长上下文按服务端结算；停止或超时不保证免扣费。
            </span>
          )}
        </span>
      </div>
      {tierBlocked && (
        <div className="inline-notice" role="alert">
          {capability.data
            ? `当前模型或分组不支持 ${tierName(serviceTier)}，请重新选择`
            : capability.error || "正在确认速度档位，暂不可发送"}
          {capability.error && (
            <button type="button" onClick={capability.reload}>
              重试查询
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="inline-notice">
          <Notice text={error} />
          <button className="text-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      <div className="messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="idea-mark">✳</div>
            <h2>从一个问题开始</h2>
            <p>
              写点东西，理清思路，
              <br />
              或者探索一个全新的方向。
            </p>
            <div className="suggestions">
              {[
                "帮我把一个复杂想法讲清楚",
                "一起构思一个有趣的故事",
                "为我的新项目整理思路",
              ].map((v) => (
                <button key={v} onClick={() => setText(v)}>
                  {v}
                  <Plus size={15} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <article key={m.id} className={`message ${m.role}`}>
              <div className="message-label">
                {m.role === "user" ? "你" : "Meta API"}
              </div>
              {m.reasoning && (
                <details>
                  <summary>思考过程</summary>
                  <p>{m.reasoning}</p>
                </details>
              )}
              <div className="message-content">
                {m.content || (!m.error && busy ? "正在思考…" : "")}
              </div>
              {m.error && <p className="message-error">{m.error}</p>}
              {m.request && m.request.serviceTier !== "default" && (
                <small>
                  本次选择 {tierName(m.request.serviceTier)} ×
                  {m.request.multiplier}
                </small>
              )}
              {m.error && m.request && (
                <button
                  type="button"
                  className="copy-button"
                  disabled={busy}
                  onClick={() => void submit(m.request)}
                >
                  按原参数重试
                </button>
              )}
              {m.role === "assistant" && m.content && (
                <button
                  className="copy-button"
                  onClick={() => void copy(m)}
                  aria-label="复制回复"
                >
                  {copied === m.id ? <Check size={14} /> : <Copy size={14} />}
                </button>
              )}
            </article>
          ))
        )}
      </div>
      <form className="composer" onSubmit={send}>
        <textarea
          aria-label="输入消息"
          placeholder="把想法写在这里…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          maxLength={32000}
        />
        <div className="composer-bottom">
          <span>AI 回答可能有误，请核实重要信息</span>
          {busy ? (
            <button
              className="send"
              type="button"
              aria-label="停止生成"
              onClick={() => void stop()}
            >
              <Square size={17} />
            </button>
          ) : (
            <button
              className="send"
              aria-label="发送消息"
              disabled={!text.trim() || !model || loading || tierBlocked}
            >
              <ArrowUp size={21} />
            </button>
          )}
        </div>
      </form>
      {picker === "speed" && (
        <>
          <ChoiceSheet
            title="选择速度"
            close={() => setPicker(null)}
            onSelect={(id) => selectConfig({ serviceTier: id as ServiceTier })}
            choices={(
              capability.data?.tiers ?? [{ id: "default", multiplier: 1 }]
            ).map((t) => ({
              id: t.id,
              label: tierName(t.id),
              meta: t.id === "default" ? undefined : `×${t.multiplier}`,
              active: t.id === serviceTier,
            }))}
          />
        </>
      )}
      {picker === "model" && (
        <ChoiceSheet
          title="选择模型"
          subtitle={`${catalog.length} 个可用于对话的模型`}
          searchable
          searchPlaceholder="搜索模型名称"
          emptyText="没有匹配的模型"
          close={() => setPicker(null)}
          onSelect={(model) => selectConfig({ model })}
          choices={catalog.map((m) => ({
            id: m.model_name,
            label: m.display_name || m.model_name,
            meta: `${m.enable_groups?.length || 0} 个分组`,
            note:
              m.display_name && m.display_name !== m.model_name
                ? m.model_name
                : m.owner_by,
            active: m.model_name === model,
          }))}
        />
      )}
      {picker === "group" && (
        <ChoiceSheet
          title="选择分组"
          subtitle={`${model} 可用的分组，倍率越低越便宜`}
          emptyText="该模型暂无可用的分组"
          close={() => setPicker(null)}
          onSelect={(group) => selectConfig({ group })}
          choices={groupChoices.map((id) => ({
            id,
            label: id,
            note: groups[id]?.desc,
            meta: `${groups[id]?.ratio ?? 1}×`,
            active: id === group,
          }))}
        />
      )}
      {history && (
        <div className="sheet-backdrop">
          <section
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label="聊天历史"
          >
            <div className="sheet-heading">
              <h2>聊天历史</h2>
              <button
                className="icon-button"
                aria-label="关闭历史"
                onClick={() => setHistory(false)}
              >
                <X size={20} />
              </button>
            </div>
            <button
              className="secondary full"
              disabled={busy}
              onClick={newChat}
            >
              <Plus size={17} />
              新建对话
            </button>
            {!conversations.length && <p className="muted">还没有聊天记录</p>}
            {conversations.map((c) => (
              <div key={c.id} className="history-item">
                <button
                  disabled={busy}
                  onClick={() => {
                    setSelected(c.id);
                    setModel(c.model);
                    setGroup(c.group);
                    setServiceTier(c.serviceTier ?? "default");
                    setHistory(false);
                  }}
                >
                  <strong>{c.title}</strong>
                  <small>{new Date(c.updatedAt).toLocaleString("zh-CN")}</small>
                </button>
                <button
                  className="icon-button"
                  aria-label={`删除会话 ${c.title}`}
                  disabled={busy}
                  onClick={() => {
                    setConversations((old) => old.filter((v) => v.id !== c.id));
                    if (selected === c.id) {
                      setSelected(null);
                      setServiceTier("default");
                    }
                  }}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </section>
        </div>
      )}
    </section>
  );
}
