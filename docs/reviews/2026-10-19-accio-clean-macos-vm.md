# Accio 干净 macOS 虚拟机验收

最新续验（2026-10-28）：v0.1.114最终候选Core（SHA256 `631aa1893988dcfa8a564f2f61d1569be4cf225f73c06b6f30b48058bfceba5f`）通过产品启动入口受控运行官方Accio0.35.3，原生gpt-6-astra/鹈鹕王一次合成文件任务完成读取→写入→读回→修改→读回。独立结果total=123、随机marker匹配、verified=true，原input/guard未变；6条请求均200和正输出，结束活跃0。退出后旧能力401、active撤销、Accio/helper/Core/监听清零，测试VM正常关机；日常VM保留。测试窗口通过独立签名未改的Tart副本及移回内建显示器恢复，不绕过系统锁屏。范围与不足见[实验交付决定](../../.agents/notes/implemented/feature/2026-10-27-agent-experimental-release.md)。以下保留此前历史记录，不将旧失败覆盖最新证据，也不把最新基础任务扩展为官方电商云端或全平台通过。

日期：2026-10-19，2026-10-20 续验。当前状态：独立系统与关机空白基线已创建；用户已在工作 VM 登录元衡和 Accio。真实 GUI 配置、Core 首次自动安装和关机重开恢复通过；0.35.2 的手机号会话认证、原生模型目录及一次最小回复在仅测试构建中通过。正式启动链、切换后完整回复及新设备工具任务尚未完成，不能宣称新用户完整流程通过。工作 VM 已正常关机。

## 环境

- 宿主 Apple Silicon，macOS 27.0.1；原有元衡 App/Core 保持运行。
- 虚拟系统来自 Apple 的 UniversalMac 27.0.1（26A434）恢复镜像；新系统盘和新本地用户，无 Apple ID、无宿主钥匙串/浏览器/元衡/Accio 登录态复制。
- 虚拟机名 `yuanheng-fresh-macos`，本地用户 `yhqa`，ComputerName、LocalHostName、HostName 均为 `YuanHeng-QA`。4 CPU、8 GiB 内存、80 GB 稀疏系统盘容量上限。
- 未安装软件前正常关机并保存克隆基线 `yuanheng-clean-baseline`，该基线不含云端账号登录。测试后须关机，磁盘可复用。
- 虚拟化工具固定 Tart 2.41.1；发布包 SHA-256 `e680a734febccfce7d4e910c1f7f13fc3b00f19a181c945e2d746de3214c32c2`，macOS Developer ID 签名 Team ID `9M2P8L4D89` 验证通过。未安装 Homebrew 或宿主后台服务；独立 TART_HOME，移除继承 TRACEPARENT/OTLP 导出配置。
- 初始及隔离模式关闭共享剪贴板、音频及 USB；只读共享专用安装材料目录，不挂载宿主 Home/桌面/文档。2026-10-21用户授权人工入口共享剪贴板的变化见末节。VM 使用默认 NAT，网络出口并不匿名。

## 已观察结果

空环境检查确认以下项目不存在：`/Applications/Accio.app`、元衡 App、元衡/Accio 配置目录、Core LaunchAgent、元衡钥匙串项。第一次 OS 启动已实际看到桌面。随后宿主锁屏，CUA 不能继续观察虚拟机画面；未尝试解锁或绕过该限制，之后只执行授权范围内的 guest CLI 检查。

元衡实验测试包包含前后端 Accio 开关和 P0 修复，使用正常产品标识和 Core 服务路径，但关闭正式 updater 来源。Tauri debug bundle 的初始资源签名检查未通过，因此仅对专用 staging 副本补本地 ad-hoc 签名并重新验证，重新制作 DMG；这是本地测试材料，不能替代 Developer ID 签名、公证和正式发布包验收。

元衡测试包已在 guest 从只读 DMG 安装，guest codesign 验证通过。首次运行创建全新数据库、默认配置和未登录状态，进程存在、日志记录主窗口显示；尚未完成图形界面登录。此时 Core LaunchAgent 不存在、guest 15721 未监听，不把这个未登录阶段当成已验收 Core 首次安装，也不通过手动预启动绕过该阶段。

网络探测：Accio 官网 HEAD 首次返回 503，而实际官方固定安装包下载 GET 返回 200，不能将 HEAD 结果判成下载不可用。元衡首页 HEAD 返回 200。官方包下载在本轮设置的 180 秒时间窗内收到 129,820,390 / 247,595,020 字节后超时，已按原地址断点续传；该时间窗是测试命令的限制，不是元衡产品下载超时证据。

后续断点续传返回 206，收到余下 117,774,630 字节。完整包 SHA-256 `88ea9a2ac6b3d7d579b4709ac5b43223e4a8a9ff4ced1b00d13e6e2b45989e9b`，与已验证官方 0.34.5 相同；guest 的 pkgutil 确认 Developer ID Installer `P75YXKHHMH` 和 Apple 公证信任。使用 guest 系统 installer 实际执行 PKG，返回安装成功，有 `com.accio.desktop` receipt；App 签名校验通过，CFBundleShortVersionString 为 0.34.5，安装器自动启动的 Accio 进程存在。这不是解包复制 App；但执行方式为 guest CLI，系统图形安装向导和元衡下载按钮未据此判通过。

