import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  ImagePlus,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { settingsApi } from "@/lib/api";
import { mediaStudioApi, type MediaRecord } from "@/lib/api/media-studio";
import { useYuanhengConnection } from "@/lib/query/yuanheng";
import { extractErrorMessage } from "@/utils/errorUtils";
import { PageHeader } from "./PageHeader";
import { dt } from "./desktopI18n";

const pending = (r: MediaRecord) =>
  ["queued", "in_progress"].includes(r.status);
export const MEDIA_POLL_LIMIT = 40;
export const MUSE_POLL_LIMIT = 120;
export const MEDIA_POLL_DELAY = 15_000;

export function MediaStudioPage() {
  const { data: connection } = useYuanhengConnection();
  if (!connection?.connected)
    return <p className="p-6">{dt("请先登录元衡")}</p>;
  const scope = JSON.stringify([
    connection.baseUrl,
    connection.userId,
    connection.connected,
  ]);
  return <MediaStudioContent key={scope} scope={scope} />;
}

export function MediaStudioContent({ scope }: { scope: string }) {
  const client = useQueryClient();
  const historyKey = ["media-studio", scope, "history"];
  const models = useQuery({
    queryKey: ["media-studio", scope, "models"],
    queryFn: mediaStudioApi.models,
    retry: false,
    staleTime: 60_000,
  });
  const history = useQuery({
    queryKey: historyKey,
    queryFn: mediaStudioApi.history,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [kind, setKind] = useState<"image" | "video">("image");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const [prompt, setPrompt] = useState("");
  const [reference, setReference] = useState<string | null>(null);
  const [extraReferences, setExtraReferences] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [waiting, setWaiting] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    id: string;
    url: string;
    mime: string;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const alive = useRef(true);
  const submitLock = useRef(false);
  const actionLock = useRef(false);
  const readSequence = useRef(0);
  const stagedReference = useRef<{ model: string; data: string } | null>(null);
  const activeUrl = useRef<string | null>(null);
  const available = (models.data ?? []).filter((m) => m.kind === kind);
  const selected = available.find((m) => m.id === model);
  const isMuse = model === "muse-video";
  const referenceList = reference ? [reference, ...extraReferences] : [];
  const promptLimit = isMuse ? 4000 : 8000;
  const referenceVideoModels = (models.data ?? []).filter(
    (m) => m.kind === "video" && m.reference !== "none",
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readSequence.current++;
      if (activeUrl.current) URL.revokeObjectURL(activeUrl.current);
    };
  }, []);
  useEffect(() => {
    // Refreshes cannot silently replace a model the user already selected.
    if (model) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(`yuanheng-media-model-${kind}`);
    } catch {
      /* storage optional */
    }
    setModel(
      available.find((m) => m.id === saved)?.id ?? available[0]?.id ?? "",
    );
  }, [kind, models.data, model]);
  useEffect(() => {
    setSize(selected?.sizes[0] ?? "");
    setDuration(selected?.durations[0] ?? null);
    if (stagedReference.current?.model === model) {
      setReference(stagedReference.current.data);
      setExtraReferences([]);
      stagedReference.current = null;
    } else if (!selected || selected.reference === "none") {
      if (reference)
        setMessage(
          dt("此模型不支持参考图，已移除图片。生成前请确认使用方式。"),
        );
      setReference(null);
      setExtraReferences([]);
    } else if (model !== "muse-video" && extraReferences.length) {
      setExtraReferences([]);
      setMessage(dt("此模型仅接受一张参考图，已保留首图并移除其他图片。"));
    }
    setReading(false);
    readSequence.current++;
    if (fileInput.current) fileInput.current.value = "";
  }, [model]);

  const update = (record: MediaRecord) => {
    client.setQueryData<MediaRecord[]>(historyKey, (rows) =>
      [record, ...(rows ?? []).filter((r) => r.id !== record.id)].sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
    );
  };
  // Sequential, bounded GET polling. Unmount/pause stops scheduling; no paid retries.
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    let rounds = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      try {
        const record = await mediaStudioApi.refresh(waiting);
        if (stopped || !alive.current) return;
        update(record);
        setMessage(record.message);
        rounds++;
        if (!pending(record)) {
          setWaiting(null);
          return;
        }
        if (
          rounds >=
          (record.model === "muse-video" ? MUSE_POLL_LIMIT : MEDIA_POLL_LIMIT)
        ) {
          setWaiting(null);
          setMessage(
            dt("已暂停自动等待，任务仍保留。稍后点击继续查询，不会重新生成。"),
          );
          return;
        }
        timer = setTimeout(() => void poll(), MEDIA_POLL_DELAY);
      } catch (error) {
        if (!stopped && alive.current) {
          setMessage(extractErrorMessage(error));
          setWaiting(null);
        }
      }
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [waiting, scope]);

  const pick = async (files: File[]) => {
    const sequence = ++readSequence.current;
    if (!files.length) return;
    const existing = isMuse ? referenceList : [];
    if (files.length + existing.length > (isMuse ? 4 : 1)) {
      setMessage(dt("Muse最多4张参考图，其他模型最多1张。"));
      return;
    }
    const allowed = isMuse
      ? ["image/png", "image/jpeg", "image/webp"]
      : ["image/png", "image/jpeg"];
    if (
      files.some(
        (file) => !allowed.includes(file.type) || file.size > 10 * 1024 * 1024,
      )
    ) {
      setMessage(
        dt(
          isMuse
            ? "Muse支持PNG、JPEG、WebP，单张最多10MB，总计最多24MB。"
            : "请选择不超过 10 MB 的 PNG 或 JPEG 参考图",
        ),
      );
      return;
    }
    const existingSize = existing.reduce((total, raw) => {
      const data = raw.split(",")[1] ?? "";
      return (
        total +
        (data.length * 3) / 4 -
        (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
      );
    }, 0);
    if (
      isMuse &&
      existingSize + files.reduce((n, f) => n + f.size, 0) > 24 * 1024 * 1024
    ) {
      setMessage(dt("Muse支持PNG、JPEG、WebP，单张最多10MB，总计最多24MB。"));
      return;
    }
    setReading(true);
    try {
      const next = [...existing];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!alive.current || readSequence.current !== sequence) return;
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        next.push(`data:${file.type};base64,${btoa(binary)}`);
      }
      setReference(next[0]);
      setExtraReferences(next.slice(1));
      setMessage("");
    } catch {
      if (alive.current && readSequence.current === sequence)
        setMessage(dt("读取参考图失败"));
    } finally {
      if (alive.current && readSequence.current === sequence) setReading(false);
    }
  };

  const generate = async () => {
    if (
      submitLock.current ||
      actionLock.current ||
      !selected ||
      !prompt.trim() ||
      Array.from(prompt).length > promptLimit ||
      (kind === "video" && !selected.durations.includes(duration ?? 0)) ||
      reading ||
      models.isError
    )
      return;
    submitLock.current = true;
    setBusy(true);
    setMessage("");
    setWaiting(null);
    try {
      try {
        localStorage.setItem(`yuanheng-media-model-${kind}`, model);
      } catch {
        /* optional preference */
      }
      const record = await mediaStudioApi.submit({
        operationId: crypto.randomUUID(),
        model,
        prompt: prompt.trim(),
        size,
        duration: kind === "video" ? duration : null,
        reference: isMuse && referenceList.length > 1 ? null : reference,
        ...(isMuse && referenceList.length > 1
          ? { images: referenceList }
          : {}),
      });
      if (!alive.current) return;
      update(record);
      setMessage(record.message);
      if (pending(record) && record.taskId) setWaiting(record.id);
    } catch (error) {
      if (alive.current) {
        setMessage(extractErrorMessage(error));
        await history.refetch();
      }
    } finally {
      submitLock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const operate = async (id: string, fn: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setAction(id);
    setMessage("");
    try {
      await fn();
    } catch (error) {
      if (alive.current) setMessage(extractErrorMessage(error));
    } finally {
      actionLock.current = false;
      if (alive.current) setAction(null);
    }
  };
  const show = async (record: MediaRecord) => {
    const result = await mediaStudioApi.preview(record.id);
    if (!alive.current) return;
    if (
      !["image/png", "image/jpeg", "image/webp", "video/mp4"].includes(
        result.mime,
      )
    )
      throw new Error(dt("作品格式不受支持"));
    const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
    if (activeUrl.current) URL.revokeObjectURL(activeUrl.current);
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mime }));
    activeUrl.current = url;
    setPreview({ id: record.id, url, mime: result.mime });
  };
  const save = async (record: MediaRecord) => {
    const result =
      record.kind === "image" ? await mediaStudioApi.preview(record.id) : null;
    if (!alive.current) return;
    const extension =
      record.kind === "video"
        ? "mp4"
        : result?.mime === "image/jpeg"
          ? "jpg"
          : result?.mime === "image/webp"
            ? "webp"
            : "png";
    const path = await settingsApi.saveFileDialog(
      `yuanheng-${record.id}.${extension}`,
    );
    if (!path || !alive.current) return;
    await mediaStudioApi.export(record.id, path);
    if (alive.current) setMessage(dt("作品已保存到所选位置"));
  };
  const remove = async (record: MediaRecord) => {
    if (
      !window.confirm(
        dt("删除本机作品和记录？此操作不能取消上游任务或退还费用。"),
      )
    )
      return;
    await mediaStudioApi.delete(record.id);
    if (!alive.current) return;
    if (preview?.id === record.id) {
      if (activeUrl.current) URL.revokeObjectURL(activeUrl.current);
      activeUrl.current = null;
      setPreview(null);
    }
    await history.refetch();
  };
  const useForVideo = async (record: MediaRecord) => {
    if (
      submitLock.current ||
      models.isError ||
      models.isFetching ||
      !referenceVideoModels.length
    )
      return;
    const target =
      referenceVideoModels.find((m) => m.id === model) ??
      referenceVideoModels.find((m) => m.id === "muse-video") ??
      referenceVideoModels[0];
    const prepared = await mediaStudioApi.prepareVideoReference(record.id);
    if (!alive.current) return;
    if (
      prepared.mime !== "image/png" ||
      !prepared.data ||
      prepared.data.length > 14 * 1024 * 1024
    ) {
      throw new Error(dt("参考图转换失败，请重新选择图片"));
    }
    const data = `data:${prepared.mime};base64,${prepared.data}`;
    setExtraReferences([]);
    readSequence.current++;
    if (target.id === model) setReference(data);
    else stagedReference.current = { model: target.id, data };
    setKind("video");
    setModel(target.id);
    setPrompt("");
    setReading(false);
    setWaiting(null);
    setMessage(
      dt("参考图已准备，请填写运动描述并确认模型后点击生成；尚未提交视频。"),
    );
    formRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <PageHeader
        title={dt("图片与视频")}
        description={dt("描述你的想法，选择模型，直接生成图片或视频。")}
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label={dt("创作类型")} className="flex gap-2">
          {(["image", "video"] as const).map((tab) => (
            <Button
              key={tab}
              role="tab"
              aria-selected={kind === tab}
              variant={kind === tab ? "default" : "outline"}
              disabled={busy || !!action}
              onClick={() => {
                setKind(tab);
                setModel("");
              }}
            >
              {dt(tab === "image" ? "图片生成" : "视频生成")}
            </Button>
          ))}
        </div>
        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs">
          {dt("分组：生图和视频")}
        </span>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(280px,1fr)_minmax(300px,1.3fr)]">
        <form
          ref={formRef}
          className="space-y-4 rounded-2xl border bg-card p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 space-y-2 text-sm">
              {dt("生成模型")}
              <select
                className="block w-full rounded-md border bg-background p-2"
                value={model}
                disabled={busy || !!action || models.isFetching}
                onChange={(e) => setModel(e.target.value)}
              >
                {!model && <option value="">{dt("请选择模型")}</option>}
                {model && !selected && (
                  <option value={model} disabled>
                    {model}
                  </option>
                )}
                {available.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !!action || models.isFetching}
              aria-label={dt("刷新模型")}
              onClick={() => void models.refetch()}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          {models.isError && (
            <p role="alert" className="text-sm text-destructive">
              {extractErrorMessage(models.error)}
            </p>
          )}
          {selected && (
            <p className="text-xs text-muted-foreground">
              {dt(
                selected.kind === "video"
                  ? selected.reference === "none"
                    ? "此模型当前仅支持文生视频，不接受参考图。"
                    : "此模型支持文生视频和图生视频。"
                  : selected.reference === "none"
                    ? "此模型当前仅支持文生图。"
                    : "此模型支持文字生成和参考图创作。",
              )}
            </p>
          )}
          {model && !selected && !models.isPending && (
            <p role="alert" className="text-sm text-destructive">
              {dt("所选模型已不可用，请重新选择；不会自动换模型。")}
            </p>
          )}
          {!models.isPending && !models.isError && available.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {dt("此分组暂无本版支持的模型，请检查分组权限或刷新目录。")}
            </p>
          )}
          <label className="block space-y-2 text-sm">
            {dt("画面描述")}
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              maxLength={promptLimit * 2}
              disabled={busy || !!action}
              placeholder={dt(
                "例如：清晨的海边书店，阳光穿过落地窗，温暖的胶片色调…",
              )}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {Array.from(prompt).length} / {promptLimit}
          </p>
          {selected && selected.reference !== "none" && (
            <div className="space-y-2">
              <input
                ref={fileInput}
                type="file"
                accept={
                  isMuse
                    ? "image/png,image/jpeg,image/webp"
                    : "image/png,image/jpeg"
                }
                multiple={isMuse}
                className="hidden"
                aria-label={dt("选择参考图")}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  void pick(files);
                }}
                disabled={busy || !!action || reading}
              />
              <Button
                type="button"
                variant="outline"
                disabled={busy || !!action || reading}
                onClick={() => fileInput.current?.click()}
              >
                <ImagePlus className="h-4 w-4" />
                {dt(
                  selected.reference === "required"
                    ? "上传参考图（必选）"
                    : "上传参考图（可选）",
                )}
              </Button>
              {referenceList.map((raw, index) => (
                <div
                  key={`${index}-${raw.slice(-16)}`}
                  className="flex flex-wrap items-start gap-2"
                >
                  {isMuse && (
                    <span className="text-xs">
                      {index + 1} · {dt(index === 0 ? "首帧" : "参考图")}
                    </span>
                  )}
                  <img
                    src={raw}
                    alt={
                      index === 0
                        ? dt("参考图")
                        : `${dt("参考图")} ${index + 1}`
                    }
                    className="h-24 max-w-full rounded-md object-contain"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy || !!action || reading}
                    aria-label={dt("移除参考图")}
                    onClick={() => {
                      readSequence.current++;
                      const next = referenceList.filter((_, i) => i !== index);
                      setReference(next[0] ?? null);
                      setExtraReferences(next.slice(1));
                      if (fileInput.current) fileInput.current.value = "";
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                  {index > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy || !!action || reading}
                      onClick={() => {
                        const next = [...referenceList];
                        [next[index - 1], next[index]] = [
                          next[index],
                          next[index - 1],
                        ];
                        setReference(next[0]);
                        setExtraReferences(next.slice(1));
                      }}
                    >
                      {dt("前移")}
                    </Button>
                  )}
                </div>
              ))}
              {isMuse && (
                <p className="text-xs text-muted-foreground">
                  {dt(
                    "最多4张：第一张是首帧，其余为人物、场景或画风参考，最后一张不是尾帧。",
                  )}
                </p>
              )}
              {isMuse && referenceList.length > 1 && (
                <p
                  role="note"
                  className="text-xs text-amber-700 dark:text-amber-300"
                >
                  {dt(
                    "多图参考为实验功能：已测样本主要采纳首图，第2–4张的效果不保证。",
                  )}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {dt("仅发送你选择的参考图和描述；请确认拥有素材使用权。")}
              </p>
            </div>
          )}
          {selected && (
            <details className="rounded-lg bg-muted/30 p-3">
              <summary className="cursor-pointer text-sm">
                {dt("更多设置")}
              </summary>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="text-xs">
                  {dt("尺寸或比例")}
                  <select
                    className="mt-1 block w-full rounded border bg-background p-2"
                    value={size}
                    disabled={busy || !!action}
                    onChange={(e) => setSize(e.target.value)}
                  >
                    {selected.sizes.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                {kind === "video" && (
                  <label className="text-xs">
                    {dt("请求时长（秒）")}
                    {isMuse ? (
                      <input
                        type="number"
                        min={4}
                        max={180}
                        step={1}
                        aria-label={dt("Muse时长（秒）")}
                        className="mt-1 block w-full rounded border bg-background p-2"
                        value={duration ?? ""}
                        disabled={busy || !!action}
                        onChange={(e) =>
                          setDuration(
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                          )
                        }
                      />
                    ) : (
                      <select
                        className="mt-1 block w-full rounded border bg-background p-2"
                        value={duration ?? ""}
                        disabled={busy || !!action}
                        onChange={(e) => setDuration(Number(e.target.value))}
                      >
                        {selected.durations.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    )}
                  </label>
                )}
              </div>
              {kind === "video" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {dt(
                    "实际时长可能由供应商调整；Grok 当前使用 480p，其他型号按所选尺寸生成。",
                  )}
                </p>
              )}
            </details>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {dt(
              "点击生成会按所选模型及生图和视频分组计费。暂不提供精确估价，费用以平台实际用量为准。",
            )}
          </p>
          {kind === "video" && (
            <p className="text-xs text-muted-foreground">
              {dt(
                isMuse
                  ? "Muse提交最长等待30分钟。返回任务编号后继续查询；超时不会自动重发。"
                  : "视频提交最长等待 10 分钟。返回任务编号后继续查询；超时不会自动重发。",
              )}
            </p>
          )}
          {isMuse && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {dt(
                "Muse文档支持4–180秒、720p；超过30秒会分段拼接，请按段描述镜头，并非单个连续长镜头。新能力正在实际验证。",
              )}
            </p>
          )}
          {isMuse && (
            <p className="text-xs text-muted-foreground">
              {dt(
                "Muse自动查询约30分钟；长片建议直接保存，超过64MB不在页面内预览。下载最长15分钟、上限256MB，失败可重下原任务。",
              )}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={
              busy ||
              !!action ||
              reading ||
              !selected ||
              !prompt.trim() ||
              Array.from(prompt).length > promptLimit ||
              (kind === "video" &&
                !selected?.durations.includes(duration ?? 0)) ||
              models.isError ||
              !selected.sizes.includes(size) ||
              (selected.reference === "required" && !reference)
            }
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {dt(busy ? "正在提交，请勿重复生成" : "生成")}
          </Button>
          {busy && (
            <p className="text-xs text-muted-foreground">
              {dt("离开页面不会撤销已提交的生成，返回后请先查看作品记录。")}
            </p>
          )}
        </form>
        <section
          className="min-w-0 rounded-2xl border bg-card p-5"
          aria-label={dt("作品预览")}
        >
          <h2 className="mb-3 font-medium">{dt("作品预览")}</h2>
          <div className="flex min-h-72 items-center justify-center overflow-hidden rounded-xl bg-muted/30">
            {preview ? (
              preview.mime === "video/mp4" ? (
                <video
                  key={preview.url}
                  controls
                  src={preview.url}
                  className="max-h-[520px] w-full"
                />
              ) : (
                <img
                  src={preview.url}
                  alt={dt("生成结果")}
                  className="max-h-[520px] max-w-full object-contain"
                />
              )
            ) : (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {dt("生成完成后，从下方作品记录打开预览。")}
              </p>
            )}
          </div>
        </section>
      </div>
      {message && (
        <p
          role="status"
          className="mt-4 whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm"
        >
          {dt(message)}
        </p>
      )}
      <section className="mt-6 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">{dt("本机作品记录")}</h2>
          <Button
            variant="ghost"
            disabled={history.isFetching || busy}
            onClick={() => void history.refetch()}
          >
            {dt("刷新记录")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {dt(
            "最多保留 50 条记录；提示词和参考图不写入历史。视频可继续查询原任务，暂停等待不会取消生成或退款。",
          )}
        </p>
        {history.isError && (
          <p role="alert">{extractErrorMessage(history.error)}</p>
        )}
        {history.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {dt("还没有作品，试着描述你的第一个想法。")}
          </p>
        )}
        {history.data?.map((record) => (
          <article
            key={record.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="break-all text-sm font-medium">{record.model}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(record.createdAt * 1000).toLocaleString()} ·{" "}
                {dt(record.message)}
              </p>
              {record.taskId && (
                <p className="break-all font-mono text-xs">{record.taskId}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {record.status === "completed" && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!action}
                    onClick={() => void operate(record.id, () => show(record))}
                  >
                    <Play className="h-3.5 w-3.5" />
                    {dt(action === record.id ? "处理中…" : "预览")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!action}
                    onClick={() => void operate(record.id, () => save(record))}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {dt("保存")}
                  </Button>
                  {record.kind === "image" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        !!action ||
                        busy ||
                        reading ||
                        models.isError ||
                        models.isFetching ||
                        !referenceVideoModels.length
                      }
                      onClick={() =>
                        void operate(record.id, () => useForVideo(record))
                      }
                    >
                      <ImagePlus className="h-3.5 w-3.5" />
                      {dt("用作视频参考图")}
                    </Button>
                  )}
                </>
              )}
              {pending(record) && record.taskId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setWaiting(waiting === record.id ? null : record.id)
                  }
                >
                  {waiting === record.id ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {dt(waiting === record.id ? "暂停等待" : "继续查询")}
                </Button>
              )}
              {!pending(record) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!action || busy}
                  aria-label={dt("删除本机记录")}
                  onClick={() => void operate(record.id, () => remove(record))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            {record.kind === "image" &&
              record.status === "completed" &&
              !referenceVideoModels.length && (
                <p className="w-full text-xs text-muted-foreground">
                  {dt(
                    "当前目录没有可用的图生视频模型，请刷新模型或检查分组权限。",
                  )}
                </p>
              )}
          </article>
        ))}
      </section>
    </div>
  );
}
