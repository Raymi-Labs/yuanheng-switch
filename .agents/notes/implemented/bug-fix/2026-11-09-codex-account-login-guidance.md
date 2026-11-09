# Agent Note: 中转配置与 ChatGPT 账号登录分离

Status: implemented

## Problem

首次配置弹窗仅推荐 API Key 登录，已有 API Key 时跳过全部指引。现场 auth.json 为 apikey，客户端日志明确拒绝 API Key 访问远程插件目录；本地会话数据库仍有记录。现有证据不能确认用户报告的启动失败原因，也不能将所有不可见项目归因于本地历史删除。

## Existing capabilities and impact

复用 CodexLoginGuide、FocusToolCard 与只读 get_codex_login_guide。桌面配置写入本来就保留 auth.json，并以 provider bearer token 承载中转凭据，无需切换账号登录方式。部分取代[首次登录指引](../../implemented/feature/2026-11-04-codex-first-login-guide.md)的 API Key 优先及所有登录材料跳过策略；保留账号归属校验、短期凭据状态和启动续接。[官方首次登录](../../implemented/bug-fix/2026-11-06-codex-official-first-login.md)的路由切换与原生认证边界继续保留。

## Decision

优先指引保留或恢复原 ChatGPT 账号，说明同一账号与工作区要求及 API Key 的账号功能限制。API Key 保留为可选方式；只有检测到 OAuth token 材料时跳过指引，API Key 和仅元数据不再误判为官方登录。中转卡片持续展示恢复提示，覆盖已经配置的用户。文件检测无法判断钥匙串登录，因此提示已登录时保留登录，不自动退出或改写凭据。

## Alternatives considered

- 自动删除 auth.json 并重启：步骤少，但会丢失用户当前凭据且无法完成浏览器身份验证，不采用。
- 自动把所有历史 provider ID 改为当前值：可能改变会话可见性，但破坏原路由与归属，不能恢复账号云端内容，现场没有必要性证据，不采用。
- 仅修改首次登录文案：改动更小，但已使用 API Key 的受影响用户无法再次看到指引，因此同时修正后端判定和工具卡提示。

## Verification

API Key、空对象、仅元数据均允许显示引导；OAuth token 跳过；损坏 JSON 返回错误；读取引导不改写登录文件，既有配置切换保留认证回归继续通过。完整前端 175 文件 / 1315 项通过，Codex 原生相关 640 项通过、2 项既有忽略；TypeScript 与 renderer 构建通过。前端覆盖推荐官方登录、API Key 限制、复制、关闭续接和两类工具卡恢复提示。

## Consequences

无法从文件证明服务端登录有效，账号恢复需用户亲自登录；不宣称修复未复现启动故障。官方依据为 https://learn.chatgpt.com/docs/auth ，API Key 不提供云端账号功能。