结束前 guest 无元衡会话 selector、Accio 运行时配置数为 0，尚未创建 Core LaunchAgent。已保存的空白基线仍无软件/账号；当前工作 VM 留有已安装应用但无平台登录。宿主锁屏使 GUI 观察受阻，未借助其他接口绕过锁屏。已正常停止 VM，所有 guest 程序随 VM 停止，下一步需用户解锁宿主并在 VM 中进行真实登录。

## 隐私与后续

官方 PKG 在 guest 执行时仍可能上报虚拟机电脑名和设备标识哈希，已提前告知用户。元衡配置创建的设备 Token 名称也应使用中性测试电脑名。禁止复制宿主账号会话作为首次登录结果，禁止将密码、VM 磁盘和原始登录日志提交 GitHub。

剩余待验收：官方下载入口与安装向导的完整 GUI 路径、支持新版的正式启动链、新设备文件工具任务、原生切换后完整回复、已配置状态下官方自动更新的路由继承。用户已完成真实登录；不重新要求登录，也不复制宿主会话。Core 首次安装和重启恢复的续验结果见下节。

## 三项续验中的 VM 结果

2026-10-19 后续实际观察到元衡全新登录页和 Accio 0.34.5 登录页，没有预填宿主凭据。启动后的只读清单确认元衡 session selector 行数为 0、Accio profile 数量为 0、启用代理配置数量为 0、官方 remembered-accounts 文件不存在、Core LaunchAgent 与 15721 均不存在。

未登录阶段没有 Core 是当前设计：App 未 connected 时只显示账号页，配置入口先验证账号/分组/Key 后才调用 proxy_service.start；不存在规范的免登录 GUI 导入入口可以完成这一流程。没有用 CLI start、直接改 DB 或导入宿主 SQL 备份冒充新用户配置成功。

官方 updater 在未登录时实际获取更新 0.35.2，自动下载成功，日志记录 `autoInstallOnAppQuit=true`。通过 guest 正常进程终止触发官方退出安装，随后 installed version 变为 0.35.2，官方 codesign 身份验证通过。工作 VM 停止后重新启动，确认登录信息仍为空，0.35.2 原生登录页正常显示。该验证证明下载/更新/重新打开成立；由于此前没有元衡连接，不能证明“原有元衡路由在更新后被保留”。

上述 10 月 19 日阶段未登录真实平台账号，也未创建元衡工具 Key 或执行模型调用；当时工作 VM 与空白基线均关机保存。该历史登录阻塞已在以下续验解除。

## 2026-10-20 手机号登录后的干净设备续验

日期按北京时间；guest 保留的日志使用 UTC，桌面显示美国时区的 10 月 19 日。用户在 VM 内亲自完成手机号登录，宿主账号、钥匙串和浏览器会话未复制到 VM。本轮只测试、记录，不提交、不发布，不放宽产品版本门禁。

### GUI 配置与 Core 首装

从真实元衡登录后的工具管理进入 Accio Work 实验卡，选择已有分组和 `gpt-6-sol`，点击“配置”。此前没有 Core LaunchAgent，也没有 Accio profile；随后自动生成服务并运行，15721 `/health` 返回 `healthy`。保存了一个 inactive profile，模型目录 7 项，所选模型正确；本次未生成 `.codex/config.toml`。安装到 guest 的 Core SHA-256 为 `271e9b5b9d7116069aefc5c66fd3e23f45600bdfbcf598df6be65a956b0840e3`。

关机再启动后，Core 自动恢复为 running、health 正常，配置与元衡登录保留。这只证明服务和配置恢复，不证明活跃对话无缝恢复或旧 capability 仍应有效。

GUI 点击启动并确认后没有观察到 Accio 进程，未捕获最终 toast，不能把代码中的错误文案写成实测结果。源码仍严格要求 0.34.5，而安装的官方 App 是 0.35.2。配置动作发生在启动版本校验之前，所以“配置完成/启动可点”不代表已支持当前 App；版本预检前移和就绪提示属于尚需处理的产品缺口。

### 手机号会话与启动上下文对照

复用仅 `cfg(test)` 的 `native035probe`，在 VM 内从 GUI 已生成的真实 profile 准备权限受限 fixture，未从宿主导入账号。正式 Core 不替换、版本限制不修改。测试 App 仍验证官方签名、Bundle ID、Team ID 和精确 0.35.2。

SSH 直接运行探针时，官方 `ElectronSafeAuthStorage` 报加密存储不可用，`hasCredentials=false`；已有加密凭据文件并未消失，探针已完成模型记录为 0。不能将这轮判为手机号登录协议不支持或账号失效。

改成 VM 桌面 `gui/501` 的临时 LaunchAgent 后，原加密凭据加载成功，无需重新登录；原生工作区可见，经本地桥接的 `auth/userinfo` 返回 200。首次对照用了 Interactive，随后匹配 Core 的 Background 也验证成功；没有修改存储模式、解密文件或导出手机号。成功身份请求证据包括 UTC `2026-10-19T17:11:53Z` 和 `17:18:06Z`。这是测试探针在 GUI 会话域的兼容证据，不替代正式 Core 的新版启动验收。

