# Agent Note: 本机 AI 工具间项目会话一键同步

Status: proposed

## Problem

Meta API 为同一台电脑上的十余个 AI 编码客户端（Claude Code、Claude Desktop、Codex CLI/桌面版、Gemini CLI、Grok Build、OpenCode、OpenClaw、Hermes、WorkBuddy、DSH、Accio Work 等）配置模型。用户在其中任何一个里积累了项目聊天记录后，切换到另一个客户端就等于从零开始：对方看不到历史会话，用户只能复述。用户要的是：在 Meta API 里给某个客户端配好模型、点"启动"，程序发现"这个项目在其他客户端里有聊天记录而这里没有"，弹一个只需点一次的提示，确认后记录就出现在目标客户端自己的历史列表里，可以直接接着聊。任意两个客户端之间都应如此，不限于某一对。

失败条件：需要手动导出导入；需要理解 provider、文件路径或格式；同步损坏或覆盖对方客户端的原始记录；同步后目标客户端无法续聊；每新增一个客户端都要改所有已有客户端的转换代码。

本篇取代同日已删除的"导出包归档中心"方案，那篇把需求误解为跨设备、跨云端产品的迁移。用户随后两次澄清：同一台机器、Meta API 一键完成、覆盖全部已配置客户端而非特定两个。

## Existing capabilities and impact

- **读取侧已基本就绪**：[session_manager/mod.rs](../../../../src-tauri/src/session_manager/mod.rs) 并行扫描 7 个 provider（codex、claude、opencode、openclaw、gemini、hermes、grokbuild），统一为 `SessionMeta`，`load_messages` 按 provider 分派读出 `SessionMessage { role, content, ts }`。这就是同步的"源端读取"，不另写。
- **会话页**：[SessionManagerPage](../../../../src/components/sessions/SessionManagerPage.tsx) 的 grouped 视图按 provider + 目录分组，是同步状态与手动入口的位置。
- **启动入口**：[FocusToolCard](../../../../src/components/desktop/FocusToolCard.tsx) 与工具管理的启动按钮 → [launchTool](../../../../src/lib/api/yuanheng.ts) → [launch_tool](../../../../src-tauri/src/commands/misc.rs)，带 `tool` 与可选 `cwd`。同步检查挂在这条链前。
- **各客户端本地存储（本机核对 + 适配器源码）**：

  | 客户端 | 会话位置 | 目录字段 | 恢复方式 | 写入可行性 |
  | --- | --- | --- | --- | --- |
  | Claude Code（CLI，Claude Desktop 内置模式待核验） | `~/.claude/projects/<编码cwd>/<uuid>.jsonl` | 每行 `cwd` | `claude --resume <id>` | 探针通过 |
  | Codex CLI / Codex Desktop（共用 `~/.codex`） | `sessions/年/月/日/rollout-*.jsonl`，索引 `state_5.sqlite` | `session_meta.cwd` | `codex resume <id>` | 探针通过，首次 resume 自动登记索引 |
  | Gemini CLI | `~/.gemini/tmp/<hash>/chats/*.json` + `.project_root` | `.project_root` | `gemini --resume <id>` | JSON 单文件，预期可写 |
  | Grok Build | `sessions/<编码项目>/<id>/chat_history.jsonl` + `summary.json` | 目录名 | `grok --resume <id>` | JSONL + 摘要，预期可写 |
  | OpenCode | `opencode.db`（session/message/part 表）或 `storage/` JSON | `session.directory` | 无 CLI 参数，列表内选择 | 需写 SQLite 三表，中等 |
  | Hermes | `state.db` sessions 表 + `sessions/` | `cwd`/`directory` | 待核验 | 需写 SQLite，中等 |
  | OpenClaw | `agents/<agent>/sessions/*.jsonl` + `sessions.json` 索引 | 无稳定目录字段 | 网关管理，无 CLI 恢复 | 可写文件和索引，恢复路径待核验 |
  | Claude Desktop 云端聊天、WorkBuddy、DSH、Accio Work、TRAE | 云端或未调研 | — | — | 本期只做"读"（若有本地记录）或不参与 |

- **可行性探针（2026-11-03，本机，已清理）**：向 `~/.claude/projects/` 写入仅含 `custom-title` + 一轮 user/assistant 的合成文件，`claude -p --resume` 正确回忆合成内容；向 `~/.codex/sessions/` 写入仅含 `session_meta` + 一轮消息的合成 rollout，`codex exec resume` 正确回忆，且 Codex 自动把线程登记进 `state_5.sqlite`，`codex delete --force` 可清除。结论：最小子集格式足以续聊，不需伪造工具调用、thinking 或请求元数据；这一结论作为其余客户端写适配器的实现范式。
- [Codex 统一会话历史](../../../../docs/guides/codex-unified-session-history-guide-zh.md)与本方案互不干扰，其"改前备份、精确还原"原则沿用。[profile.rs](../../../../src-tauri/src/services/profile.rs) 的 Profile 是配置快照意义上的项目，与聊天项目无关，不复用。
- 已有笔记检索 `rg --hidden -i '会话同步|session sync|rollout' .agents/notes` 无重叠。

