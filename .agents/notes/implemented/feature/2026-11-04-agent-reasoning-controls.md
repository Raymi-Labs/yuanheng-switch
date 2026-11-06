# Agent Note: Agent推理等级端到端补齐

Status: implemented

## Problem

工作台和工具管理只给Codex及Claude Desktop显示推理控件；多数工具配置命令仍接收reasoning却不投影到原生配置，造成界面缺失及保存假成功。WorkBuddy/DSH状态固定auto；Accio已有按当前模型补缺省参数但入口隐藏。

## Decision

复用模型能力目录和两处控件/统一配置流程，补原生参数投影与状态回读。前后端使用同一JSON原生能力表，避免重复名单漂移。按工具真实配置能力和模型等级交集开放，不把固定三工具名单当能力表。auto表示移除本次托管的显式默认或恢复原值而非强制低档；工具内会话/环境/全局优先级各不相同，就近提示并在使用说明列出。未知/不支持组合明确拒绝，不能只写notes宣称生效。

核对官方文档及只读程序包，不读取用户真实密钥/聊天、不修改当前安装或账号配置。测试使用隔离目录与合成请求，禁止真实收费推理。TRAE是辅助配置，不伪装为自动写入。复用既有拥有权/备份恢复，避免全局默认污染其他供应商。

## Alternatives considered

- 只放开全部下拉框：最快，但未写出参数的工具仍会假成功，拒绝。
- 全工具改走新本地代理：可统一注入，但扩大网络、凭据、生命周期与兼容风险；优先原生配置。
- 原生配置与现有代理各自承接：保留实际工作方式，用工具能力和模型能力共同决定档位，采用。

## Verification

All existing managed tools and the TRAE assisted entry were audited; native field paths and explicit gaps are documented in [the guide](../../../../docs/guides/agent-reasoning.md). Frontend: 171 files, 1267 tests passed. YuanHeng configuration tests: 169 passed. Reasoning-filtered native tests: 88 passed (overlapping the previous suite, not additive). TypeScript, formatting, production renderer build and GUI/Core Clippy with -D warnings passed.

Tests cover nine newly visible selectors, WorkBuddy draft-to-configure IPC, invalid explicit levels, high/low/auto native round trips, both DSH profiles, Gemini model alias resolution, external edits, stale snapshots, write-failure rollback and Accio request precedence. Tests use isolated directories and synthetic data, with no paid requests or personal account access. This is not Windows/Intel or live upstream verification. No push, release or version change.

## Consequences

Agent版本和协议各异，不将本地字符串匹配冒充实际运行。未发现支持字段的工具明确反馈缺口；不编造字段或数字预算映射。真实上游行为不由离线测试推断。

## Adversarial findings

- 发现Gemini仅创建thinking别名而未指定model会导致原生解析失败；写入完整实际模型并保留其他生成参数，恢复时移除整个本次新别名，不遗留空别名。thinkingBudget与thinkingLevel互斥，includeThoughts等其他字段保留。
- WorkBuddy消费者明确不接受ultra/none；Claude官方包支持xhigh，不能沿用旧四档假设。DSH只能声明off/minimal/low/medium/high/xhigh/max，本机模型目录的ultra不直接冒充原生支持。
- Hermes原生override按模型名（并可归一化provider前缀）匹配，无法假称provider隔离：明确告知同模型其他provider可能受影响，不改全局agent.reasoning_effort。Gemini2.5用数值预算，TRAE外部写入缺依据，两者保留明确未适配说明而不是填虚构字段。
- 旧数据库仅notes=high而实际字段缺失不能算配置成功；Claude/Grok/OpenCode新增投影一致性核对，辅助字段对账失败不报成功。工具内全局/会话覆盖不能用配置存在证明请求生效。
- 只放开UI会留下后端丢参数；写aux配置失败需回滚字段。测试用.env目录制造真实写失败而非假设空token会被拒绝；保留mcp及原别名。外部修改与旧快照均拒绝覆盖。
- Grok auto沿用原文本生成以保留现有兼容输出；不能因重新序列化TOML而误判模型目录缺失。

Final configuration writers have operation exclusion and stale-snapshot checks. All test/build commands exited; no owned test, compiler or test-VM processes remain.
