# Agent Note: Codex 双模式稳定会话提供商 ID

Status: implemented

## Problem

当前安装的 Codex 引擎在恢复历史时检查 provider ID 严格相等。旧方案只投影别名，custom 历史切到 yuanheng-switch-official 后返回 modelProviderMismatch，界面因两张表同名显示 OpenAI/OpenAI。

## Existing capabilities and impact

复用 codex_history_routes 的配置投影、所有权校验、备份和既有模式事务；不另建历史存储。检查了 CLI/App 共用配置、官方检测与崩溃清理。既有登录指引和故障转移笔记分别负责认证与迟到请求，和本修复部分相关但无需改变决定。

## Decision

托管 Meta API 与官方配置统一使用历史 custom 桶，只改变路由内容。custom 被外部配置占用时使用专用 yuanheng-switch 桶；官方模式检测改为检查实际托管路由，脱离专属 ID。清理代理时仍保留稳定桶和原生登录。已有混合 yuanheng/openai/专属官方 ID 的历史不自动重写，避免修改运行中的 SQLite 与会话文件。

## Alternatives considered

- 仅保留同名别名：旧引擎可用，当前引擎明确拒绝不同 ID，不能解决问题。
- 自动重写全部历史 ID：能合并更早历史，但需要停止原生进程、事务备份和迁移多份存储；当前宿主正在运行，不能作为隐式配置副作用。

## Verification

当前安装的 Codex 原生引擎在隔离 CODEX_HOME 中复现 modelProviderMismatch；修复后合成 custom 聊天在官方、返回、代理清理三阶段恢复成功，不发 turn/start 或模型请求。配置相关 82 项通过，完整 Rust lib 2737 项通过、12 项既有忽略；最终新增身份不变、外部占用、专用桶清理回归共 15 项通过。

## Consequences

历史 custom 聊天可以跨两种模式恢复；官方路由检测不再依赖专属 ID。custom 与专用 ID 同时被占用时明确拒绝，保留用户配置。官方清理令牌后的专用托管表只有和原始托管表清理结果精确一致才重新投影。

不同历史 ID 仍需显式迁移。本修复保留聊天内容、认证和项目归属，不代表 GUI 重启或真实官方模型请求验收。稳定桶不再单凭 ID 区分供应商；用量解析既有规则对 custom 返回未知来源，不能推断官方或平台扣费。
