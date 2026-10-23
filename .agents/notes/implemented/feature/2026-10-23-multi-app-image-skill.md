# Agent Note: 多应用图像技能与本机绑定

Status: implemented

Scope update: [独立图像分组](../bug-fix/2026-10-23-independent-image-group.md) 部分替代仅复用聊天凭据的限制；本篇的每目标投影、绑定、启停、宿主和导出边界继续有效。

## Problem

自动图像技能目前只接入 Codex。用户希望 DSH、WorkBuddy 及其他支持技能的工具也可在聊天中按需调用，沿用最新可用版本、质量优先策略。聊天模型品牌不应决定能否调用独立 Images API。

## Decision

复用同一个内置 Skill、选模 helper、SkillService 安装记录、备份及回滚。仅在技能域引入目标适配，扩展 SkillApps 的 DSH/WorkBuddy 字段，不把桌面工具塞进所有聊天协议共用的 AppType。

每应用使用独立 copy 投影和无密钥 binding，绑定本机稳定 runtime 文件；runtime 仅指向同一应用的 Core 图片路由。helper 通过绑定入口执行，缺失或失效时不借用 Codex 凭据。Core 从各工具既有托管配置读取凭据，不新增 Key 副本或文本 provider。新增非 Codex 目标只用 Images API，避免 Responses 回退进入聊天映射或重试链。

OpenCode 会读取 Claude 的技能目录，单凭技能文件所在目录不足以识别宿主。官方稳定版 [启动入口](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/index.ts#L75-L77) 设置 OPENCODE=1，[shell 工具](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/tool/shell.ts#L416-L425) 继承该环境。因此 launcher 在检测到该标识时只接受 OpenCode 绑定，跨目录发现其他客户端技能会在 HTTP 前拒绝，显式参数也不能绕过此入口校验；不使用缺少可靠注入的 OPENCODE_CLIENT 猜宿主。

支持现有六个技能客户端，以及 DSH 和 WorkBuddy 代码开发模式。DSH 使用当前 DSH_HOME/skills；WorkBuddy 官方证实代码开发模式读取 ~/.codebuddy/skills，此目录也被 CodeBuddy Code 使用。办公模式提供本机 ZIP 导入包，包内绑定稳定 runtime 路径，不能把文件复制等同于办公模式自动安装。图像展示遵循宿主的图片或结果预览能力；纯文本模型不伪装视觉检查。

能力中心的图像卡片使用 activeTool 和专用状态/启停/导出 API，其他能力保持既有 core AppId。自动安装保留每目标的关闭意图和全局卸载记录。应用配置、恢复、启动及手动启停都同步运行时；未知同名文件或外部修改保留。

## Existing decisions

[Codex 自动图像技能](../../implemented/feature/2026-10-23-automatic-image-skill.md) 部分重叠，保留其实时目录、质量排序、单次请求、官方登录保护；本篇扩展目标和投影绑定，替代仅 Codex 的启用范围。DSH 安装和配置所有权决定继续负责其配置文件，图像路由只读复用，不改变文本配置协议。

## Alternatives considered

- 向全局 AppType 加 DSH/WorkBuddy：可复用更多通用接口，但会扩大所有 provider、提示词、代理和协议分支；采用技能域适配。
- 独立安装注册表：局部更快，但会形成第二套启用状态，卸载和备份容易遗漏；复用 SkillApps/InstalledSkill。
- 所有应用共享符号链接和 Codex runtime：文件少，但无法保证请求使用对应账号；内置技能采用独立投影绑定。
- 在 ZIP 内固定 Core 端口或复制 Key：导入直接可用，但端口变化后过期或增加凭据副本；仅绑定本机稳定无密钥 runtime 文件。

## Verification

- DSH、WorkBuddy 和其余新目标的本地 HTTP 回归确认使用各自凭据；失效配置、已关闭技能及未知 namespace 均本地拒绝。没有真实付费图像调用。
- 安装、每目标关闭、全局卸载、备份恢复、升级、未知同名目录、绑定篡改和 DB 写失败回滚测试通过。数据库 v21 沿用既有缺表迁移约定，55 项数据库测试通过。
- helper 106 项测试通过，包括绑定丢失、跨应用、导入副本随端口变化、OpenCode 跨目录发现的零请求拒绝、最新版本质量排序和不重复生成。
- Rust 全量 2451 项单元测试及 116 项集成测试通过，3 项既有忽略项；Clippy -D warnings、Rust 格式检查通过。新增宿主约束嵌入后再次完整重验通过。
- 前端 153 文件 1013 项测试、typecheck 和 renderer build 通过；最终范围文案再跑 17 项专项。完整 App 在 Chromium 的模拟 IPC 环境验证实际工具选择、toggle/update/export、失败时清除旧 ready、800×650 暗色无横溢及刷新持久化，目视截图与 console 无错误；不代表原生 WorkBuddy 导入已验收。
- 导出从生命周期锁内取得完整只读快照再写 ZIP；Core 端口更新与 v1/v2 描述文件同锁发布，用 generation 防止较旧异步状态覆盖新端口。

## Consequences

WorkBuddy 未在本机安装，办公模式原生导入与展示暂缺本机验收条件；不能声称办公模式自动发现已验证。共享 .codebuddy 目录可能被 CodeBuddy Code 同时发现，此技能明确使用元衡 WorkBuddy 连接。ZIP 绑定当前电脑，跨电脑需要重新配置和导出。外部工具安装仍需要可执行 Node，托管 DSH 已提供私有运行时。

选择统一 ~/.agents/skills 存储时，DSH 优先加载自身 skills 中的绑定副本；关闭 DSH 后，共享源仍可能出现在发现列表，但因缺绑定且路由已关闭而拒绝执行。此处关闭的是实际调用能力，不承诺删除其他宿主扫描到的共享源条目。由 OpenCode 嵌套启动其他工具并继承 OPENCODE=1 时也会拒绝非 OpenCode 绑定，应从该工具自己的独立会话使用。

OpenCode 稳定版并发加载同名技能，不能保证自己的目录优先于 Claude 目录。若宿主发现了别的副本，入口会明确拒绝并要求使用 OpenCode 自身安装路径；不通过清除宿主标记或借用别的账号绕过。原生 WorkBuddy 办公导入及实际付费图像生成仍需相应环境验收。