### 模型与工具任务

| 项目 | 本轮证据 | 结论 |
| --- | --- | --- |
| 原生模型目录 | 菜单显示 GUI 配置分组的 7 个模型 | 通过目录加载，不等于全部模型可调用 |
| 最小回复 | 原生菜单选 `gpt-6-sol`，完整显示 `yhphoneok`；报告有 2 条 sol HTTP 200 和非零 token 记录，其中可能包含自动标题请求 | 通过一次真实回复；不把 2 条记录描述成 2 次用户对话 |
| 原生切换 | 同一会话菜单改成 `gpt-6-luna`，发送 `yhswitchok` 测试，随后 300 秒探针时限结束 | UI 切换已观察，但未取得 luna 完整回复或完成请求记录；不归因于模型/渠道，也不排除上游已收到请求 |
| 文件工具 | 下一限时窗口输入仅写/读 `yhqa-result.txt` 的合成任务；点击发送时宿主锁屏，CUA 明确拒绝操作；该窗口模型记录为 0 | 未执行、未验收，不写成工具调用失败或通过 |

部分窗口用于恢复图形控制或目录选择，在时限内未取得已完成模型请求记录；单独的零记录不证明没有请求到上游。探针 Cargo `ok` 仅代表程序及清理结束，不是业务通过判定。出现 `noWindowsAvailable` 时只说明当前图形操作失效，不能解释成 Accio 无窗口；最后明确锁屏后没有绕过限制继续 UI 操作。此前宿主旧版或新版工具通过的记录保持独立，不能充当本轮干净 VM 结果。

### 最终清理

所有已完成探针报告均记录 `processGroupClean=true`、`listenerStopped=true`；最终再次实际连接报告中的端口，存活测试 listener 为 0，Accio/探针进程为 0。临时 LaunchAgent 已 bootout 并移除，6 份权限受限的 profile fixture 副本已删除；用户的元衡配置和官方加密登录文件保留，不注销账号。

guest 通过系统 `shutdown -h now` 正常关机，管理程序报告 guest stopped。工作 VM 与干净基线最终均为 stopped，宿主无 Tart/Accio/native035probe 测试进程。宿主原有元衡 App/Core PID 保留，15721 仅由原有 Core 监听；宿主 Codex config/auth 和 Core LaunchAgent 哈希均与原基线相同。三条宿主 Accio 数据入口不存在，未新增宿主 Accio 安装。测试结束满足“结果如实记录 + 遗留测试进程为零”，不将用户正常运行的服务当作测试残留清理。

## 2026-10-20 再续验：正式版本拒绝原因与图形阻塞

本轮用户授权继续上述未完成测试。仅测试探针增加可选 `durationSeconds`，缺省300、允许30–900整数，启动前拒绝非法值；单调时钟限时、stop标记、进程组清理保留。完成记录达到10仍是停止阈值，不是严格的上游请求或计费上限。脱敏 `progress.json` 最多两秒原子更新一次，仅记录经过秒数及已完成模型/status/token。新增边界和文件写入测试2项通过，重编译测试二进制SHA-256为`03c8abe81c86e7dd8d93b8c7743fafa06df49ba5286cd3c9023abede93c9721a`。这不是产品代码或版本门禁变更。

新报告目录 `resume-a` 启动900秒探针，原生工作区可见，但CUA点击返回`noWindowsAvailable`；退出全屏后又持续返回ScreenCaptureKit `-3811`。尝试普通窗口、前台恢复、正常关机重开和重建CUA连接均未恢复捕获。没有提交本轮合成对话，主动stop后summary已完成模型记录为0、进程组与listener清理为true，临时fixture删除、测试job bootout；此次不新增模型切换或文件任务通过结论。不能将工具捕获失败解释成Accio运行故障或简单断言Mac锁屏。

图形阻塞期间，执行了一次与产品按钮同入口的Core管理启动验证：先确认已安装0.35.2、profile inactive且Accio未运行；使用guest本机现有管理凭据和规范化profile revision调用`POST /__yuanheng/core/accio/launch`。返回HTTP409及明确消息：“此 Accio 版本尚未验证主模型协议；当前仅适配 0.34.5，未修改或启动应用”。请求前后profile原文一致、active仍false、无Accio进程且Core PID未变。这直接确认了当前产品入口的版本拒绝原因，不冒充捕获到了GUI toast，也没有放宽检查。管理令牌/profile正文未输出或提交。

最后再次正常关闭guest系统；工作VM和空白基线停止。最终只读脚本已确认临时job及fixture不存在，但重启后的额外TCP连接检查返回`EINVAL`，这一步不作为端口验证通过；上一轮停止时已实际确认probe端口拒绝连接，随后guest正常关机使guest进程/监听全部退出。宿主原有元衡服务保留。剩余P0交互验收需要恢复可操作的虚拟机窗口；正式新版完整启动和已配置官方更新继承仍未通过。

## 手动界面回退入口的无消息验收

用户再次手动打开VM后，可截图但坐标点击仍报`noWindowsAvailable`。已核对唯一运行的Tart实例和普通/全屏窗口，未发现启动参数禁用图形输入；不无限重复重启，不把该工具阻塞判为Accio缺陷。

