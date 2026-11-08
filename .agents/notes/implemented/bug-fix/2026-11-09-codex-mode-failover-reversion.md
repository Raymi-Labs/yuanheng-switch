# Agent Note: 关闭故障转移时请求不得回写账号模式

Status: implemented

## Problem

本机点击官方模式后界面成功，但四秒后 Core 记录 FO-001 将 codex 切回 YuanHeng，配置备份证明 official 被 custom 替换。现场 codex enabled=true、auto_failover_enabled=false。RequestForwarder 将 Desktop 的 Codex 协议类型当作供应商命名空间，并在实际供应商与启动快照不同时无条件提交热切换，关闭重试并未禁止该副作用。

## Existing capabilities and impact

复用 handler_context、forwarder 与 FailoverSwitchManager，保留官方切换事务、原生登录和历史路由投影。前一篇[登录指引修复](../../implemented/bug-fix/2026-11-09-codex-account-login-guidance.md)负责认证说明，不能解决请求完成后的配置覆盖。四条成功路径（普通、图片兼容、两类整流重试）需一致守卫，恢复优先供应商入口仍使用同一管理器。

## Decision

上下文始终传递真实供应商命名空间，并从对应路由器获取当前供应商快照。转发器仅在自动故障转移开启且不是固定快照时允许自动提交切换；管理器执行前再次检查 enabled 与 auto_failover_enabled。关闭后的迟到请求不会写回，正常故障转移的 UI/托盘同步保留。

## Alternatives considered

- 只刷新界面：无法阻止 Core 改写磁盘配置，拒绝。
- 删除全部自动切换：可以阻止覆盖，但破坏用户显式启用的故障转移与恢复逻辑，拒绝。
- 仅修复 Desktop 命名空间：减少交叉污染，但同一命名空间的旧请求仍可能在禁用故障转移后写回，必须同时校验开关。

## Verification

本机 UI 点击官方后，配置先变 official，随后 Core FO-001 回写为 custom，复现成立。修复后的本地 HTTP 模拟回归覆盖 Desktop 响应成功不增加故障转移计数、请求状态不写入 codex、官方供应商保持；开关测试覆盖禁用拒绝及启用进入目标验证。完整 Rust lib 2711 项通过、11 项既有忽略，完整前端 175 文件 / 1315 项通过，TypeScript 与 renderer 构建通过。仅合成上游，不执行收费模型验收。

## Consequences

真正开启故障转移的并发手动供应商选择仍沿用已有事务语义，不宣称跨进程线性化。账号 OAuth 登录仍需用户完成。部署后 Core 必须升级，旧二进制仍有此缺陷。
