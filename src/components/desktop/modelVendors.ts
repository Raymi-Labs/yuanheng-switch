import { dt } from "./desktopI18n";
import type { YuanhengModelVendor } from "@/lib/api/yuanheng";
export type ModelVendorCatalog = Record<string, YuanhengModelVendor>;
export interface ModelVendorGroup {
  id: string;
  label: string;
  icon: string;
  models: string[];
  legacyId?: string;
}

interface ModelVendorDefinition {
  id: string;
  label: string;
  icon: string;
  aliases: string[];
  patterns: RegExp[];
}

const MODEL_VENDOR_DEFINITIONS: ModelVendorDefinition[] = [
  {
    id: "openai",
    label: "OpenAI",
    icon: "openai",
    aliases: ["openai"],
    patterns: [/^(?:gpt|chatgpt)(?:[-_.]|$)/, /^o[134](?:[-_.]|$)/, /codex/],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    icon: "anthropic",
    aliases: ["anthropic", "claude"],
    patterns: [/^claude(?:[-_.]|$)/],
  },
  {
    id: "google",
    label: "Google",
    icon: "gemini",
    aliases: ["google", "gemini"],
    patterns: [/^gemini(?:[-_.]|$)/],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    icon: "deepseek",
    aliases: ["deepseek"],
    patterns: [/^deepseek(?:[-_.]|$)/],
  },
  {
    id: "xai",
    label: "xAI",
    icon: "grok",
    aliases: ["xai", "grok"],
    patterns: [/^grok(?:[-_.]|$)/],
  },
  {
    id: "qwen",
    label: "阿里千问",
    icon: "qwen",
    aliases: ["alibaba", "dashscope", "qwen", "tongyi"],
    patterns: [/^qwen(?:\d|[-_.]|$)/, /^(?:qwq|qvq)(?:[-_.]|$)/],
  },
  {
    id: "zhipu",
    label: "智谱 AI",
    icon: "zhipu",
    aliases: ["zhipu", "bigmodel", "chatglm", "glm"],
    patterns: [/^(?:glm|chatglm)(?:[-_.]|$)/],
  },
  {
    id: "kimi",
    label: "月之暗面",
    icon: "kimi",
    aliases: ["kimi", "moonshot"],
    patterns: [/^(?:kimi|moonshot)(?:[-_.]|$)/, /^k\d+(?:[-_.]|$)/],
  },
  {
    id: "minimax",
    label: "MiniMax",
    icon: "minimax",
    aliases: ["minimax"],
    patterns: [/^minimax(?:[-_.]|$)/],
  },
  {
    id: "doubao",
    label: "字节豆包",
    icon: "doubao",
    aliases: ["bytedance", "doubao", "volcengine"],
    patterns: [/^(?:doubao|seed)(?:[-_.]|$)/],
  },
  {
    id: "meta",
    label: "Meta",
    icon: "meta",
    aliases: ["meta", "llama"],
    patterns: [/^llama(?:[-_.]|$)/],
  },
  {
    id: "mistral",
    label: "Mistral",
    icon: "mistral",
    aliases: ["mistral"],
    patterns: [/^(?:mistral|codestral|pixtral)(?:[-_.]|$)/],
  },
  {
    id: "cohere",
    label: "Cohere",
    icon: "cohere",
    aliases: ["cohere"],
    patterns: [/^(?:command|cohere)(?:[-_.]|$)/],
  },
  {
    id: "baidu",
    label: "百度文心",
    icon: "baidu",
    aliases: ["baidu", "ernie"],
    patterns: [/^ernie(?:[-_.]|$)/],
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    icon: "tencent",
    aliases: ["tencent", "hunyuan"],
    patterns: [/^hunyuan(?:[-_.]|$)/],
  },
  {
    id: "mimo",
    label: "小米 MiMo",
    icon: "xiaomi",
    aliases: ["xiaomi", "mimo"],
    patterns: [/^mimo(?:[-_.]|$)/],
  },
  {
    id: "stepfun",
    label: "阶跃星辰",
    icon: "stepfun",
    aliases: ["stepfun"],
    patterns: [/^step(?:[-_.]|$)/],
  },
  {
    id: "longcat",
    label: "美团 LongCat",
    icon: "longcat",
    aliases: ["longcat", "meituan"],
    patterns: [/^longcat(?:[-_.]|$)/],
  },
];

const VENDOR_BY_ALIAS = new Map(
  MODEL_VENDOR_DEFINITIONS.flatMap((vendor) =>
    vendor.aliases.map((alias) => [alias, vendor] as const),
  ),
);
const VENDOR_ORDER = new Map(
  MODEL_VENDOR_DEFINITIONS.map((vendor, index) => [vendor.id, index]),
);
const MODEL_NAME_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