## Proposal

### 1. 用户看到的全部内容

- **启动时一次询问**。点任一客户端的"启动"，若当前目录（或全部目录）在其他客户端里有未同步到此客户端的会话，弹窗：

  > 「yuanheng」这个项目在 **Codex 有 54 次**、**Gemini 有 6 次** 聊天，还没带到 Claude Code。
  > [全部带过来并启动]  [直接启动]  [这个项目不再提醒]

  确认后显示进度，完成后直接启动。来源多于一个时逐行列出，仍然一个按钮。
- **一个总开关**。设置 → 通用 → "自动同步各客户端的聊天记录"，默认开。关掉后启动不询问，会话页仍可手动同步。
- **会话页状态与手动入口**。grouped 视图的每个目录组显示"已同步到 3 个客户端 / Codex 有 2 条待同步"徽标与"立即同步到…"按钮；同步生成的会话带来源角标（`来自 Codex`）；详情页提供"撤销这次同步"。
- 文案不出现 provider、rollout、jsonl、uuid；只说"Codex 里的聊天""带到 Claude Code"。

### 2. 星形架构：一个中间格式，每客户端两个适配器

```text
Claude Code ─ 读 ─┐                          ┌─ 写 ─ Claude Code
Codex       ─ 读 ─┤                          ├─ 写 ─ Codex
Gemini      ─ 读 ─┼→ 通用会话 (CanonicalSession) ─┼─ 写 ─ Gemini
OpenCode    ─ 读 ─┤        + 同步账本            ├─ 写 ─ OpenCode
…           ─ 读 ─┘                          └─ 写 ─ …
```

- `CanonicalSession { origin: (provider, id), project_dir, title, created_at, updated_at, turns: [ {role: user|assistant, text, ts} ] }`。
- 读适配器：现有 `scan_sessions` + `load_messages` 后接一层清洗（见 §4），不改现有函数。
- 写适配器：新 trait `SessionWriter { fn write(&CanonicalSession) -> TargetRef; fn fingerprint(&TargetRef); fn remove(&TargetRef) }`，每客户端一个文件。新增客户端只需实现这一个 trait，其他客户端自动与之互通。
- 任意源 → 任意目标都走同一条链，不存在成对转换器。

### 3. 同步单位与匹配

- **单位是工作目录**。各客户端的目录字段规范化（`realpath`、尾斜杠、`/tmp` → `/private/tmp`）后相等即同一项目。Codex 的命名项目、Grok 的编码目录、Gemini 的 `.project_root` 都归一到绝对路径；OpenClaw 这类没有稳定目录字段的客户端，其会话只能作为"未关联目录"手动同步，不参与启动时自动匹配。
- **默认范围**：未归档、最近 90 天、每目录每来源最多 100 条、轮次 ≥ 2；子代理会话（Claude 的 `agent-*`、Codex 的 `source.subagent`）与空会话永不同步。弹窗"更多选项"可放开范围。
- **身份映射**：目标会话 ID 由 `(源 provider, 源 id, 目标 provider)` 经 UUID v5 确定性派生，重复同步永远落到同一目标，天然幂等。
- **不做传递同步**：由同步生成的会话不再作为源同步到第三个客户端，避免 A→B→C 产生第二份 A 的副本；C 直接从 A 取。

### 4. 内容清洗（通用，不随客户端变化）

只保留 user 文本与 assistant 文本，工具调用折叠为一行 assistant 文本（`（执行了 shell：git status）`），结果不带。剔除各客户端注入的上下文与元行：Codex 的 `# AGENTS.md instructions`、`<app-context>`、IDE 上下文；Claude 的 `<local-command-caveat>`、`isMeta` 行；Gemini 的 toolCalls 结构；其余客户端在实现各自读清洗时补充。thinking、附件、文件快照、用量全部丢弃。标题加来源前缀 `[Codex] `。

### 5. 写适配器要点

- **Claude Code**：`~/.claude/projects/<编码 cwd>/<id>.jsonl`，`custom-title` 行 + user/assistant 行，`parentUuid` 链与 `cwd`、`timestamp` 按源填。目录编码规则（空格等）以 Claude Code 实际行为为准并补单测。
- **Codex**：`sessions/<源时间 年/月/日>/rollout-<时间>-<id>.jsonl`，`session_meta`（`cwd`、`originator: "meta-api-sync"`、`model_provider` 取 Meta API 当前为 Codex 写入的标识，使其出现在当前供应商的历史列表）+ `response_item.message`。不写 `state_5.sqlite`；Codex Desktop 列表在首次 resume 前是否显示待核验，不显示则提示用户用 `codex resume <id>` 打开一次。
- **Gemini / Grok Build**：按现有读适配器反向生成单文件 JSON / JSONL + 摘要文件。
- **OpenCode / Hermes**：只在目标 SQLite 存在且 schema 版本与读适配器已知版本一致时写入最小列集，否则该方向标记"暂不支持"并在会话页说明；不触碰迁移表。
- **OpenClaw**：写会话文件与 `sessions.json` 索引项；恢复路径核验后再决定是否开放。
- 每个写适配器附带"探针用例"：写入最小合成会话 → 调用该客户端的恢复命令 → 断言回忆内容 → 清理。作为集成测试在客户端版本变更后重跑。

