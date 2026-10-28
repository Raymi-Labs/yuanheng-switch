import i18n from "@/i18n";
import { DESKTOP_JA } from "./desktopI18n.ja";
import { DESKTOP_KO } from "./desktopI18n.ko";
import { DESKTOP_ZH_TW } from "./desktopI18n.zhTW";

type Values = Record<string, string | number | null | undefined>;

export const DESKTOP_EN: Record<string, string> = {
  "如果报错提示不支持思考强度 none，请检查 TRAE 模型的高级配置 → 模型系列、思考模式，以及对话中的思考强度。按服务商支持的值调整后再测试；保存成功不代表请求兼容。":
    "If an error says reasoning effort none is unsupported, check the model family and thinking mode in TRAE's advanced model settings, as well as the conversation's reasoning effort. Use values supported by your provider and test again; saving a model does not confirm request compatibility.",
  "连接检查出现 Empty response data 时，先核对完整地址与请求日志，避免反复重试。直接保存只保留配置，仍需用实际任务验证。":
    "If the connection check reports Empty response data, check the full URL and request logs before retrying. Saving directly only retains the configuration; verify it with an actual task.",
  国内版: "China edition",
  国际版: "International edition",
  "TRAE 版本": "TRAE edition",
  "当前版本：{{edition}}": "Selected edition: {{edition}}",
  "国内版与国际版分别配置，账号和模型不会自动迁移。请先用小任务验证当前版本。":
    "Configure the China and international editions separately. Accounts and models are not migrated automatically. Verify the selected version with a small task first.",
  "测试文件功能时，请选择一个专用工作文件夹。若操作被审批拒绝，先查看拒绝原因，不要关闭安全审批。":
    "Choose a dedicated workspace folder for file tests. If an action is denied, check the reason rather than disabling safety approval.",
  实验接入: "Experimental integration",
  "生成官方自定义模型的填写说明；请在 TRAE 内保存并选择模型。复制参数不代表已接通。":
    "Prepare the official custom model fields, then save and select the model in TRAE. Copying fields does not confirm connectivity.",
  "依据国际版 TRAE 3.6.4 核对。不同版本和系统可能存在差异，请先用小任务确认可用。":
    "Checked against international TRAE 3.6.4. Other versions and systems may differ; verify with a small task first.",
  "需要切换其他模型时，用对应 Model ID 再添加一条自定义模型，然后在 TRAE 输入框的模型菜单切换。":
    "To switch models, add another custom model with its Model ID, then select it from the model menu in the TRAE composer.",
  "请先验证停止生成是否及时生效；界面停止不一定代表上游请求已结束，费用以平台记录为准。":
    "Verify that stopping generation ends the request promptly. A stopped UI does not necessarily mean the upstream request has ended; platform records determine usage.",
  "实验功能：目前支持本地模型与文件任务，官方电商云端工具执行尚未支持；仅限已验证的 Apple Silicon Mac 和 Accio 版本。":
    "Experimental: local model and file tasks are supported; official commerce cloud tool execution is not yet supported. Limited to verified Apple Silicon Macs and Accio versions.",
  "此系统请手动安装并打开 TRAE；自动启动仍待验证。":
    "Install and open TRAE manually on this system. Automatic launch is not yet verified.",
  "TRAE 操作未完成，请确认官方安装与应用路径后重试。":
    "TRAE operation did not complete. Check the official installation and app path, then retry.",
  "暂未检测到 TRAE，请安装后重新检测或选择路径。":
    "TRAE was not detected. Finish installation, then check again or select its path.",
  "已检测到 TRAE，请打开后登录官方账号并完成模型配置。":
    "TRAE detected. Open it, sign in to TRAE and complete model setup.",
  "TRAE 安装与启动": "TRAE installation and launch",
  "TRAE 检测失败，请重新检测。": "TRAE detection failed. Check again.",
  "TRAE 自选路径已失效，请重新选择或清除后检测。":
    "The selected TRAE path is no longer valid. Select it again, or clear it and check again.",
  "已检测到 TRAE，启动时核验官方签名；不代表模型已配置。":
    "TRAE detected. Its official signature is checked at launch. This does not confirm model setup.",
  "尚未检测到 TRAE，请安装后重新检测。":
    "TRAE has not been detected. Install it, then check again.",
  "重新检测 TRAE": "Check for TRAE again",
  "选择 TRAE 路径": "Select TRAE path",
  "清除 TRAE 自选路径": "Clear selected TRAE path",
  "已请求打开 TRAE，请在官方应用中登录并配置模型。":
    "TRAE launch requested. Sign in and configure your model in the official app.",
  "打开 TRAE": "Open TRAE",
  "下载并检测 TRAE": "Download and detect TRAE",
  "停止 TRAE 安装检测": "Stop checking TRAE installation",
  "关闭此向导会停止安装检测；不会关闭 TRAE，也不会写入或修改它的模型配置。":
    "Closing this guide stops installation checks. It does not close TRAE or change its model configuration.",
  "请先在 TRAE 登录官方账号。未登录时，Models 页面只显示登录入口，无法添加自定义模型。":
    "Sign in to your official TRAE account first. Without sign-in, the Models page only shows a login button and custom models cannot be added.",
  "TRAE 辅助配置": "TRAE assisted setup",
  "配置 TRAE": "Set up TRAE",
  "TRAE 自定义模型配置": "TRAE custom model setup",
  "生成官方自定义模型的填写说明；需在 TRAE 内完成配置，尚未验证接通。":
    "Prepare the official custom model fields. Complete setup in TRAE; connectivity has not been verified.",
  "依据国际版 TRAE 3.6.4 核对；国内版、其他版本和原生请求效果仍需验证。":
    "Checked against international TRAE 3.6.4. The China edition, other versions and native requests still need validation.",
  "TRAE 官方下载": "Official TRAE download",
  "TRAE 官方说明": "Official TRAE instructions",
  "API 格式": "API format",
  "TRAE API 格式": "TRAE API format",
  "请选择渠道实际支持的格式；元衡不会在此向导中自动转换协议或测试模型。":
    "Choose a format supported by your channel. This guide does not convert protocols or test models.",
  "请先连接元衡账号，再选择分组和模型。":
    "Connect your YuanHeng account before choosing a group and model.",
  "当前连接地址不受此向导支持，未生成请求地址。":
    "This guide does not support the current connection address. No request URL was generated.",
  "请选择 TRAE 要使用的分组和模型。":
    "Choose the group and model to use in TRAE.",
  "该分组与模型组合已不可用，请刷新目录或重新选择。":
    "This group and model pair is no longer available. Refresh the catalog or select another pair.",
  "请选择支持的 API 格式。": "Choose a supported API format.",
  "所选分组：{{group}}": "Selected group: {{group}}",
  "打开 TRAE 设置 → Models（模型）→ Add Model（添加模型）→ Custom Model（自定义模型）。":
    "Open TRAE Settings → Models → Add Model → Custom Model.",
  "API Format 选择 {{format}}，打开 Full URL（完整地址）开关。":
    "Set API Format to {{format}} and turn on Full URL.",
  "在元衡令牌管理中选择或创建同一分组的专用 API Key，再粘贴到 TRAE 的 API Key 栏。不要使用登录密码或 PROXY_MANAGED。":
    "Select or create a dedicated API key in the same group in YuanHeng token management, then paste it into TRAE's API Key field. Do not use your login password or PROXY_MANAGED.",
  打开元衡令牌管理: "Open YuanHeng token management",
  "在 TRAE 内保存，并在输入框的模型菜单选择刚添加的模型。发送测试消息后，到元衡请求日志核对模型和分组；测试会产生用量。":
    "Save in TRAE and select the added model in the input box's model menu. Send a test message and check the model and group in YuanHeng request logs. Testing incurs usage.",
  "这里选择分组只生成说明，不会修改 API Key 的分组、权限或 TRAE 配置；实际路由和计费以所填令牌为准。":
    "Choosing a group here only prepares instructions. It does not change your API key's group, permissions or TRAE configuration. The supplied token determines routing and billing.",
  "TRAE 的保存流程使用官方账号服务，请先确认其凭据处理规则。此向导不读取或提交密钥，也不替代 TRAE 官方登录。":
    "TRAE's save flow uses its official account service. Review its credential handling before proceeding. This guide neither reads nor submits keys and does not replace TRAE sign-in.",
  "复制 {{field}}": "Copy {{field}}",
  "复制失败，请手动选中复制。":
    "Copy failed. Select and copy the text manually.",
  "打开失败，请重试。": "Could not open the page. Try again.",
  图片分组: "Image group",
  "{{tool}} 图片分组": "{{tool}} image group",
  使用聊天连接: "Use chat connection",
  图片分组已更新: "Image group updated",
  "聊天中需要图片时可调用此技能，生成或编辑后继续对话。":
    "Use this skill when images are needed in a conversation, then continue chatting after generation or editing.",
  "可为图片单独选择分组，聊天模型和分组保持不变；生成费用按所选分组结算。":
    "Choose a separate group for images while keeping your chat model and group. Image generation is billed under the selected group.",
  "正在读取可选图片分组…": "Loading image group options…",
  "无法读取图片分组，请重新检查图像能力。":
    "Could not load image groups. Check image capability again.",
  "当前自动选择：{{model}}": "Current automatic selection: {{model}}",
  "当前连接没有可用的 GPT 图像模型，请选择其他图片分组。":
    "This connection has no available GPT image models. Choose another image group.",
  "图片模型目录尚未确认，请检查图像能力。":
    "The image model catalog has not been verified. Check image capability.",
  图像能力操作失败: "Image capability action failed",
  图像能力已安装或更新: "Image capability installed or updated",
  办公技能包已导出: "Office skill package exported",
  "{{tool}} 图像生成能力": "{{tool}} image generation",
  "最新可用版本 · 质量优先": "Latest available version · Quality first",
  "使用当前工具的元衡连接，按需生成或编辑图片，完成后继续对话。":
    "Generate or edit images using this tool’s YuanHeng connection, then continue the conversation.",
  "正在检查图像能力…": "Checking image capability…",
  "无法检查图像能力，请重试。": "Could not check image capability. Try again.",
  "当前工具暂不支持此图像技能。请选择其他工具。":
    "This tool does not support this image skill yet. Choose another tool.",
  图像技能已启用: "Image skill enabled",
  图像技能未启用: "Image skill disabled",
  元衡连接已配置: "YuanHeng connection configured",
  元衡连接未配置: "YuanHeng connection not configured",
  图像能力已就绪: "Image capability ready",
  等待本地连接就绪: "Waiting for the local connection",
  前往工具管理配置连接: "Configure the connection in Tools",
  "开发模式安装到 ~/.codebuddy/skills；办公模式请导出 ZIP 后在 WorkBuddy 中导入。导入包仅限本机使用。":
    "Code mode installs to ~/.codebuddy/skills. For Office mode, export a ZIP and import it in WorkBuddy. The package works only on this computer.",
  "在 {{tool}} 中启用图像生成": "Enable image generation in {{tool}}",
  安装并启用: "Install and enable",
  "导出办公模式 ZIP": "Export Office ZIP",
  检查图像能力: "Check image capability",
  下载进度: "Download",
  组件进度: "Components",
  "已处理 {{completed}} / {{total}} 个组件":
    "Processed {{completed}} / {{total}} components",
  "正在下载，文件总大小暂不可用。":
    "Downloading; total file size is not available yet.",
  "正在解析组件清单，确认总数后显示进度。":
    "Resolving components; progress will appear once the total is known.",
  "2 · 分组与模型": "2 · Group and model",
  "{{tool}} 分组与模型": "{{tool}} Group and Model",
  未选择分组: "No group selected",
  "选择分组，再选择模型": "Choose a group, then a model",
  "搜索分组或模型…": "Search groups or models…",
  "选择分组后展开模型，点选模型后应用完整组合":
    "Choose a group to see its models; select a model to use the pair",
  没有找到匹配的分组或模型: "No matching groups or models",
  "该厂商暂无可用分组，请刷新模型目录":
    "No available groups for this provider. Refresh the model catalog.",
  "{{count}} 个模型": "{{count}} models",
  先选择左侧分组: "Choose a group on the left",
  "当前组合未在目录中确认，已保留原配置；请刷新或重新选择分组与模型。":
    "This pair is not confirmed in the catalog. Your configuration is preserved; refresh or choose a group and model.",
  "选定分组和模型后立即应用。":
    "The selected group and model are applied immediately.",
  "选定分组和模型后，点击配置或启动保存。":
    "Choose a group and model, then configure or launch to save.",

  "正在准备安装…": "Preparing installation…",
  "正在检查官方最新版本…": "Checking the latest official version…",
  "正在下载运行环境…": "Downloading the runtime…",
  "正在校验下载文件…": "Verifying the download…",
  "正在解压运行环境…": "Extracting the runtime…",
  "正在下载并安装 DSH…": "Downloading and installing DSH…",
  "正在验证工具能否运行…": "Checking that the tool runs…",
  "正在保存并验证安装…": "Saving and verifying the installation…",
  "正在运行官方安装程序…": "Running the official installer…",
  "等待完成官网安装，正在自动检测…":
    "Waiting for installation; checking automatically…",
  安装进度: "Installation progress",
  "已用时 {{time}}": "Elapsed {{time}}",
  "已下载 {{size}}": "Downloaded {{size}}",
  "距上次进展 {{time}}": "Last activity {{time}} ago",
  "请在官网下载并运行安装包；元衡每 3 秒检测一次，最多等待 5 分钟。":
    "Download and run the official installer. YuanHeng checks every 3 seconds for up to 5 minutes.",
  "暂未收到新的进度，安装可能仍在进行。请检查网络或系统安装提示。":
    "No new progress yet; installation may still be running. Check your network or system installer prompts.",

  "DSH 版本更新": "DSH updates",
  "当前版本 {{version}}": "Current version {{version}}",
  检查更新: "Check for updates",
  "正在停止更新…": "Stopping update…",
  "正在验证 DSH 更新…": "Verifying DSH update…",
  "正在下载并更新 DSH…": "Downloading and updating DSH…",
  "正在检查 DSH 官方版本…": "Checking the official DSH version…",
  "无法检查 DSH 官方版本，请稍后重试。":
    "Could not check the official DSH version. Try again later.",
  "官方 latest：{{version}}": "Official latest: {{version}}",
  "此 DSH 来自自选路径或外部安装，请通过原渠道更新。":
    "This DSH uses a custom path or external installation. Update it through its original channel.",
  当前版本无需更新: "No update needed",
  "更新 DSH": "Update DSH",
  取消更新: "Cancel update",
  "DSH 更新完成并已验证；重新打开 DSH 后使用新版本。":
    "DSH updated and verified. Reopen DSH to use the new version.",
  "DSH 更新已取消，原安装保持不变。":
    "DSH update cancelled. The previous installation is unchanged.",

  本机登录信息需要恢复访问: "Access to saved sign-in needs to be restored",
  "macOS 暂时无法读取旧登录信息。你可以直接使用账号密码重新登录，无需恢复旧条目；也可以点击下方按钮，按系统提示恢复原来的登录。":
    "macOS cannot read the previous sign-in. You can sign in again with your username and password without restoring old entries, or use the button below to restore your previous sign-in with system authorization.",
  "已登录；本次会话未保存在本机，关闭应用后需要重新登录。":
    "Signed in for this session only. You will need to sign in again after closing the app.",
  恢复本机登录: "Restore saved sign-in",
  本机登录已恢复: "Saved sign-in restored",
  "凭据访问已恢复，请重新登录":
    "Credential access restored. Please sign in again.",
  "未恢复访问，原有登录信息已保留。可稍后再次点击恢复。":
    "Access was not restored. Your saved sign-in is unchanged. You can try again later.",
  "搜索令牌分组…": "Search token groups…",
  "星标收藏置顶，仅在本机保存":
    "Star groups to pin them. Saved on this device only.",
  没有找到匹配的分组: "No matching groups",
  "收藏分组 {{name}}": "Favorite group {{name}}",
  "取消收藏分组 {{name}}": "Unfavorite group {{name}}",

  常用收藏: "Favorites",
  "收藏模型 {{name}}": "Favorite model {{name}}",
  "取消收藏模型 {{name}}": "Unfavorite model {{name}}",
  "收藏厂商 {{name}}": "Favorite vendor {{name}}",
  "取消收藏厂商 {{name}}": "Unfavorite vendor {{name}}",
  "无法保存收藏，请检查本地存储后重试":
    "Could not save favorites. Check local storage and try again.",

  "基础环境已就绪，但工具检测未完成。请先点击重新检测，再继续配置 Claude。":
    "Prerequisites are ready, but tool detection did not finish. Redetect tools before continuing Claude setup.",
  不再提醒: "Don’t remind me again",
  "仅在本机生效，下次进入元衡不再自动提醒。需要时仍可在工具管理中安装或配置 Claude。":
    "Applies only on this device. YuanHeng will no longer remind you automatically on startup. You can still install or configure Claude in Tools.",
  "无法保存提醒偏好，请重试。":
    "Could not save your reminder preference. Please try again.",
  "请保存工作后重启 Windows。之后可在工具管理中继续安装或配置 Claude，不需要重新填写密钥。":
    "Save your work and restart Windows. You can then continue installing or configuring Claude in Tools without re-entering keys.",
  "准备 Claude Desktop 运行环境": "Prepare Claude Desktop",
  "安装应用、Windows 基础环境、官方工作区下载和模型连接分别检查；准备过程中不会自动重启或调用收费模型。":
    "App installation, Windows prerequisites, official workspace downloads and model connectivity are separate checks. Preparation never reboots automatically or invokes paid models.",
  "正在检查 Windows 运行环境…": "Checking Windows prerequisites…",
  "请保存工作后重启 Windows。重新打开元衡会恢复检查，之后点击继续即可，不需要重新填写密钥。":
    "Save your work and restart Windows. Reopen YuanHeng to resume checks, then continue without re-entering keys.",
  "继续安装或配置 Claude": "Continue Claude setup",
  准备必要组件: "Prepare required components",
  "正在准备，请稍候": "Preparing, please wait",
  "继续准备 Claude": "Resume Claude setup",
  后台继续: "Continue in background",
  "安装并准备 Claude Desktop": "Install and prepare Claude Desktop",
  安装并准备: "Install and prepare",
  准备运行环境: "Preparing environment",
  "运行环境已准备，请先连接元衡账号，再配置 Claude。":
    "Prerequisites are ready. Connect your YuanHeng account before configuring Claude.",
  "先准备 Claude 必要组件，通过后自动打开官方下载页；可能需要管理员授权及重启。":
    "Preparing Claude prerequisites before opening the official download page. Administrator approval and a restart may be required.",
  "先检查 Claude 必要组件，通过后打开官方下载页；安装完成后自动检测。":
    "Checking Claude prerequisites before opening the official download page. Installation is detected automatically.",
  "搜索模型名称或厂商…": "Search models or vendors…",
  按厂商筛选: "Filter by vendor",
  "显示 {{visible}} / {{total}} 个模型":
    "Showing {{visible}} / {{total}} models",
  清除筛选: "Clear filters",
  当前使用: "Currently selected",
  "{{count}} 个可用分组": "{{count}} available groups",
  "{{count}} 档推理等级": "{{count}} reasoning levels",
  "WSL 安装暂不支持安全取消，请在对应发行版检查进程":
    "Safe cancellation is unavailable for WSL. Check processes in the target distribution.",
  "取消不回滚已写文件；停止后请先重新检测":
    "Cancellation does not roll back files. Detect the tool again after stopping.",
  "安装已结束或尚未就绪，请稍后重新检测":
    "Installation has ended or is not ready. Check detection shortly.",
  "取消请求失败，安装可能仍在运行，请重试取消":
    "Cancellation failed. Installation may still be running; retry cancellation.",
  "正在停止安装…": "Stopping installation…",
  取消安装: "Cancel installation",
  "安装已停止；请先重新检测，取消不会回滚已写文件":
    "Installation stopped. Detect the tool again; cancellation does not roll back files.",
  "正在验证安装…": "Verifying installation…",
  "正在安装，请稍候…": "Installing, please wait…",
  "下载 Node.js LTS": "Download Node.js LTS",
  "无法打开下载页，请手动访问 nodejs.org":
    "Could not open the download page. Please visit nodejs.org.",
  "{{v0}} 安装完成并已验证可运行": "{{v0}} installed and verified",
  "默认体检不调用模型、不测试收费推理；服务运行、网关认证和桌面工作区是不同检查项。失败时可预览并导出同一份脱敏诊断。":
    "Default checks do not invoke models or billable inference. Service status, gateway authentication and the desktop workspace are separate checks. Preview and export the same redacted snapshot when troubleshooting.",
  "启动 DSH Web": "Launch DSH Web",
  "DSH 已安装，但配置未完成，请重试配置后启动":
    "DSH is installed, but configuration is incomplete. Retry configuration before launching.",
  "DSH 已配置，正在打开本机 Web 界面":
    "DSH is configured. Opening its local Web UI.",
  "可选择 DeepSeek Harness 应用或源码目录；源码需要依赖及构建。一键安装会独立准备运行环境并打开本机 Web，不修改旧目录。":
    "Select a DeepSeek Harness app or source directory; source requires dependencies and a build. One-click installation prepares a private runtime and opens the local Web UI without modifying old directories.",
  "同步桌面端和本机 Web 的模型目录。已有会话保留原模型；自定义 profile 和远程 Web 需单独配置。":
    "Sync model catalogs for Desktop and local Web. Existing sessions keep their model; custom profiles and remote Web require separate configuration.",
  "可选择 DeepSeek Harness 应用，或 deepseek-harness 源码目录。源码启动需要已完成 DSH 构建并安装 pnpm。":
    "Select the DeepSeek Harness app or the deepseek-harness source directory. Launching from source requires a built DSH checkout and pnpm.",
  "新模型的目录未包含原分组 {{old}}。是否改用 {{next}}？取消将保留原配置。":
    "The new model's catalog does not include {{old}}. Switch to {{next}}? Cancel keeps the original configuration.",
  "请先选择令牌分组，再配置或启动。":
    "Select a token group before configuring or launching.",
  选择令牌分组: "Select token group",
  "保留原分组：当前目录尚未确认其可用性。请刷新或手动选择，不会自动换组。":
    "Original group retained; availability is not confirmed in the current catalog. Refresh or choose manually. No automatic group switch.",
  "分组选择需点击配置或启动后保存；再次打开将恢复已保存配置。":
    "Click Configure or Launch to save your group choice. Reopening restores the saved configuration.",
  "历史会话配置与自定义供应商冲突（{{providers}}），已保留原配置，请检查供应商设置。":
    "History settings conflict with custom providers ({{providers}}). Your settings were preserved; review the provider configuration.",
  "历史会话配置需要修复，请再次点击当前使用方式。":
    "History settings need repair. Click the currently selected account mode again.",
  "历史对话沿用当前使用方式；旧模型不可用时，请在 Codex 中重新选择模型。":
    "Past conversations use the current account mode. If an old model is unavailable, select another model in Codex.",

  检查通过: "Checks Passed",
  "配置检查已通过，实际调用以请求记录为准。":
    "Configuration checks passed. Request records determine actual call results.",
  存在需要关注的项目: "Items Need Attention",
  "请查看本次检查详情与诊断报告。":
    "Review the current check details and diagnostic report.",
  本次检查项已通过: "The current checks passed",
  最近请求需要关注: "Recent requests need attention",
  "配置检查通过不等于模型调用成功，请查看报告中的最近 HTTP 状态和耗时。":
    "Passing configuration checks does not prove a model call succeeded. Review recent HTTP status codes and timings in the report.",
  本次检查发现需要关注的项目: "This check found items that need attention",
  预览脱敏报告: "Preview Redacted Report",
  脱敏诊断已导出: "Redacted diagnostics exported",
  "仅包含诊断元数据，不含账号、令牌、原始路径和对话内容。复制与导出使用本次快照，不会重新体检。":
    "Diagnostic metadata only: no account details, tokens, raw paths or conversations. Copy and export use this snapshot without running another check.",
  "分享前请确认内容；报告不会自动上传，快照有效期为 15 分钟。":
    "Review before sharing. Reports are never uploaded automatically. Snapshots expire after 15 minutes.",
  "本次检测暂未完成，仍显示上次本机快照；启动前会重新验证。":
    "Detection did not finish. Showing the last local snapshot; launch will revalidate.",
  网络体检超时: "Network check timed out",
  "已停止等待网络检查，仍可导出本机状态；未将账号判定为失效。":
    "Stopped waiting for the network. Local status can still be exported; the account was not marked invalid.",
  未读公告: "Unread announcement",
  "公告中心，有未读公告": "Announcements, unread notices",
  选择当前工具: "Choose current tool",
  公告中心: "Announcements",
  客户端更新: "App Updates",
  平台通知: "Platform Notices",
  "仅展示最近两次客户端更新，不累计历史记录。":
    "Only the latest two app updates are kept; older entries are not accumulated.",
  "v{{version}} 更新公告": "v{{version}} release notes",
  查看更新内容: "Read Updates",
  标记本次更新已读: "Mark Update as Read",
  "暂时无法同步，正在显示本地保存的最近两次更新。":
    "Unable to sync right now. Showing the last two locally saved updates.",
  配置待验证: "Configuration awaiting verification",
  连接与配置检查: "Connection and configuration check",
  "工具无法连接或报错时，检查登录状态、访问凭据和本地路由。":
    "If a tool cannot connect or reports errors, check sign-in, credentials, and local routing.",
  开始检查: "Start Check",
  "检查中…": "Checking…",
  "将重新生成当前设备凭据并更新工具配置；旧令牌会保留，避免中断其他工具，是否继续？":
    "Regenerate this device's credentials and update tool configurations? Old tokens will be retained to avoid interrupting other tools.",
  等待请求记录: "Waiting for a request record",
  等待调用验证: "Waiting for call verification",
  "调用失败（HTTP {{code}}）": "Call failed (HTTP {{code}})",
  帮助: "Help",
  官网: "Website",
  关闭帮助: "Close help",
  "使用说明随客户端更新，可离线查看。":
    "The guide updates with the app and is available offline.",
  使用说明: "User Guide",
  元衡使用说明: "YuanHeng User Guide",
  "安装、配置、模型切换和常见问题都可以在这里快速查看。":
    "Find concise help for installation, configuration, model switching, and common issues.",
  "当前说明版本：v0.1": "Guide version: v0.1",
  "内容会随元衡平台更新，客户端保留本地版本以便离线查看。":
    "The guide follows platform updates, with a local copy available offline.",
  打开网页版: "Open Web Guide",
  快速开始: "Getting Started",
  遇到问题: "Troubleshooting",
  "登录元衡账号，等待模型和令牌分组同步完成。":
    "Sign in to YuanHeng and wait for models and token groups to sync.",
  "进入工作台选择工具，点击配置，客户端会自动写入所需设置。":
    "Choose a tool in Workspace and click Configure. The required settings are written automatically.",
  "首次配置后按提示重新打开对应的 AI 工具。":
    "After the first setup, reopen the AI tool as prompted.",
  "在工作台直接切换模型、令牌分组和推理等级。":
    "Switch models, token groups, and reasoning levels directly in Workspace.",
  "Codex 支持在元衡中转与 OpenAI 官方账号之间切换。":
    "Codex can switch between YuanHeng Relay and an OpenAI official account.",
  "模型切换前会进行兼容性预检，避免配置后才发现协议或模型不匹配。":
    "A compatibility check runs before model changes to catch protocol or model mismatches early.",
  "先点击重新检测，确认工具路径、账号连接和本地路由状态。":
    "Click Retry Detection first to verify tool paths, account connection, and local routing.",
  "配置未生效时，完全退出并重新打开对应工具。":
    "If a configuration is not active, fully quit and reopen the tool.",
  "仍然失败时，查看诊断信息，并提供工具、模型、错误提示和发生时间。":
    "If it still fails, check diagnostics and provide the tool, model, error, and approximate time.",
  常见问题: "FAQ",
  "为什么配置后还不能用？": "Why does it still not work after configuration?",
  "多数情况是工具尚未重新打开，或当前模型/分组刚刚发生变化。":
    "Usually the tool has not been reopened, or the current model or group has just changed.",
  "切换官方账号会删除元衡配置吗？":
    "Does switching to the official account delete YuanHeng settings?",
  "不会。两种模式独立保存，切回元衡后会恢复上次模型和分组。":
    "No. Both modes are stored separately, and your previous YuanHeng model and group are restored when you switch back.",
  "第三方 Skill 可以直接安装吗？":
    "Can third-party Skills be installed directly?",
  "可以检索，但社区 Skill 可能未经验证，请确认来源后再安装。":
    "You can search for them, but community Skills may be unverified. Check the source before installing.",
  "请勿分享账号密码、API 密钥或未经授权的声音与内容。":
    "Do not share account passwords, API keys, or voices and content without authorization.",
  工作台: "Workspace",
  工具管理: "Tool Management",
  能力中心: "Capability Center",
  会话与用量: "Sessions & Usage",
  声音克隆: "Voice Clone",
  连接与路由: "Connections & Routing",
  设置: "Settings",
  元衡桌面端: "YuanHeng Desktop",
  日常使用: "Daily",
  专业控制: "Advanced",
  元衡用户: "YuanHeng User",
  "用户 {{id}}": "User {{id}}",
  "打开官网失败，请稍后重试":
    "Unable to open the website. Please try again later.",
  账号与余额: "Account & Balance",
  已登录: "Signed in",
  可用余额: "Available Balance",
  充值: "Top Up",
  访问元衡官网: "Visit YuanHeng Website",
  访问官网: "Visit Website",
  本地路由运行中: "Local routing is running",
  本地路由未启动: "Local routing is stopped",
  打开中: "Opening...",
  余额与消费记录由元衡平台统一管理:
    "Balance and billing records are managed by YuanHeng.",
  查看详情: "View Details",
  今日请求: "Requests Today",
  "今日 Tokens": "Tokens Today",
  今日成本: "Cost Today",
  缓存命中率: "Cache Hit Rate",
  请求数: "Requests",
  "{{count}} 次": "{{count}} requests",
  "Token 总量": "Total Tokens",
  估算成本: "Estimated Cost",
  "约 {{amount}}": "About {{amount}}",
  缓存率: "Cache Rate",
  "{{rate}}% 命中": "{{rate}}% hit",
  在线: "Online",
  离线: "Offline",
  "余额 ${{balance}}": "Balance ${{balance}}",
  元衡服务: "YuanHeng Service",
  已连接: "Connected",
  未连接: "Disconnected",
  本地路由: "Local Routing",
  "运行中 · {{port}}": "Running · {{port}}",
  运行中: "Running",
  未启动: "Stopped",
  应用接管: "App Routing",
  已启用: "Enabled",
  未启用: "Disabled",
  用量: "Usage",
  连接状态: "Connection Status",
  管理: "Manage",
  当前状态: "Current Status",
  焦点应用: "Focused App",
  查看用量: "View Usage",
  今日速览: "Today at a Glance",
  元衡连接: "YuanHeng Connection",
  远程服务: "Remote Service",
  请求直连上游: "Requests go directly upstream",
  "已接管至少一个 AI 工具": "At least one AI tool is routed",
  应用配置保持原状: "App configurations are unchanged",
  故障转移: "Failover",
  可按应用配置候选线路: "Backup routes can be configured per app",
  仅使用当前线路: "Current route only",
  本地路由与高可用: "Local Routing & High Availability",
  "专业功能默认收起，普通使用无需调整。":
    "Advanced controls are collapsed by default; no changes are needed for normal use.",
  本地接管: "Local Routing",
  自动故障转移: "Automatic Failover",
  路由设置保存失败: "Failed to save routing settings",
  "元衡账号负责远程权限和模型目录，本地路由负责接管、健康检查与故障转移。":
    "Your YuanHeng account provides remote access and the model catalog; local routing handles app routing, health checks, and failover.",
  "安装、检测和修复本机 AI 工具；日常模型切换请在工作台完成。":
    "Install, detect, and repair local AI tools. Switch models from the workspace.",
  "本地请求、会话历史和元衡余额集中在同一处查看。":
    "View local requests, session history, and your YuanHeng balance in one place.",
  元衡余额: "YuanHeng Balance",
  用量统计: "Usage Statistics",
  会话记录: "Session History",
  "给 AI 工具安装可复用的专业能力":
    "Install reusable capabilities for AI tools",
  "连接文件、数据库和外部服务":
    "Connect files, databases, and external services",
  按工具维护系统提示词和指令: "Manage system prompts and instructions per tool",
  自治代理编排能力仍在建设中:
    "Autonomous agent orchestration is under development",
  "YuanHeng 图像生成": "YuanHeng Image Generation",
  "自动选模 · 质量优先": "Auto model · Quality first",
  "配置元衡 Codex 后自动启用，按需在对话中生成或编辑图片。使用当前连接可用的最新 GPT Image 模型，生成后继续对话。":
    "Enabled automatically after configuring YuanHeng Codex. Generate or edit images during a conversation with the latest GPT Image model available to your connection, then continue chatting.",
  图像生成能力已更新: "Image generation capability updated",
  "图像生成能力已启用到 Codex": "Image generation capability enabled for Codex",
  图像生成能力安装失败: "Failed to install image generation capability",
  更新能力: "Update Capability",
  "启用到 Codex": "Enable for Codex",
  "统一管理 {{app}} 的 Skills、MCP、提示词与 Agent 能力。":
    "Manage Skills, MCP, prompts, and agent capabilities for {{app}}.",
  正在检测本机工具: "Detecting local tools",
  本机工具检测失败: "Local tool detection failed",
  "尚未检测到已安装的 AI 工具": "No installed AI tools detected",
  "没有将检测失败误判为未安装，你可以重新检测或进入工具管理。":
    "The detection error was not treated as an uninstall. Retry detection or open Tool Management.",
  "安装或配置工具后，这里会显示当前工具、模型和令牌分组。":
    "After installing or configuring a tool, its current model and token group will appear here.",
  打开工具管理: "Open Tool Management",
  安装与配置: "Install & Configure",
  未选择: "Not Selected",
  "{{tool}} 模型供应商": "{{tool}} Model Provider",
  "{{tool}} {{vendor}}模型": "{{tool}} {{vendor}} Models",
  "选择 {{vendor}}模型": "Select {{vendor}} Models",
  供应商: "Provider",
  "{{tool}} 当前工具令牌分组": "{{tool}} Token Group",
  正在读取本机工具与配置状态: "Reading local tool and configuration status",
  当前模型: "Current Model",
  使用方式: "Connection Mode",
  "OpenAI 官方账号": "OpenAI Official Account",
  "使用 Codex 中已登录的 OpenAI 官方账号":
    "Use the OpenAI account already signed in to Codex",
  "使用元衡模型、分组与本地安全路由":
    "Use YuanHeng models, token groups, and local secure routing",
  元衡中转: "YuanHeng Relay",
  "OpenAI 官方": "OpenAI Official",
  使用元衡模型与令牌分组: "Use YuanHeng models and token groups",
  "当前使用 OpenAI 官方账号，模型由 Codex 管理":
    "The OpenAI official account is active. Codex manages the model.",
  "已切换到 OpenAI 官方账号": "Switched to the OpenAI official account",
  已切换到元衡中转: "Switched to YuanHeng Relay",
  "Codex 使用方式切换失败": "Failed to switch the Codex connection mode",
  配置已写入: "Configuration Written",
  路由已启动: "Routing Ready",
  无需本地路由: "No Local Route Needed",
  等待重新打开: "Waiting for Reopen",
  客户端已就绪: "Client Ready",
  已收到请求: "Request Received",
  请求不可观测: "Request Not Observable",
  模型调用成功: "Model Call Succeeded",
  模型兼容性预检: "Model Compatibility Check",
  预检通过: "Check Passed",
  需要自动准备: "Auto Setup Needed",
  预检未通过: "Check Failed",
  快捷切换: "Quick Switch",
  账号默认: "Account Default",
  查看所有工具: "View All Tools",
  启动: "Launch",
  "启动 {{tool}}": "Launch {{tool}}",
  工作目录: "Working Directory",
  用户主目录: "Home Directory",
  "选择 {{tool}} 工作目录": "Choose {{tool}} Working Directory",
  "已将 {{tool}} 工作目录切换为 {{directory}}":
    "{{tool}} working directory changed to {{directory}}",
  选择工作目录失败: "Failed to choose working directory",
  选择模型: "Select Model",
  "搜索网站可用模型...": "Search available models...",
  "当前/推荐优先 · 新版本在前 · 共 {{count}} 个":
    "Current/recommended first · Newest first · {{count}} total",
  没有找到匹配的模型: "No matching models found",
  正在核验工具状态: "Verifying tool status",
  "待 {{count}} 个终端下一条消息应用":
    "Pending for {{count}} terminals on their next message",
  "已应用 {{model}}": "Applied {{model}}",
  "已连接 {{count}} 个终端": "{{count}} terminals connected",
  配置已生效: "Configuration Active",
  待配置: "Setup Required",
  "{{tool}} 模型选择": "{{tool}} Model",
  "{{tool}} 快捷令牌分组": "{{tool}} Quick Token Group",
  "{{tool}} 快捷推理等级": "{{tool}} Quick Reasoning Level",
  连接元衡后即可在此切换模型: "Connect YuanHeng to switch models here",
  快捷控制台: "Quick Console",
  不适用: "N/A",
  "网站模型同步失败，已保留上次可用列表":
    "Model sync failed. The last available list is preserved.",
  "{{tool}} 没有可用模型": "No models are available for {{tool}}",
  配置失败: "Configuration failed",
  "已选择 {{model}}，终端下一条消息自动应用":
    "Selected {{model}}. It will apply on the terminal's next message.",
  "Codex 默认模型已切换到 {{model}}":
    "Codex default model switched to {{model}}",
  模型切换失败: "Failed to switch model",
  "{{tool}} 已切换到 {{model}}": "{{tool}} switched to {{model}}",
  "{{tool}} 已切换到 {{group}} 分组 · {{model}}":
    "{{tool}} switched to group {{group}} · {{model}}",
  "{{tool}} 推理等级已更新 · {{model}}":
    "{{tool}} reasoning level updated · {{model}}",
  "{{tool}} 已启动": "{{tool}} launched",
  启动失败: "Launch failed",
  自动: "Auto",
  关闭: "Off",
  极简: "Minimal",
  低: "Low",
  中: "Medium",
  高: "High",
  超高: "Very High",
  最大: "Max",
  极限: "Ultra",
  "自动（默认：{{level}}）": "Auto (default: {{level}})",
  "已完成 {{count}} 个工具的元衡配置":
    "Configured {{count}} tools for YuanHeng",
  "{{tool}}：{{error}}": "{{tool}}: {{error}}",
  工具配置失败: "Tool configuration failed",
  "Codex 已切换到 {{model}}，下一条消息生效":
    "Codex switched to {{model}}. It will apply on the next message.",
  "已打开 {{tool}} 官方下载页，安装完成后请刷新检测":
    "Opened the official {{tool}} download page. Refresh detection after installation.",
  "{{tool}} 安装任务已完成": "{{tool}} installation completed",
  安装失败: "Installation failed",
  模型配置失败: "Model configuration failed",
  推荐模型: "Recommended Model",
  重新打开: "Reopen",
  打开: "Open",
  "{{tool}} 已使用 {{model}} {{action}}":
    "{{tool}} was {{action}} with {{model}}",
  网站模型同步失败: "Model sync failed",
  "已选择 {{count}} 个工具": "{{count}} tools selected",
  选择你需要使用的工具: "Select the tools you want to use",
  "元衡将写入 API、模型和认证配置；工作目录仅在你主动选择时更改。":
    "YuanHeng writes API, model, and authentication settings; working directories change only when you choose one.",
  刷新工具状态: "Refresh Tool Status",
  刷新: "Refresh",
  一键配置所选工具: "Configure Selected Tools",
  "请先连接元衡账号，再为工具写入配置。":
    "Connect your YuanHeng account before configuring tools.",
  "选择 {{tool}}": "Select {{tool}}",
  桌面应用: "Desktop App",
  未检测到: "Not Detected",
  自定义路径: "Custom Path",
  注册表检测: "Registry Detection",
  自动检测: "Automatic Detection",
  开始菜单检测: "Start Menu Detection",
  运行中检测: "Running Process Detection",
  尚未选择应用路径: "No application path selected",
  "原自定义路径已失效，当前继续使用自动检测结果。":
    "The custom path is no longer valid. The automatically detected app is still in use.",
  重新选择: "Choose Again",
  选择路径: "Choose Path",
  清除自定义路径: "Clear Custom Path",
  "已保存 {{v0}} 应用路径": "Saved the {{v0}} application path",
  应用路径无效: "Invalid application path",
  已恢复自动检测: "Automatic detection restored",
  清除应用路径失败: "Failed to clear the application path",
  已配置: "Configured",
  需更新: "Update Required",
  "打开 Claude Desktop": "Open Claude Desktop",
  重新检测: "Detect Again",
  桌面模型: "Desktop Model",
  终端模型: "Terminal Model",
  "{{tool}} 令牌分组": "{{tool}} Token Group",
  "{{count}} 档": "{{count}} levels",
  "{{tool}} 推理等级": "{{tool}} Reasoning Level",
  "配置已就绪，可直接启动使用。":
    "Configuration is ready. You can launch it now.",
  "配置发生变化，点击即可自动恢复。":
    "The configuration changed. Click to repair it automatically.",
  "元衡会自动选择适合的模型。":
    "YuanHeng automatically selects a suitable model.",
  "安装后即可由元衡自动配置。":
    "YuanHeng can configure it automatically after installation.",
  "打开 {{tool}} 官方下载页": "Open the official {{tool}} download page",
  "一键安装 {{tool}}": "Install {{tool}}",
  官方下载: "Official Download",
  一键安装: "Install",
  "配置 {{tool}}": "Configure {{tool}}",
  应用模型: "Apply Model",
  自动恢复: "Repair Automatically",
  重新配置: "Reconfigure",
  配置: "Configure",
  应用并刷新: "Apply & Refresh",
  应用并启动: "Apply & Launch",
  刷新显示: "Refresh",
  公告: "Announcement",
  进行中: "Ongoing",
  已上线: "Released",
  重要提醒: "Important Notice",
  紧急通知: "Urgent Notice",
  平台同步: "Platform Sync",
  关闭公告中心: "Close Announcement Center",
  平台公告: "Platform Announcements",
  "与元衡平台公告中心同步，每分钟自动检查更新":
    "Synced with YuanHeng announcements and checked every minute.",
  "已同步 {{count}} 条公告": "{{count}} announcements synced",
  查看历史: "View History",
  标记最新公告为已读: "Mark Latest Announcement as Read",
  "正在同步平台公告…": "Syncing platform announcements...",
  平台公告暂时同步失败: "Platform announcements are temporarily unavailable",
  "已同步，暂无公告": "Synced. No announcements yet.",
  欢迎: "Welcome",
  连接元衡: "Connect YuanHeng",
  配置工具: "Configure Tools",
  完成: "Done",
  "已有 {{count}} 个 AI 工具接入元衡，可以直接开始使用。":
    "{{count}} AI tools are connected to YuanHeng and ready to use.",
  "你可以稍后进入工具管理页面完成配置。":
    "You can finish setup later in Tool Management.",
  配置完成: "Setup Complete",
  首次配置: "First-time Setup",
  "连接元衡账号并配置本机 AI 工具":
    "Connect a YuanHeng account and configure local AI tools",
  "账号密码验证通过，请完成两步验证":
    "Password verified. Complete two-factor authentication.",
  注册并登录成功: "Registered and signed in",
  登录成功: "Signed in successfully",
  "登录账号不能为空且不能超过 254 个字符":
    "Sign-in name is required and must be no more than 254 characters",
  "用户名不能为空且不能超过 20 个字符":
    "Username is required and must be no more than 20 characters",
  "密码长度必须为 8 到 20 个字符": "Password must be 8–20 characters",
  两次输入的密码不一致: "Passwords do not match",
  注册失败: "Registration failed",
  登录失败: "Sign-in failed",
  请输入两步验证码或备用码: "Enter a two-factor code or backup code",
  两步验证失败: "Two-factor authentication failed",
  元衡数据已同步: "YuanHeng data synced",
  同步失败: "Sync failed",
  "已退出元衡账号，本机工具配置保持不变":
    "Signed out of YuanHeng. Local tool settings were preserved.",
  退出登录失败: "Sign out failed",
  "账号已断开；{{tools}} 缺少原配置，元衡配置仍保留":
    "Account disconnected. Original settings are missing for {{tools}}, so YuanHeng settings were preserved.",
  "已断开元衡账号，并恢复工具原配置":
    "YuanHeng account disconnected and original tool settings restored",
  已断开元衡账号: "YuanHeng account disconnected",
  断开失败: "Disconnect failed",
  完成两步验证: "Complete Two-Factor Authentication",
  登录你的元衡账号: "Sign In to YuanHeng",
  "输入认证器验证码或备用码，验证成功后即可继续。":
    "Enter an authenticator code or backup code to continue.",
  "直接使用账号密码登录或注册。密码不会保存在本机，登录后客户端会自动创建或复用本机专用工具凭据。":
    "Sign in or register with your username and password. Passwords are not stored locally; the app creates or reuses device-specific tool credentials after sign-in.",
  "6 位验证码或备用码": "6-digit code or backup code",
  输入元衡用户名: "Enter YuanHeng username",
  "8 到 20 个字符": "8–20 characters",
  再次输入密码: "Enter password again",
  注册并登录: "Register & Sign In",
  登录: "Sign In",
  一切正常: "All Good",
  "账号、API 和工具配置均可用。":
    "Your account, API, and tool configurations are available.",
  需要完成一项设置: "One Action Required",
  "元衡可以自动处理大部分配置问题。":
    "YuanHeng can automatically resolve most configuration issues.",
  当前不可用: "Currently Unavailable",
  "检查结果中有需要处理的问题。": "The check found issues that need attention.",
  "体检完成，一切正常": "Health check complete. Everything looks good.",
  "已修复 {{count}} 个工具配置": "Repaired {{count}} tool configurations",
  连接与凭据已恢复: "Connection and credentials restored",
  "自动修复失败，请重新登录": "Automatic repair failed. Please sign in again.",
  脱敏诊断已复制: "Redacted diagnostics copied",
  复制诊断失败: "Failed to copy diagnostics",
  "将重新生成当前设备凭据，并自动更新已经配置的工具。旧凭据会被撤销，是否继续？":
    "This regenerates credentials for this device and updates configured tools. The old credentials will be revoked. Continue?",
  "凭据已更新，并同步到 {{count}} 个工具":
    "Credentials updated and synced to {{count}} tools",
  本机凭据已重新生成: "Local credentials regenerated",
  重新生成凭据失败: "Failed to regenerate credentials",
  "脱敏诊断已导出：{{path}}": "Redacted diagnostics exported: {{path}}",
  导出诊断失败: "Failed to export diagnostics",
  前往登录: "Sign In",
  重新检查: "Check Again",
  一键修复: "Repair Now",
  暂时无法检查: "Unable to Check",
  智能体检: "Health Check",
  检查详情: "Check Details",
  复制脱敏诊断: "Copy Redacted Diagnostics",
  导出脱敏诊断: "Export Redacted Diagnostics",
  重新生成本机凭据: "Regenerate Local Credentials",
  模型自动同步: "Automatic Model Sync",
  配置立即生效: "Instant Configuration",
  本机安全凭据: "Secure Local Credentials",
  返回首页: "Return Home",
  切换模型与分组: "Switch models and groups",
  "Skills、MCP 与提示词": "Skills, MCP, and prompts",
  查看请求与成本: "View requests and costs",
  账号连接与本地代理: "Account connection and local proxy",
  应用偏好: "App preferences",
  "操作失败，请稍后重试": "Action failed. Please try again later.",
  "搜索页面、工具或操作...": "Search pages, tools, or actions...",
  页面导航: "Navigation",
  切换当前工具: "Switch Current Tool",
  "切换工具 {{tool}}": "Switch to {{tool}}",
  快捷操作: "Quick Actions",
  "充值 余额 topup": "top up balance",
  "官网 website": "website",
  "检查更新 update": "check updates",
  没有找到匹配的操作: "No matching actions found",
  充值账户余额: "Top Up Account Balance",
  检查客户端更新: "Check for App Updates",
  "↑↓ 选择 · Enter 执行 · Esc 关闭": "↑↓ Select · Enter Run · Esc Close",

  "统一管理 {{v0}} 的 Skills、MCP、提示词与 Agent 能力。":
    "Manage Skills, MCP, prompts, and agent capabilities for {{v0}}.",
  发现能力: "Discover Capabilities",
  全局能力配置: "Global Capability Settings",
  "按工具管理图像生成、Skills、MCP、提示词与 Agent 能力。":
    "Manage image generation, Skills, MCP, prompts, and agents by tool.",
  通用能力配置: "General Capability Settings",
  "此处管理 {{app}} 的通用能力，启用状态同步到该工具。":
    "Manage general capabilities for {{app}} here. Enabled settings sync to that tool.",
  当前管理: "Currently managing",
  "，启用状态直接同步到对应工具。":
    ". Enabled states sync directly to the corresponding tool.",
  "从技能仓库发现并安装新能力；安装后可按工具启用。":
    "Discover and install capabilities from the skill repository, then enable them per tool.",
  "{{v0}} 次": "{{v0}} requests",
  "约 {{v0}}": "About {{v0}}",
  "{{v0}}% 命中": "{{v0}}% hit",
  "余额 ${{v0}}": "Balance ${{v0}}",
  "运行中 · {{v0}}": "Running · {{v0}}",
  当前工具: "Current Tool",
  分组: "Group",
  推理: "Reasoning",
  "先选供应商，再选模型；修改后立即生效":
    "Choose a provider, then a model. Changes apply immediately.",
  "1 · 模型供应商": "1 · Model Provider",
  "{{v0}} 模型供应商": "{{v0}} Model Provider",
  "2 · 细分模型": "2 · Model",
  "{{v0}} {{v1}}模型": "{{v0}} {{v1}} Models",
  "选择 {{v0}}模型": "Select {{v0}} Models",
  "3 · 令牌分组": "3 · Token Group",
  "{{v0}} 当前工具令牌分组": "{{v0}} Token Group",
  "切换工具 {{v0}}": "Switch to {{v0}}",
  当前: "Current",
  推荐: "Recommended",
  "模型目录与可用分组来自你的元衡账号。":
    "The model catalog and available groups come from your YuanHeng account.",
  "已识别 {{v0}} 个图像生成专用模型。它们不能作为终端主模型，请通过 Images API 或图像生成工具调用。":
    "{{v0}} image-generation-only models detected. They cannot be terminal chat models; use the Images API or an image generation tool.",
  "检测失败不会再显示成“未安装”，请重新检测。":
    "Detection failures are no longer shown as uninstalled. Please detect again.",
  "直接调整模型、令牌分组和推理等级":
    "Adjust models, token groups, and reasoning levels directly",
  安装与维护: "Install & Maintain",
  "未检测到已安装的 AI 工具": "No installed AI tools detected",
  去安装与配置: "Install & Configure",
  "待 {{v0}} 个终端下一条消息应用":
    "Pending for {{v0}} terminals on their next message",
  "已应用 {{v0}}": "Applied {{v0}}",
  "已连接 {{v0}} 个终端": "{{v0}} terminals connected",
  "启动 {{v0}}": "Launch {{v0}}",
  模型: "Model",
  "{{v0}} 模型选择": "{{v0}} Model",
  令牌分组: "Token Group",
  "{{v0}} 快捷令牌分组": "{{v0}} Quick Token Group",
  推理等级: "Reasoning Level",
  "{{v0}} 快捷推理等级": "{{v0}} Quick Reasoning Level",
  "一次连接，配置所有 AI 工具": "Connect Once, Configure Every AI Tool",
  "连接元衡账号，选择本机需要使用的工具，自动写入 API、认证和推荐模型。":
    "Connect your YuanHeng account, select local tools, and automatically apply API, authentication, and recommended model settings.",
  "也可以暂时跳过，稍后在“连接与路由”中完成。":
    "You can also skip this for now and finish it later in Connections & Routing.",
  选择需要的工具: "Select Your Tools",
  "只配置你实际使用的工具，之后可以随时增减。":
    "Configure only the tools you use. You can add or remove them at any time.",
  "已有 {{v0}} 个 AI 工具接入元衡，可以直接开始使用。":
    "{{v0}} AI tools are connected to YuanHeng and ready to use.",
  稍后配置: "Configure Later",
  上一步: "Back",
  继续: "Continue",
  进入工具中心: "Open Tool Center",
  重试: "Retry",
  "已同步 {{v0}} 条公告": "{{v0}} announcements synced",
  "自动（默认：{{v0}}）": "Auto (default: {{v0}})",
  "已完成 {{v0}} 个工具的元衡配置": "Configured {{v0}} tools for YuanHeng",
  "{{v0}}：{{v1}}": "{{v0}}: {{v1}}",
  "Codex 已切换到 {{v0}}，下一条消息生效":
    "Codex switched to {{v0}}. It will apply on the next message.",
  "已打开 {{v0}} 官方下载页，安装完成后请刷新检测":
    "Opened the official {{v0}} download page. Refresh detection after installation.",
  "{{v0}} 安装任务已完成": "{{v0}} installation completed",
  "{{v0}} 已使用 {{v1}} {{v2}}": "{{v0}} was {{v2}} with {{v1}}",
  "已选择 {{v0}} 个工具": "{{v0}} tools selected",
  "选择 {{v0}}": "Select {{v0}}",
  可选: "available",
  "个 · 点击切换": " · click to switch",
  "{{v0}} 令牌分组": "{{v0}} Token Group",
  " · {{v0}} 档": " · {{v0}} levels",
  "{{v0}} 推理等级": "{{v0}} Reasoning Level",
  "右下角固定显示“元衡\n                      AI”；模型与推理等级在此切换，无需重启。":
    "YuanHeng AI stays visible in the lower-right corner. Switch models and reasoning levels here without restarting.",
  "从元衡启动后，模型会在同一会话的下一条消息自动切换，无需重启。":
    "After launching from YuanHeng, the model switches on the next message in the same session without restarting.",
  "使用独立桌面配置；已有任务保持原模型，请新建任务。":
    "Uses a separate desktop configuration. Existing tasks keep their original model; create a new task to use the new model.",
  "写入 WorkBuddy 自定义模型；应用后会重新打开。":
    "Writes the WorkBuddy custom model and reopens the app after applying.",
  "打开 {{v0}} 官方下载页": "Open the official {{v0}} download page",
  "一键安装 {{v0}}": "Install {{v0}}",
  "配置 {{v0}}": "Configure {{v0}}",
  "一个入口，连接全部工具": "One Place for Every Tool",
  "登录后，模型与额度": "After sign-in, models and quota",
  自动同步到本机: "sync automatically to this device",
  "使用元衡账号统一管理 Claude、Codex、ChatGPT 等 AI\n            工具，无需逐个填写接口与密钥。":
    "Manage Claude, Codex, ChatGPT, and other AI tools with one YuanHeng account—no need to enter endpoints and keys for each tool.",
  "正在检查登录状态…": "Checking sign-in status...",
  登录后自动进入工作台: "Open the workspace automatically after sign-in",
  "账号已断开；{{v0}} 缺少原配置，元衡配置仍保留":
    "Account disconnected. Original settings are missing for {{v0}}, so YuanHeng settings were preserved.",
  "元衡 API": "YuanHeng API",
  账号密码仅用于本次认证: "Your password is used only for this authentication",
  两步验证码: "Two-Factor Code",
  验证并登录: "Verify & Sign In",
  返回账号登录: "Back to Account Sign-In",
  注册: "Register",
  用户名: "Username",
  密码: "Password",
  确认密码: "Confirm Password",
  "用户 {{v0}}": "User {{v0}}",
  "元衡账号已登录 · 本机工具凭据已就绪":
    "Signed in to YuanHeng · Local tool credentials are ready",
  同步: "Sync",
  退出登录: "Sign Out",
  "已修复 {{v0}} 个工具配置": "Repaired {{v0}} tool configurations",
  "凭据已更新，并同步到 {{v0}} 个工具":
    "Credentials updated and synced to {{v0}} tools",
  "脱敏诊断已导出：{{v0}}": "Redacted diagnostics exported: {{v0}}",
  其他模型: "Other Models",
  阿里千问: "Alibaba Qwen",
  "智谱 AI": "Zhipu AI",
  月之暗面: "Moonshot AI",
  字节豆包: "ByteDance Doubao",
  百度文心: "Baidu ERNIE",
  腾讯混元: "Tencent Hunyuan",
  "小米 MiMo": "Xiaomi MiMo",
  阶跃星辰: "StepFun",
  "美团 LongCat": "Meituan LongCat",
  "{{v0}} 没有可用模型": "No models are available for {{v0}}",
  "已选择 {{v0}}，终端下一条消息自动应用":
    "Selected {{v0}}. It will apply on the terminal's next message.",
  "Codex 默认模型已切换到 {{v0}}": "Codex default model switched to {{v0}}",
  "{{v0}} 已切换到 {{v1}}": "{{v0}} switched to {{v1}}",
  "{{v0}} 已切换到 {{v1}} 分组 · {{v2}}":
    "{{v0}} switched to group {{v1}} · {{v2}}",
  "{{v0}} 推理等级已更新 · {{v1}}": "{{v0}} reasoning level updated · {{v1}}",
  "配置已保存；重启 Codex App 后加载新的模型与推理档位":
    "Configuration saved. Restart Codex App to load the new model and reasoning options.",
  需要重启以加载模型目录: "Restart required to load the model catalog",
  "重启并应用 {{v0}}": "Restart and apply {{v0}}",
  重启并应用: "Restart & Apply",
  "{{v0}} 已启动": "{{v0}} launched",
  尚未连接元衡: "YuanHeng Not Connected",
  登录后会自动创建本机凭据并检查工具配置:
    "After sign-in, local credentials are created and tool configurations are checked automatically.",
  登录状态不完整: "Incomplete Sign-In State",
  请重新登录元衡账号: "Please sign in to YuanHeng again.",
  账号连接正常: "Account Connection Healthy",
  登录状态有效: "Your sign-in session is valid.",
  登录状态已失效: "Sign-In Session Expired",
  请退出后重新登录元衡账号: "Sign out and sign in to YuanHeng again.",
  本机凭据缺失: "Local Credentials Missing",
  可以自动重新创建本机工具凭据:
    "Local tool credentials can be recreated automatically.",
  "API 连接正常": "API Connection Healthy",
  本机凭据可访问模型接口: "Local credentials can access the model API.",
  本机凭据已失效: "Local Credentials Expired",
  可以自动重新同步本机工具凭据:
    "Local tool credentials can be synced again automatically.",
  部分工具配置需要恢复: "Some Tool Configurations Need Repair",
  工具配置正常: "Tool Configuration Healthy",
  "尚未配置 AI 工具": "No AI Tools Configured",
  选择本机已安装的工具后即可一键配置:
    "Select installed tools to configure them with one click.",
  登录后会自动检查: "Checks run automatically after sign-in.",
  "已打开 {{v0}} 官方下载页，元衡将在后台等待安装完成":
    "Opened the official {{v0}} download page. YuanHeng will detect the installation in the background.",
  "暂未检测到 {{v0}}，可重新检测或手动选择路径":
    "{{v0}} was not detected yet. Retry detection or choose the app path manually.",
  "已检测到 {{v0}}，并完成元衡配置":
    "Detected {{v0}} and completed YuanHeng configuration.",
  "已检测到 {{v0}}，现在可以进行配置":
    "Detected {{v0}}. It is ready to configure.",
  "已检测到 {{v0}}，但自动配置未完成，可点击配置重试":
    "Detected {{v0}}, but automatic configuration did not finish. Use Configure to retry.",
  自动配置失败: "Automatic configuration failed",
  等待安装: "Waiting for Install",
  "将恢复元衡接管前的工具配置，并保留账号连接。外部修改过的文件不会被覆盖，是否继续？":
    "Restore tool configurations from before YuanHeng took control while keeping the account connected? Externally modified files will not be overwritten.",
  "已回滚 {{v0}} 个工具配置": "Rolled back {{v0}} tool configurations",
  没有可安全回滚的工具配置: "No tool configurations can be safely rolled back",
  "部分外部修改的配置已保留，请查看诊断详情":
    "Some externally modified configurations were preserved. Review the diagnostic details.",
  回滚工具配置失败: "Failed to roll back tool configurations",
  恢复接管前配置: "Restore Previous Configurations",
  "即将执行以下修复：": "The following repairs will be applied:",
  "修复前会保留可恢复的原工具配置，是否继续？":
    "Recoverable original tool configurations will be preserved before repair. Continue?",
  模型与分组匹配: "Models and Groups Match",
  已配置工具使用的模型仍在当前账号目录中:
    "Configured tools still use models available to the current account.",
  模型或分组已经失效: "Model or Group Is No Longer Available",
  本地模型路由正常: "Local Model Route Healthy",
  需要本地协议适配的桌面工具可以访问元衡:
    "Desktop tools that require local protocol adaptation can reach YuanHeng.",
  本地模型路由未运行: "Local Model Route Is Not Running",
  "Codex 或 Claude Desktop 的配置存在，但本地协议路由未启动。":
    "Codex or Claude Desktop is configured, but the local protocol route is not running.",
};

