import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  ImagePlus,
  Info,
  Pencil,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  defaultMediaParameters,
  loadMediaPreference,
  saveMediaPreference,
  mediaPreferenceKey,
  mediaParametersValid,
  type MediaParameters,
} from "@/lib/mediaPreferences";
import { Textarea } from "@/components/ui/textarea";
import {
  mediaStudioApi,
  type MediaRecord,
  type MediaGroups,
} from "@/lib/api/media-studio";
import { useYuanhengConnection } from "@/lib/query/yuanheng";
import { extractErrorMessage } from "@/utils/errorUtils";
import {
  mediaReferencePolicy,
  referenceBytes,
  referencesFit,
} from "@/lib/mediaReferences";
import { MediaInspirationGallery } from "./MediaInspirationGallery";
import type { MediaInspiration } from "@/lib/mediaInspiration";
import { MediaParameterFields } from "./MediaParameterFields";
import { PageHeader } from "./PageHeader";
import { dt } from "./desktopI18n";

function MediaHelp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={dt("查看说明")}
            onClick={() => setOpen(!open)}
            className="inline-flex rounded p-1 text-muted-foreground"
          >
            <Info size={15} />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs whitespace-pre-wrap">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

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
  const [view, setView] = useState<"explore" | "create" | "history">("explore");
  const [kind, setKind] = useState<"image" | "video">("image");
  const historyKey = ["media-studio", scope, "history"];
  const groupsKey = ["media-studio", scope, "groups"];
  const groups = useQuery({
    queryKey: groupsKey,
    queryFn: mediaStudioApi.groups,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const [chosenGroups, setChosenGroups] = useState<
    Partial<Record<"image" | "video", string>>
  >({});
  const [switchingGroup, setSwitchingGroup] = useState(false);
  const [groupError, setGroupError] = useState("");
  const groupLock = useRef(false);
  const eligibleGroups = (groups.data?.groups ?? []).filter(
    (g) =>
      view === "explore" ||
      !groups.data?.modelsByGroup ||
      groups.data.modelsByGroup[g.id]?.some((m) => m.kind === kind),
  );
  const candidateGroup =
    chosenGroups[kind] ??
    (groups.data?.selectedGroups
      ? groups.data.selectedGroups[kind]
      : groups.data?.selectedGroup) ??
    "";
  const group = eligibleGroups.some((g) => g.id === candidateGroup)
    ? candidateGroup
    : "";
  const groupAllowed =
    !!group && !!groups.data?.groups.some((g) => g.id === group);
  const groupReady =
    groupAllowed && !groups.isFetching && !groups.isError && !switchingGroup;
  const models = useQuery({
    queryKey: ["media-studio", scope, "models", group],
    queryFn: () => mediaStudioApi.models(group),
    enabled: groupReady,
    retry: false,
    staleTime: 60_000,
    initialData: () => groups.data?.modelsByGroup?.[group],
    initialDataUpdatedAt: groups.dataUpdatedAt,
    refetchOnWindowFocus: false,
  });
  const appliedCatalogAt = useRef(0);
  useEffect(() => {
    if (appliedCatalogAt.current === groups.dataUpdatedAt) return;
    if (!groups.data?.modelsByGroup || groups.isError || groups.isFetching)
      return;
    appliedCatalogAt.current = groups.dataUpdatedAt;
    for (const [id, catalog] of Object.entries(groups.data.modelsByGroup)) {
      client.setQueryData(["media-studio", scope, "models", id], catalog, {
        updatedAt: groups.dataUpdatedAt,
      });
    }
  }, [
    groups.data,
    groups.dataUpdatedAt,
    groups.isError,
    groups.isFetching,
    scope,
    client,
  ]);
  const history = useQuery({
    queryKey: historyKey,
    queryFn: mediaStudioApi.history,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const [model, setModel] = useState("");
  const [parametersKey, setParametersKey] = useState("");
  const [size, setSize] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const [quality, setQuality] = useState<string | undefined>();
  const [resolution, setResolution] = useState<string | undefined>();
  const [outputFormat, setOutputFormat] = useState<string | undefined>();
  const [background, setBackground] = useState<string | undefined>();
  const [outputCompression, setOutputCompression] = useState<
    number | undefined
  >();
  const [savePrompt, setSavePrompt] = useState(false);
  const [needsReference, setNeedsReference] = useState(false);
  const pendingParameters = useRef<MediaParameters | null>(null);
  const parameters: MediaParameters = {
    size,
    duration,
    quality,
    resolution,
    outputFormat,
    background,
    outputCompression,
  };
  const preferenceKey = mediaPreferenceKey(scope, kind, group);
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
  const pageRef = useRef<HTMLDivElement>(null);
  const focusDraft = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const alive = useRef(true);
  const submitLock = useRef(false);
  const actionLock = useRef(false);
  const readSequence = useRef(0);
  const readLock = useRef(false);
  const stagedReference = useRef<{ model: string; data: string } | null>(null);
  const activeUrl = useRef<string | null>(null);
  const available = (groupAllowed ? (models.data ?? []) : []).filter(
    (m) => m.kind === kind,
  );
  const selected = available.find((m) => m.id === model);
  const isMuse = model === "muse-video";
  const isGptImage = model.startsWith("gpt-image-");
  const referencePolicy = mediaReferencePolicy(model);
  const referenceList = reference ? [reference, ...extraReferences] : [];
  const referencesValid =
    referencesFit(model, referenceList) &&
    !(selected?.reference === "none" && referenceList.length > 0);
  const promptLimit = isMuse ? 4000 : 8000;
  const videoGroup =
    chosenGroups.video ??
    (groups.data?.selectedGroups ? groups.data.selectedGroups.video : group) ??
    "";
  const referenceVideoModels = (
    !groups.isError && !groups.isFetching && !switchingGroup
      ? groups.data?.modelsByGroup
        ? (groups.data.modelsByGroup[videoGroup] ?? [])
        : (models.data ?? [])
      : []
  ).filter((m) => m.kind === "video" && m.reference !== "none");
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
    if (model || !groupReady || models.isFetching || models.isError) return;
    let saved: string | null = null;
    try {
      saved = loadMediaPreference(preferenceKey)?.model ?? null;
    } catch {
      /* storage optional */
    }
    setModel(saved ?? available[0]?.id ?? "");
  }, [
    kind,
    models.data,
    models.isFetching,
    models.isError,
    model,
    groupReady,
    group,
    scope,
  ]);
  useEffect(() => {
    if (selected) {
      const remembered = loadMediaPreference(preferenceKey);
      const next =
        pendingParameters.current ??
        (remembered?.model === model
          ? remembered.parameters
          : defaultMediaParameters(selected));
      pendingParameters.current = null;
      setParametersKey(JSON.stringify([kind, group, model]));
      setSize(next.size);
      setDuration(next.duration);
      setQuality(next.quality);
      setResolution(next.resolution);
      setOutputFormat(next.outputFormat);
      setBackground(next.background);
      setOutputCompression(next.outputCompression);
    }
    if (stagedReference.current?.model === model) {
      setReference(stagedReference.current.data);
      setExtraReferences([]);
      stagedReference.current = null;
    } else if (
      selected &&
      (!referencesFit(model, referenceList) ||
        (selected.reference === "none" && referenceList.length > 0))
    ) {
      setMessage(
        dt(
          "参考图不符合当前模型的数量、格式或大小要求，请调整后再生成；原图已保留。",
        ),
      );
    }
    setReading(false);
    readLock.current = false;
    readSequence.current++;
    if (fileInput.current) fileInput.current.value = "";
  }, [model, group, selected?.id]);

  useEffect(() => {
    pageRef.current?.scrollTo?.({ top: 0 });
    if (view === "create" && focusDraft.current) {
      focusDraft.current = false;
      formRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    }
  }, [view]);

  useEffect(() => {
    if (
      parametersKey === JSON.stringify([kind, group, model]) &&
      selected &&
      groupReady &&
      mediaParametersValid(selected, parameters)
    ) {
      saveMediaPreference(preferenceKey, model, parameters);
    }
  }, [
    size,
    duration,
    quality,
    resolution,
    outputFormat,
    background,
    outputCompression,
    model,
    parametersKey,
  ]);
  const applyParameters = (p: MediaParameters) => {
    setSize(p.size);
    setDuration(p.duration);
    setQuality(p.quality);
    setResolution(p.resolution);
    setOutputFormat(p.outputFormat);
    setBackground(p.background);
    setOutputCompression(p.outputCompression);
  };
  const switchKind = (next: "image" | "video") => {
    if (next === kind || busy || reading || action || switchingGroup) return;
    setKind(next);
    setModel("");
    pendingParameters.current = null;
  };
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
    if (
      !files.length ||
      groupLock.current ||
      !groupReady ||
      models.isFetching ||
      models.isError ||
      readLock.current ||
      submitLock.current ||
      actionLock.current ||
      !selected ||
      selected.reference === "none"
    )
      return;
    const sequence = ++readSequence.current;
    const existing = referencePolicy.maxCount > 1 ? referenceList : [];
    if (files.length + existing.length > referencePolicy.maxCount) {
      setMessage(
        dt("当前模型最多支持 {{count}} 张参考图。", {
          count: referencePolicy.maxCount,
        }),
      );
      return;
    }
    const allowed = referencePolicy.mimeTypes;
    if (
      files.some(
        (file) =>
          !allowed.includes(file.type) ||
          (referencePolicy.exclusiveBytes
            ? file.size >= referencePolicy.maxBytes
            : file.size > referencePolicy.maxBytes),
      )
    ) {
      setMessage(
        dt(
          isGptImage
            ? "GPT Image最多16张PNG、JPEG或WebP参考图，每张须小于50MB。"
            : isMuse
              ? "Muse支持PNG、JPEG、WebP，单张最多10MB，总计最多24MB。"
              : "请选择不超过 10 MB 的 PNG 或 JPEG 参考图",
        ),
      );
      return;
    }
    const existingSize = existing.reduce(
      (total, raw) => total + referenceBytes(raw),
      0,
    );
    if (
      isMuse &&
      existingSize + files.reduce((n, f) => n + f.size, 0) > 24 * 1024 * 1024
    ) {
      setMessage(dt("Muse支持PNG、JPEG、WebP，单张最多10MB，总计最多24MB。"));
      return;
    }
    readLock.current = true;
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
      if (alive.current && readSequence.current === sequence) {
        readLock.current = false;
        setReading(false);
      }
    }
  };

  const pasteReference = (event: ClipboardEvent<HTMLFormElement>) => {
    // Only consume images explicitly pasted into the creation form. Text and
    // copied URLs retain their normal editing behavior; never fetch HTML images.
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!files.length) {
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    event.preventDefault();
    if (
      groupLock.current ||
      !groupReady ||
      readLock.current ||
      submitLock.current ||
      actionLock.current
    )
      return;
    if (!selected || selected.reference === "none") {
      setMessage(dt("当前模型无法添加参考图，请先选择支持参考图的模型。"));
      return;
    }
    void pick(files);
  };

  const generate = async () => {
    if (
      groupLock.current ||
      !groupReady ||
      models.isFetching ||
      submitLock.current ||
      actionLock.current ||
      !selected ||
      !mediaParametersValid(selected, parameters) ||
      (needsReference && referenceList.length === 0) ||
      !prompt.trim() ||
      Array.from(prompt).length > promptLimit ||
      (kind === "video" && !selected.durations.includes(duration ?? 0)) ||
      !referencesValid ||
      readLock.current ||
      reading ||
      models.isError
    )
      return;
    submitLock.current = true;
    setBusy(true);
    setMessage("");
    setWaiting(null);
    try {
      const record = await mediaStudioApi.submit({
        operationId: crypto.randomUUID(),
        quality,
        resolution,
        outputFormat,
        background,
        outputCompression,
        savePrompt,
        group,
        model,
        prompt: prompt.trim(),
        size,
        duration: kind === "video" ? duration : null,
        reference: referenceList.length > 1 ? null : reference,
        ...(referenceList.length > 1 ? { images: referenceList } : {}),
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
    setView("create");
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
    const path = await mediaStudioApi.saveDialog(
      `yuanheng-${record.id}.${extension}`,
      extension,
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
      groupLock.current ||
      groups.isError ||
      groups.isFetching ||
      !videoGroup ||
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
    setChosenGroups((old) => ({ ...old, video: videoGroup }));
    setKind("video");
    setModel(target.id);
    setPrompt("");
    setReading(false);
    setWaiting(null);
    setMessage(
      dt("参考图已准备，请填写运动描述并确认模型后点击生成；尚未提交视频。"),
    );
    setView("create");
  };

  const useInspiration = (example: MediaInspiration): boolean => {
    if (
      groupLock.current ||
      !groupReady ||
      submitLock.current ||
      actionLock.current ||
      readLock.current ||
      busy ||
      action ||
      reading ||
      models.isFetching ||
      models.isError
    )
      return false;
    const target = models.data?.find(
      (m) => m.id === example.model && m.kind === example.kind,
    );
    if (!target) return false;
    if (
      (prompt.trim() || referenceList.length) &&
      !window.confirm(dt("使用此灵感会替换当前描述并移除参考图，是否继续？"))
    )
      return false;
    readSequence.current++;
    stagedReference.current = null;
    setReference(null);
    setExtraReferences([]);
    if (fileInput.current) fileInput.current.value = "";
    setKind(target.kind);
    pendingParameters.current =
      target.id === model && target.kind === kind
        ? null
        : defaultMediaParameters(target);
    setNeedsReference(false);
    setModel(target.id);
    applyParameters(defaultMediaParameters(target));
    setPrompt(dt(example.prompt));
    focusDraft.current = true;
    setMessage(
      dt("灵感已带入草稿，请确认描述和参数后点击生成；尚未提交请求。"),
    );
    setView("create");
    return true;
  };

  const editRecord = (record: MediaRecord) => {
    if (busy || reading || action || switchingGroup || groupLock.current)
      return;
    if (
      (prompt.trim() || referenceList.length) &&
      !window.confirm(dt("再次编辑将替换当前草稿，是否继续？"))
    )
      return;
    setKind(record.kind);
    setChosenGroups((old) => ({
      ...old,
      [record.kind]: record.group ?? "生图和视频",
    }));
    setModel(record.model);
    const draft = record.draft;
    pendingParameters.current =
      record.kind === kind &&
      record.model === model &&
      (record.group ?? "生图和视频") === group
        ? null
        : (draft ?? null);
    if (draft) applyParameters(draft);
    else {
      const original =
        groups.data?.modelsByGroup?.[record.group ?? "生图和视频"]?.find(
          (m) => m.id === record.model,
        ) ?? models.data?.find((m) => m.id === record.model);
      if (original) applyParameters(defaultMediaParameters(original));
    }
    if (activeUrl.current) {
      URL.revokeObjectURL(activeUrl.current);
      activeUrl.current = null;
    }
    setPreview(null);
    setPrompt(draft?.prompt ?? "");
    setReference(null);
    setExtraReferences([]);
    stagedReference.current = null;
    readSequence.current++;
    setNeedsReference(!!draft?.needsReference);
    setSavePrompt(false);
    setMessage(
      dt(
        draft?.needsReference
          ? "参数已恢复，请重新添加参考图；尚未提交请求。"
          : draft?.prompt
            ? "草稿已恢复，确认后再生成。"
            : "参数已恢复，请补充描述；旧记录缺失的参数需重新确认。",
      ),
    );
    focusDraft.current = true;
    setView("create");
    requestAnimationFrame(() => {
      if (!alive.current) return;
      formRef.current
        ?.querySelector<HTMLTextAreaElement>("textarea")
        ?.focus({ preventScroll: true });
      pageRef.current?.scrollTo?.({ top: 0 });
    });
  };
  const changeGroup = async (next: string) => {
    if (
      !next ||
      next === group ||
      groupLock.current ||
      submitLock.current ||
      actionLock.current ||
      readLock.current ||
      groups.isFetching ||
      groups.isError
    )
      return;
    groupLock.current = true;
    setSwitchingGroup(true);
    setGroupError("");
    try {
      const nextKind =
        view === "explore" &&
        groups.data?.modelsByGroup?.[next] &&
        !groups.data.modelsByGroup[next].some((m) => m.kind === kind)
          ? groups.data.modelsByGroup[next][0].kind
          : kind;
      const saved = await mediaStudioApi.selectGroup(next, nextKind);
      if (!alive.current) return;
      if (saved !== next)
        throw new Error(dt("分组切换未确认，请刷新分组后重试。"));
      // Keep model and references: an unavailable model requires explicit replacement.
      setChosenGroups((old) => ({ ...old, [nextKind]: saved }));
      if (nextKind !== kind) {
        setKind(nextKind);
        setModel("");
      }
      setMessage("");
      client.setQueryData(
        groupsKey,
        (data: MediaGroups | undefined) =>
          data
            ? {
                ...data,
                selectedGroups: { ...data.selectedGroups, [nextKind]: saved },
                selectedGroup: saved,
              }
            : data,
        { updatedAt: groups.dataUpdatedAt },
      );
    } catch (error) {
      if (alive.current) setGroupError(extractErrorMessage(error));
    } finally {
      groupLock.current = false;
      if (alive.current) setSwitchingGroup(false);
    }
  };

  return (
    <div
      ref={pageRef}
      className="media-studio-shell h-full overflow-y-auto p-4 md:p-6"
    >
      {view !== "explore" && (
        <PageHeader title={dt("图片与视频")} description="" />
      )}
      <nav
        className="media-studio-nav"
        role="tablist"
        aria-label={dt("创作导航")}
      >
        {(["explore", "create", "history"] as const).map((tab) => (
          <button
            type="button"
            role="tab"
            id={`studio-tab-${tab}`}
            aria-controls={`studio-panel-${tab}`}
            aria-selected={view === tab}
            key={tab}
            onClick={() => setView(tab)}
            onKeyDown={(event) => {
              const tabs = ["explore", "create", "history"] as const;
              const index = tabs.indexOf(tab);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % 3
                  : event.key === "ArrowLeft"
                    ? (index + 2) % 3
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 2
                        : null;
              if (next !== null) {
                event.preventDefault();
                setView(tabs[next]);
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>(
                    `#studio-tab-${tabs[next]}`,
                  )
                  ?.focus();
              }
            }}
            tabIndex={view === tab ? 0 : -1}
          >
            {dt(
              tab === "explore"
                ? "灵感广场"
                : tab === "create"
                  ? "创作工作台"
                  : "我的作品",
            )}
            {tab === "history" && (
              <span className="studio-count">{history.data?.length ?? 0}</span>
            )}
          </button>
        ))}
      </nav>
      {view !== "history" && (
        <div className="mb-5 flex flex-wrap items-center gap-3 border-b pb-4">
          <label className="flex min-w-0 flex-[0_1_400px] items-center gap-3 text-xs">
            <span className="shrink-0">{dt("模型分组")}</span>
            <select
              aria-label={dt("模型分组")}
              className="block min-w-0 flex-1 rounded-md border bg-background p-2 text-sm"
              value={group}
              disabled={
                busy ||
                !!action ||
                reading ||
                switchingGroup ||
                groups.isFetching ||
                groups.isError
              }
              onChange={(event) => void changeGroup(event.target.value)}
            >
              <option value="" disabled>
                {dt(groups.isPending ? "正在读取分组…" : "请选择创作分组")}
              </option>
              {eligibleGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.id}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={
              busy || !!action || reading || switchingGroup || groups.isFetching
            }
            onClick={() => {
              setGroupError("");
              void groups.refetch();
            }}
          >
            {dt("刷新分组")}
          </Button>
          <MediaHelp
            text={dt(
              "分组仅筛选模型；实际路由和费用由平台统一令牌决定。切换不改变聊天配置。",
            )}
          />

          {(groups.isError || groupError) && (
            <p
              role="alert"
              className="w-full text-xs text-destructive dark:text-red-300"
            >
              {groupError || extractErrorMessage(groups.error)}
            </p>
          )}
          {!groups.isError && !!groups.data?.unverifiedGroupCount && (
            <p
              role="alert"
              className="w-full text-xs text-destructive dark:text-red-300"
            >
              {dt("部分分组目录读取失败，请刷新重试。")}
            </p>
          )}
          {!groups.isPending &&
            !groups.isError &&
            !groups.data?.unverifiedGroupCount &&
            eligibleGroups.length === 0 && (
              <p role="alert" className="w-full text-xs">
                {dt("暂无可用的生图或视频分组。")}
              </p>
            )}
          {!groups.isPending &&
            !groups.isError &&
            eligibleGroups.length > 0 &&
            !groupAllowed && (
              <p role="alert" className="w-full text-xs">
                {dt("请选择有权限的创作分组，不会自动切换到其他分组。")}
              </p>
            )}
        </div>
      )}
      <div
        role="tabpanel"
        id="studio-panel-explore"
        aria-labelledby="studio-tab-explore"
        hidden={view !== "explore"}
      >
        <MediaInspirationGallery
          models={groupReady ? (models.data ?? []) : []}
          unavailable={
            !groupReady ||
            models.isError ||
            models.isFetching ||
            models.isPending
          }
          locked={busy || !!action || reading || switchingGroup}
          onUse={useInspiration}
          onCreate={() => setView("create")}
        />
        {models.isError && (
          <p
            role="alert"
            className="mt-4 text-sm text-destructive dark:text-red-300"
          >
            {dt("模型目录读取失败，请到创作工作台刷新；不会自动选择其他模型。")}
          </p>
        )}
      </div>
      <div
        role="tabpanel"
        id="studio-panel-create"
        aria-labelledby="studio-tab-create"
        hidden={view !== "create"}
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label={dt("创作类型")}
            className="flex gap-2"
          >
            {(["image", "video"] as const).map((tab) => (
              <Button
                key={tab}
                role="tab"
                aria-selected={kind === tab}
                variant={kind === tab ? "default" : "outline"}
                disabled={busy || !!action || switchingGroup || reading}
                onClick={() => {
                  switchKind(tab);
                }}
              >
                {dt(tab === "image" ? "图片生成" : "视频生成")}
              </Button>
            ))}
          </div>
        </div>
        <div className="grid gap-5 xl:grid-cols-[minmax(280px,1fr)_minmax(300px,1.3fr)]">
          <form
            ref={formRef}
            onPaste={pasteReference}
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
                  disabled={
                    busy ||
                    !!action ||
                    reading ||
                    !groupReady ||
                    models.isFetching
                  }
                  onChange={(e) => {
                    pendingParameters.current = null;
                    setModel(e.target.value);
                    setNeedsReference(false);
                  }}
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
                disabled={
                  busy ||
                  !!action ||
                  reading ||
                  !groupReady ||
                  models.isFetching
                }
                aria-label={dt("刷新模型")}
                onClick={() => void models.refetch()}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            {models.isError && (
              <p
                role="alert"
                className="text-sm text-destructive dark:text-red-300"
              >
                {extractErrorMessage(models.error)}
              </p>
            )}
            {model && !selected && !models.isPending && (
              <p
                role="alert"
                className="text-sm text-destructive dark:text-red-300"
              >
                {dt("所选模型已不可用，请重新选择；不会自动换模型。")}
              </p>
            )}
            {groupReady &&
              !models.isPending &&
              !models.isFetching &&
              !models.isError &&
              available.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {dt(
                    "当前创作类型在此分组没有已适配模型，可切换图片／视频或其他分组。",
                  )}
                </p>
              )}
            <label className="block space-y-2 text-sm">
              {dt("画面描述")}
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={6}
                maxLength={promptLimit * 2}
                disabled={busy || !!action || switchingGroup || reading}
                placeholder={dt(
                  "例如：清晨的海边书店，阳光穿过落地窗，温暖的胶片色调…",
                )}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              {Array.from(prompt).length} / {promptLimit}
            </p>
            {selected &&
              (selected.reference !== "none" || referenceList.length > 0) && (
                <div className="space-y-2">
                  <input
                    ref={fileInput}
                    type="file"
                    accept={referencePolicy.mimeTypes.join(",")}
                    multiple={referencePolicy.maxCount > 1}
                    className="hidden"
                    aria-label={dt("选择参考图")}
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      void pick(files);
                    }}
                    disabled={
                      busy ||
                      !!action ||
                      reading ||
                      selected?.reference === "none"
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      busy ||
                      !!action ||
                      reading ||
                      selected?.reference === "none"
                    }
                    onClick={() => fileInput.current?.click()}
                  >
                    <ImagePlus className="h-4 w-4" />
                    {dt(
                      selected.reference === "required"
                        ? "上传参考图（必选）"
                        : "上传参考图（可选）",
                    )}
                  </Button>
                  <MediaHelp
                    text={dt(
                      isGptImage
                        ? "GPT Image最多16张PNG、JPEG或WebP参考图，每张须小于50MB。"
                        : isMuse
                          ? "最多4张：第一张是首帧，其余为人物、场景或画风参考，最后一张不是尾帧。"
                          : "也可在此表单按 ⌘V / Ctrl+V 粘贴复制的图片或截图，点击生成后才会上传。",
                    )}
                  />
                  {!referencesValid && (
                    <p
                      role="alert"
                      className="text-sm text-destructive dark:text-red-300"
                    >
                      {dt(
                        "参考图不符合当前模型的数量、格式或大小要求，请调整后再生成；原图已保留。",
                      )}
                    </p>
                  )}
                  {referenceList.map((raw, index) => (
                    <div
                      key={`${index}-${raw.slice(-16)}`}
                      className="flex flex-wrap items-start gap-2"
                    >
                      {referencePolicy.maxCount > 1 && (
                        <span className="text-xs">
                          {index + 1} ·{" "}
                          {dt(isMuse && index === 0 ? "首帧" : "参考图")}
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
                          const next = referenceList.filter(
                            (_, i) => i !== index,
                          );
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
              <MediaParameterFields
                model={selected}
                value={parameters}
                onChange={applyParameters}
                disabled={busy || !!action || switchingGroup || reading}
              />
            )}
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={savePrompt}
                onChange={(e) => setSavePrompt(e.target.checked)}
                disabled={busy}
              />
              {dt("保存描述到本机以便再次编辑")}
            </label>
            {needsReference && !referenceList.length && (
              <p
                role="alert"
                className="text-sm text-amber-700 dark:text-amber-300"
              >
                {dt("原作品使用过参考图，请重新添加后生成。")}
                {selected?.reference !== "required" && (
                  <button
                    type="button"
                    className="ml-2 underline underline-offset-4"
                    onClick={() => setNeedsReference(false)}
                  >
                    {dt("改为纯文字创作")}
                  </button>
                )}
              </p>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {dt(
                "点击生成会产生费用。实际分组由平台统一令牌路由决定，费用以平台用量记录为准。",
              )}
            </p>
            {kind === "video" && (
              <MediaHelp
                text={dt(
                  isMuse
                    ? "Muse支持4–180秒；长片按段拼接。提交最长等待30分钟，超时不自动重发。"
                    : "实际时长以供应商结果为准。提交最长等待10分钟，超时不自动重发。",
                )}
              />
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={
                busy ||
                !!action ||
                !groupReady ||
                models.isFetching ||
                !referencesValid ||
                reading ||
                !selected ||
                !prompt.trim() ||
                Array.from(prompt).length > promptLimit ||
                (kind === "video" &&
                  !selected?.durations.includes(duration ?? 0)) ||
                models.isError ||
                !mediaParametersValid(selected, parameters) ||
                (needsReference && !referenceList.length) ||
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
      </div>
      {busy && view !== "create" && (
        <p role="status" className="mt-3 rounded-xl border p-3 text-sm">
          {dt("生成正在提交，请勿重复操作。切换视图不会取消任务。")}
        </p>
      )}
      {waiting && view !== "history" && (
        <button
          type="button"
          className="mt-3 text-sm underline underline-offset-4"
          onClick={() => setView("history")}
        >
          {dt("有视频任务正在查询，查看我的作品")}
        </button>
      )}
      {message && view !== "explore" && (
        <p
          role="status"
          className="mt-4 whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm"
        >
          {dt(message)}
        </p>
      )}
      <section
        role={view === "history" ? "tabpanel" : undefined}
        id="studio-panel-history"
        aria-labelledby="studio-tab-history"
        hidden={view === "explore"}
        className="mt-6 space-y-3"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <h2 className="font-medium">{dt("本机作品记录")}</h2>
            <MediaHelp
              text={dt(
                "最多保留50条；描述仅在勾选保存时保存在本机，参考图不保存。",
              )}
            />
          </div>
          <Button
            variant="ghost"
            disabled={history.isFetching || busy}
            onClick={() => void history.refetch()}
          >
            {dt("刷新记录")}
          </Button>
        </div>

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
              <p className="break-all text-xs text-muted-foreground">
                {dt("提交时的目录分组：{{group}}", {
                  group: record.group ?? "生图和视频",
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {new Date(record.createdAt * 1000).toLocaleString()} ·{" "}
                {dt(record.message)}
              </p>
              {record.taskId && (
                <p className="break-all font-mono text-xs">{record.taskId}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || reading || !!action || switchingGroup}
                onClick={() => editRecord(record)}
              >
                <Pencil size={14} />
                {dt("再次编辑")}
              </Button>
              {record.draft?.prompt &&
                !pending(record) &&
                record.status !== "submitting" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!action || busy}
                    onClick={() => {
                      if (
                        window.confirm(dt("删除已保存的描述？成品和参数保留。"))
                      )
                        void operate(record.id, async () => {
                          await mediaStudioApi.forgetPrompt(record.id);
                          await history.refetch();
                        });
                    }}
                  >
                    {dt("删除描述")}
                  </Button>
                )}
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
