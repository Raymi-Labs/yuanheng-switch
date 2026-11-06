# Agent Note: Codex 从中转切换官方首次登录

Status: implemented

## Problem

0.1.131 的官方切换在 IPC 预检和配置事务中都要求 auth.json 已有 OAuth。先使用元衡 API Key 登录的用户无法先恢复官方模式再登录；系统凭据库中的登录也不能由文件判断。按钮只报错，没有完整的退出 API Key 与 ChatGPT 登录指引。

## Decision

复用现有账号模式切换、配置回滚和历史路由投影，取消将只读登录材料检测作为切换门禁。登录检测仍是辅助信息，切换结果只确认模式，认证由 Codex 原生界面完成。官方模式显示重启、退出已有 API Key 登录、Sign in with ChatGPT 的步骤；不写删 auth.json、不操作系统凭据库、不强制退出应用、不改变用户认证限制。

共享官方转发校验拒绝 sk- API Key，避免未完成原生账号切换时将中转 Key 发送到官方；原有占位符保护继续保留，不检查本地文件以支持系统凭据库。文本与图片入口复用此校验。

## Existing capabilities and impact

工作台 CLI/App 共用 FocusToolCard 和 useModelSwitchCenter；后端两层校验必须一致修改。保留元衡两份配置、模型/分组/令牌、配置冲突拒绝及事务回滚。既有 [标记恢复](../../implemented/bug-fix/2026-10-14-codex-surface-mode-repair.md) 的官方预登录门禁被本决定部分取代，其他恢复边界保留；[首次中转登录指引](../../implemented/feature/2026-11-04-codex-first-login-guide.md) 是另一流程，仍保留凭据所有权。检索到的 TRAE/Accio、媒体与更新笔记不负责 Codex 官方登录。

官方依据：[认证文档](https://learn.chatgpt.com/docs/auth)说明文件/系统凭据库、API Key/ChatGPT 登录与账号菜单退出。

## Alternatives considered

- 保持门禁并仅改报错：代码少，但文件检测仍误拦凭据库用户，首次官方切换仍依赖用户自行发现顺序。
- 自动清理 auth.json 或写强制登录方式：步骤少，但影响原生凭据所有权、用户自定义认证策略与其他 Codex 入口；由用户在 Codex 内完成登录。
- 接管 OAuth：可以在元衡内完成认证，但重复实现官方账号流程、引入凭据存储，不符合本次范围。

## Verification

已验证无登录文件、API Key、空/损坏文件均可选择官方模式且文件原样保留；已有 OAuth 双向切换保留；CLI/App 均显示登录指引且可切回元衡；API Key 与旧占位符在官方路由本地拒绝，OAuth 透传保持。

相关前端 58 项及 Codex 后端 640 项（2 项既有忽略）通过。完整前端 173 文件/1285 项通过，完整 cargo test、Clippy warnings-as-errors、类型、格式、renderer 构建和版本检查通过。本机 Node 25 默认 Web Storage 与 jsdom Storage.prototype 模拟冲突导致初跑 5 项失败；使用 NODE_OPTIONS=--no-experimental-webstorage 后全量通过，不修改业务或测试规避失败。

## Consequences

仅观察文件无法确认真实登录有效性，页面不得宣称已登录。Windows 客户机真实登录和付费推理未验收；测试使用临时目录和合成凭据。
