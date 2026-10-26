import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  BookmarkPlus,
  CheckCircle2,
  Clock3,
  Download,
  FileAudio,
  Loader2,
  Mic,
  Square,
  Trash2,
  Upload,
  WandSparkles,
  Waves,
} from "lucide-react";
import { toast } from "@/lib/toast";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { voiceCloneApi } from "@/lib/api";
import { useYuanhengConnection } from "@/lib/query/yuanheng";
import { extractErrorMessage } from "@/utils/errorUtils";
import {
  VOICE_CLONE_MAX_FILE_BYTES,
  VOICE_CLONE_MAX_RECORDING_SECONDS,
  base64ToAudioBlob,
  blobToBase64,
  encodePcm16Wav,
  formatAudioBytes,
  normalizeVoiceCloneMimeType,
  validateVoiceCloneFile,
} from "@/utils/voiceCloneAudio";
import { cn } from "@/lib/utils";
import { PageHeader } from "./PageHeader";

const MODEL = "mimo-v2.5-tts-voiceclone";

interface ReferenceAudio {
  blob: Blob;
  name: string;
  mimeType: "audio/wav" | "audio/mpeg";
}

interface ActiveRecording {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  chunks: Float32Array[];
  startedAt: number;
}

interface GeneratedVoiceSegment {
  url: string;
  text: string;
  finalTextPreview: string | null;
}

interface VoiceCloneHistoryItem {
  id: string;
  createdAt: number;
  label: string;
  segments: GeneratedVoiceSegment[];
}

interface VoiceProfile {
  id: string;
  name: string;
  reference: ReferenceAudio;
}

