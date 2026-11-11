# Codex 显示 OpenAI 与 OpenAI 不匹配

Codex 按 `model_provider` ID 检查聊天归属，提示框显示的是提供商名称。名称相同不代表 ID 相同。旧版本在升级或切换模式时可能把 `yuanheng-switch-official` 改成 `custom` 或 `yuanheng-switch`。

0.3.1 起保留已有托管配置的活跃 ID，避免继续改变聊天归属。此修复不会合并此前已经产生的不同 ID 历史。

## 恢复一个旧身份下的聊天

1. 安装 0.3.1 或后续版本。等待任务结束，退出 Codex App、CLI 和 Meta API，避免运行中配置被覆盖。
2. 备份 Codex 配置目录中的 `config.toml`。默认目录为 `~/.codex`；使用独立 CLI 目录时必须核对实际目录。
3. 根据该聊天会话文件 `session_meta.payload.model_provider` 确认原 ID。不要凭 OpenAI 名称猜测，不需要修改会话文件。
4. 确认配置中存在对应的 `[model_providers.<原 ID>]` 表，且与当前托管表的路由、认证设置一致。如果不同或包含用户自定义内容，停止，不要覆盖。
5. 只将配置顶层 `model_provider` 改为已确认的原 ID。例如旧聊天使用 `yuanheng-switch-official`，则设为 `model_provider = "yuanheng-switch-official"`。
6. 启动 Meta API 后启动 Codex，再打开该聊天。0.3.1 会保留这个已托管 ID。

这只恢复该 ID 的聊天，其他 ID 的聊天仍可能提示不匹配。要撤销，退出上述应用后恢复配置备份。不要删除登录、SQLite 或聊天文件；不要把当前固定迁入 custom 的历史迁移功能当作专用 ID 的修复方案。

## 验证范围

Rust 回归检查四种托管 ID 的刷新、官方切换、返回中转和清理不变。`scripts/check-codex-history-resume.py --preserve-provider yuanheng-switch-official` 在隔离目录用本机原生引擎测试合成旧聊天恢复，不调用模型、不读取用户凭据；不能代替用户现有聊天的实际恢复验收。
