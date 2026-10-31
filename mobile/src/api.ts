import { Channel, invoke } from "@tauri-apps/api/core";
import { StreamReader } from "./stream";

export type Account = {
  id: number;
  username: string;
  display_name?: string;
  quota: number;
  used_quota: number;
  transferable_quota?: number;
  aff_code?: string;
  aff_count?: number;
  aff_quota?: number;
  aff_history_quota?: number;
  group: string;
};
export type Group = { ratio?: number; desc?: string };
export type Token = {
  id: number;
  name: string;
  group: string;
  status: number;
  remain_quota: number;
  unlimited_quota: boolean;
  used_quota: number;
  expired_time: number;
  created_time?: number;
  accessed_time?: number;
  model_limits_enabled?: boolean;
  model_limits?: string;
  allow_ips?: string;
};
export type PricingModel = {
  model_name: string;
  display_name?: string;
  description?: string;
  tags?: string;
  icon?: string;
  vendor_id?: number;
  quota_type?: number;
  model_ratio?: number;
  completion_ratio?: number;
  model_price?: number;
  audio_duration_price?: number;
  enable_groups?: string[];
  supported_endpoint_types?: string[];
  context_length?: number;
  max_output_tokens?: number;
  release_date?: string;
  capabilities?: Record<string, boolean>;
  billing_mode?: string;
  billing_expr?: string;
  owner_by?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  supports_cache_read?: boolean;
  cache_ratio?: number;
};
export type PricingVendor = {
  id: number;
  name: string;
  icon?: string;
  description?: string;
};
export type Pricing = {
  success?: boolean;
  message?: string;
  data: PricingModel[];
  vendors?: PricingVendor[];
  group_ratio?: Record<string, number>;
  usable_group?: Record<string, string>;
  auto_groups?: string[];
  time_ratio?: number;
  time_ratio_at?: string;
};
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  error?: string;
};
export type Conversation = {
  id: string;
  title: string;
  model: string;
  group: string;
  updatedAt: number;
  messages: Message[];
};
export type ImageResult = { data: string; mime: string };
export type ImageTaskRecord = {
  id: string;
  prompt: string;
  model: string;
  size: string;
  createdAt: number;
  elapsed?: number;
  reference?: string;
  result: ImageResult;
};
export type Envelope<T> = { success: boolean; data: T; message?: string };
export type Page<T> = { items: T[]; total: number };
export type Redemption = {
  benefit_type?: string;
  quota_added?: number;
  action_summary?: string;
  plan_title?: string;
  product_name?: string;
  issuance_id?: number;
  code?: string;
  options?: { id: number; plan_title?: string; end_time?: number }[];
};
export type UsageLog = {
  id: number;
  created_at: number;
  type: number;
  content?: string;
  token_name?: string;
  model_name?: string;
  quota: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  use_time?: number;
  group?: string;
  is_stream?: boolean;
  channel?: number;
  channel_name?: string;
  request_id?: string;
  other?: string;
};
export type LogStat = {
  quota: number;
  rpm?: number;
  tpm?: number;
};
export type RedemptionCode = {
  id: number;
  key: string;
  status: number;
  quota: number;
  created_time: number;
  redeemed_time?: number;
  expired_time?: number;
};
export type RedemptionSummary = {
  daily_created_count: number;
  daily_created_quota: number;
  active_count: number;
  daily_create_limit: number;
  daily_quota_limit: number;
  active_limit: number;
  minimum_quota: number;
  reset_at?: number;
};
export type RedemptionCreated = {
  redemption: RedemptionCode;
  remaining_quota?: number;
  remaining_transferable_quota?: number;
};

export type HealthGroup = {
  group: string;
  avg_output_tps?: number | null;
  cache_hit_rate?: number | null;
  cache_sample_count?: number;
  request_count?: number;
  success_rate?: number | null;
  avg_ttft_ms?: number | null;
  ttft_count?: number;
  avg_completion_ms?: number | null;
  completion_count?: number;
};
export type HealthGroups = {
  enabled?: boolean;
  window_hours?: number;
  collection_incomplete?: boolean;
  groups: HealthGroup[];
};

