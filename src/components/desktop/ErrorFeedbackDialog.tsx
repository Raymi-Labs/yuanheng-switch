import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { CheckCircle2, Copy, Loader2, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyText } from "@/lib/clipboard";
import {
  desktopFeedbackApi,
  type DesktopFeedbackRequest,
} from "@/lib/api/desktopFeedback";
import {
  getFeedbackErrors,
  sanitizeFeedbackText,
  type FeedbackError,
} from "@/lib/errorFeedback";
import {
  FEEDBACK_OPEN_EVENT,
  getFeedbackContext,
  subscribeFeedbackContext,
} from "@/lib/feedbackContext";
import { isLinux, isMac, isWindows } from "@/lib/platform";

export function ErrorFeedbackDialog() {
  const { t } = useTranslation();
  const context = useSyncExternalStore(
    subscribeFeedbackContext,
    getFeedbackContext,
  );
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<readonly FeedbackError[]>([]);
  const [includeErrors, setIncludeErrors] = useState(true);
  const [capturedContext, setCapturedContext] = useState({
    view: "startup",
    tool: "unknown",
  });
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [copied, setCopied] = useState(false);
  const [receipt, setReceipt] = useState<number | null>(null);
  const requestRef = useRef<{
    fingerprint: string;
    request: DesktopFeedbackRequest;
  }>();
  const pending = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setOpen(false);
    setDescription("");
    setErrors([]);
    setFailure("");
    setReceipt(null);
    setBusy(false);
    pending.current = false;
    requestRef.current = undefined;
  }, [context.scope]);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      if (pending.current) return;
      const errorId = (event as CustomEvent<string | undefined>).detail;
      const available = getFeedbackErrors();
      const selected = available.find((entry) => entry.id === errorId);
      setErrors(selected ? [selected] : available);
      const current = getFeedbackContext();
      setCapturedContext({ view: current.view, tool: current.tool });
      setReceipt(null);
      setFailure("");
      setCopied(false);
      setOpen(true);
    };
    window.addEventListener(FEEDBACK_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(FEEDBACK_OPEN_EVENT, handleOpen);
  }, []);

  useEffect(() => {
    if (open && !version) {
      void getVersion()
        .then(setVersion)
        .catch(() => undefined);
    }
  }, [open, version]);

  const body = {
    description: sanitizeFeedbackText(description.trim(), 4000),
    context: capturedContext,
    errors: includeErrors
      ? errors.map(({ occurredAt, source, message }) => ({
          occurredAt,
          source,
          message,
        }))
      : [],
  };
  const preview = JSON.stringify(
    {
      ...body,
      appVersion: version ?? t("feedback.versionAutomatic"),
      platform: isWindows()
        ? "windows"
        : isMac()
          ? "macos"
          : isLinux()
            ? "linux"
            : "unknown",
    },
    null,
    2,
  );
  const valid =
    Boolean(description.trim()) && Array.from(description).length <= 4000;

  const submit = async () => {
    if (!valid || !context.userId || pending.current || receipt !== null)
      return;
    const owner = context.userId;
    const currentGeneration = generation.current;
    const fingerprint = JSON.stringify(body);
    if (requestRef.current?.fingerprint !== fingerprint) {
      requestRef.current = {
        fingerprint,
        request: { ...body, reportId: crypto.randomUUID() },
      };
    }
    pending.current = true;
    setBusy(true);
    setFailure("");
    try {
      const result = await desktopFeedbackApi.submit(
        requestRef.current.request,
        owner,
      );
      if (generation.current !== currentGeneration) return;
      setReceipt(result.id);
      setDescription("");
      requestRef.current = undefined;
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      const detail = sanitizeFeedbackText(
        error instanceof Error ? error.message : String(error),
        500,
      );
      setFailure(`${t("feedback.failed")} ${detail}`);
    } finally {
      if (generation.current === currentGeneration) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  const copy = async () => {
    const currentGeneration = generation.current;
    setCopied(false);
    try {
      await copyText(preview);
      if (generation.current === currentGeneration) setCopied(true);
    } catch {
      if (generation.current === currentGeneration)
        setFailure(t("feedback.copyFailed"));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!pending.current) setOpen(value);
      }}
    >
      <DialogContent className="max-w-2xl overflow-y-auto" zIndex="top">
        <DialogHeader>
          <DialogTitle>{t("feedback.title")}</DialogTitle>
          <DialogDescription>{t("feedback.introduction")}</DialogDescription>
        </DialogHeader>
        {receipt !== null ? (
          <div className="space-y-4 p-6" role="status">
            <CheckCircle2 className="h-8 w-8 text-emerald-600" />
            <p className="font-medium">
              {t("feedback.received", { id: receipt })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("feedback.receivedHint")}
            </p>
            <Button onClick={() => setOpen(false)}>
              {t("feedback.close")}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 p-6 pt-4">
            <div className="space-y-2">
              <label
                htmlFor="feedback-description"
                className="text-sm font-medium"
              >
                {t("feedback.description")}
              </label>
              <Textarea
                id="feedback-description"
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setCopied(false);
                }}
                disabled={busy}
                maxLength={4000}
                rows={4}
                placeholder={t("feedback.placeholder")}
              />
              <p className="text-xs text-muted-foreground">
                {t("feedback.privacy")}
              </p>
            </div>
            {errors.length > 0 ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={includeErrors}
                  onChange={(event) => {
                    setIncludeErrors(event.target.checked);
                    setCopied(false);
                  }}
                  disabled={busy}
                />
                {t("feedback.includeErrors", { count: errors.length })}
              </label>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("feedback.noErrors")}
              </p>
            )}
            <details className="rounded-lg border p-3" open>
              <summary className="cursor-pointer text-sm font-medium">
                {t("feedback.preview")}
              </summary>
              <pre
                className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs leading-5"
                data-testid="feedback-preview"
              >
                {preview}
              </pre>
            </details>
            {!context.userId && (
              <p role="status" className="text-sm text-amber-600">
                {t("feedback.loginRequired")}
              </p>
            )}
            {failure && (
              <p role="alert" className="break-words text-sm text-destructive">
                {failure}
              </p>
            )}
            {copied && (
              <p role="status" className="text-sm text-emerald-600">
                {t("feedback.copied")}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                {t("feedback.close")}
              </Button>
              <Button
                variant="outline"
                onClick={() => void copy()}
                disabled={busy}
              >
                <Copy className="h-4 w-4" />
                {t("feedback.copy")}
              </Button>
              <Button
                onClick={() => void submit()}
                disabled={!valid || !context.userId || busy}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {t(busy ? "feedback.submitting" : "feedback.submit")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
