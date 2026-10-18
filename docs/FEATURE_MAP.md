# YuanHeng Desktop: capability map

Verified from the local checkout on 2026-09-29. This is a scoped navigation aid, not a complete product audit or a replacement for [existing guidance](../README.md). Recheck implementation when using it; extend entries only as tasks confirm the relevant behavior. Do not treat roadmap ideas as implemented features.

| Capability | Entry / UI | API / orchestration | Implementation / data | Review boundary |
|---|---|---|---|---|
| Project connection and local tool configuration | [src/App.tsx](../src/App.tsx) | [src/lib/api/yuanheng.ts](../src/lib/api/yuanheng.ts) | [src-tauri/src/commands/yuanheng.rs](../src-tauri/src/commands/yuanheng.rs) | Console owns keys, model access and billing; inspect desktop configuration application before adding another configuration flow. |
| MCP, skills and prompts | [src/components/skills](../src/components/skills) | [src/lib/api/skills.ts](../src/lib/api/skills.ts) | [src-tauri/src/services/skill.rs](../src-tauri/src/services/skill.rs) | Compare existing MCP and prompt managers as well; preserve local tool compatibility. |
| Usage and local routing | [src/components/usage](../src/components/usage) | [src/lib/api/usage.ts](../src/lib/api/usage.ts) | [src-tauri/src/services/usage_stats.rs](../src-tauri/src/services/usage_stats.rs) | Local proxy usage is not console billing; inspect provider routing and failover before changing selection. |
| 请求分组与用量估算 | [请求日志/详情](../src/components/usage/PlatformQuote.tsx)、[报价目录](../src/components/usage/PlatformPricingPanel.tsx) | [请求上下文](../src-tauri/src/proxy/handler_context.rs) → [日志写入](../src-tauri/src/proxy/usage/logger.rs) → [逐请求估算](../src-tauri/src/services/platform_pricing.rs) | nullable request_group 快照；日志与聚合不受目录比较分组影响；chatgpt-desktop 输入按包含缓存处理 | 令牌请求分组不等于平台最终结算分组；历史、官方、非托管及自动组不猜倍率。见[决策笔记](../.agents/notes/implemented/bug-fix/2026-10-17-request-group-usage.md)。 |
| 出站连接复用与连接错误诊断 | 现有全局代理设置、工具请求错误 | [Core 热刷新](../src-tauri/src/core_daemon.rs) → [共享 HTTP 客户端](../src-tauri/src/proxy/http_client.rs) | [系统代理快照](../src-tauri/src/proxy/system_proxy.rs)、[安全错误分类](../src-tauri/src/proxy/transport_error.rs) | 配置未变复用连接池，系统代理变化仍刷新；不新增重放、不改写外部 DNS/分流，图片与原始头路径沿用原策略。见 [Codex 排查说明](guides/codex-connection-troubleshooting.md)。 |
| 官方 API 连接线路 | 设置 → 路由 → [连接线路](../src/components/settings/RouteSelectionCard.tsx)，工作台异常入口 | [IPC](../src-tauri/src/commands/route_selection.rs) → 已鉴权 Core 管理端点 → [选路器](../src-tauri/src/route_selection.rs) | SQLite 单条偏好；内存探测、网络代次、请求快照 | meta-api.vip 跳板 / nan.meta-api.vip CF；自动或固定。活跃约10分钟轻量探测、手动短流；只作用于本地托管文本模型转发，不含图片、WebSocket、官方账号、外部直连；不主动调用计费模型、不跨线重放。 |
| Claude Desktop local gateway diagnostics | [YuanhengHealthCard](../src/components/desktop/YuanhengHealthCard.tsx) | [diagnose_yuanheng](../src-tauri/src/commands/yuanheng.rs), [local probe](../src-tauri/src/commands/claude_desktop_diagnostics.rs) | [bounded Core events](../src-tauri/src/core_diagnostics.rs), [TLS connectors](../src-tauri/src/proxy/hyper_client.rs), [MSIX detection](../src-tauri/src/desktop_app_detection.rs) | Default probes only read the local model directory. A healthy Core, valid credential or enabled virtual machine platform is not proof of inference success. Reports reuse the account-bound preview/export snapshot; no prompts, credentials, raw errors or original request IDs. Windows end-to-end validation is separate. |
| Sessions and snapshots | [src/components/sessions](../src/components/sessions) | [src/lib/api/workspace.ts](../src/lib/api/workspace.ts) | [src-tauri/src/commands/workspace.rs](../src-tauri/src/commands/workspace.rs) | Check session and workspace entry points together; retain import and backup compatibility. |
| macOS installer signing and notarization | [Desktop Release](../.github/workflows/release.yml), [read-only Apple status](../.github/workflows/apple-notarization-status.yml) | Tauri signing/notarization with [bounded Apple tool retries and independent receipts](../scripts/apple-release-tools.py) | [packaged-app verification](../scripts/verify-macos-release.py), [setup guide](guides/macos-signing-release.md) | Requires complete Apple secrets; retries stapling and only explicit timestamp-service signing failures, checks stapling immediately and rejects swallowed failures before artifact collection. Verifies the build app, updater app and app inside the DMG with native tools. Offline tests do not prove actual notarization or another user's first installation. |
| 正式 Release 与收尾恢复 | [Desktop Release](../.github/workflows/release.yml)、[收尾恢复](../.github/workflows/finalize-desktop-release.yml) | [集中发布器](../scripts/desktop-release.mjs) | [发布说明](release-announcements.md)、[既有标签权限修复](../.agents/notes/implemented/bug-fix/2026-10-13-release-existing-tag-target.md) | 正式版先独立核验远端标签 SHA，再通过 `--verify-tag` 创建 Release，不传冗余 `target_commitish`；分支预发布继续绑定构建 SHA。恢复只使用已验证的原 run 三平台产物。 |

