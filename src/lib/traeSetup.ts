import {
  type YuanhengConnectionStatus,
  yuanhengTerminalModels,
} from "@/lib/api/yuanheng";

export const TRAE_DOWNLOAD_URL = "https://www.trae.ai/download";
export const TRAE_MODELS_DOC_URL = "https://docs.trae.ai/ide/models";

export const TRAE_EDITIONS = {
  china: {
    label: "国内版",
    tool: "trae-cn",
    downloadUrl: "https://www.trae.cn/download",
    docsUrl: "https://docs.trae.cn/ide_models",
  },
  international: {
    label: "国际版",
    tool: "trae",
    downloadUrl: TRAE_DOWNLOAD_URL,
    docsUrl: TRAE_MODELS_DOC_URL,
  },
} as const;
export type TraeEdition = keyof typeof TRAE_EDITIONS;

export function traeApiFormats(edition: TraeEdition) {
  return TRAE_API_FORMATS.filter(
    (format) =>
      edition === "international" || format.value !== "openai-responses",
  );
}

// Verified against the signed international TRAE 3.6.4 model dialog. Always
// use Full URL: its base-URL suffixes differ between OpenAI and Anthropic.
export const TRAE_API_FORMATS = [
  {
    value: "openai-chat",
    label: "OpenAI Chat Completions",
    path: "/v1/chat/completions",
  },
  {
    value: "openai-responses",
    label: "OpenAI Responses API",
    path: "/v1/responses",
  },
  {
    value: "anthropic-messages",
    label: "Anthropic Messages",
    path: "/v1/messages",
  },
] as const;

export type TraeApiFormat = (typeof TRAE_API_FORMATS)[number]["value"];
export interface TraeModelSelection {
  model: string;
  group: string;
}

export type TraeSetupPreview =
  | {
      ready: true;
      model: string;
      group: string;
      apiFormat: string;
      requestUrl: string;
      tokenPageUrl: string;
    }
  | {
      ready: false;
      reason: "connection" | "origin" | "selection" | "catalog" | "protocol";
    };

/** No credentials, token creation, config writes, inference, or status mutation. */
export function buildTraeSetupPreview(
  connection: YuanhengConnectionStatus | undefined,
  selection: TraeModelSelection | undefined,
  protocol: string,
  edition: TraeEdition = "international",
): TraeSetupPreview {
  if (!connection?.connected || !connection.userId?.trim()) {
    return { ready: false, reason: "connection" };
  }
  const rawUrl = connection.baseUrl;
  let origin: string;
  try {
    const url = new URL(rawUrl);
    if (
      /[\s\\]/u.test(rawUrl) ||
      url.protocol !== "https:" ||
      !["meta-api.vip", "cn.meta-api.vip"].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      rawUrl.includes("?") ||
      rawUrl.includes("#") ||
      !["/", "/v1", "/v1/"].includes(url.pathname)
    ) {
      return { ready: false, reason: "origin" };
    }
    // Preserve the connected origin; never migrate a credential across hosts.
    origin = url.origin;
  } catch {
    return { ready: false, reason: "origin" };
  }
  if (!selection?.group || !selection.model) {
    return { ready: false, reason: "selection" };
  }
  const { group, model } = selection;
  if (
    ![group, model].every(
      (value) =>
        value === value.trim() &&
        value.length <= 256 &&
        !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value),
    ) ||
    !connection.groups.some((entry) => entry.id === group) ||
    !yuanhengTerminalModels(connection).includes(model) ||
    connection.imageGenerationModels?.includes(model) ||
    !Object.prototype.hasOwnProperty.call(connection.modelGroups, model) ||
    !connection.modelGroups[model]?.includes(group)
  ) {
    return { ready: false, reason: "catalog" };
  }
  if (!Object.prototype.hasOwnProperty.call(TRAE_EDITIONS, edition))
    return { ready: false, reason: "protocol" };
  const format = traeApiFormats(edition).find(
    (entry) => entry.value === protocol,
  );
  if (!format) return { ready: false, reason: "protocol" };
  return {
    ready: true,
    model,
    group,
    apiFormat: format.label,
    requestUrl: `${origin}${format.path}`,
    tokenPageUrl: `${origin}/console/token`,
  };
}
