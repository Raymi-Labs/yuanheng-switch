# Agent Note: Codex 项目检查随切换自动触发

Status: implemented

## Problem

常驻项目消失提示和手动检查按钮打断工具卡片，用户要求切换项目时自动检查。

## Existing capabilities and impact

复用 [恢复命令](../../../../src-tauri/src/session_sync/projects/codex_local_map.rs)、[恢复窗口](../../../../src/components/desktop/CodexProjectRecovery.tsx) 与 [统一工具 API](../../../../src/lib/api/yuanheng.ts)。元衡没有 Codex 原生侧栏的项目切换事件，接入可控的账号模式、CLI 工作目录切换与启动入口。原 [恢复决定](../../implemented/bug-fix/2026-11-09-codex-project-map-recovery.md) 的显式检查入口被替代，备份和写入保护继续有效。

## Decision

移除工具卡常驻提示。成功切换后及启动前自动只读检查，无异常不弹窗；只有发现缺失才展示恢复窗口。运行时不能写，窗口激活时重新检查，用户确认后按指纹备份恢复；错误不把已成功的模式切换伪报失败。监听随账号挂载，切号丢弃迟到结果，单飞避免重复读取。

## Alternatives considered

- 自动写入全部历史项目：无需点击，但不能区分用户主动删除与登录切换丢失，也不能安全写入运行中的 Codex；保留恢复确认。
- 后台定时扫描：可发现外部变化，但持续读取私有文件且与切换时机无关；采用明确入口及已打开窗口的焦点重检。

## Testing

定向回归覆盖无问题静默、异常才弹窗、并发合并、切号丢弃、失败切换不检查、目录与启动入口、恢复指纹和运行保护。集成夹具补充无缺失项目的只读检查响应。前端全量 180 文件/1339 项通过，类型检查与 renderer 构建通过。

## Consequences

不监听 Codex 原生侧栏内部项目切换，不声称修复云端项目；无历史快照或格式不支持不能自动重建。