macOS credential access: [connection panel](../src/components/desktop/YuanhengConnectionPanel.tsx) → [connection/recovery command](../src-tauri/src/commands/yuanheng.rs) → [secure storage](../src-tauri/src/secure_storage.rs) / [serialized native access](../src-tauri/src/macos_keychain.rs). Startup, refresh, migration and external subscription reads suppress Keychain UI. Only explicit recovery may prompt for fixed YuanHeng entries; denial preserves stored data. Authorized values are cached only in this process; mutations evict stale values and migration verifies the native store directly. No ACL weakening or plaintext fallback.

Fresh macOS password, registration and two-factor sign-ins use [credential sessions](../src-tauri/src/commands/yuanheng/credential_session.rs): one new system-store item contains the complete authenticated session, while an atomic SQLite update selects it and publishes public account metadata. Old fixed Keychain items never gate reauthentication. If write/read-back fails, AppState retains the new session only for the current process and `sessionOnly` explains the restart requirement. Two-factor challenges remain in memory; session-only and signed-out markers prevent fallback to old accounts. Recovery reads only validated own selectors; Windows/Linux retain their existing platform-store path.

pnpm remains the application package manager. Existing Tauri/Rust checks and signed release workflows remain unchanged.

## DSH 安装、更新与本机 Web（2026-10-17，本地）

DSH 安装由工作台 `FocusToolCard` 和工具管理 `ToolSetupGrid` 直接触发，复用 `useModelSwitchCenter` 与共享生命周期。已安装工具仅在工具管理通过 `DshUpdateControl` 显示当前版和官方版、检查及更新入口；工作台不常驻版本面板，仅在任务进行时显示共享进度与取消按钮。`settingsApi.runToolLifecycleAction` → `misc.rs` 的 DSH 专用分支 → `dsh_install.rs`，复用任务 ID、锁、取消与进程组/Windows Job 监督。Node 24.14.0 按平台固定 SHA256，DSH 每次安装/更新先读取官方 npm latest 元数据，再以经过严格校验的精确版本安装；独立目录、不执行 npm lifecycle scripts、不改全局 Node，engine-strict 拒绝不兼容运行时。成功验证后原子发布安装标记，取消/失败不替换旧安装；安装后配置成功才请求启动。

更新仅替换元衡托管安装，不降级，不修改自选目录或外部安装；实际 manifest 与运行版本一致才接受，不再锁定某一个 DSH 版本。查询失败明确提示重试；更新完成后提示用户重新打开 DSH，不自动改配置、终止旧进程或调用模型。决定见[官方 DSH 更新](../.agents/notes/implemented/feature/2026-10-17-dsh-official-updates.md)。