为使相同验收可继续，在本机专用QA目录准备“开始模型切换测试.command”。最终入口只接管已打开且验证电脑名为YuanHeng-QA的测试VM；若已有Accio/探针则拒绝，不改变现有会话。用户按固定sol→luna→sol顺序在真实原生界面提交三个独立合成提示，程序记录脱敏已完成模型/status/token，最长900秒，Enter/Ctrl-C结束清理。数据仍来自guest已有GUI配置，无新token/购买/宿主登录复制，正式0.34.5限制未修改。

包装器自动开VM曾返回VZErrorDomain1；直接原有启动方式成功，去除detached仍不能消除此问题，因此移除了自动开机路径，未作唯一根因判断。最终由原入口开机、手动测试脚本复用的无消息实际冒烟通过：state running、经过30秒时完成模型记录0，自动向该终端送Enter结束；fixtureRemoved和guestJobRemoved为true、guestProcessesRemaining=0、guestListenerRemaining=false、vmStopped=true、fallbackStopUsed=false、errors为空、hostTestProcessesRemaining=0。结束再次确认工作VM和基线stopped，宿主保护文件哈希不变，锁与控制文件已移除。没有提交合成模型请求，不能把本轮算为三段切换或文件任务通过；真实Ctrl-C路径也只经过合成验证。

末轮独立审查发现退出时旧progress可能尚未包含最后一轮完成记录，已增加stop读取最终summary并仅投影models/endedBy/清理状态到宿主`final-models.json`；证据缺失时明确标记，不用progress替代且不阻止关机。新增合成回归覆盖三条末尾记录、rawLog丢弃及缺证据继续清理；这一投影补充未再次运行真实探针，不将合成检查写成业务验收。

## 2026-10-21 人工剪贴板配置

用户明确要求解决跨Mac/VM复制粘贴。本机run和run-test原有`--no-clipboard`，guest也没有Tart剪贴板组件。现保留自动/隔离模式禁用状态，增加run-manual并让原“打开测试虚拟机.command”使用它，另提供隔离入口。人工启动仍关闭音频/USB且只读共享专用材料目录，未开放宿主用户目录；窗口限60分钟而非原20分钟，不据此推断此前收尾错误的唯一原因。

guest安装官方固定0.15.0、核验发布SHA-256和Cirrus Labs开发者签名，仅使用`--run-vdagent`用户LaunchAgent，无RPC/resize/debug。关机重开后服务自动running，lsof确认共享设备已打开，CPU采样0.0%，未读取剪贴板内容。CUA屏幕捕获失败，实际双向合成粘贴仍待用户确认；配置/通道检查不能当作完整复制验证。

这次只处理剪贴板，未重新发模型请求、未放宽Accio版本门禁，也未删除上一轮未完成的模型验收锁/凭据。guest正常关机结束，本轮无运行测试残留，后续模型验收仍应先处理自身收尾状态。权限变化及可回退方案见[决定](../../.agents/notes/implemented/testing/2026-10-21-qa-vm-clipboard-opt-in.md)。

用户反馈仍无法粘贴后的续查：确认其已运行run-manual且agent正常。经事先告知，以合成标记替换剪贴板，宿主→guest GUI会话的标记比较、guest→宿主的不同标记比较均为true；仅输出布尔结果，没有输出原剪贴板内容或发模型消息。临时Ruby检查job已退出并bootout，用户原先打开的VM和剪贴板组件保留。

但CUA的Command-V在Accio中只产生v，坐标点击仍报noWindowsAvailable；清除测试字符后不再猜测操作。由此只能区分文本传输已通与自动快捷键传递异常，不能确定用户手动粘贴受同一问题影响。需要原生菜单Paste的对照；不把双向数据检查当作Accio输入体验全部修复。

用户随后亲自确认复制粘贴可用，人工输入项完成；其后普通启动Accio显示官方Auto模型不能视为元衡接入。只读核查显示普通Accio没有网关覆盖、元衡配置已保存7模型但未激活，准确区分两个入口。

## 2026-10-21 新版测试入口恢复

经用户授权恢复模型验收。先对旧manual-switch运行核对owner与死PID，复用原cleanup删除guest临时fixture并卸载精确LaunchAgent，返回进程0、监听false；再移除宿主失效锁和控制文件，保留脱敏报告。旧最终模型证据仍不可用，不补造业务通过。登录和GUI配置保留。

续验时已安装版本从0.35.2变成0.35.3，实际检查官方Bundle ID/Team ID/Apple签名链通过。仅从签名App提取代码作离线验证，无账号/日志拷贝。worker SHA-256为`8effbddb576d5ae6feea2a8512e33f6d0c8700e707221db1f4027d2e9475ea9f`；检查脚本用固定哈希识别版本，按审查过的AST标识符映射复用目录用例，SDK/protobuf原定义不重写。0.35.3及旧0.35.2各15项通过，外部请求0，定时器0。仅cfg(test)启动器增加精确0.35.3，正式门禁仍0.34.5；未修改已安装官方App、未降级、未发布。

