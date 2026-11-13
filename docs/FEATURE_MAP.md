Codex 配置与 MCP 同步自动移除服务顶层无效 `type` 字段；HTTP 导入依据 `url` 识别，统一数据库类型保留。工作台与工具管理移除调用验收进度面板，配置预检及错误反馈保留。

# YuanHeng Desktop: capability map

移动大型模型目录：[Models](../mobile/src/Models.tsx)在全量搜索/筛选/排序后按24项显示；[mobile_api](../mobile/src-tauri/src/lib.rs)仅pricing操作调用[有界流式读取](../mobile/src-tauri/src/pricing.rs)，跳过无用元数据但不丢弃尾部模型，保留账号epoch检查及其他API限制。64MiB网络、8MiB保留数据预算与节点/深度保护；合成浏览器与原生测试不代表APK真机验收，见[决定](../.agents/notes/implemented/bug-fix/2026-11-12-mobile-pricing-stream.md)。

CLI付费启动的空快照修复：[身份检查与单模型刷新](../src-tauri/src/services/codex_launch_speed.rs) → [配置切换锁内写入共享DB与CLI目录](../src-tauri/src/commands/yuanheng/service_tiers.rs) → 票据/桥接/Core原有校验。不会在实时查询前被旧空记录拦截；超时及并发账号/组/模型变化拒发，已配置工具不为付费启动重配全目录。见[失败场景与验证](../.agents/notes/implemented/bug-fix/2026-11-09-cli-empty-tier-snapshot.md)。

Codex CLI本次启动速度：[工作台](../src/components/desktop/FocusToolCard.tsx) → [自动能力查询与偏好](../src/components/desktop/useCodexLaunchSpeed.ts) → launch_tool再次核对 → [一次性连接票据](../src-tauri/src/services/codex_launch_speed.rs) → [终端桥接](../src-tauri/src/services/codex_session_bridge.rs)。首次标准、换账号标准，付费不落盘；模型/分组切换确认支持后保留，不支持自动标准；进入/聚焦/联网自动刷新，无后台轮询。成功启动保留选择并独立显示最近启动档位。既有连接与在途请求不改档，配置不匹配或恢复旧线程拒发。最终扣费看服务端日志，不伪称结算确认。见[启动决定](../.agents/notes/implemented/feature/2026-11-09-cli-launch-speed-picker.md)与[偏好决定](../.agents/notes/implemented/feature/2026-11-09-cli-speed-capability-retention.md)。

桌面Codex原生速度：[配置能力查询](../src-tauri/src/commands/yuanheng/service_tiers.rs) → [模型目录](../src-tauri/src/codex_config.rs)的service_tiers → 官方原生线程/单轮选择 → [Core档位守卫](../src-tauri/src/services/desktop_service_tiers.rs)。能力按账号/组/精确模型读取，404/缺失不开放；标准全局默认，不写付费全局档位；付费请求不自动故障转移，最终字段/模型被改写时拒发。兼容托管历史alias的零重试字段，不覆盖用户自定义非零重试配置。见[桌面指南](guides/desktop-service-tiers.md)与[决定](../.agents/notes/implemented/feature/2026-11-09-desktop-native-service-tiers.md)。安卓误实现已回退，不算桌面交付。

移动音频播放使用[打包CSP](../mobile/src-tauri/tauri.conf.json)的media-src self/data/blob，保持脚本和外部连接约束；[浏览器回归](../mobile/scripts/test-media-browser.cjs)对生产dist验证旧策略拒绝、新策略播放、遮罩真实alpha与320/390六入口布局，全部合成IPC，无原生/收费验收推断。声音/遮罩纳入[AI同意说明](../mobile/src/App.tsx)，声音页去除标语。

移动媒体交互边界：[声音页](../mobile/src/Voice.tsx)替换样本立即撤销旧输入和授权，读取失败不回退旧音频；[遮罩](../mobile/src/MaskEditor.tsx)要求图片解码就绪，支持轻点画笔并隔离次要触点，捕获丢失停止绘制。合成回归不替代Android实际触摸与像素验证，见[外部改版审查](reviews/2026-11-07-mobile-external-review.md)。

移动端外部媒体改版（待真机验收）：[Voice](../mobile/src/Voice.tsx) → [账号绑定TTS](../mobile/src-tauri/src/voice.rs) → 既有`/pg/chat/completions`，支持分组选择、同意、取消及有界音频；[Images](../mobile/src/Images.tsx)扩展4参考图和[遮罩编辑](../mobile/src/MaskEditor.tsx)，复用[账号收藏](../mobile/src-tauri/src/gallery.rs)与原有并发/幂等防护。定价查询带登录态、回前台刷新；其他移动钱包和iOS边界不变。外部APK不作为正式产物，见[审查报告](reviews/2026-11-07-mobile-external-review.md)与[移植决定](../.agents/notes/implemented/feature/2026-11-07-mobile-external-media.md)。

网站账号浏览器登录：[BrowserAccountLogin](../src/components/desktop/BrowserAccountLogin.tsx)复用登录面板 → [原生短期授权](../src-tauri/src/commands/yuanheng/browser_login.rs) → Meta `/api/desktop-auth`协议与网站显式确认。系统浏览器处理GitHub/Google账号，本机proof不进入URL或前端；取消/过期/切号阻止旧会话覆盖。不自动创建工具令牌。Meta由用户部署后才可用，密码入口保留，见[交付说明](guides/browser-account-login.md)。

Accio官方包自动诊断：[维护者命令/工作流指南](guides/accio-compatibility-check.md) → [完整检查脚本](../scripts/check-accio-package.py) → 官方固定元数据与ARM64包 → SHA512/归档/签名核验 → [关键声明指纹匹配](../scripts/accio-protocol-fingerprint.cjs)及既有16项隔离协议回归。0.37.2签名及102个选定声明检查通过，[结果](reviews/2026-11-01-accio-0372-protocol.json)明确原生GUI未测。诊断不修改用户版本门禁或客户端自动查询；相关PR自动回归，完整官方包通过手动工作流触发，无周期任务。见[决定](../.agents/notes/implemented/testing/2026-11-01-accio-package-automation.md)。

Verified from the local checkout on 2026-09-29. This is a scoped navigation aid, not a complete product audit or a replacement for [existing guidance](../README.md). Recheck implementation when using it; extend entries only as tasks confirm the relevant behavior. Do not treat roadmap ideas as implemented features.

签名候选构建：手动[Desktop Release](../.github/workflows/release.yml)选择`candidate_only=true`，复用三平台签名/公证/完整性检查，仅保存Actions产物，不创建Release或推送更新；默认草稿与标签正式发布不变。见[候选流程](../.agents/notes/implemented/process/2026-10-29-signed-candidate-artifacts.md)。

