# Agent Note: 跨客户端聊天项目归档与迁移中心

Status: proposed

## Problem

用户长期在 ChatGPT 中积累了大量项目（Projects）与聊天记录，现在转用 Claude 桌面端（Claude Desktop）和 Claude Code。期望：打开 Claude 客户端时，之前 ChatGPT 的项目和聊天记录也能"看得到、用得上"，而且这条迁移路径对其他客户端组合（Claude → ChatGPT、桌面 → 手机、换电脑）也成立。

两个硬约束决定了方案形态：

1. ChatGPT 网页/桌面端的项目与聊天保存在 OpenAI 云端。桌面端本地只有加密的私有缓存，没有可读的会话文件；唯一官方、稳定、不依赖登录态的出口是"设置 → 数据控制 → 导出数据"生成的 zip（含 `conversations.json`）。
2. Claude Desktop 与 claude.ai 的聊天同样在 Anthropic 云端，没有导入接口，也没有把外部记录注入原生侧栏的途径。它能"看到"外部数据的受支持通道只有 MCP 工具，以及 Claude Projects 的知识文件上传。

因此"在 Claude 客户端上展示 ChatGPT 项目记录"不能理解为改写 Claude 客户端的列表，而要理解为：Meta API 桌面端成为所有来源的本地归档中心，再通过 MCP 把归档按需喂给 Claude Desktop / Claude Code，并提供可上传到 Claude Projects 的交接包。失败条件：若只做"桌面端内浏览"，用户在 Claude 里仍然摸不到旧记录；若走非官方抓取接口，会违反项目既有的凭据与隐私边界。

## Existing capabilities and impact

- **会话管理页**（侧栏"会话与用量"）：[SessionManagerPage](../../../../src/components/sessions/SessionManagerPage.tsx) 调 [sessionsApi](../../../../src/lib/api/sessions.ts) → [commands/session_manager.rs](../../../../src-tauri/src/commands/session_manager.rs) → [session_manager/mod.rs](../../../../src-tauri/src/session_manager/mod.rs)。七个 provider 适配器并行扫描本地文件，统一为 `SessionMeta { provider_id, session_id, title, summary, project_dir, created_at, last_active_at, source_path, resume_command }`，前端用 FlexSearch 对元数据做搜索，列表支持 flat / grouped（按 provider + 目录）两种视图，详情复用 `SessionMessageItem`。它是本方案的展示层复用对象，但当前模型是"文件即会话"，没有"项目"实体，也没有持久索引。
- **Claude 本地会话解析**：[providers/claude.rs](../../../../src-tauri/src/session_manager/providers/claude.rs) 只读 `~/.claude/projects/**/*.jsonl`，这是 Claude Code 的会话，不是 Claude Desktop 的聊天。
- **Codex 统一会话历史**（[指南](../../../../docs/guides/codex-unified-session-history-guide-zh.md)）解决的是同一工具内官方/第三方标签分列的问题，与跨产品迁移无关，但其"改写前先备份、可精确还原"的原则沿用。
- **MCP 管理**：[services/mcp.rs](../../../../src-tauri/src/services/mcp.rs) 把 `mcp_servers` 表按应用物化到 Claude Code / Codex / Gemini 等配置；对 `AppType::ClaudeDesktop` 明确跳过同步（Claude Desktop 3P 配置由 [claude_desktop_config.rs](../../../../src-tauri/src/claude_desktop_config.rs) 单独负责模型路由）。本方案需要往 Claude Desktop 的 `claude_desktop_config.json` 写入**一个**自有 MCP 服务，必须作为显式、单项、可撤销的写入，不打开通用 MCP 同步。
- **Core sidecar**：[src-tauri/src/bin/yuanheng-core.rs](../../../../src-tauri/src/bin/yuanheng-core.rs) 已作为独立二进制随应用分发，可承载 stdio MCP 子命令。
- **数据库**：主库 `~/.yuanheng-switch/yuanheng-switch.db`（rusqlite bundled）。`profiles` 表是"配置快照"意义上的项目实体，与聊天项目语义不同，不复用。
- **备份/同步**：[WebdavSyncSection](../../../../src/components/settings/WebdavSyncSection.tsx) 与 S3 同步覆盖主库快照，可作为归档库跨设备同步的既有通道。
- **已有笔记检索**：`rg --hidden -i 'chatgpt|导入会话|会话管理' .agents/notes` 无重叠提案；[session-manager.md](../../../../session-manager.md) 是会话页的原始 PRD，其 Backlog 列有"按项目聚合（Repo 视图）"与"导出 Markdown/JSONL"，本方案吸收这两项。[移动端架构](../../implemented/architecture/2026-10-19-mobile-clients.md)部分相关：归档库日后可经 Core 供手机端读取，本篇不展开。