测试二进制SHA-256为`ccbf4764449e7725a4d72fcf1454e859a5ce8dfa866b6f48a275bff4430c3a1d`，独立v3材料，未覆盖v2。两个probe报告/期限Rust单测及Node/Ruby手动入口合成清理自检通过；guest在创建fixture前先拒绝未检查的版本。

实际启动后确认Accio由native035probe-v3持有，启动环境含loopback GATEWAY_BASE_URL；正式GUI数据库仍inactive属于预期，因为本轮profile只在测试服务内存中激活，不能把正式客户端也写成已接通。CUA坐标仍不可用，Escape恢复画面后看到macOS对新探针的局域网权限弹窗；未擅自选择Allow，未发送模型提示。主动停止后最终summary可用、模型记录0、stop_marker、进程组和listener清理true；fixture/job移除、guest进程0、监听false、正常关机、无fallback/errors、宿主测试进程0。主模型转发及sol→luna→sol三段回复仍未验收，下一步需用户确认如何处理系统权限弹窗。

用户同意续验后，重开VM并运行相同v3测试入口。本轮权限弹窗没有再次出现，没有点击Allow或Don't Allow，故没有“拒绝权限后推理成功”的结论。CUA初次截图报ScreenCaptureKit -3811，Raise与Escape恢复画面；键盘Tab和Space实际展开Accio原生模型菜单，看到gpt-6-sol、gpt-5.6-luna等元衡目录条目。只读检查确认父进程为native035probe-v3、GATEWAY_BASE_URL存在且为loopback。菜单展示仍不能单独证明新网络目录请求或推理成功。

CUA坐标操作持续noWindowsAvailable，Shift-Tab向前移动、文字输入未可靠落入编辑框；本轮未在Accio中按Enter发送模型提示。已请用户在原生UI完成操作，未得到新回执后主动结束。最终summary为stop_marker、models为空、进程组/监听清理true；临时fixture和job删除、guest进程0、listenerfalse、VM正常停止、无fallback/errors、宿主测试进程0，宿主原元衡服务保留。测试入口无需再次修锁；人工打开VM→完整退出普通Accio→运行“开始模型切换测试.command”即可重新建立有界测试。此轮未放宽正式门禁、未发布，不宣称0.35.3模型切换已通过。

## 手动入口在第二步立即关机的复现与修复

用户随后双击测试入口立即得到manual_test_failed与关机。宿主报告无progress，guest只有owner/fixture/plist，ready/progress/summary不存在且stdout/stderr均0字节。旧日志未保留异常类型，不能仅凭该截图判断账号、版本或操作失误。先增加只输出固定异常类别/操作阶段/helper行号的诊断，在同一VM复现相同状态与收尾双失败：两次Errno::ENOENT均位于读取共享manual-switch-control.json处；宿主文件存在且按action原子替换。该观测确定跨机控制文件读取失效，不对VirtioFS内部机制或locale作额外根因推断。

修复将控制JSON和当前Ruby helper直接经原SSH stdin传入，guest不再依赖共享控制文件或共享helper代码的即时同步；只读共享仍用于固定二进制。请求仅允许固定版本schema、规范runId和四种动作，shutdown必须与sudo匹配；base64传递避免shell插值，here-doc分隔符冲突和过大源文件拒绝。guest读取即删除控制环境变量，保留run owner、路径/权限、版本/签名和收尾检查。原始异常正文仍不输出。host控制文件只用于审计，未变成任意远程命令入口。

同时修正过早的“探针已建立”：bootstrap后先显示等待，只有status返回真实ready/running后才显示三步提示；90秒未就绪、提前退出、取消均进入原收尾流程。没有取消异常关机或替换业务验收为API直发。原用户失败与诊断复现的fixture/job经精确owner核验清理，旧死锁和控制文件移除，历史脱敏报告保留。

合成检查覆盖直接stdin、不依赖共享控制文件、动作/ID/提权/大小/分隔符拒绝、错误信息脱敏、就绪等待/超时/提前退出/取消及既有清理分支。中文locale下真实无消息冒烟达到running，连续检查32秒后自动送Enter：finalEvidenceAvailable=true、finalModels=[]、stop_marker、fixture/job删除、guest进程0、listenerfalse、进程组清理true、正常关机、fallbackfalse、errors=[]、宿主测试进程0、锁/控制文件均移除。该轮没有模型消息，修复的是测试入口可靠性，sol→luna→sol仍须原生完整回复和模型记录共同验收。

## 0.35.3 用户实测及最终转发记录

用户使用修复后的入口亲自测试，反馈未严格按固定顺序操作，但实际使用感觉正常。最终summary确认5条完成记录：gpt-6-sol四条、gpt-6-luna一条，均HTTP200且输入/输出用量为正；依序输入/输出tokens为34429/13、499/67、34465/10、34498/10、34531/21。可能包含官方自动标题等后台调用，因此不把5条记录等同于5条用户消息。不读取或复述实际用户提示内容。

此结果与用户回执共同支持0.35.3测试入口的实际元衡转发、sol和luna两模型调用及本次基础使用通过。没有记录到luna之后再切回sol，不将其写成严格三段切换完成；同一对话连续性、0353文件工具、官方更新后的路由继承、正式客户端启动及其他系统仍需分别验证。

