# Agent Note: Claude Code 分组模型菜单与逐请求选择

Status: implemented

## Problem

托管配置把当前模型同时写进 Haiku/Sonnet/Opus，Claude Code 菜单重复显示 Opus。本地代理还按家族或默认模型覆盖显式型号，单改菜单仍会请求错误型号。

## Decision

复用分组目录和令牌权限交集，用官方 modelPicker（2.1.242+）替换内建菜单；默认型号在前，其余去重列出。角色优先使用目录内对应家族，缺失家族沿用已授权默认型号承接后台调用。直连沿用平台 Messages；本地接管保留完整型号并逐请求复用现有协议转换。旧配置通过 schema 检测重新应用；Claude Desktop 独立路由不变。

官方依据：[modelPicker](https://code.claude.com/docs/en/settings-reference#modelpicker)。图片专用型号继续过滤，菜单不替代平台令牌鉴权。

## Existing notes audit

[厂商与分组级联](../../implemented/feature/2026-10-20-tool-model-group-cascade.md)部分重叠，保留其分组与保存时机；本篇负责 Claude 原生菜单。[模型层级](../../implemented/feature/2026-10-02-model-picker-groups.md)仅负责元衡选择器，不替换决定。Accio、DSH 与 Claude Desktop 笔记无关。

## Alternatives considered

- 三个槽位分别映射虽小，但无法覆盖分组全部型号。
- 网关动态发现需要增加本地模型端点和鉴权生命周期；配置阶段已有验证目录，直接复用官方菜单设置。
- 仅改菜单不能解决本地二次映射，必须保持精确型号与实际协议一致。

## Verification

Rust 全量 lib 2695 项通过、9 项原有忽略；新增配置回归覆盖重复/图片过滤、家族选择、切组清理、旧共享片段覆盖保护及 schema；本地 HTTP 回归核对四个真实出站型号、Messages/Responses/Chat 三种路径及 Claude 格式返回。接管回归保持完整型号、默认和菜单，旧非托管映射回归通过。Clippy、原生 GUI/Core debug 构建、前端类型检查、1282 项测试、renderer 构建通过。Node 25 默认 Web Storage 与 jsdom 的 Storage spy 冲突导致首轮五项失败；通过 NODE_OPTIONS=--no-experimental-webstorage 使用 jsdom 存储后全量通过，不改产品或测试规避断言。

本机 Claude Code 2.1.317 在独立临时 CLAUDE_CONFIG_DIR、合成令牌、不可达 loopback 上显示 Opus/Sonnet/Haiku/不同 Opus 版本/GPT/DeepSeek 六项菜单；选择 GPT 后原生顶部与提示确认切换并保存。没有真实模型请求，未修改用户 Claude 配置。

## Consequences

Claude Code 需 2.1.242+；目录是配置快照，分组变化后重新应用。角色缺失时后台调用仍落在已有授权默认型号，原生菜单由完整目录替代，避免重复槽位。共享配置继续保留权限等用户设置，模型和菜单归当前托管配置所有。模拟端到端与原生菜单测试不证明真实付费推理、流式上游或各系统原生菜单全部验收；流式协议仍复用既有转换与回归。