识别及启动复用 `desktop_app_detection` 与 `launch_tool`：优先明确选择的应用/源码，否则使用托管运行时或已有 CLI。CLI/Web 源码不要求 `apps/desktop`；源码缺依赖/构建明确报错，不自动更新工作树。托管运行时检测执行有界版本检查，启动 Web 固定 loopback、随机空闲端口、明确 DSH_HOME，并关闭会话遥测。配置仍归 `yuanheng/dsh.rs` 的事务与拥有权逻辑。`useInstallContinuation` 阻止安装完成后跨页面卸载/账号切换继续应用旧意图。

托管 `yuanheng-messages` Claude 路由使用 600 秒流空闲等待和最多一次自动重试；GPT、其他路由与用户供应商沿用原策略。桌面/Web 两份 profile 均需包含当前策略，否则工具状态提示重新配置；可信旧块仍可复用凭据或恢复，外部修改继续受 hash 保护。配置后刷新或重启 DSH，正在执行的请求不追加等待。用户自定义 profile、远程 Web 和服务器超时不自动修改。取舍与验证见[Claude 请求策略](../.agents/notes/implemented/bug-fix/2026-10-13-dsh-claude-stream-policy.md)。

回归：DSH Rust 测试、两入口安装/配置/启动与失败测试、真实 shell 校验失败拒绝测试，以及 `scripts/test-dsh-web.mjs` 对官方包和本机模拟模型服务的浏览器验收。使用步骤见 [DSH 首次使用](guides/dsh-first-run.md)。自动化结果不代表 Windows 真机或真实上游推理验收。

Unauthenticated recovery: [YuanhengAccessScreen](../src/components/desktop/YuanhengAccessScreen.tsx) exposes [AccessUpdateControl](../src/components/desktop/AccessUpdateControl.tsx) for manual checks while no update is known, including login loading, credential errors, registration and two-factor challenges. Known updates use the shared top-row entry without duplicating the login button. It reuses the global [UpdateProvider](../src/contexts/UpdateContext.tsx) / [UpdatePrompt](../src/components/UpdatePrompt.tsx) and existing native updater; manual checks bypass automatic-check preferences and dismissed prompts. Check failures keep retry and the existing official download page reachable. Installing is exclusive with checks and duplicate installs; no authentication or credential-recovery command is required. Older binaries without this entry can use [manual recovery](release-announcements.md).

Before adding a feature, inspect adjacent flows and the current source of truth; shared filters, data definitions and access rules must not diverge across entry points.

Claude diagnostic persistence uses a bounded background writer, not disk I/O on the request path. Snapshot writer counters describe Core-local logging health, not billing. Claude Store discovery accepts only the verified full package family; unknown legacy identities are not trusted by a name prefix.

## Claude Desktop Windows 首次准备（2026-10-02，本地）

`claudeWorkspaceSetup` 共享安装/配置/启动意图，`ClaudeWorkspacePreparation` 在主界面显示必要组件、UAC、准备和重启状态；`useDesktopInstallFlow` 只在基础准备通过后打开官方页面。`claude_workspace_setup.rs` 仅提权系统目录下 DISM 的固定 VirtualMachinePlatform `/All /NoRestart` 参数；不接受任意程序、参数，不重启或强杀 Windows servicing。后端启动入口再次校验，智能体检使用同一只读状态机。

系统启动时间和任务完成标记只在本地保存，不包含密钥；跨重启恢复只读检查后由用户点击继续，使用现有工具配置。已保存配置但准备延期用专门错误类型与普通配置失败区分，刷新保存状态而不回退模型选择。默认不调用模型，基础就绪不等于 Claude 官方工作区组件已下载。说明及 Windows 验收边界见 [首次使用准备](guides/claude-windows-first-run.md)。

环境未就绪提示下提供“不再提醒”，通过独立本机偏好关闭启动弹窗、自动复查和闲置恢复按钮；任务标记及系统环境检查保留。主动安装、配置或启动仍检查并可重新打开提示，手动重试不清除偏好，取消勾选恢复提醒；存储失败显示错误且保持原值。回归入口：`ClaudeWorkspacePreparation.test.tsx`、`claudeWorkspaceSetup.test.ts`。见[提醒偏好笔记](../.agents/notes/implemented/feature/2026-10-13-claude-preparation-reminder.md)。