用户报告测试完成后先读本轮随机端口/status，确认active_connections=0、success_requests=5、failed_requests=0，再核对宿主driver PID/脚本/owner并发送正常SIGINT结束。driver最终报告finalEvidenceAvailable=true、stop_marker、进程组/监听清理true、fixture/job删除、guest进程0、listenerfalse、正常关机、无fallback/errors、宿主测试进程0；锁/控制文件已移除，宿主原元衡服务保留。本轮只读取用量与状态，没有额外发送模型消息。

## 本地客户端入口补齐（2026-10-21）

配置前、模型预检和Core启动共用官方签名/版本检查，产品路径精确允许0.34.5及0.35.3，未知版本拒绝；默认功能开关和实验发布保护仍在。工作台与工具管理显示配置保存、从元衡启动和原生菜单说明，调用确认以当前启动/账号/分组摘要筛选且要求当前路由活跃、正输出，其他Agent不改变。决策与测试边界见[桌面入口](../../.agents/notes/implemented/feature/2026-10-21-accio-verified-desktop-entry.md)。

验证：42项Accio Rust、Codex生效链回归、相关前端74项与全量前端982项通过，tsc、renderer和本地debug .app构建完成。真实隔离Core验证孤立active/重复实例/外部Origin/重启失效/连接器退避，未发模型且退出。该包无updater endpoints、本地ad-hoc签名，只在QA VM安装；旧VM应用保存在专用product-entry目录，宿主正式应用不替换。

构建Core SHA-256 `582c3eee6bc6f6d0e2c05b599ecf785463e2e3f68a1bbbc52c342c10e5ebb27a`，GUI `8bcc5e3a3929854ccc3cf3dd6c9d7b252eda73111477cb81f3782a59e062fbc9`，zip `d703bc6d532e08c953d6b720e625ef8c85364f6009187ff025cee3e86e098bea`。guest更新前无Accio、Core活跃连接0，备份旧包后由产品Core start命令安装新版本服务并校验运行哈希/health。

实际Core管理launch返回200、重复请求409，父进程确为产品yuanheng-core，capability轮换、active_targets含Accio；目录200且7模型与配置相同。此调用复用现有guest配置与受控接口，不是cfg(test)探针，也没有通过SQL伪造active。退出前活跃连接0，准确子进程TERM后，Core route/磁盘active撤销、旧目录地址401、Accio及helpers为0。

GUI画面显示“本机登录信息需要恢复访问”，旧登录材料没有被主动删除；不能仅凭该提示断定是代码签名变化还是SSH图形会话上下文。Accio启动还出现新Core局域网权限提示，未代点授权或绕过。完整GUI重新配置/启动和新三段模型请求没有执行，此轮不新增付费推理。保存本地包与报告后正常关闭guest，测试VM/进程/监听归零；系统授权后的GUI验证仍需用户参与。

最终复核两台QA VM均stopped、无Tart/探针/隔离Core测试进程；宿主Codex config/auth与元衡Core LaunchAgent三个保护文件SHA-256均与本轮基线一致，宿主正在运行的元衡/Core服务保留。40篇笔记结构/链接检查、格式检查和git diff --check通过；结构校验不代替上面的业务证据或系统授权。

## 产品入口用户回复与文件能力续验（2026-10-21）

用户随后在新版元衡中从启动提示进入Accio并反馈hi有回复。只读核验当前启动scope的记录：北京时间15:52:52 sol 34431/11 tokens、16:00:53 luna 495/8、16:00:58 luna 34461/62，均HTTP200、无error、分组匹配，Accio父进程为产品Core而非测试探针。支持本地产品入口的真实模型调用；标题等辅助请求不作为用户消息数，sol→luna→sol严格回切未观察到。

用户授权继续本地测试后，在同一0.35.3和产品Core会话中准备唯一临时目录，只有合成input.json及guard.txt；随机marker不写入提示，预期合计73。未导入宿主文档、未新建令牌、未调用外部账号写操作。CUA自动长文本和修饰键存在乱序/大写锁定问题，未发送的错误文字清除，改用逐键输入且截图核对再发送。只读对照的路径被输入为大写，事先用File.identical?确认在当前guest文件系统指向同一文件；不把此行为推广至区分大小写的系统。

实际提交三个不同范围的提示：

| 阶段 | 原生UI与独立结果 | 判定 |
| --- | --- | --- |
| 一次完成读取、计算、写入、读回 | 16:20:34收到YUANHENG_STREAM_INCOMPLETE，文案“元衡上游返回错误”；记录200/0/0，未产生输出 | 失败，不能记为零费用或成功 |
| 只读input.json并返回marker | 16:29:14与16:29:20两条luna记录34676/125、34945/18；原生UI完整回复准确的随机marker，与独立fixture比较一致 | 本地文件读取与工具结果回传通过 |
| 单独请求write产生result.json并读回 | 16:33:23再次YUANHENG_STREAM_INCOMPLETE，文案“元衡上游返回流错误”；记录200/0/0，result.json不存在 | 写入任务失败，未进入修改测试 |