const DYNAMIC_EN: Array<[RegExp, (...matches: string[]) => string]> = [
  [
    /^检测到 (\d+) 个工具配置发生变化。$/,
    (count) => `${count} tool configurations have changed.`,
  ],
  [/^(\d+) 个工具已经就绪。$/, (count) => `${count} tools are ready.`],
  [
    /^(\d+) 个工具使用了当前账号目录中不存在的模型或分组。$/,
    (count) =>
      `${count} tools use a model or group that is unavailable to the current account.`,
  ],
];

const DYNAMIC_KO: Array<[RegExp, (...matches: string[]) => string]> = [
  [
    /^检测到 (\d+) 个工具配置发生变化。$/,
    (count) => `${count}개 도구 구성이 변경되었습니다.`,
  ],
  [/^(\d+) 个工具已经就绪。$/, (count) => `${count}개 도구가 준비되었습니다.`],
  [
    /^(\d+) 个工具使用了当前账号目录中不存在的模型或分组。$/,
    (count) =>
      `${count}개 도구가 현재 계정에 없는 모델 또는 그룹을 사용합니다.`,
  ],
];

const DYNAMIC_JA: Array<[RegExp, (...matches: string[]) => string]> = [
  [
    /^检测到 (\d+) 个工具配置发生变化。$/,
    (count) => `${count}個のツール設定が変更されました。`,
  ],
  [
    /^(\d+) 个工具已经就绪。$/,
    (count) => `${count}個のツールが準備完了しました。`,
  ],
  [
    /^(\d+) 个工具使用了当前账号目录中不存在的模型或分组。$/,
    (count) =>
      `${count}個のツールが現在のアカウントで利用できないモデルまたはグループを使用しています。`,
  ],
];