## Proposal

### 1. 目标与非目标

目标：
- 任何客户端的聊天项目与记录都能进入本机的"聊天归档库"，在 Meta API 桌面端按来源 → 项目 → 会话浏览、全文搜索、导出。
- Claude Desktop / Claude Code 通过 MCP 直接检索并读取归档，用户在 Claude 里说"接着我 ChatGPT 里的 XX 项目做"即可拿到上下文。
- 一键生成"项目交接包"（Markdown），可直接上传到 Claude Projects 知识库或 ChatGPT Projects 文件区，完成项目级迁移。
- 方向对称：Claude.ai 导出包同样可导入，反向迁移走同一条路。

非目标：
- 不改写任何客户端的原生会话列表，不注入对方数据库。
- 不用登录态调用 chatgpt.com / claude.ai 的非公开后端接口，不读取桌面端加密缓存。
- 不承诺"续聊"：ChatGPT 对话不能原样在 Claude 中继续，只能作为上下文引用。
- 默认不上传归档内容；云同步仅在用户开启 WebDAV/S3 时按选项纳入。

### 2. 总体架构

```text
来源                        归档库（本机）                      消费方
ChatGPT 导出 zip ─┐                                   ┌─ Meta API 桌面端：会话与用量页浏览/搜索/导出
Claude.ai 导出 zip ─┼→ 导入器 → archive.sqlite(FTS5) ─┼─ MCP 归档服务 → Claude Desktop / Claude Code / 其他 MCP 客户端
本地 CLI 会话扫描 ─┘  (现有 7 个 provider 以只读视图接入)   └─ 项目交接包 (.md 目录/zip) → Claude Projects / ChatGPT Projects 上传
```

- 归档库是独立文件 `~/.yuanheng-switch/archive/archive.sqlite`，不并入主库：体量大（百 MB 级）、属用户内容、备份策略不同。
- 现有本地扫描 provider 不迁入归档库，仍由文件扫描提供；会话页把两者合并呈现，归档库条目用 `provider_id = "chatgpt" | "claude-ai"` 区分，`source_path` 用 `archive:<conversation_id>` 前缀复用现有 `load_messages` 分派模式（与 `sqlite:` 前缀同理）。

### 3. 数据模型

```sql
archive_sources       (id, kind TEXT CHECK(kind IN ('chatgpt-export','claude-export')), account_label, file_name, file_sha256, exported_at, imported_at)
archive_projects      (id, source_kind, external_id, name, instructions, created_at, updated_at, UNIQUE(source_kind, external_id))
archive_conversations (id, source_kind, external_id, project_id NULL, title, model, created_at, updated_at, message_count, preview, raw_json, UNIQUE(source_kind, external_id))
archive_messages      (conversation_id, seq, role, content_md, content_type, ts, raw_json)
archive_messages_fts  (FTS5: title, content_md)  -- rusqlite bundled 是否默认启用 FTS5 需实现时确认，否则退回 LIKE + 前端 FlexSearch
archive_attachments   (conversation_id, message_seq, file_name, mime, size, stored_path NULL)
```

规则：
- 以 `(source_kind, external_id)` 去重；重复导入时 `updated_at` 更新者覆盖，旧版本不保留历史（导出包本身就是全量快照）。
- `raw_json` 保留原始条目，便于后续解析器升级后重建派生字段，不需要用户重新导出。
- 项目归属：ChatGPT 的 `conversations.json` 中项目会话带 `gizmo_id`（`g-p-` 前缀）；导出包是否包含项目名称需用用户真实导出包核验。若缺失，导入向导按 `gizmo_id` 分组展示每组前几条标题，让用户命名；命名结果持久化，再次导入自动沿用。Claude.ai 导出包有 `projects.json`，会话与项目的关联字段同样待核验。

### 4. 导入器