| Capability | Entry / UI | API / orchestration | Implementation / data | Review boundary |
|---|---|---|---|---|
| Codex 官方首次切换 | 工作台 CLI/App 当前模型行的 Meta API / OpenAI 分段切换 | switch_codex_account_mode 复用配置事务，登录文件只作辅助检测 | 移除独立使用方式说明卡；可先选 OpenAI 再原生登录，不读写系统凭据库、不写删 auth.json；切回恢复 Meta API 模型/分组 | 官方文本/图片路由拒绝 sk- API Key 并提示 ChatGPT 登录；本地回归不代表 Windows 真机登录通过，见[决定](../.agents/notes/implemented/bug-fix/2026-11-06-codex-official-first-login.md)。 |
| Codex 首次登录指引 | 工作台 / 工具管理 / 安装续接的共享配置 API → [登录弹窗](../src/components/desktop/CodexLoginGuide.tsx) | 桌面配置成功后按发起账号读取 [只读指引命令](../src-tauri/src/commands/yuanheng/codex_login_guide.rs) | 复用本次工具分组令牌，复制与 API Key 登录步骤；关闭后继续原流程 | 有登录材料时跳过；不创建额外令牌、不写 auth.json；关闭/切号清理，不入查询缓存。外部钥匙串状态和真实客户端登录待验收，见[决定](../.agents/notes/implemented/feature/2026-11-04-codex-first-login-guide.md)。 |
| Codex 项目分组同步到 DSH | 会话页“带过来”菜单、DSH 启动前提示 | [同步 API](../src/lib/api/sessionSync.ts) → [项目适配器](../src-tauri/src/session_sync/projects/mod.rs) | 只读 Codex 项目，按目录合并 DSH 工作区；同步会话生成列表标题缓存 | 保留用户分组名称与已有归属；运行中的 DSH 拒绝工作区写入；备份、校验和原子写入。真实桌面本轮未复验，见[进展](../.agents/notes/proposed/feature/2026-11-03-local-session-sync.md)。 |
| 登录密码可见性 | [登录与注册面板](../src/components/desktop/YuanhengConnectionPanel.tsx) | 密码和确认密码各自支持眼睛按钮切换 | 默认隐藏；切换登录/注册及认证完成后恢复隐藏 | 登录页与紧凑连接面板共用；按钮不提交表单，支持键盘操作。 |
| Claude Code 分组模型菜单 | 工作台/工具管理配置后 → Claude Code `/model` | [托管配置](../src-tauri/src/commands/yuanheng.rs)写入官方 modelPicker（2.1.242+） | 分组目录与令牌权限交集、文本过滤/去重；[本地映射](../src-tauri/src/proxy/model_mapper.rs)保留目录精确型号并逐请求选择协议 | 旧配置重新应用后重开会话；原生 2.1.317 菜单切换、配置写入及本地三协议回归通过，真实付费推理未测。见[修复决定](../.agents/notes/implemented/bug-fix/2026-11-05-claude-group-model-picker.md)。 |
| Project connection and local tool configuration | [src/App.tsx](../src/App.tsx) | [src/lib/api/yuanheng.ts](../src/lib/api/yuanheng.ts) | [src-tauri/src/commands/yuanheng.rs](../src-tauri/src/commands/yuanheng.rs) | Console owns keys, model access and billing; inspect desktop configuration application before adding another configuration flow. |
| 通用凭据与下线分组修复 | [连接诊断卡片](../src/components/desktop/YuanhengHealthCard.tsx)的显式分组选择 | 登录/刷新仅同步会话；配置通用凭据不重配工具 | [设备凭据获取](../src-tauri/src/commands/yuanheng/device_credentials.rs)：实时分组、分页、串行锁、持久待确认标记，验证后写安全存储 | 不回退default、不自动换计费组、403不冒充过期；正常工具独立校验。声音克隆读取同一安全凭据入口。模拟测试边界见[决定](../.agents/notes/implemented/bug-fix/2026-11-02-credential-group-repair.md)。 |
| 工具配置验收与就近诊断 | 工作台 / 工具管理已移除生效状态与就近诊断面板；保留诊断数据能力 | [账号隔离查询与配置后刷新](../src/lib/query/yuanheng.ts) | [静态证据分层](../src/lib/toolActivationAssessment.ts)，原 activation 状态和诊断快照 | 刷新状态不发送模型请求；详细体检仍可能维护 Codex 历史路由。旧成功不证明当前连接，2xx 未确认不算成功，直连请求不可观测；不自动上传。见[决定](../.agents/notes/implemented/feature/2026-10-31-tool-configuration-checks.md)。 |
| Codex本地插件 | 能力中心当前Codex目标 → NativePluginsPanel → 检查/确认/启停/加载检测/卸载 | native-plugins IPC → services/native_plugins → 固定原生app-server方法 | 本地来源摘要、确认计划、原生配置版本与来源归属；不接管既有官方插件，实际目标共用Codex home时共享安装 | 内置审查/公开文档样本与本地导入；未知结果不重试，真实OAuth/GUI加载/业务调用不伪称成功。见[使用说明](guides/native-plugins.md)、[协议核查](reviews/2026-11-10-native-plugin-protocol.md)与[决定](../.agents/notes/implemented/feature/2026-11-10-native-plugin-manager.md)。 |
| 图片与视频独立创作 | 声音克隆下方 [MediaStudioPage](../src/components/desktop/MediaStudioPage.tsx)，帮助抽屉 | [类型化 IPC](../src/lib/api/media-studio.ts) → [原生命令](../src-tauri/src/commands/yuanheng/media_studio.rs) | 含已适配媒体模型的授权分组选择与独立偏好、分组模型目录和真实令牌权限，通用名称凭据；Muse单次提交1800秒、其他视频600秒；账号隔离的任务、成品与系统凭据库中的图片URL | 图片支持内嵌数据或受信任HTTPS来源的无凭据下载；视频有界查询可恢复。Omni720p按用户确认恢复文生视频；Veo按用户要求移除，Grok首帧未开放；没有客户端真实付费验收。见[说明](guides/media-studio.md)。 |
| 创作分组、参数与再次编辑 | 灵感／工作台的模型分组、直接参数表单、历史再次编辑 | 媒体profile → 有界目录快照 → 分类型偏好 → 原submit；旧任务仍token_id | 按账号/会话缓存60秒，图片/视频分别记忆；GPT/Gemini/Grok按型号扩参数；可选描述存本地文件，数据库仅参数与保存标记，参考图不持久化 | 分组仅筛目录，不锁定计费；历史恢复不提交、不回退；旧记录兼容。见[决定](../.agents/notes/implemented/feature/2026-11-10-media-studio-p1-p2.md)及[参数依据](reviews/2026-11-10-media-generation-parameters.md)。 |
| 灵感广场与创作导航 | 图片与视频默认灵感页 → 详情／使用灵感 → 原工作台；我的作品复用历史 | MediaInspirationGallery + 本地模板 → 当前账号模型目录精确匹配 → 只填草稿，原提交IPC不变 | 三张用户提供的本地WebP图片示意，非推荐模型实测产物；无外部图库、无真实作品上传；确认后替换草稿、读取／提交锁和切号隔离保持 | 单一MediaStudioContent生命周期保留查询；目录按账号及分组隔离，加载失败不回退模型；五语言、容器窄窗单列与暗色；视频无样片时显示空态。配图与布局见[改版决定](../.agents/notes/implemented/feature/2026-11-05-media-gallery-artwork-redesign.md)。见[决定](../.agents/notes/implemented/feature/2026-11-05-media-inspiration-gallery.md)。 |
| 图片作品转视频草稿 | 已完成图片的“用作视频参考图”，同一创作页 | prepare_media_video_reference → 账号作品读取 → 限额解码/PNG转换 → 草稿 | 长边1536等比例缩小，不覆盖原图；仅选择目录授权且接受参考图的视频型号（当前Muse） | 只准备不提交；缺权限禁用、切号丢弃、操作期间锁定选择。上传参考图真实解码、8192边长/16,777,216像素上限。见[决定](../.agents/notes/implemented/feature/2026-10-31-image-to-video-workflow.md)。 |
| 参考图粘贴 | 图片与视频创作表单的 ⌘V / Ctrl+V | 原生paste文件事件 → 与上传共用pick读取/限额 → 原有submit IPC解码校验 | 主动粘贴实际图片，GPT最多16图/Muse最多4图均追加，单图型号替换；文字保持默认粘贴，链接/HTML不自动下载；读取锁和账号/模型失效检查 | 仅准备草稿，明确生成才上传；不增加剪贴板权限或后台监控。见[决定](../.agents/notes/implemented/feature/2026-11-02-media-reference-paste.md)。 |
| GPT Image多参考图 | 图片与视频的上传/粘贴、预览排序删除 | reference/images互斥 → 校验 → /images/edits单图image或多图image[] | 含Sunburst/Flare，按官方最多16张PNG/JPEG/WebP、每张小于50MB；不套用Muse合计24MB。切到较小容量型号保留草稿并提示调整，禁止静默截断 | 本机原有解码资源保护保持，不能称作官方模型限制；不自动提交/重试/回退单图。见[决定](../.agents/notes/implemented/feature/2026-11-02-gpt-image-multiple-references.md)。 |
| Muse长片与多参考图 | 同一图片与视频页的时长输入、参考图列表排序 | 单图input_reference / 多图images互斥；原生逐图解码与限额；视频流式文件下载 | Muse 4–180秒、4000码点、最多4张PNG/JPEG/WebP，10MB/张及24MB合计；120次查询，提交1800秒；视频下载900秒/256MB | 按用户文档适配，实际测试由另一会话负责；超过30秒分段拼接，非连续长镜头。64MB以上保存后播放，不全量base64预览，不改本站价格/分组。 |
| 媒体保存文件类型 | 创作页保存 → mediaStudioApi.saveDialog | save_media_file_dialog使用MP4/PNG/JPEG/WebP filter；export_media_studio核对实际MIME与扩展名 | 独立于数据库save_file_dialog的SQL filter；不静默改目标路径，取消不写入 | 修复.mp4.sql误存，含API与原生filter连接回归；真实系统保存窗口仍需安装包验收。见[决定](../.agents/notes/implemented/bug-fix/2026-10-31-media-save-extension.md)。 |
| 客户端问题反馈 | 工具栏、登录页、崩溃页 [反馈入口](../src/components/desktop/ErrorFeedbackButton.tsx)，普通错误提示 | [统一错误通知](../src/lib/toast.ts) → [预览和提交](../src/components/desktop/ErrorFeedbackDialog.tsx) → [原生命令](../src-tauri/src/commands/yuanheng/desktop_feedback.rs) | [十条内存脱敏错误](../src/lib/errorFeedback.ts)，平台 POST /api/user/desktop-feedback；后台 /console/desktop-feedback | 用户主动预览提交，账号切换清空，重试 UUID 幂等；无聊天/磁盘日志/自动体检。登录失败可复制报告；平台接口需部署后可接收。见[决策](../.agents/notes/implemented/feature/2026-10-26-desktop-error-feedback.md)。 |
| TRAE 安装启动与官方自定义模型辅助配置 | 工作台当前工具选择器 / 工具管理同级工具卡片 → [TraeSetupGuide](../src/components/desktop/TraeSetupGuide.tsx) / [安装操作](../src/components/desktop/TraeInstallationActions.tsx) | [withAssistedTools](../src/config/desktopTools.ts)统一展示顺序；国内版trae-cn / 国际版trae分别检测和保存路径；复用ToolModelPicker/安装缓存 → [只读字段生成](../src/lib/traeSetup.ts)；launch_tool → [官方签名启动](../src-tauri/src/trae.rs) | 与其他Agent并列，按钮为辅助配置；需在TRAE内保存；不进入托管ToolId/批量配置；当前元衡HTTPS来源不迁移；两版提供Chat Completions/Responses/Messages；Mac Bundle/Team ID成对校验 | 国内版3.4.9/Apple Silicon Mac的鹈鹕王Astra Responses真实文件任务、重开后调用及原生停止通过；[配置流程](guides/trae-astra-setup.md)、[协议决定](../.agents/notes/implemented/bug-fix/2026-10-28-trae-native-responses.md)。仍为辅助填写，不自动导入；跨模型/其他平台及供应商侧停止计费未验证，见[上线核对](reviews/2026-10-27-trae-release-readiness.md)。 |
| TRAE 人工QA窗口监督（仅本机测试环境） | 专用QA目录中的打开TRAE测试虚拟机.command | run-manual → session-supervisor.cjs → Tart挂起 | 人工60分钟可续时、5分钟预警、退出原因本地日志；自动任务仍有界停止 | 用户登录状态保留；实际恢复/续时/挂起及重复启动拒绝通过。不是产品模型配置或推理验收，见[监督决定](../.agents/notes/implemented/testing/2026-10-26-trae-manual-vm-lifecycle.md)。 |
| MCP, skills and prompts | [src/components/skills](../src/components/skills) | [src/lib/api/skills.ts](../src/lib/api/skills.ts) | [src-tauri/src/services/skill.rs](../src-tauri/src/services/skill.rs) | Compare existing MCP and prompt managers as well; preserve local tool compatibility. |
| Usage and local routing | [src/components/usage](../src/components/usage) | [src/lib/api/usage.ts](../src/lib/api/usage.ts) | [src-tauri/src/services/usage_stats.rs](../src-tauri/src/services/usage_stats.rs) | Local proxy usage is not console billing; inspect provider routing and failover before changing selection. |
| Codex 本机代理兼容 | 智能体检 → 本机代理兼容；原桌面/CLI 启动按钮 | [本机保护与探针](../src-tauri/src/loopback_proxy.rs)、[macOS 登录修复](../src-tauri/src/loopback_proxy/macos.rs) → 原 App Server | 合并大小写绕过条目；LaunchServices 显式环境；实际进程检查；显式可撤销用户 LaunchAgent | 无计费直连/默认代理对照，Core 出站证据独立；已有进程需受控重启；环境与模型成功分开。真实 Dock/重新登录验收边界见[排查说明](guides/codex-connection-troubleshooting.md)。 |
| Core 健康巡检与退出恢复 | 桌面后台巡检、既有启动/升级入口 | [共享巡检退避](../src-tauri/src/services/proxy.rs) → [CoreSupervisor](../src-tauri/src/core_daemon.rs) | [进程、端口及 launchd 核验](../src-tauri/src/core_daemon/recovery.rs) | 只读状态连接最多 3 秒，启动临时故障最多三轮确认并共用 12 秒上限；状态失败不等于进程退出；连续探测失败后先核验，存活或未知时保留服务，最多 60 秒退避。macOS 自动恢复不卸载已有服务，显式配置迁移仍先停止旧实例。见 [恢复决策](../.agents/notes/implemented/bug-fix/2026-10-26-core-health-recovery.md)及[连接排查](guides/codex-connection-troubleshooting.md)。 |
| 请求分组与用量估算 | [请求日志/详情](../src/components/usage/PlatformQuote.tsx)、[报价目录](../src/components/usage/PlatformPricingPanel.tsx) | [请求上下文](../src-tauri/src/proxy/handler_context.rs) → [日志写入](../src-tauri/src/proxy/usage/logger.rs) → [逐请求估算](../src-tauri/src/services/platform_pricing.rs) | nullable request_group 快照；日志与聚合不受目录比较分组影响；chatgpt-desktop 输入按包含缓存处理 | 令牌请求分组不等于平台最终结算分组；历史、官方、非托管及自动组不猜倍率。见[决策笔记](../.agents/notes/implemented/bug-fix/2026-10-17-request-group-usage.md)。 |
| 出站连接复用与连接错误诊断 | 现有全局代理设置、工具请求错误 | [Core 热刷新](../src-tauri/src/core_daemon.rs) → [共享 HTTP 客户端](../src-tauri/src/proxy/http_client.rs) | [系统代理快照](../src-tauri/src/proxy/system_proxy.rs)、[安全错误分类](../src-tauri/src/proxy/transport_error.rs) | 配置未变复用连接池，系统代理变化仍刷新；不新增重放、不改写外部 DNS/分流，图片与原始头路径沿用原策略。见 [Codex 排查说明](guides/codex-connection-troubleshooting.md)。 |
| 账号目录连接与配置预检恢复 | 工作台/工具页安装续接、模型切换、启动与账号刷新 | [账号调用](../src-tauri/src/commands/yuanheng.rs) → [只读恢复](../src-tauri/src/commands/yuanheng/account_http.rs) | 全局代理配置下独立 15 秒账号连接池；同地址 GET 至多两次 | 连接/正文中断可恢复一次，HTTP/业务/解析/证书/未知连接错误不重试；POST 不重放。失败不放行实时权限，DSH 保留已安装状态，可手动再次启动。见[账号目录连接笔记](../.agents/notes/implemented/bug-fix/2026-10-26-account-catalog-transport.md)。 |
| 官方 API 连接线路 | 设置 → 路由 → [连接线路](../src/components/settings/RouteSelectionCard.tsx)，工作台异常入口 | [IPC](../src-tauri/src/commands/route_selection.rs) → 已鉴权 Core 管理端点 → [选路器](../src-tauri/src/route_selection.rs) | SQLite 单条偏好；内存探测、网络代次、请求快照 | meta-api.com 首选 / meta-api.vip 跳板 / nan.meta-api.vip CF；自动优先 .com，健康恢复经两轮和冷却验证，或手动固定。活跃约10分钟轻量探测、手动短流；只作用于本地托管文本模型转发，不含图片、WebSocket、官方账号、外部直连；不主动调用计费模型、不跨线重放；[Hyper 原始 HTTP](../src-tauri/src/proxy/hyper_client.rs)从最终 URI 补齐选路后缺失的 Host，保留头格式。官网/控制台及内嵌充值/Pulse 使用 .com，账号 API 与已有工具配置保留兼容。 |
| Claude Desktop local gateway diagnostics | [YuanhengHealthCard](../src/components/desktop/YuanhengHealthCard.tsx) | [diagnose_yuanheng](../src-tauri/src/commands/yuanheng.rs), [local probe](../src-tauri/src/commands/claude_desktop_diagnostics.rs) | [bounded Core events](../src-tauri/src/core_diagnostics.rs), [TLS connectors](../src-tauri/src/proxy/hyper_client.rs), [MSIX detection](../src-tauri/src/desktop_app_detection.rs) | Default probes only read the local model directory. A healthy Core, valid credential or enabled virtual machine platform is not proof of inference success. Reports reuse the account-bound preview/export snapshot; no prompts, credentials, raw errors or original request IDs. Windows end-to-end validation is separate. |
| Sessions and snapshots | [src/components/sessions](../src/components/sessions) | [src/lib/api/workspace.ts](../src/lib/api/workspace.ts) | [src-tauri/src/commands/workspace.rs](../src-tauri/src/commands/workspace.rs) | Check session and workspace entry points together; retain import and backup compatibility. |
| macOS installer signing and notarization | [Desktop Release](../.github/workflows/release.yml), [read-only Apple status](../.github/workflows/apple-notarization-status.yml) | Tauri signing/notarization with [bounded Apple tool retries and independent receipts](../scripts/apple-release-tools.py) | [packaged-app verification](../scripts/verify-macos-release.py), [setup guide](guides/macos-signing-release.md) | Requires complete Apple secrets; retries stapling and only explicit timestamp-service signing failures, checks stapling immediately and rejects swallowed failures before artifact collection. Verifies the build app, updater app and app inside the DMG with native tools. Offline tests do not prove actual notarization or another user's first installation. |
| 正式 Release 与收尾恢复 | [Desktop Release](../.github/workflows/release.yml)、[收尾恢复](../.github/workflows/finalize-desktop-release.yml) | [集中发布器](../scripts/desktop-release.mjs) | [发布说明](release-announcements.md)、[既有标签权限修复](../.agents/notes/implemented/bug-fix/2026-10-13-release-existing-tag-target.md) | 正式版先独立核验远端标签 SHA，再通过 `--verify-tag` 创建 Release，不传冗余 `target_commitish`；分支预发布继续绑定构建 SHA。恢复只使用已验证的原 run 三平台产物。 |