const DYNAMIC_ZH_TW: Array<[RegExp, (...matches: string[]) => string]> = [
  [
    /^检测到 (\d+) 个工具配置发生变化。$/,
    (count) => `偵測到 ${count} 個工具設定發生變更。`,
  ],
  [/^(\d+) 个工具已经就绪。$/, (count) => `${count} 個工具已就緒。`],
  [
    /^(\d+) 个工具使用了当前账号目录中不存在的模型或分组。$/,
    (count) => `${count} 個工具使用了目前帳號目錄中不存在的模型或分組。`,
  ],
];

function translateDynamic(
  source: string,
  translations: Array<[RegExp, (...matches: string[]) => string]>,
): string | undefined {
  for (const [pattern, translate] of translations) {
    const match = source.match(pattern);
    if (match) return translate(...match.slice(1));
  }
  return undefined;
}

function interpolate(template: string, values?: Values): string {
  if (!values) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    String(values[key] ?? ""),
  );
}

export function desktopLocale(): string {
  return i18n.resolvedLanguage || i18n.language || "en";
}

export function dt(source: string, values?: Values): string {
  const language = i18n.resolvedLanguage || i18n.language;
  let template: string;

  if (language === "zh-CN") {
    template = source;
  } else if (language === "zh-TW") {
    template =
      DESKTOP_ZH_TW[source] ??
      translateDynamic(source, DYNAMIC_ZH_TW) ??
      source;
  } else if (language === "ja") {
    template =
      DESKTOP_JA[source] ?? translateDynamic(source, DYNAMIC_JA) ?? source;
  } else if (language === "ko") {
    template =
      DESKTOP_KO[source] ?? translateDynamic(source, DYNAMIC_KO) ?? source;
  } else {
    template =
      DESKTOP_EN[source] ?? translateDynamic(source, DYNAMIC_EN) ?? source;
  }

  return interpolate(template, values);
}