- 入口：会话与用量页工具栏"导入聊天记录"，以及设置 → 导入导出同一入口。
- 流程：选择 zip 或已解压目录 → Rust 侧流式解析（`zip` crate 已在依赖中；`conversations.json` 可达数百 MB，用 `serde_json::StreamDeserializer` 逐条处理，不整体读入内存）→ 预览（来源、账号、项目数、会话数、消息数、时间范围、与库内重叠数）→ 未命名项目命名 → 写入事务 → 结果摘要。
- ChatGPT 线性化：每个会话是 `mapping` 树，从 `current_node` 回溯到根得到当前分支；被放弃的分支不导入，但 `raw_json` 保留整棵树。`content_type` 覆盖 `text`、`code`、`multimodal_text`、`execution_output`、`tether_browsing_display` 等，未知类型降级为 JSON 文本并标记。`author.role = system/tool` 的空消息和隐藏元消息跳过。
- 附件：zip 内与 `file-` 指针匹配的文件复制到 `archive/attachments/`，缺失的仅记录名称。
- 容错：单会话解析失败不中断整包，收集到结果摘要；导入前对库做一次 `VACUUM INTO` 备份到 `~/.yuanheng-switch/backups/archive/<时间戳>/`，沿用 Codex 统一历史的"改前先备份"原则。

### 5. 会话页展示

- grouped 视图新增来源层级：`ChatGPT / Claude.ai` → 项目 → 会话；未归入项目的会话落在"未分类"。flat 视图直接混排，按 `last_active_at` 排序。
- 搜索：归档来源走 Rust 侧 FTS 查询返回命中片段，与现有 FlexSearch 元数据搜索合并结果；FlexSearch 不再索引归档全文，避免前端内存膨胀。
- 详情：复用 `SessionMessageItem` 与目录（TOC）；去掉"在终端恢复"（归档会话无 `resume_command`），新增"复制为 Markdown""导出此会话""导出整个项目交接包""复制 Claude 引导语"。
- 项目卡：显示项目说明/指令（ChatGPT Project instructions、Claude Project prompt_template），这是迁移时最该带走的内容。

### 6. MCP 归档服务（让 Claude 客户端"看见"）

- 形态：`yuanheng-core mcp archive` stdio 子命令，无网络监听，仅读 `archive.sqlite`。stdio 对 Claude Desktop 与 Claude Code 都是零配置路径，且不扩大 Core 的 HTTP 暴露面。
- 工具（返回体限长，默认 8k 字符，支持分页）：
  - `archive_list_projects(source?)`
  - `archive_list_conversations(project_id?, source?, query?, since?, limit, cursor)`
  - `archive_search(query, limit)`：返回会话标题 + 命中片段 + id
  - `archive_get_conversation(id, format = markdown|json, from_seq?, max_chars)`
  - `archive_get_project_brief(project_id)`：项目说明 + 会话列表 + 各会话一句话预览，供"接着这个项目做"一次拿齐
- 工具描述明确写"当用户提到在 ChatGPT / Claude.ai 里聊过的内容、旧项目、之前的方案时调用"，让模型自发使用。
- 接入：会话页顶部"连接到 Claude Desktop / Claude Code"按钮。Claude Code 走现有 `mcp_servers` 表 + `enabled_claude` 物化；Claude Desktop 走 `claude_desktop_config.rs` 新增单项写入 `mcpServers["meta-api-archive"]`，写前备份原文件，按钮可一键移除。不改变 `services/mcp.rs` 对 ClaudeDesktop 的跳过策略。
- 引导：连接成功后给出可复制的首句提示，例如"用 archive 工具列出我在 ChatGPT 的项目，然后读取《XX》项目简报"。

### 7. 项目交接包

- 输出目录结构：`<项目名>/README.md`（项目说明、指令、会话索引、时间范围）+ `conversations/<日期>-<标题>.md`（角色标注的对话全文，代码块保留）+ `attachments/`。可选打成 zip。
- 用途说明写在 README 顶部：上传到 Claude Projects 的知识文件，或 ChatGPT Projects 的文件区。单文件超过目标平台上限时自动按会话拆分，并在 README 标注。
- 可选摘要（后期）：用用户的 Meta API 账号经 Core 为每个会话生成 200 字摘要写入 README，默认关闭，开启前显示预计消耗。

### 8. 跨设备与反向迁移

