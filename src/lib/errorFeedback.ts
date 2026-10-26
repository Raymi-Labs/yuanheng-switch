export interface FeedbackError {
  readonly id: string;
  readonly occurredAt: string;
  readonly source: string;
  readonly message: string;
}

const MAX_ERRORS = 10;
const MAX_INPUT_LENGTH = 16_000;
const MAX_MESSAGE_LENGTH = 2_000;
const REDACTED = "[REDACTED]";
const SECRET_NAMES =
  "api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|session[_-]?id|authorization|credential|password|passwd|bearer|cookie|secret|token|auth|pwd|key";
const SECRET_KEY = new RegExp(`^(?:${SECRET_NAMES})s?$`, "i");
const SECRET_CONTAINER = new RegExp(
  `((?:\\\\?["'])?\\b(?:${SECRET_NAMES})s?(?:\\\\?["'])?\\s*[:=]\\s*)(?!\\[REDACTED\\])[\\[{][\\s\\S]*`,
  "gi",
);
const NAMED_SECRET = new RegExp(
  `((?:\\\\?["'])?\\b(?:${SECRET_NAMES})s?(?:\\\\?["'])?\\s*[:=]\\s*)(?:\\[REDACTED\\]|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}\\]]+)`,
  "gi",
);

// Only the sanitized snapshot is retained. Nothing here reads files, writes
// storage or sends telemetry; the caller owns the explicit preview/send flow.
let errors: readonly FeedbackError[] = Object.freeze([]);
let scopeFingerprint: string | undefined;
let sequence = 0;
const listeners = new Set<() => void>();

function fingerprintScope(scope: string): string {
  // Keep no account address/identifier in this store. Two independent 64-bit
  // accumulators are only an in-memory change detector, not an auth mechanism.
  let first = 0xcbf29ce484222325n;
  let second = 0x84222325cbf29ce4n;
  for (let index = 0; index < scope.length; index += 1) {
    const code = BigInt(scope.charCodeAt(index));
    first = BigInt.asUintN(64, (first ^ code) * 0x100000001b3n);
    second = BigInt.asUintN(64, (second ^ code) * 0x100000001b7n);
  }
  return `${first.toString(16)}:${second.toString(16)}`;
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A feedback observer must not create another unhandled exception.
    }
  }
}

export function setFeedbackScope(scope: string): void {
  const next = fingerprintScope(scope);
  if (scopeFingerprint === next) return;
  scopeFingerprint = next;
  clearFeedbackErrors();
}

export function clearFeedbackErrors(): void {
  if (errors.length === 0) return;
  errors = Object.freeze([]);
  notify();
}

export function subscribeFeedbackErrors(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFeedbackErrors(): readonly FeedbackError[] {
  return errors;
}

function redactStructured(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[nested data omitted]";
  if (typeof value === "string") return sanitizePlainText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => redactStructured(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .map(([key, item]) => [
          sanitizePlainText(key),
          SECRET_KEY.test(key.replace(/\s/g, ""))
            ? REDACTED
            : /^(?:stack|cause)$/i.test(key)
              ? "[omitted]"
              : redactStructured(item, depth + 1),
        ]),
    );
  }
  return value;
}

function sanitizePlainText(input: string): string {
  return (
    input
      .replace(
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gi,
        REDACTED,
      )
      .replace(/\b(?:https?|wss?|file|tauri):\/\/[^\s<>"']+/gi, (raw) => {
        try {
          const url = new URL(raw);
          if (url.protocol === "file:") return "file://[LOCAL_PATH]";
          return `${url.protocol}//${url.host}${url.pathname}${url.search ? "?[REDACTED]" : ""}${url.hash ? "#[REDACTED]" : ""}`;
        } catch {
          return "[URL REDACTED]";
        }
      })
      .replace(
        /(^|[\r\n])([ \t]*(?:(?:proxy-)?authorization|cookie|set-cookie|x-api-key|api-key)\s*[:=]\s*)[^\r\n]+/gim,
        "$1$2[REDACTED]",
      )
      .replace(
        /\b(Bearer|Basic|Token|ApiKey|Digest|Negotiate|AWS4-HMAC-SHA256)\s+[^\s"',}\]]+/gi,
        "$1 [REDACTED]",
      )
      .replace(
        /(?:sk-[A-Za-z0-9._~+\/-]{6,}|AIza[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{6,}|gh[pousr]_[A-Za-z0-9_]{6,}|xox[baprs]-[A-Za-z0-9-]{6,}|ya29\.[A-Za-z0-9._-]{6,}|(?:AKIA|ASIA)[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
        REDACTED,
      )
      // Malformed or prefixed JSON cannot safely be parsed. If a secret contains
      // nested data, omit the remaining payload instead of guessing its boundary.
      .replace(SECRET_CONTAINER, "$1[REDACTED]")
      .replace(NAMED_SECRET, "$1[REDACTED]")
      .replace(/([?&][A-Za-z0-9_.~-]+)=([^&#\s"'<>]*)/g, "$1=[REDACTED]")
      .replace(
        /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b/gi,
        "[EMAIL]",
      )
      .replace(
        /(?:\/(?:Users|home)\/|[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)[^\r\n"'<>|,;]+/gi,
        "[LOCAL_PATH]",
      )
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
  );
}

/** Best-effort redaction; callers must show the exact payload before sending. */
export function sanitizeFeedbackText(
  input: string,
  maxLength = MAX_MESSAGE_LENGTH,
): string {
  const limit = Number.isFinite(maxLength)
    ? Math.max(0, Math.min(Math.floor(maxLength), MAX_INPUT_LENGTH))
    : MAX_MESSAGE_LENGTH;
  const trimmed = input.trim();
  let safe: string;
  if (input.length > MAX_INPUT_LENGTH) {
    // Never truncate raw credentials mid-value before redaction.
    safe = "[oversized text omitted]";
  } else if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      safe = sanitizePlainText(
        JSON.stringify(redactStructured(JSON.parse(trimmed))),
      );
    } catch {
      safe = sanitizePlainText(input);
    }
  } else {
    safe = sanitizePlainText(input);
  }
  return Array.from(safe).slice(0, limit).join("");
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value === null || typeof value !== "object") return String(value);
  // Unknown rejection objects can contain arbitrary request bodies or getters.
  // Keep only an own textual message, never serialize the object or its stack.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "message");
    if (typeof descriptor?.value === "string") return descriptor.value;
  } catch {
    // Proxies can throw during property inspection.
  }
  return "[non-text error omitted]";
}

export function recordFeedbackError(
  source: string,
  message: unknown,
): FeedbackError {
  const occurredAt = new Date().toISOString();
  const entry: FeedbackError = Object.freeze({
    id: `error-${Date.now().toString(36)}-${(++sequence).toString(36)}`,
    occurredAt,
    source: /^[a-zA-Z0-9._-]+$/.test(source) ? source.slice(0, 64) : "unknown",
    message:
      sanitizeFeedbackText(errorMessage(message)).trim() || "[empty error]",
  });
  errors = Object.freeze([entry, ...errors].slice(0, MAX_ERRORS));
  notify();
  return entry;
}
