# Agent Note: Codex 自动图像技能与实时模型选择

Status: implemented

## Problem

内置图像技能及能力中心固定显示并请求 gpt-image-2；客户端升级不会刷新已安装技能，新用户还必须手动启用。用户希望在聊天需要图片时自动生图、展示结果后继续原任务，并跟随平台可用最新版本，默认质量优先。

## Existing capabilities and impact

复用现有 SkillService 的 SSOT、应用同步、禁用与卸载入口，以及内置 meta-api-imagegen helper。allow_implicit_invocation 已开启，不新增聊天页或另一套技能。现有 Images Core 只为 Codex namespace 转发，模型目录路由用于文本模型，不能当作图像权限目录。

检索 active notes 的 imagegen、builtin、图像、Skills 未发现专属决定。早期 docs/reviews/2026-09-27-codex-images-compatibility.md 只覆盖原生工具的图片代理，与技能脚本部分重叠；继续保留单次 POST、不映射模型、不自动故障转移的约定。

## Decision

成功配置元衡 Codex、切换元衡及已有配置启动时自动补装或更新己方未修改的技能；保留用户禁用、卸载和外部同名内容。沿用手动按钮作为恢复入口。运行时描述仅保存本地 Core 地址，不复制平台或 OAuth 密钥。

安装、卸载、启用及备份恢复共用生命周期锁；运行时同步单独串行，在异步 Core 查询后读取当前状态，避免启动旧快照覆盖用户刚保存的禁用或模式切换。

Core 为 CLI 和桌面独立路由提供图像请求及只读图片模型目录，目录使用同一托管 provider 的真实凭据，限制时间、响应大小与重定向。helper 每次生成前读取该目录，按数字版本和质量优先排序，显式型号覆盖。目录不可读则报错，不把公共价目表当访问权限。

图像成功后内嵌本地文件并继续对话。只有明确未执行的接口不支持错误才能一次 Responses 兼容回退；未知网络结果、业务拒绝、输出保存错误不能再生成。回退携带所选图片模型，外层文本模型不被当作图片型号。自动启用不发送付费请求。

## Alternatives considered

- 固定改成 2.5 Sunburst：改动小，但下一版仍需客户端发布，不能满足自动跟随。
- 公共 pricing 目录排序：无需凭据，但可能选择当前令牌/分组无权限的模型。
- 将平台 key 写入技能目录：调用简单，但增加凭据副本并可能覆盖官方 Codex 认证；采用 Core 的既有凭据。
- 无条件重装并自动回退任意错误：体验表面简单，但会覆盖用户关闭/修改并可能重复计费。

## Verification

Node 本地 HTTP 测试 67 项通过，覆盖模型目录、数字版本排序、显式选择、两条路由、生成/编辑、无凭据外发、回退和截断 SSE。Rust 全量测试通过；配置集成测试进一步验证两种 Codex 首次配置自动安装、运行时路由和启动保留禁用选择。Clippy、前端类型/格式、完整单元测试及 renderer 构建通过。Node 25 的 Web Storage 测试环境通过 NODE_OPTIONS=--no-experimental-webstorage 对齐项目测试语义。

真实 Chromium 使用完整 App 壳和模拟 Tauri IPC，验证 1440×900 浅色、900×600 深色、刷新、未启用到启用、更新成功、处理中按钮禁用及失败重试；无横向溢出、控制台无错误。截图位于本机忽略目录 output/playwright，不提交模拟数据。

## Consequences

自动启用不调用计费接口；每次生图前增加一次有界目录读取，平台可用的新版 GPT Image 能自动被选择。当前优先 Sunburst，再考虑普通版本、未知同版本变体和 Flare/mini；未来型号语义变化时需要调整同版本质量规则。显式模型选择不强制目录预检。

Codex 自主选择技能，允许隐式调用不保证每次匹配；新技能在旧会话中可能需要重新打开会话。模型目录可用不等于上游生成一定成功；本轮没有真实付费生成或 Windows/macOS 全平台用户验收。自动升级不覆盖自定义内容，冲突需要能力中心处理；helper 需要 Node 的 fetch/FormData 支持。官方模式将已有运行时描述禁用，保留官方 auth.json。

元衡终端桥接传递对应 CODEX_HOME 和 surface；直接从外部终端启动且未传递 surface 的 Codex 与桌面共享默认路由。手动安装、启用、卸载和备份恢复同步描述；后半段失败时明确报告已完成的技能变更，并重新读取 UI 状态。