- 归档库纳入 WebDAV / S3 同步作为独立开关（默认关），同步整文件而非增量；冲突以 `imported_at` 新者为准。
- Claude.ai 导出包导入走同一导入器，产出同样可被 ChatGPT Projects 使用的交接包。ChatGPT 侧目前仅支持远程 MCP 连接器，本机 stdio 不可用，暂不做 ChatGPT 端 MCP 接入。

### 9. 分期

- M1：ChatGPT 导出包导入、归档库、会话页来源/项目分组、FTS 搜索、单会话 Markdown 导出。先用用户真实导出包校验字段假设。
- M2：MCP 归档服务，Claude Code / Claude Desktop 一键接入与移除，引导语。
- M3：Claude.ai 导出包导入、项目交接包、重复导入增量、归档备份与还原入口。
- M4（可选）：WebDAV/S3 纳入、本地摘要、监听下载目录自动识别新导出包。

### 10. 开放问题

- ChatGPT 导出包中项目名称是否可得、Claude 导出包中会话与项目的关联字段，均以真实样本为准。
- FTS5 在当前 rusqlite 构建中是否可用。
- `claude_desktop_config.json` 在 `Claude` 与 `Claude-3p` 两套目录下的写入目标选哪一个：按当前工具管理里 Claude Desktop 的生效模式决定，两者都存在时都写。

## Alternatives considered

- **用登录态调用 chatgpt.com 非公开 backend-api 直接拉取会话** — 最强论据是免去手动导出、可实时同步。否决：违反服务条款、接口无契约随时变化，且需持有用户会话令牌，与本项目"不导出登录授权、不读取非公开接口"的既有边界（见 TRAE 系列笔记）冲突。
- **解析 ChatGPT 桌面端本地缓存** — 零操作成本。否决：缓存加密且无文档，版本一变即失效，与"不解密官方数据库"的原则冲突。
- **把归档条目直接写进现有 `~/.claude/projects` JSONL 伪装成 Claude Code 会话** — 可让 `claude --resume` 直接续聊。否决：伪造的会话格式会被 Claude Code 后续版本拒绝或污染其索引，且 Claude Desktop 根本不读这个目录，解决不了主诉求。
- **只在 Meta API 桌面端内展示，不做 MCP** — 实现最简。否决：用户的核心诉求是在 Claude 客户端里能用上，不接 MCP 等于迁移只完成一半；列为 M1 的中间态而非终态。
- **HTTP（streamable）MCP 挂在 Core 的 axum 服务上而非 stdio** — 好处是手机端和远程客户端也能接。否决（本期）：扩大网络暴露面、需要鉴权与令牌下发，Claude Desktop 对本机 stdio 的支持更稳定；留作 ChatGPT 远程连接器或手机端需求出现时再评估。
- **归档表并入主库 `yuanheng-switch.db`** — 省一个文件与连接管理。否决：主库参与 WebDAV 快照与升级迁移，塞入百 MB 用户内容会拖慢同步并混淆备份语义。

## Acceptance criteria

- 用真实 ChatGPT 导出包导入后，会话页能按项目分组看到全部会话，消息顺序、代码块与时间与网页一致；重复导入不产生重复条目。
- 全文搜索在 1 万条消息规模下 300 ms 内返回命中片段。
- 在 Claude Desktop 中新开对话，提问"我在 ChatGPT 有哪些项目"，模型通过 MCP 工具返回项目列表；"读取 XX 项目简报"返回项目说明与会话索引；移除接入后工具不再出现，`claude_desktop_config.json` 其余内容逐字节不变。
- 交接包上传到 Claude Projects 后，项目说明与任意一次会话全文可被引用。
- 全程无出站请求（可选摘要除外），归档目录不进入默认备份快照；导入失败或解析异常不影响现有本地会话扫描。

## Risks

- 导出格式由 OpenAI / Anthropic 单方变更：解析器按版本号分支并保留 `raw_json`，变更后只需升级解析器重建派生表。
- 会话内容含密钥、个人信息：导入预览提示；交接包导出时提供可选的敏感信息遮罩（沿用 PRD 第 7 节的正则策略）。
- 大导出包导入耗时：后台任务 + 进度 + 可取消，写入分批事务。
- Claude Desktop 改变 MCP 配置格式或路径：写入逻辑集中在 `claude_desktop_config.rs`，并以备份文件支持还原。
- 用户误以为能"续聊"：界面与引导语统一措辞为"作为上下文引用"，不出现"恢复/继续"字样。
