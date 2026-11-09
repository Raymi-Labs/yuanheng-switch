# Codex 本地项目列表恢复

项目列表在 API Key / ChatGPT 登录切换后变化，不一定表示项目被删除。已观察到的客户端版本会把原登录的界面状态保存在 `.codex-global-state.json` 的历史账号区；SQLite 中仍有项目也不能证明当前侧栏正在使用它们。首次设置提示同样不能单独证明配置文件损坏。

在 Meta API 工作台选择 Codex CLI 或 Codex App，点击“检查本地项目”。检查只读取本机文件，显示历史登录中可以补充的项目数和会话归属数。确认这些是需要找回的本地项目后：

1. 保存工作，完全退出 ChatGPT/Codex 及 Codex CLI。
2. 回到 Meta API，再次点击“检查本地项目”。
3. 点击“备份并恢复”，然后重新打开 ChatGPT/Codex 检查侧栏。

本功能合并唯一历史登录的本地项目映射到当前列表，保留原项目 ID、名称和原有会话归属；当前已有的项目、会话归属及主动标记为未分配的会话优先。同目录不同 ID 会保留为独立项目，防止把聊天错误指向新建空项目。不把目录授权配置当作侧栏清单，不根据 cwd 猜测归属。

恢复不登录账号，不恢复云端 ChatGPT 项目，不改变账号偏好、认证文件、模型路由、SQLite 或聊天正文。多个历史登录都有项目时不自动选择来源；没有可恢复快照时也不会根据 SQLite 强行重建。旧账号容器完整保留，返回原账号仍可使用其原始状态。

应用或 CLI 运行时拒绝写入；预览之后文件变化需重新检查。原文件保存在相邻的 `.codex-global-state.json.yuanheng-backup-<UUID>.bak`，结果中会显示完整路径。备份包含私有本机状态，应只在本机妥善保存。不要在客户端运行期间直接覆盖文件。需要回滚时，先退出客户端，保留恢复后的文件，再用对应备份替换原文件。

## 维护者离线工具

无需启动元衡 UI，可构建同一恢复实现的命令行示例：

```sh
cargo build --manifest-path src-tauri/Cargo.toml --example recover_codex_projects
src-tauri/target/debug/examples/recover_codex_projects
src-tauri/target/debug/examples/recover_codex_projects --apply
```

默认只读预览，`--apply` 明确执行备份及合并，两者都使用相同的格式校验和运行状态保护。自定义目录使用 `--config-dir /path/to/codex-home`；维护者工具不读取元衡的目录覆盖设置，需显式传入。不要把 `--apply` 放进后台循环或登录启动项。

## 验证边界

本功能针对实际观察到的历史账号映射结构，内部格式未来可能变化。隔离测试不等于真实客户端重启验收。客户端在最终检查后再次启动仍存在短暂竞态，恢复期间请保持退出；不强制终止用户的应用或任务。
