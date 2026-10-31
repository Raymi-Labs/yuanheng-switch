import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  ImagePlus,
  RotateCcw,
  Sparkles,
  Square,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { api, randomId, errorText, ImageResult } from "./api";
import { Notice } from "./App";

type ImageTask = {
  id: string;
  prompt: string;
  model: string;
  size: string;
  reference?: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  elapsed?: number;
  result?: ImageResult;
  error?: string;
  favorite?: boolean;
};
type Filter = "all" | "running" | "done" | "favorite";
const filters: [Filter, string][] = [
  ["all", "全部"],
  ["running", "生成中"],
  ["done", "已完成"],
  ["favorite", "收藏"],
];
function retainTasks(tasks: ImageTask[]): ImageTask[] {
  let bytes = 0;
  return tasks.filter((task, index) => {
    if (task.status === "running") return true;
    const size =
      (task.result?.data.length ?? 0) + (task.reference?.length ?? 0);
    if (index >= 60 || bytes + size > 80 * 1024 * 1024) return false;
    bytes += size;
    return true;
  });
}

export function Images({
  userId,
  active,
  refresh,
}: {
  userId: number;
  active: boolean;
  refresh: () => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gpt-image-2");
  const [size, setSize] = useState("1024x1024");
  const [models, setModels] = useState<string[]>([]);
  const [reference, setReference] = useState<string>();
  const [referenceUrl, setReferenceUrl] = useState<string>();
  const [tasks, setTasks] = useState<ImageTask[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const [savingId, setSavingId] = useState<string>();
  const [viewer, setViewer] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState("");
  const alive = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<FileReader | null>(null);
  const activeTasks = useRef(new Set<string>());
  const activeInputs = useRef(new Set<string>());
  const favoriteLock = useRef(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const resetReader = () => {
    const reader = readerRef.current;
    readerRef.current = null;
    reader?.abort();
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      resetReader();
      for (const id of activeTasks.current) void api.cancel(id);
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    void api
      .get<string[]>("models")
      .then((values) => {
        if (mounted) {
          const available = values.filter((m) =>
            /image|dall-e|flux|imagen|seedream/i.test(m),
          );
          setModels(available);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    void api
      .galleryList(userId)
      .then((entries) => {
        if (!mounted || !Array.isArray(entries)) return;
        setTasks((prev) => {
          const known = new Set(prev.map((task) => task.id));
          const restored = entries
            .filter(
              (entry) =>
                entry &&
                typeof entry.id === "string" &&
                !known.has(entry.id) &&
                entry.result &&
                typeof entry.result.data === "string" &&
                typeof entry.result.mime === "string",
            )
            .map<ImageTask>((entry) => ({
              id: entry.id,
              prompt: typeof entry.prompt === "string" ? entry.prompt : "",
              model: typeof entry.model === "string" ? entry.model : model,
              size: typeof entry.size === "string" ? entry.size : "1024x1024",
              reference:
                typeof entry.reference === "string"
                  ? entry.reference
                  : undefined,
              status: "done",
              startedAt: Number(entry.createdAt) || Date.now(),
              finishedAt: Number(entry.createdAt) || Date.now(),
              elapsed:
                typeof entry.elapsed === "number" ? entry.elapsed : undefined,
              result: entry.result,
              favorite: true,
            }));
          return retainTasks([...prev, ...restored]);
        });
      })
      .catch((error) => {
        if (mounted) setMessage(errorText(error));
      });
    return () => {
      mounted = false;
    };
    // Favorites only need to load when the tab becomes visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const runningCount = tasks.filter((task) => task.status === "running").length;
  useEffect(() => {
    if (!runningCount) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runningCount]);
  const patch = (id: string, changes: Partial<ImageTask>) => {
    if (!alive.current) return;
    setTasks((prev) =>
      retainTasks(
        prev.map((task) => (task.id === id ? { ...task, ...changes } : task)),
      ),
    );
  };
  const seconds = (task: ImageTask) =>
    task.status === "running"
      ? Math.max(0, Math.floor((now - task.startedAt) / 1000))
      : (task.elapsed ??
        (task.finishedAt
          ? Math.round((task.finishedAt - task.startedAt) / 1000)
          : 0));
  const pick = async (file?: File) => {
    if (!file) return;
    resetReader();
    setMessage("");
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 10 * 1024 * 1024
    ) {
      setMessage("请选择不超过 10 MB 的 PNG、JPEG 或 WebP 图片");
      return;
    }
    const reader = new FileReader();
    readerRef.current = reader;
    reader.onload = () => {
      if (
        alive.current &&
        readerRef.current === reader &&
        typeof reader.result === "string"
      ) {
        setReferenceUrl(reader.result);
        setReference(reader.result.split(",")[1]);
      }
    };
    reader.onerror = () => {
      if (alive.current && readerRef.current === reader)
        setMessage("读取参考图失败");
    };
    reader.readAsDataURL(file);
  };
  const generate = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    const inputKey = JSON.stringify([text, model, size, reference ?? null]);
    if (activeInputs.current.has(inputKey)) {
      setMessage("相同参数的图片正在生成，请勿重复提交");
      return;
    }
    if (activeTasks.current.size >= 4) {
      setMessage("最多同时等待4个任务，请先等待完成或停止");
      return;
    }
    const id = randomId();
    activeTasks.current.add(id);
    activeInputs.current.add(inputKey);
    const startedAt = Date.now();
    setNow(startedAt);
    setMessage("");
    setTasks((prev) =>
      retainTasks([
        {
          id,
          prompt: text,
          model,
          size,
          reference: referenceUrl,
          status: "running" as const,
          startedAt,
          favorite: false,
        },
        ...prev,
      ]),
    );
    setSelectedId(id);
    try {
      const value = await api.image(id, text, model, size, reference);
      const finishedAt = Date.now();
      patch(id, {
        status: "done",
        result: value,
        finishedAt,
        elapsed: Math.round((finishedAt - startedAt) / 1000),
      });
    } catch (error) {
      patch(id, {
        status: "error",
        error: errorText(error),
        finishedAt: Date.now(),
      });
    } finally {
      activeTasks.current.delete(id);
      activeInputs.current.delete(inputKey);
      if (alive.current) void refresh();
    }
  };
  const stop = (task: ImageTask) => {
    void api.cancel(task.id).catch((error) => {
      if (alive.current) setMessage(errorText(error));
    });
  };
  const toggleFavorite = async (task: ImageTask) => {
    if (!task.result || favoriteLock.current) return;
    favoriteLock.current = true;
    setFavoriteBusy(true);
    const favorite = !task.favorite;
    try {
      if (favorite) {
        await api.gallerySave(
          {
            id: task.id,
            prompt: task.prompt,
            model: task.model,
            size: task.size,
            createdAt: task.finishedAt ?? task.startedAt,
            elapsed: task.elapsed,
            reference: task.reference,
            result: task.result,
          },
          userId,
        );
      } else {
        await api.galleryDelete(task.id, userId);
      }
      patch(task.id, { favorite });
    } catch (error) {
      if (!alive.current) return;
      setMessage(errorText(error));
    } finally {
      favoriteLock.current = false;
      if (alive.current) setFavoriteBusy(false);
    }
  };
  const save = async (task: ImageTask) => {
    if (!task.result) return;
    setSavingId(task.id);
    try {
      await api.saveImage(task.result.data);
      if (alive.current) setMessage("已保存到系统相册");
    } catch (error) {
      if (alive.current) setMessage(errorText(error));
    } finally {
      if (alive.current) setSavingId(undefined);
    }
  };
  const reuse = (task: ImageTask) => {
    resetReader();
    setPrompt(task.prompt);
    setModel(task.model);
    setSize(task.size);
    setReferenceUrl(task.reference);
    setReference(task.reference?.split(",")[1]);
    if (fileRef.current) fileRef.current.value = "";
    setMessage("已载入这条记录的参数");
  };
  const remove = async (task: ImageTask) => {
    if (favoriteLock.current || task.status === "running") return;
    favoriteLock.current = true;
    setFavoriteBusy(true);
    try {
      if (task.favorite) await api.galleryDelete(task.id, userId);
      if (alive.current)
        setTasks((prev) => prev.filter((item) => item.id !== task.id));
    } catch (error) {
      if (alive.current) setMessage(errorText(error));
    } finally {
      favoriteLock.current = false;
      if (alive.current) setFavoriteBusy(false);
    }
  };
  const done = useMemo(() => tasks.filter((task) => task.result), [tasks]);
  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[0];
  const listed = tasks.filter((task) =>
    filter === "all"
      ? true
      : filter === "running"
        ? task.status === "running"
        : filter === "done"
          ? task.status === "done"
          : task.favorite,
  );
  return (
    <div className="page images-page">
      <div className="page-heading">
        <span className="eyebrow">MAKE IT VISIBLE</span>
        <h1>把想象变成画面</h1>
        <p className="muted">写下你想看到的，剩下的交给 AI。</p>
      </div>
      <div className="image-stage">
        {selected?.result ? (
          <button
            type="button"
            className="image-open"
            aria-label="放大查看生成图片"
            onClick={() => setViewer(true)}
          >
            <img
              alt="生成结果"
              src={`data:${selected.result.mime};base64,${selected.result.data}`}
            />
          </button>
        ) : (
          <div className="image-placeholder">
            <div className="image-landscape">
              <span />
              <span />
              <span />
            </div>
            <Sparkles size={30} />
            <p>每一幅画，都始于一个想法</p>
          </div>
        )}
        {selected?.status === "running" && (
          <div className="image-progress">
            <span className="spinner" />
            正在生成 · {seconds(selected)} 秒
          </div>
        )}
      </div>
      {done.length > 1 && (
        <div className="image-thumbs" role="tablist" aria-label="生成图片">
          {done.map((task) => (
            <button
              key={task.id}
              type="button"
              role="tab"
              aria-selected={selected?.id === task.id}
              className={`image-thumb${selected?.id === task.id ? " active" : ""}`}
              aria-label={`查看第 ${done.indexOf(task) + 1} 张图片`}
              onClick={() => setSelectedId(task.id)}
            >
              <img
                alt=""
                src={`data:${task.result!.mime};base64,${task.result!.data}`}
              />
            </button>
          ))}
        </div>
      )}
      {selected?.result && (
        <div className="image-actions">
          <button
            type="button"
            className="secondary"
            disabled={savingId === selected.id}
            onClick={() => void save(selected)}
          >
            <Download size={16} />
            {savingId === selected.id ? "正在保存…" : "保存到相册"}
          </button>
          <button
            type="button"
            className={`secondary${selected.favorite ? " active" : ""}`}
            aria-pressed={!!selected.favorite}
            onClick={() => void toggleFavorite(selected)}
          >
            <Star
              size={16}
              fill={selected.favorite ? "currentColor" : "none"}
            />
            {selected.favorite ? "已收藏" : "收藏"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => reuse(selected)}
          >
            <RotateCcw size={16} />
            复用
          </button>
        </div>
      )}
      <form onSubmit={generate} className="image-form">
        <label>
          画面描述
          <textarea
            rows={4}
            placeholder="例如：清晨的海边书店，阳光穿过落地窗，温暖的胶片色调…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={8000}
            required
          />
        </label>
        <div className="two-columns">
          <label>
            模型
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {!models.includes(model) && <option>{model}</option>}
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            画幅
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              <option value="1024x1024">方形 · 1:1</option>
              <option value="1536x1024">横向 · 3:2</option>
              <option value="1024x1536">竖向 · 2:3</option>
              <option value="auto">自动</option>
            </select>
          </label>
        </div>
        <input
          ref={fileRef}
          type="file"
          className="visually-hidden"
          accept="image/png,image/jpeg,image/webp"
          aria-label="上传参考图"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {referenceUrl ? (
          <div className="reference">
            <img src={referenceUrl} alt="参考图" />
            <span>已添加参考图</span>
            <button
              type="button"
              className="icon-button"
              aria-label="移除参考图"
              onClick={() => {
                resetReader();
                setReference(undefined);
                setReferenceUrl(undefined);
                if (fileRef.current) fileRef.current.value = "";
              }}
            >
              <X size={17} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="upload-button"
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus size={20} />
            添加参考图 <span>可选</span>
          </button>
        )}
        <Notice text={message} />
        <button
          className="primary full"
          disabled={!prompt.trim() || runningCount >= 4}
        >
          <Sparkles size={18} />
          生成图片
        </button>
        {runningCount > 0 && (
          <p className="footnote">
            已有 {runningCount} 个任务生成中，可继续提交新的任务并行生成。
          </p>
        )}
        <p className="footnote">
          每次生成按所选模型计费。请在生成期间保持 App
          打开；停止等待不保证撤销服务端任务或扣费。
        </p>
      </form>
      <section className="image-history" aria-label="生成记录">
        <div className="heading-row">
          <h2>生成记录</h2>
          {tasks.length > 0 && (
            <small className="muted">{tasks.length} 条</small>
          )}
        </div>
        <div className="chip-row">
          {filters.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`chip${filter === id ? " active" : ""}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {listed.length === 0 ? (
          <p className="choice-empty">
            {filter === "favorite" ? "还没有收藏的图片" : "还没有相关记录"}
          </p>
        ) : (
          <ul className="image-tasks">
            {listed.map((task) => (
              <li
                key={task.id}
                className={`image-task${selected?.id === task.id ? " active" : ""}`}
              >
                <button
                  type="button"
                  className="image-task-main"
                  aria-label={`查看记录：${task.prompt}`}
                  onClick={() => setSelectedId(task.id)}
                >
                  {task.result ? (
                    <img
                      alt=""
                      src={`data:${task.result.mime};base64,${task.result.data}`}
                    />
                  ) : (
                    <span
                      className={`image-task-state ${task.status}`}
                      aria-hidden="true"
                    >
                      {task.status === "running" ? (
                        <span className="spinner" />
                      ) : (
                        <X size={16} />
                      )}
                    </span>
                  )}
                  <span className="image-task-text">
                    <strong>{task.prompt}</strong>
                    <small>
                      {task.status === "running"
                        ? `生成中 · ${seconds(task)} 秒`
                        : task.status === "error"
                          ? task.error
                          : [task.model, task.size, `${seconds(task)} 秒`]
                              .filter(Boolean)
                              .join(" · ")}
                    </small>
                  </span>
                </button>
                <span className="image-task-actions">
                  {task.status === "running" ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="停止等待"
                      onClick={() => stop(task)}
                    >
                      <Square size={15} />
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={task.favorite ? "取消收藏" : "收藏"}
                        aria-pressed={!!task.favorite}
                        disabled={favoriteBusy}
                        onClick={() => void toggleFavorite(task)}
                      >
                        <Star
                          size={16}
                          fill={task.favorite ? "currentColor" : "none"}
                        />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="复用参数"
                        onClick={() => reuse(task)}
                      >
                        <RotateCcw size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="删除记录"
                        disabled={favoriteBusy}
                        onClick={() => void remove(task)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {viewer && selected?.result && (
        <div className="sheet-backdrop" onClick={() => setViewer(false)}>
          <div
            className="sheet image-viewer"
            role="dialog"
            aria-modal="true"
            aria-label="查看生成图片"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="sheet-grab" aria-hidden="true" />
            <div className="image-viewer-head">
              <small className="muted">
                {[selected.model, selected.size].filter(Boolean).join(" · ")}
              </small>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭预览"
                onClick={() => setViewer(false)}
              >
                <X size={18} />
              </button>
            </div>
            <img
              alt="生成结果"
              src={`data:${selected.result.mime};base64,${selected.result.data}`}
            />
            <div className="image-viewer-actions">
              <button
                type="button"
                className="secondary"
                disabled={savingId === selected.id}
                onClick={() => void save(selected)}
              >
                <Download size={16} />
                {savingId === selected.id ? "正在保存…" : "保存到相册"}
              </button>
              <button
                type="button"
                className={`secondary${selected.favorite ? " active" : ""}`}
                aria-pressed={!!selected.favorite}
                onClick={() => void toggleFavorite(selected)}
              >
                <Star
                  size={16}
                  fill={selected.favorite ? "currentColor" : "none"}
                />
                {selected.favorite ? "已收藏" : "收藏"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
