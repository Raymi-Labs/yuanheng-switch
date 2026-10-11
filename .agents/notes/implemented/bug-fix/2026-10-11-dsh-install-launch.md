# Agent Note: DSH 安装能力与本机 Web 启动闭环

Status: implemented

## Problem

工作台误将 TOOL_VERSION_TARGETS 当安装能力，DSH 请求在后台白名单变空；工具管理没有同一错误按钮。已有适配要求 apps/desktop，实际用户源码只有 CLI/Web。用户需要从元衡完成安装、配置和启动，不能以安装命令退出代替可用。

## Decision

两个入口共用显式安装能力。DSH 使用官方 npm 包固定版本 0.2.0-rc.2 和独立 Node 24.14.0，Node 归档按官方公布的 SHA256 固定校验。安装在元衡 tools 目录的临时目录运行，复用现有任务锁、取消和进程组监督；成功验证版本后原子发布路径标记，失败不替换已有安装。npm 禁止 lifecycle scripts、audit/fund，不修改全局 PATH 或 Node。安装后自动选择托管路径，再复用现有事务配置，然后请求启动 Web；配置失败不得启动或声称全部就绪。

识别显式选定的旧桌面应用、CLI/Web 源码；托管安装默认启动 loopback Web，不再依赖不存在的桌面包。源码目录以 package 身份和 CLI 文件判定，启动前检查构建依赖；保留用户文件。旧源码的 Desktop 入口仍沿用旧启动方式。Web 启动使用明确 DSH_HOME，与现有配置 home 一致，关闭 session telemetry，并隔离 NODE_OPTIONS/NODE_PATH。版本固定不是宣称上游稳定或最新。

安装与自选路径写入共用 DSH 工具锁，避免安装完成覆盖新的路径选择；外部变化仍校验。安装后自动配置/启动的续接绑定本次账号与组件生命周期：登出、切换账号、页面卸载后放弃旧意图。检测托管运行时执行八秒内的实际版本检查，存在文件但无法运行时允许重新安装。下载、哈希、解压、npm、验证失败按固定阶段说明，不透传可能含路径/凭据的第三方输出。清理失败保留任务锁和临时目录，不允许活跃写入者的目录被删除。

## Existing capabilities and note audit

- ToolSetupGrid/useModelSwitchCenter → settingsApi → misc.rs/tool_install_process 提供任务锁、检测和取消；复用，不另建安装任务 UI。
- yuanheng/dsh.rs 已有拥有权标记、凭据与两 profile 的事务配置，继续复用。
- [原生安装取消](2026-10-01-bounded-tool-installation.md)和[安装响应检查](2026-10-02-installer-response-validation.md)部分相关，仍保留各自职责；现有 notes 无 DSH 安装 owner。
- 实现基于伙伴 main 的 20018137；代码合并与安装包发布分别验收。

## Alternatives considered

- 仅加白名单：改动少，但没有可执行安装命令，也不能修复错误的启动参数和依赖。
- 全局 npm 安装：符合常见 CLI 习惯，但纯净环境缺 Node、全局权限和多版本 PATH 会继续阻塞小白。
- 复用用户源码自动 git pull/pnpm build：可复用现有文件，但会改用户工作树、受旧版本和本地修改影响，且没有统一发布格式。
- 独立安装官方 npm：增加运行时下载与存储成本，但可固定版本、隔离取消和失败，无需管理员权限。

## Verification

- macOS ARM64 在临时目录执行生产 `install-dsh.sh`：真实下载、固定哈希校验、npm 安装、版本和 Web 命令验证通过，未使用系统 Node 作为安装运行时。
- `scripts/test-dsh-web.mjs` 使用该真实安装、临时 DSH_HOME、特殊字符路径、本机模拟 OpenAI 上游及独立 Chrome：DSH Web 显示配置模型、发送对应模型/模拟凭据、显示模拟回复；不消费真实令牌，不执行真实模型推理。
- 前端 892 项全部通过，包含两入口安装→配置→启动、配置失败/取消不启动、账号切换后失效、真实 shell 下载错误/哈希错误拒绝执行；原有进程组取消、超时及重复任务测试沿用。
- Rust 2352 通过，2 原有忽略；TypeScript、renderer 构建、Clippy `-D warnings` 通过。Windows 使用真实 `dsh_install.rs` 和 `tool_install_process.rs`、仅 stub 配置路径/编码 helper 的独立 harness 通过 x86_64-pc-windows-msvc compile check；不是完整 Windows 应用构建/脚本运行或真机验收。
- 测试启动的 DSH、Chrome、模拟服务在 finally 关闭；不运行用户真实配置，不删除旧 DSH 目录。代码合并不代表安装包已发布，也不替换本机已安装客户端。

## Consequences

用户无需先装 Node 或手动构建源码；代价是独立运行时的下载和磁盘占用。DSH 仍为预览版，后续 schema 变化需要显式更新版本并复验。官方下载不可达时报告失败并保留重试入口。Windows 安装脚本和完整用户链路仍待真机验收，Linux 下载路径未实机运行；本机模拟回复不代表任何真实渠道可用。旧第三方桌面应用的独立数据路径不因本次改动迁移。旧受损托管目录保留，不自动删除用户可能持有的会话；后续若增加卸载/回收必须另核对所有权。