const MODEL_SERIES_PATTERNS: Record<string, RegExp[]> = {
  openai: [
    /^(?:gpt|chatgpt)(?:[-_.]|$)/,
    /^o\d+(?:[-_.]|$)/,
    /^codex(?:[-_.]|$)/,
  ],
  qwen: [/^qwen(?:\d|[-_.]|$)/, /^qwq(?:[-_.]|$)/, /^qvq(?:[-_.]|$)/],
  kimi: [/^kimi(?:[-_.]|$)/, /^moonshot(?:[-_.]|$)/, /^k\d+(?:[-_.]|$)/],
};

const MODEL_TIER_PATTERNS: Array<[RegExp, number]> = [
  [/(?:^|[-_.])(?:ultra|max|opus)(?:[-_.]|$)/, 0],
  [/(?:^|[-_.])pro(?:[-_.]|$)/, 1],
  [/(?:^|[-_.])(?:sonnet|plus)(?:[-_.]|$)/, 3],
  [/(?:^|[-_.])(?:flash|turbo)(?:[-_.]|$)/, 4],
  [/(?:^|[-_.])(?:mini|haiku|small)(?:[-_.]|$)/, 5],
  [/(?:^|[-_.])(?:nano|lite|micro)(?:[-_.]|$)/, 6],
];

function modelIdentifier(model: string): string {
  const segments = model.trim().toLowerCase().split(/[/:]/).filter(Boolean);
  return segments.at(-1) ?? model.trim().toLowerCase();
}

function modelLifecycleRank(model: string): number {
  if (/(?:^|[-_.])(?:deprecated|legacy|retired|old)(?:[-_.]|$)/.test(model)) {
    return 3;
  }
  if (
    /(?:^|[-_.])(?:experimental|experiment|alpha|canary|nightly|exp)(?:[-_.]|$)/.test(
      model,
    )
  ) {
    return 2;
  }
  if (/(?:^|[-_.])(?:preview|beta|rc)(?:[-_.]|$)/.test(model)) {
    return 1;
  }
  return 0;
}

function modelSeriesRank(vendorId: string, model: string): number {
  const patterns = MODEL_SERIES_PATTERNS[vendorId];
  if (!patterns) return 0;
  const index = patterns.findIndex((pattern) => pattern.test(model));
  return index === -1 ? patterns.length : index;
}

function modelVersionParts(model: string): number[] {
  const withoutDates = model
    .replace(/(?:19|20)\d{2}[-_.]\d{2}[-_.]\d{2}/g, "")
    .replace(/(?:19|20)\d{6}/g, "");
  return [...withoutDates.matchAll(/\d+/g)].map((match) =>
    Number.parseInt(match[0], 10),
  );
}

function compareVersionParts(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? -1;
    const rightPart = right[index] ?? -1;
    if (leftPart !== rightPart) return rightPart - leftPart;
  }
  return 0;
}

function modelSnapshot(model: string): number {
  const compact = [...model.matchAll(/(?:19|20)\d{6}/g)].map((match) =>
    Number.parseInt(match[0], 10),
  );
  const separated = [
    ...model.matchAll(/((?:19|20)\d{2})[-_.](\d{2})[-_.](\d{2})/g),
  ].map((match) => Number.parseInt(`${match[1]}${match[2]}${match[3]}`, 10));
  return Math.max(0, ...compact, ...separated);
}

function modelTierRank(model: string): number {
  for (const [pattern, rank] of MODEL_TIER_PATTERNS) {
    if (pattern.test(model)) return rank;
  }
  return 2;
}

export function compareModelNames(left: string, right: string): number {
  const leftVendor = modelVendorOf(left);
  const rightVendor = modelVendorOf(right);
  const vendorDifference =
    (VENDOR_ORDER.get(leftVendor.id) ?? Number.POSITIVE_INFINITY) -
    (VENDOR_ORDER.get(rightVendor.id) ?? Number.POSITIVE_INFINITY);
  if (vendorDifference !== 0) return vendorDifference;

  const leftModel = modelIdentifier(left);
  const rightModel = modelIdentifier(right);
  const lifecycleDifference =
    modelLifecycleRank(leftModel) - modelLifecycleRank(rightModel);
  if (lifecycleDifference !== 0) return lifecycleDifference;

  if (leftVendor.id === "other") {
    return MODEL_NAME_COLLATOR.compare(leftModel, rightModel);
  }

  const seriesDifference =
    modelSeriesRank(leftVendor.id, leftModel) -
    modelSeriesRank(rightVendor.id, rightModel);
  if (seriesDifference !== 0) return seriesDifference;

  const leftLatest = /(?:^|[-_.])latest(?:[-_.]|$)/.test(leftModel);
  const rightLatest = /(?:^|[-_.])latest(?:[-_.]|$)/.test(rightModel);
  if (leftLatest !== rightLatest) return leftLatest ? -1 : 1;

  const versionDifference = compareVersionParts(
    modelVersionParts(leftModel),
    modelVersionParts(rightModel),
  );
  if (versionDifference !== 0) return versionDifference;

  const tierDifference = modelTierRank(leftModel) - modelTierRank(rightModel);
  if (tierDifference !== 0) return tierDifference;

  const leftSnapshot = modelSnapshot(leftModel);
  const rightSnapshot = modelSnapshot(rightModel);
  if (leftSnapshot !== rightSnapshot) {
    if (leftSnapshot === 0) return -1;
    if (rightSnapshot === 0) return 1;
    return rightSnapshot - leftSnapshot;
  }

  return (
    leftModel.length - rightModel.length ||
    MODEL_NAME_COLLATOR.compare(leftModel, rightModel)
  );
}