原input与guard哈希全程不变。三个提示产生四条模型完成记录，未无限重试，也没有用shell手写输出冒充Accio写入。首次错误对应Responses error/response.failed事件，第二次对应SSE event:error；现有Core日志和用量没有保留更具体的流内原因，不能确定为模型不可用、协议转换错误或write工具本身故障。需要补安全的流内错误诊断；仅根据HTTP200不能解释真实任务结局。读取成功不抹去两条失败，也不能推出写入稳定可用。

对固定已知只读连接器端点channel/query及channel/authorization/status各发一次本机POST空体，均约5秒后返回501及YUANHENG_ACCIO_CONNECTORS_UNAVAILABLE，无data/authorizations字段。仅命中本机拒绝路径，没有转发外部账号、发邮件/消息或更改云端权限。这证明当前明确未支持，不代表已测试官方连接器的功能。

收尾前/status活跃连接0、无探针；保存脱敏结果JSON和合成fixture供复查，再正常关闭专用VM。未实现或发布任何新的产品修复，当前不应宣称Accio全部文件工具/云端功能可用；测试结果与零遗留进程需一起报告。

## 写入失败定位及安全诊断（2026-10-21）

用户要求以执行任务而非聊天作为基础能力目标。定位时先补[安全诊断](../../.agents/notes/implemented/bug-fix/2026-10-21-accio-stream-error-diagnostics.md)：固定错误code/type/参数根字段/词表与随机本地编号，原文、header、路径、用户数据不写入日志。仅VM安装初版诊断Core，未重装GUI/改变账号或宿主服务。原临时目录在guest关机后已不存在，旧fixture元数据与结果报告保留；重新创建持久合成目录writecheck，不伪造旧输出。

原生UI被新Core的macOS局域网提示阻断，未代点或绕过。进行两次明确标注的最小协议对照（不执行工具、不写文件）：同一write定义（file_path/content必填、append可选）及合成内容经现有loopback Accio入口提交给已配置分组。

- luna于北京时间17:12:11返回上游HTTP503，结构化code=server_error，错误明确为服务器当前过载；Accio错误外层仍为SSE200。本次请求没有到达工具执行，文件权限不是这条503的解释。
- sol于17:17:19返回200，输入508/输出48 tokens，完整工具调用数1，write名称、目标路径、synthetic-write-ok内容精确匹配；协议检查器没有执行该调用，输出文件不存在。

这证明至少本次luna失败是上游服务过载，而同一定义在sol可生成工具指令；不能把前两次丢失错误详情的流内失败一并定因，也不能据sol协议通过宣称原生write通过。随后将HTTP错误同样纳入有界安全诊断，支持用户看到HTTP503/过载/诊断编号；46项Accio Rust回归通过，实际UI新错误文案未验收。

为完成原生文件对照，确认active_connections=0后退出准确owned Accio、停止诊断Core，使用保留版本通过产品start命令恢复旧Core并核验哈希。再次受控启动返回200后官方0.35.3退出，17:26:49北京时间的crash报告显示EXC_BAD_ACCESS/SIGSEGV，栈顶objc_retainAutoreleaseReturnValue、UTMCLogAssemble generateFullLogMap/logAssemble/trans2CacheLog、UTMCLogFilter等，image为UTMac。发生于新任务发送前，只能定位崩溃栈，不确定根因，也未发送Apple报告。

本轮新增模型请求2条，没有重复收费重试或跨组换Key；原生写入/电商流程仍未通过。最终原VM Core已恢复、活跃0、Accio及helper0；新合成input/guard哈希不变，result/minimal文件未生成，脱敏摘要保存在本机QA报告。最终本地Core编译与46项回归通过，两台QA VM均stopped、Tart/探针/隔离Core测试进程为0，宿主三个保护文件哈希一致、原有元衡/Core服务保留；41篇笔记与diff/格式检查通过。没有推送、发布或改动官方应用。

## Astra 专项与只读云端扩展（2026-10-21晚间，本地）

用户要求后续只使用Astra及独享/鹈鹕王分组。先通过只读目录确认已有鹈鹕王令牌支持gpt-6-astra，未创建新令牌。实际元衡工作台选择Astra并保存通过；受控启动原版0.35.3后，原生菜单仍保留上一轮luna选择，手动选中Astra并截图确认后才发送任务。没有把默认模型等同于原生当前选中模型，没有发送luna/sol生成请求。

| 检查 | 证据与边界 |
| --- | --- |
| GUI配置与模型选择 | 工作台Astra+鹈鹕王、原生Astra选中、当前Core拥有Accio进程；与记录对应 |
| 原生读取/计算/写回任务 | 北京时间21:35:07返回HTTP502；未自动重发，result.json不存在，input/guard哈希不变 |
| 最小工具协议对照 | 同组Astra，HTTP200、4191输入/49输出，完整合法write调用；没有执行工具，不能称文件写入通过 |
| 官方只读接口调研 | 核验0.35.3包哈希，提取执行4个只读方法，确认plugin/list与detail为GET、channel/query与authorization/status为POST；测试无外部网络与真实凭据 |
| 新Core实际安装 | 初版只读查询Core在VM安装并受控启动成功；macOS弹出局域网隐私授权框，未代点，原生业务测试停在此处 |
| 官方账号状态 | 仅对测试启动后的日志统计类别，存在认证失败相关信息；没有足够证据断定为令牌失效或本地网络权限所致，未提取/上传原始账号数据 |

