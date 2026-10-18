import { useEffect, useRef, useState } from "react";
import { Download, ImagePlus, Sparkles, Square, X } from "lucide-react";
import { api, errorText, ImageResult } from "./api";
import { Notice } from "./App";

export function Images({
  active,
  refresh,
}: {
  active: boolean;
  refresh: () => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gpt-image-2");
  const [size, setSize] = useState("1024x1024");
  const [models, setModels] = useState<string[]>([]);
  const [reference, setReference] = useState<string>();
  const [referenceUrl, setReferenceUrl] = useState<string>();
  const [result, setResult] = useState<ImageResult>();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState("");
  const task = useRef<string | null>(null);
  const alive = useRef(true);
  const start = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (task.current) void api.cancel(task.current);
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
    if (!busy) return;
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - start.current) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [busy]);
  const pick = async (file?: File) => {
    if (!file) return;
    setMessage("");
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 10 * 1024 * 1024
    ) {
      setMessage("请选择不超过 10 MB 的 PNG、JPEG 或 WebP 图片");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (alive.current && typeof reader.result === "string") {
        setReferenceUrl(reader.result);
        setReference(reader.result.split(",")[1]);
      }
    };
    reader.onerror = () => setMessage("读取参考图失败");
    reader.readAsDataURL(file);
  };
  const generate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !prompt.trim()) return;
    const id = crypto.randomUUID();
    task.current = id;
    start.current = Date.now();
    setElapsed(0);
    setBusy(true);
    setMessage("");
    try {
      const value = await api.image(id, prompt.trim(), model, size, reference);
      if (alive.current && task.current === id) setResult(value);
    } catch (e) {
      if (alive.current && task.current === id) setMessage(errorText(e));
    } finally {
      if (alive.current && task.current === id) {
        setBusy(false);
        task.current = null;
        void refresh();
      }
    }
  };
  const save = async () => {
    if (!result) return;
    setSaving(true);
    try {
      await api.saveImage(result.data);
      setMessage("已保存到系统相册");
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="page images-page">
      <div className="page-heading">
        <span className="eyebrow">MAKE IT VISIBLE</span>
        <h1>把想象变成画面</h1>
        <p className="muted">写下你想看到的，剩下的交给 AI。</p>
      </div>
      <div className="image-stage">
        {result ? (
          <img
            alt="生成结果"
            src={`data:${result.mime};base64,${result.data}`}
          />
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
        {busy && (
          <div className="image-progress">
            <span className="spinner" />
            正在生成 · {elapsed} 秒
          </div>
        )}
      </div>
      {result && (
        <button
          className="secondary full"
          disabled={saving || busy}
          onClick={() => void save()}
        >
          <Download size={17} />
          {saving ? "正在保存…" : "保存到相册"}
        </button>
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
            disabled={busy}
          />
        </label>
        <div className="two-columns">
          <label>
            模型
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={busy}
            >
              {!models.includes(model) && <option>{model}</option>}
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            画幅
            <select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              disabled={busy}
            >
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
          disabled={busy}
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
              disabled={busy}
              onClick={() => {
                setReference(undefined);
                setReferenceUrl(undefined);
              }}
            >
              <X size={17} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="upload-button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus size={20} />
            添加参考图 <span>可选</span>
          </button>
        )}
        <Notice text={message} />
        {busy ? (
          <button
            type="button"
            className="secondary full"
            onClick={() => {
              if (task.current)
                void api
                  .cancel(task.current)
                  .catch((e) => setMessage(errorText(e)));
            }}
          >
            <Square size={16} />
            停止等待
          </button>
        ) : (
          <button className="primary full" disabled={!prompt.trim()}>
            <Sparkles size={18} />
            生成图片
          </button>
        )}
        <p className="footnote">
          每次生成按所选模型计费。请在生成期间保持 App
          打开；停止等待不保证撤销服务端任务或扣费。
        </p>
      </form>
    </div>
  );
}
