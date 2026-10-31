import { randomId } from "./api";
export type RedemptionAttempt = { quota: number; requestId: string };
const locks = new Set<number>();
const key = (userId: number) => {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error("请先登录再创建兑换码");
  return `yuanheng-mobile-redemption-v1:${userId}`;
};
export function readRedemptionAttempt(
  userId: number,
): RedemptionAttempt | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key(userId));
  } catch {
    throw new Error(
      "无法读取本机操作记录，已阻止创建兑换码，请勿清空应用数据后重试",
    );
  }
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    if (
      !Number.isSafeInteger(value.quota) ||
      value.quota <= 0 ||
      typeof value.requestId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.requestId)
    )
      throw new Error();
    return { quota: value.quota, requestId: value.requestId };
  } catch {
    throw new Error("本机兑换码操作记录损坏，请先到平台核对，暂不创建新请求");
  }
}
export function prepareRedemptionAttempt(
  userId: number,
  quota: number,
): RedemptionAttempt {
  const previous = readRedemptionAttempt(userId);
  if (previous) {
    if (previous.quota !== quota)
      throw new Error("存在待确认的兑换码操作，请先按原额度确认结果");
    return previous;
  }
  if (!Number.isSafeInteger(quota) || quota <= 0)
    throw new Error("兑换码额度无效");
  const value = { quota, requestId: randomId() };
  try {
    const raw = JSON.stringify(value);
    localStorage.setItem(key(userId), raw);
    if (localStorage.getItem(key(userId)) !== raw) throw new Error();
  } catch {
    throw new Error("无法可靠保存操作记录，未提交兑换码创建请求");
  }
  return value;
}
export function clearRedemptionAttempt(userId: number, requestId: string) {
  const value = readRedemptionAttempt(userId);
  if (value?.requestId !== requestId)
    throw new Error("兑换码操作已变化，请重新打开确认");
  try {
    localStorage.removeItem(key(userId));
    if (localStorage.getItem(key(userId)) !== null) throw new Error();
  } catch {
    throw new Error("本机操作记录未清除，请继续确认原操作，不要重复创建");
  }
}
export function lockRedemption(userId: number) {
  if (locks.has(userId))
    throw new Error("该账号的兑换码请求正在处理，请稍后确认");
  locks.add(userId);
  return () => locks.delete(userId);
}