本地新增accio_cloud精确四端点白名单、独立并发额度、20秒总超时、16KiB请求/4MiB响应限制、错误节流、禁止重定向/未知字段/凭据混用和不完整成功响应。设备标识不转发；官方accessToken只进入固定官方账号查询，不进入元衡推理。插件安装票据、云端工具执行mcp/proxy、授权新增/删除保持拒绝；不能表述成“多数官方业务功能已可用”。工作台/工具管理共用启动及保存文案同步说明边界。

初轮52项Accio回归、前端11项、类型检查及Core构建通过；后续对抗性收紧增加编码路径和管理凭据检查，最终检查独立记录。受控启动时测试Core哈希15913510f3cf095a5d98b202d71c9cae7e2ee178f180057440e6619878913107，最终源码还有额外边界收紧，不能视为同一安装包原生验收。原VM Core哈希582c3eee6bc6f6d0e2c05b599ecf785463e2e3f68a1bbbc52c342c10e5ebb27a已恢复，活跃请求/Accio/探针为零后正常关机。宿主配置和服务不修改，未推送、合并、发布。

最终源码52项Accio回归全部通过，包含真实路由的编码路径、错误方法、重复字段、安装/执行端点拒绝、模型密钥与能力令牌拒绝、慢正文读完前撤销检查；旧501兼容分支移除，失效连接的401异步节流保留。官方4条契约离线检查、前端11项、类型检查、42篇笔记与diff/格式检查通过。宿主Codex配置、认证文件及Core LaunchAgent三项保护文件哈希一致；两台VM均stopped，原宿主GUI/Core两项服务保留。

502只说明这次原生任务在元衡转发链失败，现有安全摘要不足以细分上游返回、连接失败或本地处理原因。不能因随后最小协议成功而把该任务改判成功，也不能以此认定Astra稳定性或write工具权限为根因。

## Astra 原生文件流程通过与本地错误分类（2026-10-23）

代码基于已同步的主仓库v0.1.102（d831aef2），伙伴实现保留，本地Accio仍为默认关闭的实验功能。对10月21日Astra失败行进一步脱敏核对，错误为“转发失败: 上游连接失败 [network=unknown]；请检查 DNS、出站代理及目标域名的分流规则”。这说明该502由Core的连接错误映射产生，没有取得模型HTTP响应；network=unknown不足以再细分DNS、代理或目标故障，未改变系统代理/TLS设置。

本轮先以已保留的原产品入口Core（哈希582c3eee6bc6f6d0e2c05b599ecf785463e2e3f68a1bbbc52c342c10e5ebb27a）作原生对照。通过元衡GUI启动官方0.35.3，确认原生菜单gpt-6-astra选中、鹈鹕王分组、Core拥有子进程后才提交合成文件任务。未更换模型/密钥，未执行shell来冒充Agent写文件；输入控制的乱码/乱序均在发送前清除重填并截图确认。

| 原生步骤 | 独立证据 | 结果 |
| --- | --- | --- |
| read input.json、计算、write result.json、readback | 4条Astra成功记录；13:13:29实际生成文件，marker精确匹配、total=73 | 通过 |
| 同一会话edit result.json新增verified布尔值、readback | 5条Astra成功记录（含短标题请求）；13:24:35实际修改，verified=true，marker/total不变 | 通过 |
| 文件保护 | input.json与guard.txt前后SHA256一致；操作仅在合成目录 | 通过 |
| 全部实际模型记录 | 当前受控启动scope9条，均gpt-6-astra、分组匹配、200且正输出tokens；结束active_connections=0 | 通过 |

原生write/edit各使用一次Allow，没有启用Always allow或系统目录权限。界面“工作耗时”包含等待本轮人工核对/批准的时间，不当作模型延迟。此结果只证明这两轮基础本地工具及工具结果回传正常，不能推断跨系统稳定性、所有文件格式或官方电商云端操作已通过。

本地修复共享Responses转发链仅对Accio保留原始ProxyError类型，既有错误用量记录不重复；Accio边界固定分类本地连接/超时/路由/认证/转换错误，网络标记仅从已知格式提取，原文/账号/路径/令牌不回显。上游真实错误仍单独处理，不因其声称proxy_error而当成本地产生。55项Accio与9项Codex相关回归、Core构建通过。新增连接拒绝夹具曾被当前测试环境代理转换为真实HTTP502，改用受控合成HTTP503验证来源保持、仅一次请求；本地传输类型和敏感数据丢弃单独单测，未据该夹具推断真实故障原因。

最新测试Core哈希e4a49dc01a015ab2fcbaf14b539494f09dfab0959f83a62c60c5dff9aba9ca48，仅安装在VM；旧版本及恢复元数据保留在astra-core-20261023目录。13:38:11受控启动200，尚未提交新模型任务。继续原生检查时工具报告宿主Mac锁屏且无法自动解锁，因此没有绕过锁屏或代点系统网络授权。确认新启动活跃0、无探针后，通过Tart suspend保存状态并退出运行进程，等待用户解锁后续验；当前候选Core保留在已挂起VM，不宣称已恢复旧版或完成新版原生验收。没有推送、发布或触碰真实电商账号。