const unwrap =
  (fallback: string) =>
  <T>(result: Envelope<T>): T => {
    if (!result.success) throw new Error(result.message || fallback);
    return result.data;
  };

export const api = {
  capabilities: () =>
    invoke<{ purchases: boolean; version: string }>("mobile_capabilities"),
  aiConsent: (accepted: boolean, userId: number) =>
    invoke<void>("mobile_ai_consent", { accepted, userId }),
  restore: () => invoke<Account | null>("mobile_restore"),
  login: (username: string, password: string) =>
    invoke<{ account?: Account; requiresTwoFactor?: boolean }>("mobile_login", {
      body: { username, password },
      twoFactor: false,
    }),
  twoFactor: (code: string) =>
    invoke<{ account?: Account }>("mobile_login", {
      body: { code },
      twoFactor: true,
    }),
  logout: () => invoke<void>("mobile_logout"),
  raw: <T>(operation: string, body: Record<string, unknown> = {}) =>
    invoke<Envelope<T>>("mobile_api", { operation, body }),
  async get<T>(
    operation: string,
    body: Record<string, unknown> = {},
  ): Promise<T> {
    const result = await this.raw<T>(operation, body);
    if (!result.success)
      throw new Error(result.message || "操作未成功，请重试");
    return result.data;
  },
  open: (
    destination:
      | "topup"
      | "register"
      | "account"
      | "usage"
      | "privacy"
      | "terms",
  ) => invoke<void>("mobile_open_website", { destination }),
  async pricing(): Promise<Pricing> {
    const result = await invoke<Pricing>("mobile_api", {
      operation: "pricing",
      body: {},
    });
    if (result.success === false)
      throw new Error(result.message || "无法读取模型广场");
    return result;
  },
  tokenUpdate: (body: Record<string, unknown>) =>
    invoke<Envelope<Token>>("mobile_api", {
      operation: "token_update",
      body,
    }).then((result) => {
      if (!result.success)
        throw new Error(result.message || "保存令牌失败，请重试");
      return result.data;
    }),
  tokenDelete: (id: number) =>
    invoke<Envelope<unknown>>("mobile_api", {
      operation: "token_delete",
      body: { id },
    }).then((result) => {
      if (!result.success)
        throw new Error(result.message || "删除令牌失败，请重试");
      return result.data;
    }),
  logs: (body: {
    page?: number;
    size?: number;
    type?: number;
    start?: number;
    end?: number;
  }) =>
    invoke<Envelope<Page<UsageLog>>>("mobile_api", {
      operation: "logs",
      body,
    }).then(unwrap("无法读取使用日志")),
  logStat: (start: number, end: number) =>
    invoke<Envelope<LogStat>>("mobile_api", {
      operation: "log_stat",
      body: { start, end },
    }).then(unwrap("无法读取用量统计")),
  healthGroups: (model: string) =>
    invoke<Envelope<HealthGroups>>("mobile_api", {
      operation: "health_groups",
      body: { model },
    }).then(unwrap("无法读取分组调用表现")),
  redemptions: (page = 1, size = 20) =>
    invoke<Envelope<Page<RedemptionCode>>>("mobile_api", {
      operation: "redemptions",
      body: { page, size },
    }).then(unwrap("无法读取兑换码")),
  redemptionSummary: () =>
    invoke<Envelope<RedemptionSummary>>("mobile_api", {
      operation: "redemption_summary",
      body: {},
    }).then(unwrap("无法读取兑换码额度")),
  async createRedemption(quota: number, requestId: string, userId: number) {
    const result = await invoke<Envelope<RedemptionCreated>>("mobile_api", {
      operation: "redemption_create",
      expectedUserId: userId,
      body: { quota, request_id: requestId },
    });
    if (!result.success)
      throw new Error(result.message || "创建兑换码失败，请重试");
    return result.data;
  },
  // 邀请奖励：把待使用收益划转到账户余额。
  async transferAffQuota(quota: number, userId: number) {
    const result = await invoke<Envelope<unknown>>("mobile_api", {
      operation: "aff_transfer",
      expectedUserId: userId,
      body: { quota },
    });
    if (!result.success)
      throw new Error(result.message || "划转失败，请稍后重试");
  },
  async chat(
    id: string,
    model: string,
    group: string,
    messages: Message[],
    update: (text: string, reasoning: string) => void,
  ) {
    const reader = new StreamReader(update);
    const channel = new Channel<number[]>();
    let parseError: unknown;
    channel.onmessage = (bytes) => {
      if (parseError) return;
      try {
        reader.push(new Uint8Array(bytes));
      } catch (error) {
        parseError = error;
        void this.cancel(id);
      }
    };
    try {
      await invoke("mobile_chat", {
        id,
        body: {
          model,
          group,
          stream: true,
          messages: messages.map(({ role, content }) => ({ role, content })),
        },
        onChunk: channel,
      });
    } catch (error) {
      throw parseError || error;
    }
    if (parseError) throw parseError;
    reader.finish();
  },
  cancel: (id: string) => invoke<void>("mobile_cancel", { id }),
  image: (
    id: string,
    prompt: string,
    model: string,
    size: string,
    reference?: string,
  ) =>
    invoke<ImageResult>("mobile_image", {
      id,
      input: { prompt, model, size, reference: reference ?? null },
    }),
  saveImage: (data: string) => invoke<void>("mobile_save_image", { data }),
  galleryList: (userId: number) =>
    invoke<ImageTaskRecord[]>("mobile_gallery_list", { userId }),
  gallerySave: (entry: ImageTaskRecord, userId: number) =>
    invoke<void>("mobile_gallery_save", {
      entry: JSON.stringify(entry),
      userId,
    }),
  galleryDelete: (id: string, userId: number) =>
    invoke<void>("mobile_gallery_delete", { id, userId }),
};

