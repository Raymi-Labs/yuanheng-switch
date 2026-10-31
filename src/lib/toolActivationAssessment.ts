import type { YuanhengToolActivationStatus } from "@/lib/api";

/** Only interpret recorded evidence. HTTP status alone cannot establish fault ownership. */
export function assessToolActivation(
  activation?: YuanhengToolActivationStatus,
  restartRequired = false,
) {
  const result = (title: string, message: string, ok = false) => ({
    title,
    message,
    ok,
  });
  if (!activation)
    return result("尚无检查结果", "刷新状态后再判断配置是否生效。");
  if (!activation.configWritten)
    return result("配置尚未就绪", "请先为此工具应用配置，再检查状态。");
  if (activation.routeRequired && !activation.routeReady)
    return result(
      "本地连接尚未就绪",
      "请从元衡重新打开此工具；若仍不可用，查看诊断报告。旧请求成功不代表当前连接正常。",
    );
  if (restartRequired)
    return result(
      "配置已保存，等待应用读取",
      "请结束当前任务后重新打开此工具，再查看新请求记录。",
    );
  if (!activation.routeRequired)
    return result(
      "配置已保存，请在工具内验证",
      "此工具的请求不经过本地网关，元衡无法确认模型调用结果；本次检查不会发送测试消息。",
    );
  if (!activation.requestReceived)
    return result(
      "本地配置已就绪，等待实际请求",
      "请在工具内正常使用一次，再刷新状态；本次检查不会发送测试消息。",
    );
  const code = activation.lastStatusCode;
  if (code != null && code >= 200 && code < 300) {
    if (activation.requestSucceeded && activation.configuredAt != null)
      return result(
        "最近请求已成功",
        "已记录一次成功请求；不代表文件操作或其他工具任务已完成。",
        true,
      );
    return result(
      "请求完成情况待确认",
      "HTTP 2xx 不代表完整响应已结束。请查看诊断记录，避免重复发送尚在处理的任务。",
    );
  }
  if (code === 401 || code === 403)
    return result(
      "请求被拒绝",
      "请检查当前分组的模型权限与凭据；403 也可能是安全策略拦截，不能仅凭状态码认定账号封禁。",
    );
  if (code === 402)
    return result(
      "请核对账户额度",
      "请在平台核对余额、套餐和额度；具体拒绝原因以请求记录为准。",
    );
  if (code === 429)
    return result(
      "请求受到限制",
      "请核对并发、频率和可用额度，稍后再试；不要连续重复发送。",
    );
  if (code === 408 || code === 504)
    return result(
      "请求等待超时",
      "请先查看原任务是否仍在执行，再导出诊断定位超时环节；暂不重复发送。",
    );
  if (code != null && code >= 500)
    return result(
      "请求处理异常",
      "本地网关或上游都可能返回此错误，请通过诊断记录定位，暂不需要重装工具。",
    );
  return result(
    "请求尚未成功",
    "请保留报错时间和请求编号，通过诊断报告核对模型、参数及连接情况。",
  );
}