## 安装进度（2026-10-18）

`settingsApi.runToolLifecycleAction` 为每个任务建立 Tauri Channel，`tool_install_process` 在受控进程生命周期内最多每 500ms 报告阶段/字节/输出活动。`toolLifecycleState` 保存原生任务开始和最近活动时间，工作台、工具页、关于页和 DSH 更新复用 `ToolInstallProgress`。只展示有依据的下载百分比；不传终端原文、路径、HTTP 头或凭据。取消、失败、验证结束清理；迟到回调不能覆盖新任务。官网下载安装保持观察语义，窗口/页面入口显示等待说明。

决策与验证边界见[共享安装进度](../.agents/notes/implemented/feature/2026-10-18-tool-install-progress.md)。

## 安装与模型选择连续性（2026-10-01）

| 能力/入口 | 复用链路 | 不变量与边界 |
|---|---|---|
| 工作台当前工具、工具页、关于页 CLI 安装 | `settingsApi.runToolLifecycleAction` → `toolLifecycleState` → `commands/misc.rs` | 立即发布执行/验证状态，同工具互斥；安装后本机版本探测确认可运行才成功。共享 `ToolInstallProgress` 展示阶段、耗时和最近活动；DSH 按真实字节与可用总量显示下载百分比，其他阶段使用不确定进度，静默一分钟提醒检查网络/系统提示。官网安装明确显示等待与自动检测，Claude Windows 准备复用系统阶段。 |
| 纯净环境安装 | Windows Claude 原生 PowerShell 安装器；POSIX/WSL 原生优先；npm 分支依赖检查 | npm 安装在实际执行环境检查 Node/npm；缺失给出 Node.js LTS 指引，不静默修改全局运行时。WSL 依赖不由 Windows 主机检测代替。 |
| 模型下拉与后台刷新 | `ModelPicker` → `useRefreshYuanheng` → `useYuanhengToolStatuses` | 工具状态缓存按地址/账号/连接状态隔离，不按同步时间重建。刷新保留已知状态与弹层；选择、Esc、外部点击仍正常关闭。 |

验收入口：`tests/components/ModelPicker.refresh.test.tsx`、`tests/hooks/diagnosticAccountScope.test.tsx`、`tests/lib/toolLifecycleState.test.tsx` 与 Rust 生命周期/命令测试。浏览器模拟不替代干净 Windows 真机安装验收。

## 原生安装超时与取消（2026-10-01）

工具页、关于页共用 `ToolInstallCancel` / `toolLifecycleState`；`native_tool_install_supported` 只判断任务隔离能力，不宣称网络或完整环境就绪。原生安装经 `tool_install_process` 监督，执行上限 10 分钟，每个 stdout/stderr 保留最多 64 KiB 尾部。取消按 operation ID 定位，不按工具名或全局进程名杀进程；清理失败保留后端工具锁。Unix 使用独立进程组，Windows 先绑定 Job Object 再放行脚本，父进程成功退出后仍回收任务内子进程。

取消不回滚第三方已写文件，先重新检测再决定是否重试；失败也使本机版本探测缓存失效。WSL 明确不提供原生进程树取消/超时承诺，不终止整个发行版；升级与安装后的只读验证沿用已有流程，不显示“取消安装”按钮。脚本需要用户交互、主动脱离 Unix 进程组或提权到任务外的行为不在支持范围。回归：`ToolInstallCancel.test.tsx` 与 `tool_install_process::tests`。

## Windows Claude 安装响应检查（2026-10-02，本地）

原生安装与关于页复制命令共用 `src-tauri/scripts/install-claude-windows.ps1`。脚本检查 HTTP 状态、最终 HTTPS 地址、MIME、正文形态/长度和 PowerShell 语法后才执行；失败不自动回退 npm。`misc.rs::lifecycle_error_detail` 将固定安装失败分类和 CLIXML/截断 XML 转成简短提示，普通失败最多 8 行/1200 字符。错误不输出正文、查询参数或原始异常，HTTP 元数据仅限本机进程输出；不新增上传。校验不等于签名验证，也不保证官方端点可达。

