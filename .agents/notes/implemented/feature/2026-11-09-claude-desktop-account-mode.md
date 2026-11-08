# Agent Note: Claude Desktop 中转与官方账号模式切换

Status: implemented

## Problem

Claude Desktop 已支持配置 3p 网关及恢复 1p 官方模式，但工作台和工具管理没有切换入口。启动、体检和自动修复仍把官方模式当成中转配置缺失，可能覆盖用户选择。

## Existing capabilities and impact

复用 claude_desktop_config 的四文件快照、apply_provider 与官方种子；新命令只协调模式及当前供应商，不实现账号认证。工作台与工具管理共享选择器和查询缓存，启动／自动修复识别官方模式；保留中转供应商、模型、分组以便切回。配置与切换复用 reasoning 配置锁。[Codex 回退修复](../../implemented/bug-fix/2026-11-09-codex-mode-failover-reversion.md)已有禁用自动故障转移的保护继续生效。

## Decision

提供只读模式查询和 expectedMode 校验切换，官方恢复无需中转凭据或 Core；中转恢复要求已有托管配置并启动 Core。实际配置与供应商标识一起提交，失败恢复文件和标识。未知外部 profile 不接管；正常官方模式不清理账号、会话或 MCP。两处显示重启及原生登录步骤，官方模式不自动配置中转；Core 在明确选择 Claude 官方后拒绝旧请求触发的中转故障转移。

## Alternatives considered

- 仅添加两个按钮调用通用 ProviderService::switch：已有功能多，但它先写当前供应商再写文件，失败会误报模式，且启动和修复仍可能覆盖，因此扩展事务和相关入口。
- 为官方账号代理 OAuth：能统一请求记录，但增加凭据处理且不必要，采用 Claude 原生 1p 登录。
- 删除中转配置再登录：清理简单，却丢失模型、分组及切回能力，不采用。

## Verification

macOS 临时 HOME 回归覆盖双向切换、首次官方模式、未配置中转拒绝、expectedMode 冲突、迟到配置拒绝、保留模型分组及官方状态不要求修复。跨平台文件夹具覆盖外部 profile 拒绝、非对象 JSON 拒绝、提交失败四文件回滚、无关账号字段与 MCP 保留。完整 Rust lib 2715 项通过、11 项既有忽略；完整前端 177 文件 / 1321 项通过，覆盖两个入口、启动不重配、自动修复跳过、首次配置展开和重启标记。Playwright 390px 与桌面预览检查深浅背景及点击切换；仅模拟状态，不操作真实账号。

## Consequences

macOS 与 Windows 配置路径复用现有实现，原生账号登录仍由用户完成；配置切换不代表账号已经登录。Linux 不支持该桌面配置。外部并发编辑无法跨进程完全锁定，使用保守冲突检查。
