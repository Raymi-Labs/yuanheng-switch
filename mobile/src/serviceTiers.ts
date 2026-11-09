export type ServiceTier = "default" | "priority" | "ultrafast";
export type TierOption = { id: ServiceTier; multiplier: number };
export type TierCapability = {
  model: string;
  group: string;
  managed: boolean;
  tiers: TierOption[];
};
export type ChatSnapshot = {
  model: string;
  group: string;
  serviceTier: ServiceTier;
  multiplier: number;
  messages: { role: "user" | "assistant"; content: string }[];
};
export const tierName = (id: string) =>
  ({ default: "标准", priority: "Fast", ultrafast: "UltraFast" })[id] ||
  "未知档位";
export function validateCapability(
  value: unknown,
  model: string,
  group: string,
): TierCapability {
  const v = value as TierCapability;
  if (
    !v ||
    v.model !== model ||
    v.group !== group ||
    typeof v.managed !== "boolean" ||
    !Array.isArray(v.tiers) ||
    v.tiers.length > 3
  )
    throw Error("速度能力响应无效");
  const seen = new Set<string>();
  for (const t of v.tiers) {
    if (
      !t ||
      !["default", "priority", "ultrafast"].includes(t.id) ||
      seen.has(t.id) ||
      t.multiplier !== { default: 1, priority: 2, ultrafast: 6 }[t.id] ||
      (!v.managed && t.id !== "default")
    )
      throw Error("速度能力或倍率已变化，请重新查询");
    seen.add(t.id);
  }
  if (!seen.has("default")) throw Error("标准档位缺失");
  return v;
}
export function buildChatBody(s: ChatSnapshot) {
  if (!["default", "priority", "ultrafast"].includes(s.serviceTier))
    throw Error("无效速度档位，请重新选择");
  return {
    model: s.model,
    group: s.group,
    stream: true,
    messages: s.messages.map(({ role, content }) => ({ role, content })),
    ...(s.serviceTier === "default" ? {} : { service_tier: s.serviceTier }),
  };
}
