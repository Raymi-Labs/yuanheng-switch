import { useEffect, useRef, useState } from "react";
import { Mic, Sparkles, Square, Trash2, Upload, Volume2 } from "lucide-react";
import { api, randomId, errorText } from "./api";
import { Notice } from "./App";

type Sample = {
  data: string;
  mime: string;
  url: string;
  name: string;
  size: number;
};
type Take = {
  id: string;
  text: string;
  createdAt: number;
  data: string;
  mime: string;
};

const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;

function sampleMime(file: File) {
  if (file.type.startsWith("audio/")) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".m4a") || name.endsWith(".mp4")) return "audio/mp4";
  if (name.endsWith(".ogg") || name.endsWith(".oga")) return "audio/ogg";
  if (name.endsWith(".webm")) return "audio/webm";
  if (name.endsWith(".flac")) return "audio/flac";
  return "audio/mpeg";
}

export function Voice({
  userId,
  defaultGroup = "",
}: {
  userId: number;
  defaultGroup?: string;
}) {
  const [group, setGroup] = useState(defaultGroup);
  const [groups, setGroups] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void api
      .get<Record<string, unknown>>("groups")
      .then((v) => {
        if (live) setGroups(Object.keys(v));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const [consent, setConsent] = useState(false);
  const request = useRef<string>();
  const readerRef = useRef<FileReader>();
  const [sample, setSample] = useState<Sample>();
  const [text, setText] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string>();
  const [message, setMessage] = useState("");
  const [takes, setTakes] = useState<Take[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [startedAt, setStartedAt] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readerRef.current?.abort();
      readerRef.current = undefined;
      if (request.current) void api.cancel(request.current).catch(() => {});
      request.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const pickSample = (file?: File) => {
    if (!file) return;
    readerRef.current?.abort();
    readerRef.current = undefined;
    // A replacement must never leave the previous audio eligible for submission.
    setSample(undefined);
    setConsent(false);
    setMessage("");
    if (
      !file.type.startsWith("audio/") &&
      !/\.(wav|mp3|m4a|ogg|oga|webm|flac|mp4)$/i.test(file.name)
    ) {
      setMessage("请选择 MP3、WAV、M4A、OGG、WebM 或 FLAC 音频");
      return;
    }
    if (file.size === 0 || file.size > MAX_SAMPLE_BYTES) {
      setMessage("请选择非空且不超过 10 MB 的声音样本");
      return;
    }
    const reader = new FileReader();
    readerRef.current = reader;
    reader.onload = () => {
      if (
        !alive.current ||
        readerRef.current !== reader ||
        typeof reader.result !== "string"
      )
        return;
      setSample({
        data: reader.result.split(",")[1] ?? "",
        mime: sampleMime(file),
        url: reader.result,
        name: file.name,
        size: file.size,
      });
    };
    reader.onerror = () => {
      if (alive.current && readerRef.current === reader)
        setMessage("读取声音样本失败");
    };
    reader.readAsDataURL(file);
  };
  const generate = async () => {
    if (!sample || !text.trim() || request.current || !consent) return;
    const id = randomId();
    request.current = id;
    setBusy(true);
    setActiveId(id);
    setStartedAt(Date.now());
    setNow(Date.now());
    setMessage("");
    try {
      const value = await api.tts(
        id,
        text.trim(),
        sample.data,
        instruction,
        consent,
        userId,
        group,
      );
      if (!alive.current) return;
      setTakes((prev) => {
        let bytes = 0;
        return [
          {
            id,
            text: text.trim(),
            createdAt: Date.now(),
            data: value.data,
            mime: value.mime,
          },
          ...prev,
        ]
          .slice(0, 20)
          .filter((take) => {
            bytes += take.data.length;
            return bytes <= 40 * 1024 * 1024;
          });
      });
    } catch (error) {
      if (alive.current) setMessage(errorText(error));
    } finally {
      if (request.current === id) request.current = undefined;
      if (alive.current) {
        setBusy(false);
        setActiveId(undefined);
      }
    }
  };
  const stop = () => {
    if (!activeId) return;
    void api.cancel(activeId).catch((error) => {
      if (alive.current) setMessage(errorText(error));
    });
  };
  return (
    <div className="page voice-page">
      <div className="page-heading">
        <span className="eyebrow">CLONE YOUR VOICE</span>
        <h1>让你的声音开口</h1>
        <p className="muted">
          上传已获授权的清晰人声并输入文字，使用 MiMo
          生成语音。需要账号具备音频模型权限。
        </p>
      </div>
      <section className="voice-block">
        <label>
          音频分组
          <select
            value={group}
            disabled={busy}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="">账号默认分组</option>
            {[
              ...new Set([...(defaultGroup ? [defaultGroup] : []), ...groups]),
            ].map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <div className="heading-row">
          <h2>1 · 声音样本</h2>
          <small className="muted">建议 3–30 秒 · ≤10 MB</small>
        </div>
        <input
          ref={fileRef}
          type="file"
          className="visually-hidden"
          accept="audio/*"
          aria-label="上传声音样本"
          onChange={(e) => {
            pickSample(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {sample ? (
          <div className="voice-sample">
            <audio controls src={sample.url} aria-label="声音样本试听" />
            <div className="voice-sample-name">
              <span>
                {sample.name} · {Math.ceil(sample.size / 1024)} KB
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="移除声音样本"
                onClick={() => {
                  readerRef.current?.abort();
                  readerRef.current = undefined;
                  setSample(undefined);
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="upload-button"
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={18} />
            选择音频文件
            <span>MP3 / WAV / M4A</span>
          </button>
        )}
      </section>
      <label>
        2 · 要说的话
        <textarea
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="输入要让克隆声音朗读的文本…"
          maxLength={8000}
        />
      </label>
      <label>
        语气指令（可选）
        <textarea
          rows={2}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="例如：语速稍快，带一点兴奋的笑意"
          maxLength={2000}
        />
      </label>
      <Notice text={message} />
      <label>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => {
            setConsent(e.target.checked);
            if (!e.target.checked && request.current)
              void api.cancel(request.current).catch(() => {});
          }}
        />
        我拥有参考声音的使用授权
      </label>
      <p className="footnote">
        生成按平台用量计费；停止仅停止本机等待，不保证服务端取消或退款。失败后先核对用量，不会自动重试。
      </p>
      <button
        type="button"
        className="primary full"
        disabled={!sample || !text.trim() || busy || !consent}
        onClick={() => void generate()}
      >
        {busy ? <span className="spinner" /> : <Sparkles size={18} />}
        {busy
          ? `正在合成 · ${Math.max(0, Math.floor((now - startedAt) / 1000))} 秒`
          : "生成语音"}
      </button>
      {busy && (
        <button
          type="button"
          className="secondary full voice-stop"
          onClick={stop}
        >
          <Square size={15} />
          停止等待
        </button>
      )}
      <p className="footnote">
        声音克隆按站内额度计费。请确保你拥有样本音频的使用权，合成结果仅保存在本次打开
        App 期间。
      </p>
      {takes.length > 0 && (
        <section className="voice-results" aria-label="语音结果">
          <div className="heading-row">
            <h2>生成结果</h2>
            <small className="muted">{takes.length} 条</small>
          </div>
          {takes.map((take) => (
            <div className="voice-result" key={take.id}>
              <div className="voice-result-head">
                <Mic size={14} />
                <small className="muted">
                  {new Date(take.createdAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </small>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="删除这条语音"
                  onClick={() =>
                    setTakes((prev) =>
                      prev.filter((item) => item.id !== take.id),
                    )
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <p>{take.text}</p>
              <div className="voice-play">
                <Volume2 size={15} />
                <audio
                  controls
                  src={`data:${take.mime};base64,${take.data}`}
                  aria-label="合成的语音"
                />
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
