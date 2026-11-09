# Codex 提示两个相同名称的提供商不匹配

Codex 保存的是提供商 ID，提示中显示的却是 name。多个配置都叫 YuanHeng 时，`yuanheng`、`yuanheng-switch-official` 和 `yuanheng-switch` 仍是不同身份。仅补齐别名定义无法通过当前原生引擎的身份检查。

新版配置投影保留已经验证为本工具拥有的活动 ID，模式切换只更新路由定义。官方模式、重配和 Core 清理均保留身份。已经分裂的旧记录需要一次离线维护；更新客户端本身不批改用户历史。

## 离线修复

本仓库提供 `scripts/repair-codex-provider-identity.mjs`，要求 Node.js 24 或更新版本、已安装仓库依赖，当前支持 macOS/Linux。在仓库目录执行：

```bash
node scripts/repair-codex-provider-identity.mjs
```

默认仅预览，输出目标 ID、可修复文件和索引数量、跳过数量。只有有限白名单内、形态符合本工具、且全部路由字段与当前提供商一致的别名参与。名称相同但地址/凭据/策略不同的第三方配置保留。官方 openai、其他供应商、认证和正文不变。

先更新 Meta API，完全退出 ChatGPT/Codex、Codex CLI 和 Meta API（包括 Core），然后在系统终端执行：

```bash
node scripts/repair-codex-provider-identity.mjs --apply
```

工具将原始文件、包含 WAL 的数据库快照和操作清单存入 Codex 目录下的 `provider-identity-backups/`，再同步 JSONL（包括 zstd 压缩记录）的 session_meta 与 SQLite provider 字段。可以用 `--home PATH` 指定独立 Codex 目录。进程检查不会绕过；已知仍有其他电脑/容器使用同一目录时不要执行。

文件缺失、文件与索引不一致、无法解析或超过 256 MiB 解码资源上限的记录会跳过，不猜测其内容。`applied: true` 只代表报告中的数量已修复，不代表跳过的记录可恢复。这些记录应恢复原文件或在原提供商环境中处理。遇到未完成的备份清单会拒绝继续写入；正常异常回滚已修改文件及数据库事务。进程被强制结束或磁盘故障时，保留备份并在停机后由维护者核对清单恢复，不覆盖运行中的数据库。

完成后重开 Meta API 与 Codex，并重新打开旧聊天。修复期间不用退出账号，不删除项目或聊天，也不调用模型。备份可能包含聊天内容和配置，请仅保留在本机。

## 验证

```bash
node --test scripts/test-repair-codex-provider-identity.mjs
python3 scripts/check-codex-history-resume.py --codex /path/to/codex
```

原生测试在临时 CODEX_HOME 中重现别名不匹配，离线修复后检查官方、中转及原生清理模式的恢复。只调用 thread/start 和 thread/resume，不调用 turn/start，不复制真实凭据。