macOS credential access: [connection panel](../src/components/desktop/YuanhengConnectionPanel.tsx) → [connection/recovery command](../src-tauri/src/commands/yuanheng.rs) → [secure storage](../src-tauri/src/secure_storage.rs) / [serialized native access](../src-tauri/src/macos_keychain.rs). Startup, refresh, migration and external subscription reads suppress Keychain UI. Only explicit recovery may prompt for fixed YuanHeng entries; denial preserves stored data. Authorized values are cached only in this process; mutations evict stale values and migration verifies the native store directly. No ACL weakening or plaintext fallback.

Fresh macOS password, registration and two-factor sign-ins use [credential sessions](../src-tauri/src/commands/yuanheng/credential_session.rs): one new system-store item contains the complete authenticated session, while an atomic SQLite update selects it and publishes public account metadata. Old fixed Keychain items never gate reauthentication. If write/read-back fails, AppState retains the new session only for the current process and `sessionOnly` explains the restart requirement. Two-factor challenges remain in memory; session-only and signed-out markers prevent fallback to old accounts. Recovery reads only validated own selectors; Windows/Linux retain their existing platform-store path.

pnpm remains the application package manager. Existing Tauri/Rust checks and signed release workflows remain unchanged.

## 公司仓库与客户端下载

[发布入口](release-announcements.md#公司仓库与旧版本兼容)使用 Raymi-Labs/yuanheng-switch；[下载器](../src-tauri/src/services/update_download.rs)识别新旧精确 GitHub 地址并优先生成新地址，[R2 分发器](../scripts/sync-desktop-r2.py)保留历史清单兼容。应用标识、公钥、文件名与分发域不变。官网桌面/Android 备用链接由 Raymi-Labs/meta-api 维护；见[迁移决定](../.agents/notes/implemented/process/2026-10-27-raymi-repository-migration.md)。

## DSH 官方桌面安装与显式 Web（2026-10-28）

工作台 `FocusToolCard` 和工具管理 `ToolSetupGrid` 共用 `useDesktopInstallFlow` 与 [Mac 版本选择](../src/components/desktop/useDshDesktopDownload.tsx)。Windows 打开官方 x64 EXE；Mac 选择 Apple 芯片/Intel DMG；不支持的平台明确提示，不回退 npm。选择取消不下载；官网下载后的安装观察每三秒查询，五分钟有界，关闭页面/切换账号不继续旧配置。检测后复用预检、配置事务与默认桌面启动，失败不启动。官网安装只展示等待，不伪造下载进度。

`desktop_app_detection` 与 `misc.rs` 对默认 DSH 使用桌面应用检测和启动，不以旧托管 Web 或 PATH CLI 代替；库存缓存 v2 避免重用旧判断。显式源码 Desktop 路径保留，本机 Web 仅由独立 `dsh-web` 入口调用已有运行时/CLI/源码。旧目录、配置和会话不删除。桌面版本读取已安装应用，更新由官方应用负责，不再与 npm latest 比较。历史私有 Web 更新后端保留兼容，不作为新安装入口。见[桌面端迁移决定](../.agents/notes/implemented/feature/2026-10-28-dsh-official-desktop.md)。

DSH 配置兼容：`yuanheng/dsh.rs` 以凭据引用校验旧 hash，读取并写入 version 1 / refs，保留浏览器会话 records；profile 允许官方 YAML 重排、附加偏好和目录内对应路由的模型切换，继续拒绝接口、凭据、供应商及外部覆盖变化。重配/恢复保留 DSH 新增偏好。详见[运行时配置校验](../.agents/notes/implemented/bug-fix/2026-10-18-dsh-runtime-config-ownership.md)。

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

`settingsApi.runToolLifecycleAction` 为每个任务建立 Tauri Channel，`tool_install_process` 在受控进程生命周期内最多每 500ms 报告阶段/字节/输出活动。`toolLifecycleState` 保存原生任务开始和最近活动时间，工作台、工具页、关于页和 DSH 更新复用 `ToolInstallProgress`。只展示有依据的下载百分比；DSH Windows 和 Unix 均在正文下载过程中读取总大小，npm 依赖安装按已处理/总组件数显示单独标注的组件百分比，解析清单或总量未知时说明原因；不传终端原文、路径、HTTP 头或凭据。取消、失败、验证结束清理；迟到回调不能覆盖新任务。官网下载安装保持观察语义，窗口/页面入口显示等待说明。

决策与验证边界见[共享安装进度](../.agents/notes/implemented/feature/2026-10-18-tool-install-progress.md)。

## 安装与模型选择连续性（2026-10-01）

| 能力/入口 | 复用链路 | 不变量与边界 |
|---|---|---|
| 工作台当前工具、工具页、关于页 CLI 安装 | `settingsApi.runToolLifecycleAction` → `toolLifecycleState` → `commands/misc.rs` | 立即发布执行/验证状态，同工具互斥；安装后本机版本探测确认可运行才成功。共享 `ToolInstallProgress` 展示阶段、耗时和最近活动；DSH 安装和更新按真实字节与可用总量显示下载百分比，依赖安装显示组件数量及百分比，无法确定总量时给出说明并使用不确定进度，静默一分钟提醒检查网络/系统提示。官网安装明确显示等待与自动检测，Claude Windows 准备复用系统阶段。 |
| 纯净环境安装 | Windows Claude 原生 PowerShell 安装器；POSIX/WSL 原生优先；npm 分支依赖检查 | npm 安装在实际执行环境检查 Node/npm；缺失给出 Node.js LTS 指引，不静默修改全局运行时。WSL 依赖不由 Windows 主机检测代替。 |
| 模型下拉与后台刷新 | `ToolModelPicker` / `ModelPicker` → `useRefreshYuanheng` → `useYuanhengToolStatuses` | 工具状态缓存按地址/账号/连接状态隔离，不按同步时间重建。刷新保留已知状态与弹层；选择、Esc、外部点击仍正常关闭。 |

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

所有现有 `ModelPicker` 入口复用 `modelVendors` 的云端归属优先、模型名兼容识别与排序：当前模型单独分区且不重复，当前目录内收藏模型/收藏厂商下模型进入常用区，其余厂商分组；固定搜索、厂商筛选和匹配数量，列表独立滚动。厂商/名称搜索取交集，禁用项保持禁用，不补造目录外模型，不改 onChange/onRefresh、配置写入与权限。推荐保留标签并在组内优先，不宣称官方最新顺序；重新打开重置筛选。回归：`ModelPicker.groups.test.tsx`、`ModelPicker.refresh.test.tsx` 和应用集成切换流程。


## 令牌分组与模型本地收藏（2026-10-04，本地）

实际分组入口是工具管理 `ToolSetupGrid` 和当前工具 `FocusToolCard` 的“分组与模型”。两处使用 [ToolModelPicker](../src/components/desktop/ToolModelPicker.tsx) 的级联弹层，支持搜索、星标收藏置顶，倍率和分组名来自账号目录。收藏不调用 onChange；普通工具管理仍点击配置/启动后保存，Codex 和当前工具选定完整组合后应用。独立 GroupPicker 保留，厂商与推理等级下拉使用 CompactSelectPicker。

[ModelPicker](../src/components/desktop/ModelPicker.tsx) 同时支持模型/厂商星标，只从当前传入模型目录展示。收藏不会增加任何厂商、模型或分组权限；已保存但目录外的分组值仍显示原值，不冒充首项或补入选项，不自动换组。

[本地收藏存储](../src/components/desktop/useModelFavorites.ts) 使用固定 `yuanheng:group-favorites:v1` / `yuanheng:model-favorites:v1` key，只存分组名、模型 ID、厂商 ID，不含 API 密钥、账号或地址。偏好在同一客户端本地存储范围内跨入口共享（不按账号隔离），退出/切换账号不会清除偏好，但展示严格受新目录限制。不与 newapi 网页或其他设备同步；清理本地存储会丢失收藏。损坏数据回退空值，不可写提示失败且不影响正常选择。

回归：`GroupPicker.favorites.test.tsx`、`ModelPicker.favorites.test.tsx`、既有分组/刷新测试及 `tests/integration/App.test.tsx` 工具管理与当前工具的配置边界。决定与已验证范围见[本地收藏笔记](../.agents/notes/implemented/feature/2026-10-04-model-picker-favorites.md)。

## 厂商与分组模型级联（2026-10-20，本地）

两处工具入口统一为两个下拉框：模型供应商，以及分组 → 模型。ToolModelPicker 只展示账号 groups、modelGroups 与当前工具模型目录的交集；选择厂商和分组只改变浏览，选择模型叶子才一次提交 `{model, group}`，避免 DeepSeek 企业组切至 Grok 时沿用不兼容组。支持搜索、倍率、模型/厂商/分组本地收藏和键盘展开。分组同时按账号目录倍率显示相对官方价格的差额（0.38× → 低 62%、1× → 一致、1.2× → 高 20%），保留倍率与模型数量；缺失或无效倍率不推算，刷新目录后同步更新。目录外原配置保留显示并提示，缺失目录不猜默认组；刷新不卸载弹层，账号切换中止旧预检后续写入。后端实时预检与既有配置命令保持。

回归覆盖组件、工作台与工具管理完整流程、Codex 即时应用、配置失败、账号切换、目录刷新和草稿恢复。浏览器模拟 IPC 验证深浅色、最小窗口、键盘和失败保留，不代表真实付费推理或网络故障修复。决定见[级联选择笔记](../.agents/notes/implemented/feature/2026-10-20-tool-model-group-cascade.md)。

## 顶部更新提醒（2026-10-12）

[App](../src/App.tsx) 在登录与工作台分支外的第一行挂载 [UpdateBadge](../src/components/UpdateBadge.tsx)。现有 UpdateProvider 确认可用新版后显示文字、目标版本与红点，无新版则移除并恢复原平台行高；忽略/延后仅控制自动弹窗，被动入口仍保留，主动点击重置偏好并打开 UpdatePrompt。检查、下载和安装期间禁用重复操作；顶栏遵循平台拖动规则，更新按钮与窗口控制隔开。更新端点、签名、检查频率及安装流程不变。

## 工作台操作入口精简（2026-10-12）

[WorkspaceDashboard](../src/components/desktop/WorkspaceDashboard.tsx) 只保留 [FocusToolCard](../src/components/desktop/FocusToolCard.tsx) 作为当前工具的模型、分组、推理等级和启动入口；当前工具卡内的下拉选择持久化当前工具（见下方 2026-10-13 入口更新）。删除重复的 ModelSwitchCenter 展示列表，复用 useModelSwitchCenter 的配置/启动逻辑。推理等级统一按工具原生能力与模型目录取交集；无可写档位时显示解释而非无说明隐藏，官方 Codex 账号仍由官方客户端管理，移除其底部重复说明及外层占位；保留终端待应用状态、旧快照提示与手动重新检测。空状态可重新检测；选中未安装工具后直接调用既有安装流程，显示执行/验证状态及共享取消，只有官方下载能力的桌面工具明确打开官方下载页；检测失败或已安装但不支持时进入工具管理恢复，多工具维护继续由 ToolSetupGrid 承载。当前工具卡铺满工作台内容宽度，下方依次为今日统计和智能体检；账号余额与充值使用左下角入口，移除工作台重复的账号用量卡；移除工作台重复的能力中心/工具管理导航卡及其数量查询，继续使用左侧导航，体检检查、修复和详情功能保留，检查操作与说明在同一行右侧；首次使用显示中性状态与“开始检查”，说明用于排查登录、凭据和本地路由问题，检查中保留卡片布局。决定见[工作台入口笔记](../.agents/notes/implemented/simplification/2026-10-12-workspace-single-tool-controls.md)。


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

## 手机客户端（2026-10-19，alpha）

[mobile/](../mobile/README.md) 是独立 React/Tauri 移动应用；当前本地整合伙伴改版为聊天、生图、广场、控制台、我的，复用现有元衡后台账号/2FA、SSE、图片、余额、分组、令牌和兑换接口。Rust固定HTTPS origin与操作白名单，原生Kotlin/Swift桥接Keystore/Keychain和相册；不加载桌面Core。新增Models/Console/Redemptions与gallery.rs：收藏原生按账号隔离，钱包与收藏写操作核对发起账号；兑换码未知结果持久化requestId，复用参数完整替换参考图。Android用系统浏览器打开官网充值，返回后刷新余额，不以返回动作认定到账。iOS继续双层关闭充值、兑换、奖励划转及控制台购买路径；AI同意可撤回。见[本地整合决定](../.agents/notes/implemented/feature/2026-11-01-mobile-partner-integration.md)，没有新安装包发布即不代表线上已更新。

独立 lockfile、版本和 [Mobile Build](../.github/workflows/mobile.yml) 不触发桌面发布；Android APK、iOS unsigned archive 与 App Store 签名 IPA 的边界见移动端 README；[iOS 商店工作流](../.github/workflows/ios-app-store.yml)核对证书、描述文件、版本、设备平台和权限后才允许上传；生成的 iOS 图标去除 alpha，上传必须取得 Apple 明确成功回执，模拟器验证完整应用签名。不自动提交审核。浏览器模拟与自动测试不代表真实付费推理、充值、兑换或真机验收。设计原因见[移动端笔记](../.agents/notes/implemented/architecture/2026-10-19-mobile-clients.md)与 [iOS 商店笔记](../.agents/notes/implemented/process/2026-10-23-ios-app-store-release.md)。

安卓公开测试版官网分发复用下载域名和不可变对象校验；[分发工作流](../.github/workflows/mobile-delivery.yml)仅从已发布移动 Release 同步经过摘要及证书核对的 APK/校验文件，不写桌面 latest，也不发布未签名 iOS archive。见[分发笔记](../.agents/notes/implemented/process/2026-10-19-android-website-delivery.md)。

## 云端模型厂商同步（2026-10-21）

账号同步从已有 `/api/pricing` 的 `vendors` / `vendor_id` 生成 `modelVendors`，按精确模型名关联且限制在本次模型集合。`ToolModelPicker` 的工作台与工具管理入口、独立 `ModelPicker` 共享显示规则：云端名称原文显示，稳定 ID 区分同名厂商；缺失关联时使用旧模型名规则，图标仅用本地资源。打开厂商下拉框即调用现有刷新路径；刷新不提交配置，也不卸载弹层。

同地址、同账号刷新失败时沿用仍在目录内的旧关联，成功空目录或移除关联生效；旧缓存无需迁移即可读取。云端厂商不是权限来源，工具模型和分组交集及后端预检继续约束可选项。旧厂商收藏仅在当前目录完整映射时转换，模型/分组收藏保持。

回归：`yuanheng/model_catalog.rs`、`modelVendors.test.ts`、`ToolModelPicker.test.tsx`、`ModelPicker.groups.test.tsx`、`App.test.tsx`。见[同步决定及验证边界](../.agents/notes/implemented/bug-fix/2026-10-21-cloud-model-vendors.md)。

## 多应用自动图像技能（2026-10-23）

成功配置支持技能的元衡工具，或已有连接的客户端启动时，复用 [SkillService](../src-tauri/src/services/skill/builtin_imagegen.rs) 自动补装或刷新未自行修改的内置技能。[技能目标适配](../src-tauri/src/services/skill/imagegen_target.rs) 包含 Claude Code、Codex CLI/Desktop、Gemini CLI、Grok Build、OpenCode、Hermes、DSH 和 WorkBuddy，不扩展全局 AppType。每应用关闭和全局卸载意图、未知同名内容保留；独立 copy 与绑定文件纳入生命周期和回滚。

[无密钥运行时描述](../src-tauri/src/commands/yuanheng/imagegen.rs) 连接现有 Core；[图片模型目录和图片路由](../src-tauri/src/proxy/images.rs) 按工具读取[当前托管凭据](../src-tauri/src/commands/yuanheng/imagegen_credentials.rs)，并支持[独立图片分组](../src-tauri/src/commands/yuanheng/imagegen_connection.rs)：用户从当前账号可选分组中明确选择，真实令牌目录验证通过后保存图像连接，不修改聊天配置。独立凭据由客户端存入系统凭据库，再经既有管理认证的本机通道同步至 Core 内存；SQLite、runtime 和技能绑定只含非密钥元数据。Core 重启由客户端维护循环补齐，切号、退出和关闭立即使旧引用失效。专用技能图片路由与 Codex 原生图片路由分离，独立图片分组禁止回退到聊天连接。helper 每次读取该连接授权目录，选择最新数字版本、同版本质量优先；支持命名空间并保留完整模型 ID，显式型号优先，目录失败不猜测。Codex 保留终端/桌面原生图片连接，未选择独立分组时兼容旧描述；任一 Codex 独立分组会关闭含糊的 v1 技能描述。非 Codex 在选择独立分组后拒绝旧技能路由，提示刷新技能；其余目标只走 Images API。

[图像卡片](../src/components/desktop/ImagegenCapabilityCard.tsx) 使用实际 activeTool 与[专用状态/启停/导出 API](../src-tauri/src/commands/skill_imagegen.rs)，其余能力保持 core AppId。图片分组可独立选择或恢复使用聊天连接，真实目录检查通过才展示就绪和自动选择的型号；未授权 GPT Image 时明确引导选组。DSH 使用当前 DSH_HOME/skills；WorkBuddy 开发模式读取 ~/.codebuddy/skills（同目录也供 CodeBuddy Code 发现），办公模式导出本机 ZIP 再由用户导入。导入包绑定本机稳定 runtime 路径，随 Core 端口同步，不包含密钥。

[Skill](../src-tauri/src/resources/builtin_skills/meta-api-imagegen/SKILL.md) 允许隐式调用，按宿主支持的图片/结果预览展示后继续任务；实际选择由宿主 Agent 决定。纯文本模型不强制视觉检查。OpenCode 发现其他应用同名副本时，宿主标记检查会拒绝使用该绑定，需选择自己的安装路径。Codex 仅在接口明确不支持时最多一次兼容回退，网络/业务/保存失败不重复生成，最终图片与 partial 区分。Node 模拟 HTTP、Rust 安装/路由和界面回归不代表原生 WorkBuddy 办公导入或真实付费生成验收。原始取舍见[自动图像技能](../.agents/notes/implemented/feature/2026-10-23-automatic-image-skill.md)，多应用扩展见[决策笔记](../.agents/notes/implemented/feature/2026-10-23-multi-app-image-skill.md)，独立图片分组及实际权限检查见[修复笔记](../.agents/notes/implemented/bug-fix/2026-10-23-independent-image-group.md)。

## Accio Work 实验接入

本地商品资料工作流：提供[双语商品草稿指南](guides/accio-product-copy.md)与[两条合成商品样例](examples/accio-commerce/products.json)，通过原生文件工具生成JSON/Markdown、读回并定点修订。离线校验器`scripts/check-accio-commerce.mjs`核对SKU/事实字段/语言与预览一致性，始终要求人工审稿。0.37.1配合已验证Core及Astra在Apple Silicon QA完成两阶段19条成功模型请求，原文件不变，定点修改仅影响目标标题；应用退出重开保留同会话显式模型选择及元衡业务配置，补充专用macOS虚拟机冷启动后登录/原会话/Astra/文件保留，未测试物理Mac重启、官方升级或另一模型推理。证据见[工作流验收](../.agents/notes/implemented/testing/2026-10-31-accio-commerce-workflow.md)和[TRAE/Accio收尾范围](reviews/2026-11-01-agent-acceptance-closeout.md)。该收尾时官方0.37.2尚待验证；后续取消门禁及0.37.2签名候选回归见下文。本地指南与样例不等于官方云端电商工具或店铺发布能力。

启动前Core版本核对：Accio已运行时拒绝升级；复用CoreSupervisor空闲升级，正式构建仅在协议及二进制身份与随包Core一致时发送启动POST。升级延后时提示等待，不静默使用旧Core；profile版本在升级后读取。见[修复与回归边界](../.agents/notes/implemented/bug-fix/2026-10-30-accio-core-upgrade-before-launch.md)。本地回归及签名候选的Apple Silicon原生空闲升级通过；原生取消与钥匙串跨重启恢复仍未完成验收。

Accio 0.37.1兼容修复：扩展精确版本范围，失败提示显示检测版本。Accio工具声明显式保留非严格可选参数语义，避免新版read的json_path/json_paths被同时填入后拒绝执行；不改共享转换器和模型返回参数。新版官方协议15项、旧0.35.3协议15项及Accio Rust61项通过。专用QA真实Core受控启动0.37.1返回200，保留配置和官方登录；Astra原生read→write→read→edit→read与磁盘核验通过，total=83、marker一致、verified=true、input/guard未改，6条实际模型请求全部200。收尾进程0，其他平台/模型及原生取消不由此推断。见[新版验证记录](../.agents/notes/implemented/bug-fix/2026-10-30-accio-0371-compatibility.md)。

Accio当前版本策略（取代下文历史验收中的精确版本门禁）：配置预检与Core启动复用[官方身份验证](../src-tauri/src/accio_work/installation.rs)，不再因未实测版本拒绝；工作台和工具管理的单项/批量入口一致放行未知版本，仅安装不可用仍禁用。历史实测列表只用于诊断，不是允许列表，不伪称新版本已验证。[官方版本查询](../src-tauri/src/accio_work/releases.rs)改为手动，保留固定源、无重定向、响应/超时上限及单飞缓存；取消周期查询和[仓库工作流](../.github/workflows/accio-compatibility.yml)定时触发，未知版本不作为检查失败。实际签名、路径、平台、账号和协议错误仍明确报告。原错误分类与原生证据保留，见[取消版本门禁](../.agents/notes/implemented/simplification/2026-11-01-accio-remove-version-gate.md)及[历史预警记录](../.agents/notes/implemented/feature/2026-10-30-accio-readiness-diagnostics.md)。

v0.1.121签名候选与官方Accio0.37.2的Apple Silicon原生回归通过：安装保留原profile，GUI经系统钥匙串交互恢复原会话；工作台同分组Astra配置保存与GUI受控启动通过。6条实际Astra请求完成read/write/read/edit/read，磁盘total=83、marker一致、verified=true且输入/保护文件未改；原生停止后活跃请求0。显式GUI保存会同步平台最新模型目录，不保证整个配置JSON不变；owner/group/model保留。测试进程0、QA虚拟机正常关机。见[候选回归与边界](reviews/2026-11-01-release121-native-regression.md)，不代表正式分发、Intel真机、Windows Accio或其他模型已验收。

2026-10-31原生补验：沿用已授权网络的测试Core验证Accio0.37.1原生停止（官方aborted、活跃连接0）及同会话恢复ready；菜单Astra→luna→Astra选择生效，付费请求仅Astra，未声称跨模型推理通过。新P0 Core因新权限弹窗未完成UI联网验收。发现未知上游流事件仍拒绝，补可读失败文本并保留错误字段/诊断编号，68项Rust回归与15项SDK解析通过，未放行未知事件。测试环境已恢复、临时进程0。

2026-10-29本地源码默认在工具管理、工作台及安装目录查询中展示Accio；Cargo、GUI/Core构建入口和三平台发布矩阵统一开启feature，不再受旧VITE_ENABLE_ACCIO_WORK隐藏开关影响。未支持的后端状态在网格和工作台明确提示并隐藏配置/启动操作。Apple Silicon已有下述原生验证；Intel开启既有macOS代码但待真机验证，Windows配置/启动尚未实现。见[默认启用决定及验证限制](../.agents/notes/implemented/feature/2026-10-29-accio-default-availability.md)。当前源码原生check/build、65项相关Rust回归、App候选及Core隔离生命周期通过；专用VM配置保留及后端受控启动通过，完整GUI/真实请求受登录恢复与系统授权阻塞。详见[候选回归](../.agents/notes/proposed/testing/2026-10-29-native-candidate-regression.md)，未发布新安装包。

v0.1.115按[实验交付范围](../.agents/notes/implemented/feature/2026-10-27-agent-experimental-release.md)仅对Apple Silicon发布构建启用，普通开发构建仍默认关闭。最终候选Core配合官方0.35.3、鹈鹕王Astra完成原生read/write/read/edit/read：随机标记一致、total=123、verified=true、input/guard不变，6次模型请求全部200且正输出，退出授权撤销与零遗留通过。TRAE原生表单、Accio官方电商云端执行、其他系统和跨模型仍按各自限制说明。下文早期原型与失败记录保留历史边界。

2026-10-26本地集成以伙伴v0.1.107为基准：保留正式20→21技能迁移，使用21→22同时补齐图像技能列及Accio设备表，兼容曾使用实验21数据库的设备。账号持久化同时执行图片连接与Accio账号边界，Core保留两套独立管理入口；同账号刷新不撤销，换号/主动断开后旧连接不能恢复。迁移失败事务回滚、历史结构收敛和账号组合回归见[兼容迁移决定](../.agents/notes/implemented/bug-fix/2026-10-26-accio-upstream-schema-compatibility.md)。只修改源码，未运行候选GUI/Core或迁移用户数据库。

实验构建的工具管理/工作台 → [独立配置](../src-tauri/src/commands/yuanheng/accio.rs) → [设备本地运行时快照及受控启动](../src-tauri/src/accio_work.rs) → [loopback 能力令牌路由](../src-tauri/src/proxy/accio.rs) → [Accio/Responses 边缘转换](../src-tauri/src/proxy/providers/accio.rs) → 既有 Core 三协议转发链。目录只来自配置时验证的分组，不转发官方会话/设备字段、不回退官方模型。AppType、Codex 配置、MCP/Skills 投影不变；本机表不参与 WebDAV/S3 同步。

前端 `VITE_ENABLE_ACCIO_WORK=1` 和 Rust `accio-work-experimental` 均须显式开启。默认版本不展示、不注册路由、不接受配置/启动。本地macOS入口精确允许0.34.5/0.35.3，由[共享安装检查](../src-tauri/src/accio_work/installation.rs)在配置前和Core启动时核验官方签名/版本；不兼容或失效自定义路径提前拒绝。0.34.5已有Mac ARM原生切换/工具和GUI记录，0.35.3已有用户sol/luna实际转发及本地产品Core受控启动证据，完整GUI授权后流程与工具仍须补验。身份请求仅由[固定官方身份转发](../src-tauri/src/proxy/accio_auth.rs)处理；模型仍走元衡，未知路径拒绝。限制、隐私和本地验证见[兼容性报告](reviews/2026-10-18-accio-work-compatibility.md)、[本地入口决定](../.agents/notes/implemented/feature/2026-10-21-accio-verified-desktop-entry.md)与[提案](../.agents/notes/proposed/feature/2026-10-18-accio-primary-model-bridge.md)。

工具卡区分“启动”和桌面受控重启：Accio 使用“启动/应用并启动”，要求先退出已运行的官方应用；不会承诺刷新或强制结束现有会话。下载和启动均等待 Tauri 异步确认；下载观察停止后忽略迟到同意。配置与账号持久化的合成回归覆盖分组目录、同账号换模型保留连接、换账号撤销及 Codex 配置不变。

生命周期使用[Core 子进程所有权](../src-tauri/src/accio_work/runtime.rs)：启动经管理 Bearer、loopback 与配置版本校验，Core 持有实际 Child；无内存归属的 active 记录不授权。GUI 退出不影响正在运行的 Accio，Core 重启要求重新启动。实验 Core 的配置目录排他锁及绑定后撤销防止第二次启动破坏第一实例。读取正文期间撤销也会在转发前拒绝。

两条连接器状态查询和插件list/detail在本地实验源码中改用[精确只读白名单](../src-tauri/src/proxy/accio_cloud.rs)，分别保留官方POST/GET契约、重建查询字段、移除设备标识并拒绝元衡凭据混用；不接入安装、授权变更、云端工具执行。错误连接查询继续5秒节流，失效能力令牌使用[异步延迟拒绝](../src-tauri/src/proxy/accio_compat.rs)，不占模型槽。官方包四条调用契约的离线验证通过，原生联网业务验收仍未完成，见[只读查询提案](../.agents/notes/proposed/feature/2026-10-21-accio-readonly-cloud-queries.md)。0.35.2维持仅测试范围；0.35.3通过15项离线协议检查及用户实测sol四条/luna一条正输出记录，本地产品Core支持受控启动、分组目录、重复启动拒绝与退出撤销。严格sol→luna→sol、同一对话连续性与0353工具仍未完成独立验收。两个页面使用[共用提示](../src/components/desktop/AccioConnectionNotice.tsx)和生效进度区分保存/受控启动/模型输出；日志以当前启动/账号/分组摘要筛选，旧成功和零输出不能冒充当前成功。完整更新/新安装与其他平台不能由本轮推断通过。

新设备安装使用独立 ARM macOS 虚拟机和空账号基线，避免宿主 Applications、Keychain 与 LaunchAgent 影响结果。2026-10-20用户真实登录后，GUI分组配置、Core首次自动安装及关机重开恢复通过；手机号会话认证、7模型目录和sol最小回复在0.35.2仅测试构建中通过。正式Core管理入口已实际确认0.35.2因版本门禁返回409，未激活或启动应用；配置成功提示尚未体现已安装版本的支持范围。原生切换后完整回复、干净设备文件工具和已配置自动更新继承仍未完成，后续图形测试受屏幕捕获错误阻断。环境及证据见[干净 Mac 验收](reviews/2026-10-19-accio-clean-macos-vm.md)，不得合并称为新用户完整流程通过。

图形控制受阻时，专用QA目录提供仅连接已打开VM的手动验收脚本：由人操作原生模型菜单，探针记录脱敏用量，停止时收集最终记录并清理服务/fixture/进程后关机。修复共享控制文件更新后guest读取ENOENT导致状态/清理双失败：控制JSON和helper改走SSH stdin，继续校验动作/owner/权限，真实ready后才提示开始。中文locale下无消息连续状态检查32秒及Enter清理/关机已验收，不代表模型切换或文件工具通过；此脚本不属于客户端发布功能。

0.35.3产品入口后续实测：用户GUI启动的sol/luna回复与当前运行日志匹配；合成文件只读随机marker回传通过，原文件保持不变。综合写入及独立write两轮均遇上游流内错误且输出文件不存在，修改未测，不能宣称全部文件工具可用。两条固定只读官方连接器查询实测约5秒后501未支持；未转发云端写操作。流内错误未进入具体本地诊断是待补缺口，失败记录与证据见干净Mac报告，默认关闭/发布保护保持。

[安全错误诊断](../src-tauri/src/proxy/accio_diagnostics.rs)现以固定白名单类别和本地编号区分HTTP上游错误/Responses失败/SSE错误，不回显原文。最小write协议对照中luna503明确服务器过载，sol产生正确工具调用但未执行；不能替代原生文件验收。恢复原VM Core后的官方应用启动曾出现一次UTMac日志组件栈内SIGSEGV，原因未定。后续按用户要求切换为鹈鹕王Astra：实际GUI配置和原生菜单选中通过，原生文件任务502，最小工具协议4191/49且完整调用通过但未执行工具；新版Core的系统局域网授权框尚未确认，基础写入和只读云端查询的新版原生流程仍未验收。没有自动重试/回退，发布保护保持。

2026-10-23复验进一步确认：10月21日502的记录是Core连接上游失败，不能当作模型返回的502。共享Responses链仅在Accio范围保留ProxyError类型，边界安全提示区分本地连接/超时/认证/转换与上游HTTP错误，不改其他Agent响应或自动重试。原VM产品Core配合官方0.35.3及鹈鹕王Astra完成同一会话的读取→计算→write→读回→edit→读回，独立磁盘核对total=73、marker一致、verified=true且input/guard未改；9条实际模型记录均为Astra成功。新v0.1.102实验Core已单独安装并受控启动，但原生复验被宿主锁屏阻断，不能将旧Core任务成功视为最新安装包完整验收。详情见[干净Mac报告](reviews/2026-10-19-accio-clean-macos-vm.md)。

QA人工启动入口按2026-10-21用户授权启用剪贴板共享，并在guest用户域运行已核验的clipboard-only组件；隔离/自动入口继续禁用共享，音频/USB/宿主目录边界不变。重启、通道运行及GUI会话中的双向合成文字传输已核查，用户随后确认人工复制粘贴可用；CUA自动快捷键/坐标仍存在独立异常。此项不证明Accio走元衡，不属于元衡产品功能，见[剪贴板决定](../.agents/notes/implemented/testing/2026-10-21-qa-vm-clipboard-opt-in.md)。

## Meta API 应用名称（2026-11-01）

桌面登录页、侧栏、关于及系统托盘统一显示 Meta API，Android/iOS 主屏显示同名，官网为 meta-api.com。平台服务仍可称 YuanHeng API。桌面集中发布保留旧附件文件名，Windows 模板保留旧安装身份；手机包名、签名和凭据存储兼容。iOS 内部 ASCII 产品名保留，显示名来自 Info.plist。详见[品牌与升级兼容](../.agents/notes/implemented/process/2026-11-01-meta-api-brand.md)。

## Agent 推理等级配置

工作台FocusToolCard、工具管理ToolSetupGrid及useModelSwitchCenter共用[能力表](../src/data/agent-reasoning-controls.json)，后端预检/配置也读取同一表。新增Claude Code、Gemini CLI（Gemini 3离散档）、Grok Build、OpenCode、OpenClaw、Hermes、WorkBuddy、DSH原生字段写入，以及Accio既有路由入口；Codex/Claude Desktop维持原路径。WorkBuddy实际回读档位，DSH持久化等级；原生不接受的显式档位拒绝，不静默降auto。Gemini/OpenClaw/Hermes使用字段归属记录恢复，外部编辑保留并报冲突。TRAE保持辅助配置并明确没有已验证外部写入接口；Gemini2.5 budget不编造等级映射。原生会话/环境/全局优先级与Hermes同名模型跨供应商影响见[使用边界](guides/agent-reasoning.md)和[决定](../.agents/notes/implemented/feature/2026-11-04-agent-reasoning-controls.md)。本轮仅本地代码及隔离验证，无真实模型调用或发布。

## 自动依赖维护

[Dependabot](../.github/dependabot.yml) 的 Cargo 例行更新仅刷新现有清单兼容范围内的锁文件；跨范围升级需要单独适配和三平台 CI。数据库、加密与平台接口不因例行批量更新而隐式迁移。

## 桌面端统一令牌（2026-11-08）

工具配置、Agent 图像连接、图片视频生成和通用凭据修复共用 [device_credentials](../src-tauri/src/commands/yuanheng/device_credentials.rs) 的账号统一令牌。首次配置以所选真实分组优先，其他授权真实组按名称排序，auto 不作为 routing_config 成员；后续保留平台分组顺序、模型规则、额度和限制。目录分组只筛选模型，实际路由及收费由平台决定。新 Provider 标记 routing=token，本地用量显示自动路由并不猜测分组报价。既有配置在重新应用前保持旧凭据；旧视频仍按记录 token_id 查询，升级不自动删除令牌。详见[决定与边界](../.agents/notes/implemented/architecture/2026-11-08-account-shared-token.md)。

## ChatGPT 登录与中转配置（2026-11-09）

[首次配置引导](../src/components/desktop/CodexLoginGuide.tsx)优先保留／恢复原 ChatGPT 账号与工作区；API Key 为可选本地使用方式，不能恢复账号云端功能。[只读判定](../src-tauri/src/commands/yuanheng/codex_login_guide.rs)仅 OAuth token 材料跳过，API Key 和仅元数据仍显示指引；[工具卡](../src/components/desktop/FocusToolCard.tsx)持续显示恢复提示。配置保留 auth.json 与历史记录，文件检测不证明钥匙串或服务端登录有效；启动故障需单独证据。

## Codex 账号模式与请求完成（2026-11-09）

[请求上下文](../src-tauri/src/proxy/handler_context.rs)与[转发器](../src-tauri/src/proxy/forwarder.rs)始终沿用实际入口命名空间；Codex Desktop 的协议适配复用 CLI，但供应商／熔断／请求状态不混写。只有显式自动故障转移且非固定快照请求允许供应商写回；[切换管理器](../src-tauri/src/proxy/failover_switch.rs)执行前复验开关，避免旧中转请求将官方配置覆盖回去。

## Claude Desktop 账号模式（2026-11-09）

工作台／工具管理复用 [模式选择器](../src/components/desktop/ClaudeDesktopModeSwitch.tsx) → [模式命令](../src-tauri/src/commands/yuanheng/claude_desktop_mode.rs) → [1p/3p 配置与回滚](../src-tauri/src/claude_desktop_config.rs)。官方恢复无需中转令牌或 Core，切回保留模型分组；首次无托管配置展开设置。官方模式启动与自动修复不重新配置中转，原生账号／会话不迁移，切换需重启。macOS 临时目录双向回归与跨平台文件夹具通过，真实官方登录未测。

## Codex 本地项目列表恢复（2026-11-09）

工作台 CLI/App 工具卡共用[恢复入口](../src/components/desktop/CodexProjectRecovery.tsx) → `repair_codex_project_map` → [历史登录映射合并](../src-tauri/src/session_sync/projects/codex_local_map.rs)。先只读预览，再显式备份恢复；客户端/CLI 运行、来源歧义、格式异常或指纹变化均拒绝写入。保留原项目 ID、会话归属、当前未分配选择及账号容器；不写 SQLite、认证、模型配置或云端项目。同目录不同 ID 不强制合并。支持[离线维护工具与恢复指南](guides/codex-project-recovery.md)，真实本机恢复待退出宿主后验证。

Codex 项目检查：工作台移除常驻提示与检查按钮；[统一工具 API](../src/lib/api/yuanheng.ts)在模式/CLI目录切换后与启动前自动只读检查，通过[恢复窗口](../src/components/desktop/CodexProjectRecovery.tsx)仅展示缺失项目。窗口回焦自动重检，写入仍需退出 Codex 并确认备份恢复；不监听原生侧栏项目事件。

Meta API 切换与工具配置在写入前复用本人账号查询校验会话；过期清理本机会话并刷新连接缓存，保留工具令牌，旧账号请求不得清理新登录。官方模式不受此校验限制。见[修复说明](../.agents/notes/implemented/bug-fix/2026-11-10-meta-switch-session.md)。

Codex 切换模式保留稳定 custom 提供商 ID（外部占用时使用专用 ID），官方识别依据实际托管路由；代理清理仍保留 ID，避免当前引擎按 ID 严格检查导致同名 OpenAI 不匹配。旧混合 ID 历史不自动迁移，见[兼容边界](../.agents/notes/implemented/bug-fix/2026-11-10-codex-stable-provider-bucket.md)。

Codex 页面上下文兼容：[HTTP转发入口](../src-tauri/src/proxy/forwarder.rs)在第三方协议转换前调用[页面通知适配](../src-tauri/src/proxy/codex_page_context.rs)，将无调用ID的当前/选中页面通知保留为user参考数据，修复新会话hello即报400；真实工具配对、未知输出及官方/OAuth路径保留。Responses/Chat/Anthropic本地出站回归见[决定](../.agents/notes/implemented/bug-fix/2026-11-10-codex-page-context-http.md)。

Codex 升级身份保留：[配置投影](../src-tauri/src/codex_history_routes.rs)优先沿用 previous 的托管活跃 ID，避免升级强制转入 custom/专用桶。四种历史身份的刷新、模式切换与清理保持一致；既有混合历史不自动迁移，见[升级决定](../.agents/notes/implemented/bug-fix/2026-11-11-codex-upgrade-provider-identity.md)。
| Dynamic media catalog and video parameters | [Native catalog](../src-tauri/src/commands/yuanheng/media_studio.rs), [UI](../src/components/desktop/MediaStudioPage.tsx) | Authorized group models use media-family recognition; entry, group switch, focus and manual refresh preserve user drafts | Seedance metadata/resolution/images and compatible/xAI reference fields; text and retired Veo excluded; no paid verification. [Decision](../.agents/notes/implemented/bug-fix/2026-11-11-media-dynamic-catalog.md) |

| 视频参数与任务号一致性 | [参数联动](../src/lib/mediaPreferences.ts)、[原生请求](../src-tauri/src/commands/yuanheng/media_studio.rs) | Omni1080p默认对应像素；尺寸/分辨率联动，未知规格保留比例，矛盾IPC拒绝；id/task_id兼容且冲突停止 | 不重新生成，不改报价与原记录归属。见[决定](../.agents/notes/implemented/bug-fix/2026-11-11-video-dimension-task-contract.md) |
