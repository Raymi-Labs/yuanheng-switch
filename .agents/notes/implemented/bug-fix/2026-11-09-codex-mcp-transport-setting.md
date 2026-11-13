# Agent Note: Codex MCP 传输字段兼容修复

Status: implemented

## Problem

Codex 启动忽略 mcp_servers 下的 type。元衡 MCP 同步仍生成该字段，单独修改用户文件会复发；去掉字段后 HTTP 导入不能继续默认 stdio。

## Existing capabilities and impact

复用 [配置清理](../../../../src-tauri/src/codex_config.rs)、[MCP 导入同步](../../../../src-tauri/src/mcp/codex.rs) 和 [CLI/Desktop 配置入口](../../../../src-tauri/src/commands/yuanheng.rs)。已有 [旧字段清理决策](../../implemented/bug-fix/2026-10-16-codex-context-and-obsolete-setting.md) 保持不变，本次扩展 MCP 子表边界。统一数据库的 type 继续供其他应用使用。

## Decision

在配置准备与最终写入清理每个 MCP 服务直接字段 type，支持普通和内联表，保留 env 中同名键和其他字段。MCP 同步不输出 type，并清理历史残留；导入无 type 的服务依据 command/url 推断，保留旧显式类型兼容。

另外按用户要求移除工作台和工具管理的 ToolActivationProgress 展示，包括预检通过、等待请求与诊断按钮；底层配置校验和错误反馈继续保留。

## Alternatives considered

- 仅清理 computer-use/node_repl：范围最小，但其他服务和后续同步仍出现同一警告。
- 删除统一数据库类型：减少字段，却破坏跨应用规范和传输分支，故只在 Codex 输出边界移除。

## Testing

Codex Rust 回归 649 项通过、2 项原有忽略，MCP 集成回归 24 项通过；生产库 Clippy 无警告。覆盖普通/内联表、env/header 同名键保留、幂等、无 type 的 HTTP 导入并再次同步、CLI/Desktop 配置与 auth 不变。前端 178 文件/1325 项、类型检查与 renderer 构建通过。本机 Node 25 的原生 WebStorage 干扰既有存储模拟，关闭实验 WebStorage 后全量通过；CI 继续使用 Node 20。

## Consequences

只修复已证实不支持的 type，不扩大清理其他未知字段。统一数据库保留传输类型，其他工具不受此输出调整影响。删除两处面板及工具管理仅供面板使用的重启状态订阅，保留底层预检、错误反馈、诊断数据和启动流程。自动化夹具不代表所有 MCP 服务真实连接成功，也未代替三平台发布构建及签名验证。