回归入口：`scripts/test_claude_windows_installer.py`（模拟响应的实际 PowerShell）、`tests/lib/claudeInstallerSafety.test.ts`（共享源契约）和 Rust 错误格式测试。Windows PowerShell 5.1 与本地 Rust 编译未验证，不等于完整安装验收。

## 桌面应用安装等待与重新检测（2026-10-02，本地）

`useDesktopInstallFlow` 将外部下载页和本机安装观察分开：打开失败会清理状态；重新检测先停止所有旧观察；每次观察有独立 AbortController 和五分钟总上限；旧 IPC 结果晚到时不得触发检测成功或清除新观察。停止只取消客户端观察，不宣称取消浏览器下载或杀共享检测进程。回归入口：`tests/hooks/useDesktopInstallFlow.test.tsx`。

## 模型选择器信息层级（2026-10-02，本地）

所有现有 `ModelPicker` 入口复用 `modelVendors` 识别与排序：当前模型单独分区且不重复，当前目录内收藏模型/收藏厂商下模型进入常用区，其余厂商分组；固定搜索、厂商筛选和匹配数量，列表独立滚动。厂商/名称搜索取交集，禁用项保持禁用，不补造目录外模型，不改 onChange/onRefresh、配置写入与权限。推荐保留标签并在组内优先，不宣称官方最新顺序；重新打开重置筛选。回归：`ModelPicker.groups.test.tsx`、`ModelPicker.refresh.test.tsx` 和应用集成切换流程。


## 令牌分组与模型本地收藏（2026-10-04，本地）

实际分组入口是工具管理 `ToolSetupGrid` 的“令牌分组”和当前工具 `FocusToolCard` 的“3 · 令牌分组”。两处使用 [GroupPicker](../src/components/desktop/GroupPicker.tsx)，支持搜索、星标收藏置顶，比例和分组名继续来自原 options。收藏不调用 onChange；工具管理仍点击配置/启动后保存，当前工具仍显式选择后应用。厂商与推理等级下拉仍使用原 CompactSelectPicker。

[ModelPicker](../src/components/desktop/ModelPicker.tsx) 同时支持模型/厂商星标，只从当前传入模型目录展示。收藏不会增加任何厂商、模型或分组权限；已保存但目录外的分组值仍显示原值，不冒充首项或补入选项，不自动换组。

[本地收藏存储](../src/components/desktop/useModelFavorites.ts) 使用固定 `yuanheng:group-favorites:v1` / `yuanheng:model-favorites:v1` key，只存分组名、模型 ID、厂商 ID，不含 API 密钥、账号或地址。偏好在同一客户端本地存储范围内跨入口共享（不按账号隔离），退出/切换账号不会清除偏好，但展示严格受新目录限制。不与 newapi 网页或其他设备同步；清理本地存储会丢失收藏。损坏数据回退空值，不可写提示失败且不影响正常选择。

回归：`GroupPicker.favorites.test.tsx`、`ModelPicker.favorites.test.tsx`、既有分组/刷新测试及 `tests/integration/App.test.tsx` 工具管理与当前工具的配置边界。决定与已验证范围见[本地收藏笔记](../.agents/notes/implemented/feature/2026-10-04-model-picker-favorites.md)。

## 顶部更新提醒（2026-10-12）

[App](../src/App.tsx) 在登录与工作台分支外的第一行挂载 [UpdateBadge](../src/components/UpdateBadge.tsx)。现有 UpdateProvider 确认可用新版后显示文字、目标版本与红点，无新版则移除并恢复原平台行高；忽略/延后仅控制自动弹窗，被动入口仍保留，主动点击重置偏好并打开 UpdatePrompt。检查、下载和安装期间禁用重复操作；顶栏遵循平台拖动规则，更新按钮与窗口控制隔开。更新端点、签名、检查频率及安装流程不变。

## 工作台操作入口精简（2026-10-12）