export function sortModelNames(
  models: string[],
  priorityModels: Array<string | null | undefined> = [],
): string[] {
  const priority = new Map<string, number>();
  for (const model of priorityModels) {
    if (model && !priority.has(model)) priority.set(model, priority.size);
  }

  return [...models].sort((left, right) => {
    const leftPriority = priority.get(left);
    const rightPriority = priority.get(right);
    if (leftPriority !== undefined || rightPriority !== undefined) {
      if (leftPriority === undefined) return 1;
      if (rightPriority === undefined) return -1;
      return leftPriority - rightPriority;
    }
    return compareModelNames(left, right);
  });
}

export function modelVendorOf(
  model: string,
  catalog?: ModelVendorCatalog,
): Omit<ModelVendorGroup, "models"> {
  const cloud = catalog?.[model];
  if (cloud?.id && cloud.name.trim()) {
    // Cloud names are content, not translation keys or remote icon URLs.
    return { id: `cloud:${cloud.id}`, label: cloud.name, icon: "models" };
  }
  const normalized = model.trim().toLowerCase();
  const segments = normalized.split(/[/:]/).filter(Boolean);
  const modelName = segments.at(-1) ?? normalized;

  for (const segment of segments) {
    const vendor = VENDOR_BY_ALIAS.get(segment);
    if (vendor) {
      return { id: vendor.id, label: dt(vendor.label), icon: vendor.icon };
    }
  }

  for (const vendor of MODEL_VENDOR_DEFINITIONS) {
    if (vendor.patterns.some((pattern) => pattern.test(modelName))) {
      return { id: vendor.id, label: dt(vendor.label), icon: vendor.icon };
    }
  }

  return { id: "other", label: dt("其他模型"), icon: "models" };
}

export function groupModelsByVendor(
  models: string[],
  catalog?: ModelVendorCatalog,
): ModelVendorGroup[] {
  const grouped = new Map<string, ModelVendorGroup>();
  for (const model of models) {
    const vendor = modelVendorOf(model, catalog);
    const group = grouped.get(vendor.id);
    if (group) {
      group.models.push(model);
    } else {
      grouped.set(vendor.id, { ...vendor, models: [model] });
    }
  }

  return [...grouped.values()]
    .map((group) => {
      const legacy = modelVendorOf(group.models[0]);
      const legacyId =
        group.id.startsWith("cloud:") &&
        legacy.id !== "other" &&
        group.models.every((model) => modelVendorOf(model).id === legacy.id)
          ? legacy.id
          : undefined;
      return {
        ...group,
        ...(legacyId ? { legacyId, icon: legacy.icon } : {}),
        models: sortModelNames(group.models),
      };
    })
    .sort(
      (left, right) =>
        (VENDOR_ORDER.get(left.legacyId ?? left.id) ??
          Number.POSITIVE_INFINITY) -
          (VENDOR_ORDER.get(right.legacyId ?? right.id) ??
            Number.POSITIVE_INFINITY) ||
        left.label.localeCompare(right.label) ||
        left.id.localeCompare(right.id),
    );
}

/** Resolve old name-based favorites without writing preferences during refresh. */
export function resolveVendorFavorites(
  ids: string[],
  vendors: ModelVendorGroup[],
): string[] {
  return [
    ...new Set(
      ids.flatMap((id) => {
        // A partial directory may still contain the old fallback group. Keep
        // its favorite separate until that group can be fully migrated.
        if (vendors.some((vendor) => vendor.id === id)) return [id];
        const matches = vendors.filter((vendor) => vendor.legacyId === id);
        return matches.length ? matches.map((vendor) => vendor.id) : [id];
      }),
    ),
  ];
}
