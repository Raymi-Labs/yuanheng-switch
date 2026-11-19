# Agent Note: Claude Desktop 分组模型菜单与逐请求协议选择

Status: implemented

## Problem

托管配置为 Claude Desktop 写入单一 `claude-sonnet-5` 路由，标签固定显示"YuanHeng AI"；用户选择分组后，Desktop 菜单仍只显示该标签，无法看到或切换到分组内的其他模型。本地代理虽已为 Claude Code 生成完整模型路由，但 Desktop 配置未复用。

## Decision

路由分配与旧会话兼容策略已被[路由身份持久化](2026-11-19-desktop-route-identity.md)部分取代；以下排序策略记录初始方案，菜单与逐请求协议决定保持。

扩展 `claude_desktop_model_routes` 为分组全部模型各自生成路由 ID：Claude 自身型号保留原 ID（如 `claude-opus-4-8`），首次配置的非 Claude 型号按字母序分配 `claude-sonnet-5`、`-r2`、`-r3` 等别名。Desktop `inferenceModels` 列出全部路由，`labelOverride` 显示实际型号名；默认模型的路由排在首位并声明 `supports1m: true`。

请求转发时，`map_proxy_request_model` 将路由 ID 映射回上游型号；`get_claude_api_format_for_body` 新增 `managed_desktop_route_upstream_contains` 检查，按映射后的真实型号逐请求选择协议（Anthropic Messages / OpenAI Chat / Responses）。推理档位覆盖仅当出站模型等于 `ANTHROPIC_MODEL`（默认模型）时应用；菜单中的其他模型使用 auto。

Schema 检查从"单一 `claude-sonnet-5` 的 `labelOverride` 等于固定标签"改为"每条路由的 `labelOverride` 等于其 `model` 字段"。`provider_catalog_covers_available_models` 对 Desktop 返回 true，配置阶段改由 `configure_yuanheng_tools` 按令牌可用模型过滤分组目录后再生成路由。图片专用模型继续从目录过滤。

## Existing notes audit

[Claude Code 分组模型菜单](2026-11-05-claude-group-model-picker.md)部分重叠，其决定"Claude Desktop 独立路由不变"现被本篇取代；本篇负责 Desktop 的完整模型列表与逐请求协议。[工具厂商与分组级联](../feature/2026-10-20-tool-model-group-cascade.md)负责工作台选择器，不涉及 Desktop 原生配置。[模型选择器分组](../feature/2026-10-02-model-picker-groups.md)仅负责元衡选择器层级，不涉及 Desktop。[Agent 推理等级](../feature/2026-11-04-agent-reasoning-controls.md)与[平台推理档位](../feature/2026-11-18-platform-reasoning-profiles.md)决定档位来源，本篇仅负责 Desktop 配置投影与覆盖边界；三篇互不替代。

## Alternatives considered

- **固定 claude-sonnet-5 别名 vs 按默认模型重编号**：固定别名使路由 ID 在默认模型切换后保持稳定，但旧会话引用 `claude-sonnet-5` 会映射到按字母序首个非 Claude 型号而非新默认。若按默认重编号（默认总是 `claude-sonnet-5`，其他递增 `-r2`），旧会话总是映射到当前默认，但每次切换默认会令全部别名重洗牌。选择固定别名，因旧会话无论如何都无法感知分组变化，稳定 ID 减少配置比对的噪声。
- **逐模型推理档位 vs 默认模型专属覆盖**：`local_proxy_request_overrides` 是 provider 级字段，按默认模型选中的协议生成（Anthropic 为 `output_config.effort`，Responses 为 `reasoning.effort`，Chat 为 `reasoning_effort`）。若把同一份覆盖应用到菜单中的其它模型，会把默认模型协议的参数形态套到不同协议的型号上。Desktop 菜单也没有逐模型档位入口。选择仅默认模型生效。
- **为所有模型分别写入 Haiku/Sonnet/Opus 三槽**：Desktop 原生菜单只有三项，无法展示分组全部型号。
- **动态路由发现**：需本地模型端点和生命周期管理，配置阶段已有验证目录，直接写入 `inferenceModels` 更直接。
- **菜单与本地映射分别开发**：映射不保留精确型号会导致协议选择错误；二者必须同步。

## Verification

新增两个测试，插入 `builds_hidden_managed_configs_for_each_tool` 之前：

1. **`claude_desktop_group_picker_lists_each_model_with_its_protocol`**：合成五模型目录（claude-opus-4-8, gpt-6.1-sol, deepseek-v4-pro, k3, gpt-image-1），默认 deepseek-v4-pro + reasoning high。断言路由顺序为 `claude-sonnet-5 → deepseek-v4-pro (openai_chat, 1M)`、`claude-opus-4-8 → claude-opus-4-8 (anthropic)`、`claude-sonnet-5-r2 → gpt-6.1-sol (openai_responses)`、`claude-sonnet-5-r3 → k3 (openai_chat)`。图片模型 gpt-image-1 已过滤。切换默认模型为 k3，路由 ID 映射保持不变，仅首位变为 k3。每条路由通过 `map_proxy_request_model` 和 `get_claude_api_format_for_body` 确认协议。

2. **`claude_desktop_group_picker_routes_each_model_with_default_reasoning_only`**（tokio, serial）：启动临时 Core 代理与合成上游，通过 `/claude-desktop/v1/models` 列出四条路由，逐一发送 `/messages` 请求。断言上游收到的路径与模型为：deepseek-v4-pro → `/v1/chat/completions` + `reasoning_effort: "high"`、claude-opus-4-8 → `/v1/messages` + 无 reasoning、gpt-6.1-sol → `/v1/responses` + 无 reasoning、k3 → `/v1/chat/completions` + 无 reasoning。

Rust 全量 lib 测试 2819 项通过（含新增两项）、13 项原有忽略（本项新增 0 项忽略）。Clippy lib + bins (`-D warnings`) 通过；`--tests` 目标有 9 项既有错误，分布在 `imagegen_token.rs`、`media_studio.rs`、`service_tiers.rs`、`core_diagnostics.rs`、`hermes_config.rs`、`openclaw_config.rs`、`secure_storage.rs`、`session_sync/mod.rs`，本次改动未触碰这些文件。前端 typecheck 通过、完整单元测试 1426 项通过（NODE_OPTIONS=--no-experimental-webstorage，jsdom 与 Node 25 默认 Web Storage 冲突）。

未使用原生 Claude Desktop 测试，未发送真实付费推理。模拟端到端与路由映射测试不证明 Desktop 各系统真实行为、流式协议回归或官方菜单全部验收；流式协议复用既有 Claude/OpenAI 转换。

## Consequences

目录是配置时快照，分组变化后需重新应用配置并重启 Desktop。推理档位以 provider 级覆盖写入，转发时仅当出站模型等于 `ANTHROPIC_MODEL` 才应用，菜单中其它模型保留请求原值。只有默认模型声明 `supports1m: true`。非 Claude 型号的路由 ID 形如 `claude-sonnet-5-rN`，Desktop 可能按该 ID 显示 Sonnet 层级描述（未在原生 UI 实测）。

旧会话与目录变更现遵循[路由身份持久化](2026-11-19-desktop-route-identity.md)：沿用保存的 ID→型号，型号不可用时拒绝请求，不改绑。子 agent 等发起的不在菜单里的 Claude 官方名（如带日期后缀的 `claude-haiku-4-5-20251001`）走既有角色关键词回落，仅对安全 Claude ID 生效；仅有 Sonnet/Opus/Haiku 三档时 fable 请求回落到 opus 档，显式配置 fable 档后精确匹配优先。
