export function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function fmtInt(
  value: unknown,
  locale?: string,
  fallback: string = "--",
): string {
  const num = parseFiniteNumber(value);
  if (num == null) return fallback;
  return new Intl.NumberFormat(locale).format(Math.trunc(num));
}

export function fmtUsd(
  value: unknown,
  digits: number,
  fallback: string = "--",
): string {
  const num = parseFiniteNumber(value);
  if (num == null) return fallback;
  return `$${num.toFixed(digits)}`;
}

/** Preserve the native decimal string; never round a settlement into a charge. */
export function fmtSettlementAmount(
  amount: string | null | undefined,
  symbol: string | null | undefined,
  locale: string,
): string | null {
  if (
    amount == null ||
    symbol == null ||
    amount.length > 96 ||
    !/^-?\d+(?:\.\d+)?$/.test(amount)
  )
    return null;
  const [whole, fraction = ""] = amount.split(".");
  const integer = BigInt(whole);
  const negativeFraction = whole.startsWith("-") && /[1-9]/.test(fraction);
  const grouped = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(integer === BigInt(0) && negativeFraction ? -0 : integer);
  const decimal = fraction.replace(/0+$/, "").padEnd(symbol ? 2 : 0, "0");
  const separator = new Intl.NumberFormat(locale)
    .formatToParts(1.1)
    .find((part) => part.type === "decimal")!.value;
  return `${symbol}${grouped}${decimal ? separator + decimal : ""}`;
}

function normalizeLanguageTag(language: string): string {
  return language.toLowerCase().replace(/_/g, "-");
}

function isTraditionalChineseLanguage(normalizedLanguage: string): boolean {
  return (
    normalizedLanguage === "zh-tw" ||
    normalizedLanguage.startsWith("zh-hant") ||
    normalizedLanguage.startsWith("zh-hk") ||
    normalizedLanguage.startsWith("zh-mo")
  );
}

export function getLocaleFromLanguage(language: string): string {
  if (!language) return "en-US";
  const normalized = normalizeLanguageTag(language);
  if (normalized === "zh") return "zh-CN";
  if (isTraditionalChineseLanguage(normalized)) {
    return "zh-TW";
  }
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("ja")) return "ja-JP";
  return "en-US";
}

interface I18nLike {
  resolvedLanguage?: string;
  language?: string;
}

export function getResolvedLang(i18n: I18nLike): string {
  return i18n.resolvedLanguage || i18n.language || "en";
}

/**
 * Token 数量的紧凑显示。
 *
 * Why: 中日文用户期待 "亿/万" 量纲；英文用户期待 K/M/B。共用同一份格式化
 * 逻辑避免 Hero 卡和分应用卡显示不一致。`compactDecimals=2` 用于 Hero
 * 大数副标（更精确），默认 1 位用于卡片副字段。
 */
export function formatTokensShort(
  value: number,
  lang: string,
  compactDecimals: 1 | 2 = 1,
): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const decimals = compactDecimals;
  const normalizedLang = normalizeLanguageTag(lang);
  if (isTraditionalChineseLanguage(normalizedLang)) {
    if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 億`;
    if (value >= 1e4) return `${(value / 1e4).toFixed(decimals)} 萬`;
    return value.toLocaleString("zh-TW");
  }
  if (normalizedLang.startsWith("zh") || normalizedLang.startsWith("ja")) {
    if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
    if (value >= 1e4) return `${(value / 1e4).toFixed(decimals)} 万`;
    return value.toLocaleString();
  }
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(decimals)}K`;
  return value.toLocaleString();
}

/** Only format amounts supplied by the platform quote API, never legacy USD. */
export function fmtCredits(
  value: unknown,
  digits: number,
  symbol = "⚡️",
): string {
  const num = parseFiniteNumber(value);
  return num == null ? "—" : `≈ ${symbol}${num.toFixed(digits)}`;
}