[WorkspaceDashboard](../src/components/desktop/WorkspaceDashboard.tsx) 只保留 [FocusToolCard](../src/components/desktop/FocusToolCard.tsx) 作为当前工具的模型、分组、推理等级和启动入口；当前工具卡内的下拉选择持久化当前工具（见下方 2026-10-13 入口更新）。删除重复的 ModelSwitchCenter 展示列表，复用 useModelSwitchCenter 的配置/启动逻辑。推理等级仅在支持的工具和模型下出现，官方 Codex 账号仍由官方客户端管理，移除其底部重复说明及外层占位；保留终端待应用状态、旧快照提示与手动重新检测。空状态可重新检测；选中未安装工具后直接调用既有安装流程，显示执行/验证状态及共享取消，只有官方下载能力的桌面工具明确打开官方下载页；检测失败或已安装但不支持时进入工具管理恢复，多工具维护继续由 ToolSetupGrid 承载。当前工具卡铺满工作台内容宽度，下方依次为今日统计和智能体检；账号余额与充值使用左下角入口，移除工作台重复的账号用量卡；移除工作台重复的能力中心/工具管理导航卡及其数量查询，继续使用左侧导航，体检检查、修复和详情功能保留，检查操作与说明在同一行右侧；首次使用显示中性状态与“开始检查”，说明用于排查登录、凭据和本地路由问题，检查中保留卡片布局。决定见[工作台入口笔记](../.agents/notes/implemented/simplification/2026-10-12-workspace-single-tool-controls.md)。


## 更新下载择源与断流恢复（2026-10-12）

现有所有更新入口 → [安装命令](../src-tauri/src/commands/settings.rs) → [签名下载器](../src-tauri/src/services/update_download.rs)，固定版本 meta-api.vip 直链（origin=1）/R2/GitHub 先小量试下载择源，兼容原官方镜像 URL，异常时有界切源并在本次操作内 Range 续传，备用源 HTTP 不可用时保留已有进度。不持久化部分包、不修改外部代理、未知下载地址仍使用原 Tauri 下载；完整文件通过同一公钥/签名后才安装。[UpdateContext](../src/contexts/UpdateContext.tsx) 使用明确阶段，后端互斥防止重复安装。回归覆盖本地真实 HTTP 故障和签名，手动网络 smoke 只下载不安装。服务端缓存配置与用户网络速度独立验收，参见[下载分发说明](guides/desktop-download-delivery.md)。

## 全局帮助抽屉（2026-10-13）

[DesktopSidebar](../src/components/desktop/DesktopSidebar.tsx) 的日常使用导航依次为工作台、声音克隆、会话与用量、工具管理、能力中心；底部并排提供帮助与官网，主导航不再占用说明页。[HelpDrawer](../src/components/desktop/HelpDrawer.tsx) 复用 Dialog 展示内置快速开始、日常使用、排错与 FAQ；支持关闭按钮、Escape、遮罩关闭和入口焦点恢复，正文可滚动且可离线查看。命令面板通过“帮助 / 使用说明 / help / guide”打开同一抽屉；后台页面与输入保持挂载，模态期间不执行后台跳转快捷键。旧 guide 页面恢复时回退工作台，退出登录关闭抽屉。短窗口侧栏收紧间距并保留导航滚动，底部辅助入口始终可见。决定见[帮助抽屉笔记](../.agents/notes/implemented/feature/2026-10-13-help-drawer.md)。

## R2 安装包分发（2026-10-13）