// getRandomValues also works in older WKWebView/custom-scheme contexts where randomUUID is absent.
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "操作失败，请稍后重试";

export function quotaAmount(value: number, perUnit: number): string {
  return Number.isFinite(value) && perUnit > 0
    ? `$${(value / perUnit).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
    : "—";
}
export type BalanceUnit = "quota" | "cny";
/**
 * Wallet figure without a currency symbol: quota (lightning) by default, CNY on demand.
 * CNY follows the live status.price (0.2 → quota / 5 when it cannot be read).
 */
export function balanceText(
  value: number,
  perUnit: number,
  unit: BalanceUnit,
  price: number,
): string {
  if (!Number.isFinite(value) || !Number.isFinite(perUnit) || perUnit <= 0)
    return "—";
  const base = value / perUnit;
  if (unit === "cny") {
    const rate = Number.isFinite(price) && price > 0 ? price : 0.2;
    return (base * rate).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 5,
    });
  }
  return base.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 5,
  });
}
export function amountToQuota(raw: string, perUnit: number): number {
  if (
    !/^\d+(\.\d{1,6})?$/.test(raw) ||
    !Number.isFinite(perUnit) ||
    perUnit <= 0
  )
    throw new Error("请输入有效额度（最多 6 位小数）");
  const quota = Math.round(Number(raw) * perUnit);
  if (!Number.isSafeInteger(quota) || quota <= 0)
    throw new Error("额度必须大于零且在有效范围内");
  return quota;
}
export function readConversations(userId: number): Conversation[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`yuanheng-mobile-chats-v1:${userId}`) || "[]",
    );
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (v): v is Conversation =>
          v &&
          typeof v.id === "string" &&
          typeof v.title === "string" &&
          typeof v.model === "string" &&
          typeof v.group === "string" &&
          Array.isArray(v.messages) &&
          v.messages.every(
            (m: Message) =>
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string" &&
              typeof m.id === "string",
          ),
      )
      .slice(0, 30);
  } catch {
    return [];
  }
}
export function saveConversations(
  userId: number,
  conversations: Conversation[],
) {
  localStorage.setItem(
    `yuanheng-mobile-chats-v1:${userId}`,
    JSON.stringify(conversations.slice(0, 30)),
  );
}