### 6. 同步账本与增量

主库新增 `session_sync_links(source_provider, source_id, target_provider, target_ref, source_fingerprint, target_fingerprint, status, synced_at, PRIMARY KEY(source_provider, source_id, target_provider))`。

- 待同步：源不在账本，或 `source_fingerprint`（文件大小 + 尾行哈希，SQLite 源用 `updated_at` + 消息数）已变。
- 增量：源有新内容且目标指纹未变 → 整体重写目标；目标已被续聊 → `status = diverged`，保留目标不动，会话页显示"两边都有新内容"，不再自动覆盖，不尝试合并。
- 撤销：目标指纹未变则删除目标并清账本；已续聊的只解除链接。
- 只增不改：永远只创建或重写由本程序生成的目标；每次同步前把账本快照写入 `~/.yuanheng-switch/backups/session-sync/`。

### 7. 启动链路

`launch_tool` 前增加 `check_session_sync(target_tool, cwd?) -> [{source_tool, dir, pending_count}]`；弹窗决策走 `run_session_sync(target_tool, scope)`，Rust 后台线程执行并上报进度；"不再提醒"按（目录, 目标工具）写 settings；完成或失败都继续原有 `launch_tool`，失败只 toast。无 `cwd` 的启动按全部目录汇总。

### 8. 分期

- M1：`CanonicalSession` + 读清洗 + `SessionWriter` trait + Claude Code、Codex 两个写适配器（探针已验证）+ 账本 + 会话页状态/手动同步/撤销。
- M2：启动前检测弹窗、总开关、不再提醒。
- M3：Gemini、Grok Build 写适配器；增量与分叉；Codex Desktop 可见性核验。
- M4：OpenCode、Hermes、OpenClaw 写适配器（各自核验后逐个开放）；WorkBuddy / DSH / Accio Work 本地记录调研；后台定时检测（可选）。

## Alternatives considered

- **归档中心 + MCP 让各客户端自行检索旧记录**（已删除的前版）— 不碰任何客户端格式，升级零风险。否决：记录不会出现在目标客户端的历史列表，用户还要在对话里主动调工具，违背"一键"诉求；仅适合没有本地文件的云端产品，本期不做。
- **成对转换器（Codex→Claude、Claude→Codex…）** — 每对可做到最高保真。否决：客户端数 N 增长时转换器是 N×(N-1) 个，新增一个客户端要改所有已有的；用户已明确要全客户端互通。星形架构下保真度损失在于中间格式只留文本，而探针证明文本足以续聊。
- **直接写各客户端的索引数据库（如 Codex `state_5.sqlite`）让列表立即可见** — 可见性最好。否决：这些库带迁移版本、触发器、外键，升级随时破坏；Codex 探针证明 resume 时自行登记。仅在核验发现列表确实不显示时，对单个客户端评估最小列插入。
- **启动时静默全量同步，不弹窗** — 更无感。否决：续聊转换后的长会话会整段重发历史并计费，用户应知情，且可能不想让某些聊天出现在另一边；一次性弹窗 + 总开关是最小打扰。
- **原样复制文件再改字段，不做中间格式** — 保真最高。否决：格式差异大，会带入工具专属的 thinking、快照、请求 blob，既膨胀又可能被目标拒绝，且无法推广到 N 个客户端。

## Acceptance criteria

- 在同时有 Codex 与 Claude Code 记录的机器上，启动任一方出现弹窗并正确显示目录名、各来源数量；确认后目标客户端的历史列表出现带来源前缀的会话，续聊时模型能回忆同步内容。M3 起对 Gemini、Grok Build 同样成立。
- 新增一个客户端的写适配器后，它与所有已有客户端双向互通，不改动其他适配器代码。
- 重复同步不产生第二份；源新增后再次同步更新目标；目标被续聊后不再覆盖并显示分叉；撤销后目标删除、账本清空。
- 任何操作不修改客户端自己写的文件（同步前后其他文件哈希相等）。
- 关闭总开关后不弹窗；"不再提醒"按目录 + 目标生效。
- 全程无网络请求；100 条会话同步在 3 秒内完成。

## Risks

- 各客户端本地格式无契约：写适配器各自独立，探针用例作为集成测试，客户端升级后重跑；某一客户端格式变化只影响它自己的方向。
- 续聊转换后的会话整段重发历史、无缓存命中：弹窗"更多选项"显示预计消息数，默认范围已限制。
- 目录编码、Codex Desktop 列表可见性、Claude Desktop 内置 Claude Code 的目录归属、OpenCode/Hermes schema 稳定性均未核验，列为各期首批任务，核验失败只调整写入位置不改交互。
- 用户在多端同时续聊同一会话产生分叉：只提示不合并。