function modelMatchesVoiceClone(model: string): boolean {
  return model.toLowerCase().replace(/^xiaomi\//, "") === MODEL;
}

export function VoiceClonePage() {
  const { t } = useTranslation();
  const { data: connection } = useYuanhengConnection();
  const inputRef = useRef<HTMLInputElement>(null);
  const recordingRef = useRef<ActiveRecording | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const generatedUrlsRef = useRef(new Set<string>());
  const [reference, setReference] = useState<ReferenceAudio | null>(null);
  const [referenceUrl, setReferenceUrl] = useState<string | null>(null);
  const [activeResult, setActiveResult] =
    useState<VoiceCloneHistoryItem | null>(null);
  const [history, setHistory] = useState<VoiceCloneHistoryItem[]>([]);
  const [voiceProfiles, setVoiceProfiles] = useState<VoiceProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [text, setText] = useState("");
  const [instruction, setInstruction] = useState(
    t("desktop.voiceClone.defaultInstruction"),
  );
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);

  const modelAvailable = Boolean(
    connection?.models.some(modelMatchesVoiceClone),
  );

  useEffect(() => {
    if (!reference) {
      setReferenceUrl(null);
      return;
    }
    const url = URL.createObjectURL(reference.blob);
    setReferenceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [reference]);

  useEffect(
    () => () => {
      for (const url of generatedUrlsRef.current) URL.revokeObjectURL(url);
      if (recordingTimerRef.current !== null) {
        window.clearInterval(recordingTimerRef.current);
      }
      const active = recordingRef.current;
      if (active) {
        active.stream.getTracks().forEach((track) => track.stop());
        active.source.disconnect();
        active.processor.disconnect();
        active.silentGain.disconnect();
        void active.context.close();
      }
    },
    [],
  );

  const clearOutput = () => {
    setActiveResult(null);
  };

  const saveVoiceProfile = () => {
    if (!reference) {
      toast.error(t("desktop.voiceClone.referenceRequired"));
      return;
    }
    const name = profileName.trim() || reference.name;
    setVoiceProfiles((current) =>
      [
        { id: crypto.randomUUID(), name, reference },
        ...current.filter((profile) => profile.name !== name),
      ].slice(0, 8),
    );
    setProfileName("");
    toast.success(t("desktop.voiceClone.profileSaved"));
  };

  const removeHistoryItem = (id: string) => {
    setHistory((current) => {
      const removed = current.find((item) => item.id === id);
      removed?.segments.forEach((segment) => {
        URL.revokeObjectURL(segment.url);
        generatedUrlsRef.current.delete(segment.url);
      });
      const next = current.filter((item) => item.id !== id);
      setActiveResult((active) =>
        active?.id === id ? (next[0] ?? null) : active,
      );
      return next;
    });
  };

  const applyReference = (blob: Blob, name: string, providedType: string) => {
    const mimeType = normalizeVoiceCloneMimeType(providedType, name);
    const validationError = validateVoiceCloneFile({
      name,
      type: providedType,
      size: blob.size,
    });
    if (validationError || !mimeType) {
      toast.error(
        t(`desktop.voiceClone.${validationError ?? "referenceUnsupported"}`),
      );
      return;
    }
    setReference({ blob, name, mimeType });
    clearOutput();
  };

  const handleFile = (file?: File) => {
    if (!file) return;
    applyReference(file, file.name, file.type);
  };

  const stopRecording = async (keepRecording: boolean) => {
    const active = recordingRef.current;
    if (!active) return;
    recordingRef.current = null;
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    active.stream.getTracks().forEach((track) => track.stop());
    active.source.disconnect();
    active.processor.disconnect();
    active.silentGain.disconnect();
    await active.context.close().catch(() => undefined);
    setIsRecording(false);

    if (!keepRecording || active.chunks.length === 0) return;
    const sampleRate = active.context.sampleRate;
    const blob = encodePcm16Wav(active.chunks, sampleRate);
    if (blob.size > VOICE_CLONE_MAX_FILE_BYTES) {
      toast.error(t("desktop.voiceClone.referenceTooLarge"));
      return;
    }
    const duration = Math.max(
      1,
      Math.round((Date.now() - active.startedAt) / 1000),
    );
    applyReference(blob, `voice-reference-${duration}s.wav`, "audio/wav");
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error(t("desktop.voiceClone.recordingUnsupported"));
      return;
    }
    try {
      clearOutput();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
      recordingRef.current = {
        context,
        stream,
        source,
        processor,
        silentGain,
        chunks,
        startedAt: Date.now(),
      };
      setRecordingSeconds(0);
      setIsRecording(true);
      recordingTimerRef.current = window.setInterval(() => {
        const active = recordingRef.current;
        if (!active) return;
        const seconds = Math.floor((Date.now() - active.startedAt) / 1000);
        setRecordingSeconds(seconds);
        if (seconds >= VOICE_CLONE_MAX_RECORDING_SECONDS) {
          void stopRecording(true);
        }
      }, 250);
    } catch (error) {
      toast.error(t("desktop.voiceClone.recordingFailed"), {
        description: extractErrorMessage(error),
      });
    }
  };

  const handleGenerate = async () => {
    if (!reference) {
      toast.error(t("desktop.voiceClone.referenceRequired"));
      return;
    }
    if (!text.trim()) {
      toast.error(t("desktop.voiceClone.textRequired"));
      return;
    }
    if (!consentConfirmed) {
      toast.error(t("desktop.voiceClone.consentRequired"));
      return;
    }

    setIsGenerating(true);
    clearOutput();
    try {
      const result = await voiceCloneApi.generate({
        referenceAudioBase64: await blobToBase64(reference.blob),
        mimeType: reference.mimeType,
        text: text.trim(),
        instruction: instruction.trim(),
        consentConfirmed,
      });
      const sourceSegments = result.segments?.length
        ? result.segments
        : [
            {
              audioBase64: result.audioBase64,
              mimeType: result.mimeType,
              text: text.trim(),
              finalTextPreview: result.finalTextPreview,
            },
          ];
      const segments = sourceSegments.map((segment) => {
        const blob = base64ToAudioBlob(segment.audioBase64, segment.mimeType);
        const url = URL.createObjectURL(blob);
        generatedUrlsRef.current.add(url);
        return {
          url,
          text: segment.text,
          finalTextPreview: segment.finalTextPreview,
        };
      });
      const item: VoiceCloneHistoryItem = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        label: text.trim().slice(0, 36),
        segments,
      };
      setHistory((current) => {
        const next = [item, ...current];
        for (const expired of next.slice(8)) {
          expired.segments.forEach((segment) => {
            URL.revokeObjectURL(segment.url);
            generatedUrlsRef.current.delete(segment.url);
          });
        }
        return next.slice(0, 8);
      });
      setActiveResult(item);
      toast.success(t("desktop.voiceClone.generateSuccess"));
    } catch (error) {
      toast.error(t("desktop.voiceClone.generateFailed"), {
        description: extractErrorMessage(error),
      });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-[1120px] flex-col overflow-hidden px-7 pt-6">
      <PageHeader
        eyebrow="MiMo Audio"
        title={t("desktop.voiceClone.title")}
        description={t("desktop.voiceClone.description")}
      />

      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
        <section className="flex flex-wrap items-center gap-3 border-y bg-muted/20 px-4 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Waves className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold">{MODEL}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {modelAvailable
                ? t("desktop.voiceClone.modelReady")
                : t("desktop.voiceClone.modelNotListed")}
            </p>
          </div>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium",
              modelAvailable
                ? "bg-emerald-500/10 text-emerald-600"
                : "bg-amber-500/10 text-amber-600",
            )}
          >
            {modelAvailable ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5" />
            )}
            {modelAvailable
              ? t("desktop.voiceClone.available")
              : t("desktop.voiceClone.tryDirectly")}
          </span>
        </section>

        <div className="grid gap-5 py-5 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-5">
            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">
                    {t("desktop.voiceClone.referenceTitle")}
                  </h2>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {t("desktop.voiceClone.referenceHint")}
                  </p>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  WAV / MP3
                </span>
              </div>

              <input
                ref={inputRef}
                type="file"
                accept=".wav,.mp3,audio/wav,audio/mpeg"
                className="hidden"
                onChange={(event) => handleFile(event.target.files?.[0])}
              />
              <div
                className={cn(
                  "rounded-xl border border-dashed p-4 transition-colors",
                  isDragging
                    ? "border-primary bg-primary/[0.05]"
                    : "border-border bg-card/60",
                )}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  handleFile(event.dataTransfer.files?.[0]);
                }}
              >
                {reference ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <FileAudio className="h-5 w-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold">
                          {reference.name}
                        </p>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {formatAudioBytes(reference.blob.size)} ·{" "}
                          {reference.mimeType}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("desktop.voiceClone.removeReference")}
                        onClick={() => {
                          setReference(null);
                          clearOutput();
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    {referenceUrl && (
                      <audio
                        className="h-9 w-full"
                        controls
                        src={referenceUrl}
                      />
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center py-4 text-center">
                    <Upload className="h-6 w-6 text-muted-foreground" />
                    <p className="mt-2 text-xs font-medium">
                      {t("desktop.voiceClone.dropReference")}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {t("desktop.voiceClone.referenceLimit")}
                    </p>
                  </div>
                )}

                <div className="mt-4 flex flex-wrap justify-center gap-2 border-t pt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isRecording}
                    onClick={() => inputRef.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {t("desktop.voiceClone.chooseFile")}
                  </Button>
                  {isRecording ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void stopRecording(true)}
                    >
                      <Square className="h-3.5 w-3.5" />
                      {t("desktop.voiceClone.stopRecording", {
                        seconds: recordingSeconds,
                      })}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void startRecording()}
                    >
                      <Mic className="h-3.5 w-3.5" />
                      {t("desktop.voiceClone.startRecording")}
                    </Button>
                  )}
                </div>
              </div>
            </section>

            <section className="space-y-2 rounded-xl border bg-muted/15 p-3">
              <div className="flex items-center gap-2">
                <BookmarkPlus className="h-4 w-4 text-primary" />
                <Label htmlFor="voice-profile-name">
                  {t("desktop.voiceClone.profileTitle")}
                </Label>
              </div>
              <div className="flex gap-2">
                <Input
                  id="voice-profile-name"
                  value={profileName}
                  maxLength={40}
                  placeholder={t("desktop.voiceClone.profilePlaceholder")}
                  onChange={(event) => setProfileName(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!reference}
                  onClick={saveVoiceProfile}
                >
                  {t("desktop.voiceClone.saveProfile")}
                </Button>
              </div>
              {voiceProfiles.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {voiceProfiles.map((profile) => (
                    <Button
                      key={profile.id}
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-7 text-[10px]"
                      onClick={() => {
                        setReference(profile.reference);
                        clearOutput();
                      }}
                    >
                      {profile.name}
                    </Button>
                  ))}
                </div>
              )}
              <p className="text-[9px] leading-4 text-muted-foreground">
                {t("desktop.voiceClone.profileSessionHint")}
              </p>
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="voice-clone-text">
                  {t("desktop.voiceClone.textTitle")}
                </Label>
                <span className="text-[10px] text-muted-foreground">
                  {text.length} / 20000
                </span>
              </div>
              <Textarea
                id="voice-clone-text"
                value={text}
                maxLength={20000}
                className="min-h-[138px] resize-y"
                placeholder={t("desktop.voiceClone.textPlaceholder")}
                onChange={(event) => {
                  setText(event.target.value);
                  clearOutput();
                }}
              />
              {text.length > 4500 && (
                <p className="text-[10px] text-amber-600">
                  {t("desktop.voiceClone.segmentHint")}
                </p>
              )}
            </section>

            <section className="space-y-2">
              <Label htmlFor="voice-clone-instruction">
                {t("desktop.voiceClone.instructionTitle")}
              </Label>
              <Textarea
                id="voice-clone-instruction"
                value={instruction}
                maxLength={500}
                className="min-h-[76px] resize-y"
                onChange={(event) => {
                  setInstruction(event.target.value);
                  clearOutput();
                }}
              />
            </section>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-muted/20 p-3 text-[11px] leading-5">
              <Checkbox
                checked={consentConfirmed}
                className="mt-0.5"
                onCheckedChange={(checked) =>
                  setConsentConfirmed(checked === true)
                }
              />
              <span>{t("desktop.voiceClone.consentLabel")}</span>
            </label>

            <Button
              className="w-full"
              disabled={isGenerating || isRecording}
              onClick={() => void handleGenerate()}
            >
              {isGenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <WandSparkles className="h-4 w-4" />
              )}
              {isGenerating
                ? t("desktop.voiceClone.generating")
                : t("desktop.voiceClone.generate")}
            </Button>
          </div>

          <section className="min-h-[360px] rounded-xl border bg-card/60 p-5">
            <div className="flex items-center gap-2">
              <Waves className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">
                {t("desktop.voiceClone.resultTitle")}
              </h2>
            </div>

            {activeResult ? (
              <div className="mt-5 space-y-4">
                {activeResult.segments.map((segment, index) => (
                  <div
                    key={`${activeResult.id}:${index}`}
                    className="space-y-2 rounded-xl bg-primary/[0.05] p-4"
                  >
                    <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span>
                        {t("desktop.voiceClone.segmentTitle", {
                          current: index + 1,
                          total: activeResult.segments.length,
                        })}
                      </span>
                      <a
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                        href={segment.url}
                        download={`yuanheng-voice-clone-${activeResult.createdAt}-${index + 1}.wav`}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {t("desktop.voiceClone.download")}
                      </a>
                    </div>
                    <audio
                      className="w-full"
                      controls
                      autoPlay={index === 0}
                      src={segment.url}
                    />
                    <p className="line-clamp-3 text-[10px] leading-4 text-muted-foreground">
                      {segment.finalTextPreview || segment.text}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Waves className="h-6 w-6" />
                </span>
                <p className="mt-4 text-xs font-semibold">
                  {t("desktop.voiceClone.emptyResult")}
                </p>
                <p className="mt-1 max-w-[260px] text-[10px] leading-5 text-muted-foreground">
                  {t("desktop.voiceClone.emptyResultHint")}
                </p>
              </div>
            )}

            {history.length > 0 && (
              <div className="mt-5 border-t pt-4">
                <div className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-xs font-semibold">
                    {t("desktop.voiceClone.historyTitle")}
                  </h3>
                </div>
                <div className="mt-2 space-y-2">
                  {history.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center gap-2 rounded-lg border bg-muted/15 px-3 py-2"
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setActiveResult(item)}
                      >
                        <p className="truncate text-[10px] font-medium">
                          {item.label}
                        </p>
                        <p className="text-[9px] text-muted-foreground">
                          {new Date(item.createdAt).toLocaleTimeString()} ·{" "}
                          {t("desktop.voiceClone.segmentCount", {
                            count: item.segments.length,
                          })}
                        </p>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("desktop.voiceClone.deleteHistory")}
                        onClick={() => removeHistoryItem(item.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
