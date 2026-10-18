import { Channel, invoke } from "@tauri-apps/api/core";
import { StreamReader } from "./stream";

export type Account = {
  id: number;
  username: string;
  display_name?: string;
  quota: number;
  used_quota: number;
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

export const api = {
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
};

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