现有 Desktop Release → [下载分发工作流](../.github/workflows/desktop-delivery.yml) → [R2 同步和公开摘要校验](../scripts/sync-desktop-r2.py) → 原平台镜像及 latest 发布；缺少凭据或任一验证失败时停止。新下载器精确识别 R2/原镜像/GitHub 官方更新包，候选为新入口直链/R2/GitHub；未知地址、续传和原公钥签名协议保持不变。旧下载 URL 的兼容由[源站临时跳转片段](../deploy/nginx/desktop-r2-download-location.conf)承接，镜像探测用 `origin=1` 核对平台本地包。桶级凭据已配置、12 版历史资产已回填，生产旧链接跳转及当前版完整自动分发已验证；生产验收与回滚方式见[分发说明](guides/desktop-download-delivery.md#r2-正式接入代码与上线步骤)。

## 公告铃铛与当前工具选择（2026-10-13）

[App](../src/App.tsx) 工具栏挂载 [公告铃铛](../src/components/desktop/PlatformAnnouncementCenter.tsx)，替代工作台两条横幅。客户端更新与平台通知复用原查询、内部窗口及有界已读标记；分类独立已读，新内容再次显示红点，错误在窗口内重试，关闭后恢复焦点。顶部安装更新入口继续由 UpdateProvider/UpdateBadge 管理。

[WorkspaceDashboard](../src/components/desktop/WorkspaceDashboard.tsx) 将 App 的可见工具与持久化回调传给 [FocusToolCard](../src/components/desktop/FocusToolCard.tsx)，当前工具标题下使用 CompactSelectPicker；加载、失败和未安装状态也可选择。工具管理、模型与分组写入时机不变。移除快捷切换说明。决定及验收见[入口整理笔记](../.agents/notes/implemented/feature/2026-10-13-workspace-notifications-tool-picker.md)。

## Codex 首次配置与中转切换恢复（2026-10-14）

工具管理、工作台的配置与使用方式切换共用 [yuanheng.rs](../src-tauri/src/commands/yuanheng.rs)。首次配置单个 Codex 工具时，CLI/桌面记录各自保存正确标记，单工具操作仍只写选中工具的路由。旧版复制成相同标记的元衡记录在只读检查中视为可恢复；点击“元衡中转”后才在原快照/回滚流程中纠正并应用两份路由，不要求额外安装 CLI。

恢复保留独立模型、分组、凭据和官方 auth.json；未知标记、非元衡拥有的错标记录、缺少凭据或外部端点继续拒绝。已应用状态仍检查真实文件，检测本身不迁移；官方模式继续要求官方登录，提示明确区分中转账号。回归与边界见[配置标记恢复笔记](../.agents/notes/implemented/bug-fix/2026-10-14-codex-surface-mode-repair.md)。

## Codex 配置兼容与模型窗口（2026-10-16，本地）

一键配置、重新配置及元衡模式应用复用 [yuanheng.rs](../src-tauri/src/commands/yuanheng.rs) 的两条独立路由。自有 GPT 目录不再统一写 200k；仅将符合完整旧模板的 200k 迁移到既有 921000 产品默认，非 GPT 未知模型保持 200000，显式模型额度及自定义元数据在刷新/重新配置时保留。逐模型 `context_window` 与 `max_context_window` 一致；旧 GPT 全局默认从实际路由移除，明确的自定义全局值继续生效。有效窗口比例仍由模板决定，默认不代表上游实际容量保证。

所有 Codex 生成模板停止写入 `disable_response_storage`；[codex_config.rs](../src-tauri/src/codex_config.rs) 在目录准备和最终原子写入时清理该顶层键，防止共用片段重新带回，不修改请求 `store` 或登录文件。只读状态可提示旧配置需重新应用，不后台改用户文件。迁移、配置优先级和验收边界见[兼容性笔记](../.agents/notes/implemented/bug-fix/2026-10-16-codex-context-and-obsolete-setting.md)。

## 工具栏与主内容空间（2026-10-15）

[App](../src/App.tsx) 移除“当前状态”按钮、窄窗口抽屉及宽窗口右侧常驻面板，主内容区统一填满侧栏之外的宽度。余额、当前工具、用量和连接状态仍使用原有页面及共享 API；不新增迁移或改变账户数据。工具栏依次为快捷操作、公告铃铛、语言、主题、设置；铃铛、语言、主题和设置共用 outline/icon 圆角方形按钮，铃铛保留未读红点；[LanguageSwitcher](../src/components/desktop/LanguageSwitcher.tsx) 保留文/A 翻译图标，使用与主题、设置相同的圆角方形按钮，复用五语言菜单、保存及失败回退。范围与验收见[状态面板精简笔记](../.agents/notes/implemented/simplification/2026-10-15-remove-context-panel.md)。

## 设置页标签布局（2026-10-17）

[SettingsPage](../src/components/settings/SettingsPage.tsx) 的六列标签按内容区宽度均分，局部覆盖共用 TabsTrigger 的 120px 最小宽度，避免窄窗口下相邻选中态与悬停态重叠。长标签可换行，六个按钮等高；复用既有 Radix 选择、焦点与键盘导航，不改变其他页面的标签样式或设置保存逻辑。
