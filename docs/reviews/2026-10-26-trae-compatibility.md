# TRAE 接入现状核对

核对日期：2026-10-26。本地已有辅助配置、Mac安装检测及签名启动。独立Apple Silicon Mac VM已完成官方安装、登录、自定义模型保存/选择，以及鹈鹕王Astra的原生文件读取、写入、修改和读回验证。真实推理经短时QA转发进行，尚不等于产品Core自动接入；原生取消、跨模型切换和其他系统仍待验收。

后续状态：2026-10-27的[上线条件与原生取消对照](2026-10-27-trae-release-readiness.md)已复现本机路径停止未传播，不能按完整一键接入发布；本页早期“待验收”描述保留其当时检查范围。

## 元衡当前状态

以伙伴v0.1.107和本地Accio整合源码为范围，工具管理的[辅助向导](../../src/components/desktop/TraeSetupGuide.tsx)复用分组/模型选择器，提供完整请求地址、模型ID、官方步骤及同源令牌管理入口。[安装操作](../../src/components/desktop/TraeInstallationActions.tsx)复用缓存、本地路径检测、官方网页安装观察及路径选择；Mac启动经过[精确官方签名验证](../../src-tauri/src/trae.rs)，不强制重启或传入密钥。其他系统保留手动打开提示，不宣称跨平台启动已验证。TRAE仍不进入批量配置、工作台当前Agent或已接通状态，未实现自动写入或模型目录同步。

## 官方可用入口

从TRAE官方文档读取[Built-in models & custom models](https://docs.trae.ai/ide/models)，HTTP200，页面标题一致。文档列出两类入口：预置厂商填写API Key，以及Custom Model自定义配置。后者可填写API格式、请求URL、模型ID和认证信息；入口为IDE或Agent窗口的Settings → Models，已有自定义模型可管理启停。

这说明存在官方自定义模型接入路径，不必以替换官方登录或修改应用包作为起点。文档本身不证明元衡任意模型/协议均可用，也不证明存在可安全自动写入的配置文件或导入API。国内版本文档请求被重定向后返回400，本次不把国际版结论扩大到所有发行版本。

## 固定版本官方安装包证据

从[官方下载页](https://www.trae.ai/download)引用的资源定位到官方版本元数据 `https://icube-normal.trae.ai/icube/api/v1/native/version/trae/latest`。选取普通国际版manifest的darwin/apple/sg项，不使用同响应内的TraeCode企业版或TraeWork/SOLO包。

| 项目 | 核验结果 |
| --- | --- |
| 产品版本 / 构建 | TRAE 3.6.4 / 2.3.93439；product.json的1.107.1是VS Code基础版本 |
| 官方包来源 | `https://lf-cdn.trae.ai/obj/trae-ai-sg/pkg/app/releases/stable/2.3.93439/darwin/TRAE-darwin-arm64.dmg` |
| SHA256（本次下载） | `0bf501b0ce59332f694c98ca0e0061c270672e5767241da7a6c529db3b5a8163` |
| Bundle ID / Team ID | `com.trae.app` / `79M8227NKH` |
| 签名 | `Developer ID Application: SPRING (SG) PTE. LTD. (79M8227NKH)`；codesign deep/strict校验通过 |
| 检查方式 | DMG只读挂载、静态读取，不执行应用或其完整JavaScript、不复制到Applications |

`node_modules/@byted-icube/ai-modules-chat/dist/index.mjs`中的模型弹窗还提供 **OpenAI Responses API**，因此本地向导支持三种明确可选格式：

| TRAE API Format | 元衡Full URL |
| --- | --- |
| OpenAI Chat Completions | `/v1/chat/completions` |
| OpenAI Responses API | `/v1/responses` |
| Anthropic Messages | `/v1/messages` |

官方弹窗在Full URL关闭时分别追加`/chat/completions`、`/responses`或`/v1/messages`，故向导固定要求开启Full URL并提供完整地址。不能将同一个`/v1` Base URL不加区分地用于三种格式。格式支持不证明任意所选渠道具备对应推理或工具能力；向导不自动做付费测试。

同一模块的AddCustomModel/UpdateCustomModel会经wrapRequestWithCredential调用Agent模型服务；随包SDK列出`/api/ide/v1/add_custom_model`、`/api/ide/v1/update_custom_model`，字段含provider、model_name、ak、base_url、config_detail等。原生库还包含custom-model-proxy-client和官方/custom_model隧道。未确认公开的本地导入文件、深链或无需官方登录的接口；也不能单凭这些静态字段推断密钥最终存储位置和保存期限。元衡不会读取登录态、调用私有模型管理接口或代替用户提交密钥。

## 本地实现与后续边界

向导只接受当前或历史元衡的精确HTTPS来源，根路径或/v1路径；保留连接来源，不静默跨域迁移。模型和分组均须仍在当前终端模型目录内，图像专用模型不可选。账号切换、断开或地址变更关闭向导并清空选择，目录撤销即撤下可复制字段；所有输出字段不含密钥或个人路径。

选择分组只生成说明，实际API Key的分组/权限/计费不变。用户需在元衡令牌页准备同组专用Key，在TRAE原生界面粘贴、保存并选中模型；成功标准是实际请求日志与原生工具结果，不是打开下载页或复制成功。隔离环境已验证登录、保存/选择QA Astra、原生文件工具和同会话继续；后续仍须验证原生流式取消、跨模型切换及产品持久连接，再决定可维护的自动配置入口。Windows、Intel Mac及国内版未做原生验收。

静态调研阶段未运行官方应用。后续原生阶段只在独立QA VM安装并运行TRAE，未修改宿主Applications或个人TRAE资料。官方可能收到VM的设备标识、系统信息、出口IP及中性QA目录，已提前告知；没有复制宿主Home、钥匙串、剪贴板或云端会话。没有创建密钥；真实模型请求及其用量单列在下文，不与早期模拟测试混算。

## 独立 Mac 原生检查

复用既有无云端登录的空白基线，克隆`yuanheng-trae-macos`；4 CPU、8 GiB内存、80 GB稀疏盘，独立TRAE只读材料目录。Accio工作VM保持挂起。官方3.6.4 DMG摘要、完整应用签名、Bundle ID、Team ID及guest Gatekeeper评估均通过；宿主再次按产品启动器的精确codesign requirement验证原包通过。

通过正常系统安装复制及`open -a`进入官方应用。图形检查经历短暂截图失败，恢复后按原生首次流程依次完成默认主题、快捷键、跳过可选CLI安装和登录。首次IDE启动自动提示安装Apple命令行工具，本轮取消，不据此判定后续Git功能可用。

| 检查项 | 实际结果 |
| --- | --- |
| 官方App安装、启动、首次界面 | 通过，签名身份与3.6.4一致 |
| 未登录进入界面 | 可跳过登录进入Agent/IDE，不能据此判断AI可用 |
| Settings → Models | 页面只有Log in入口，未登录没有添加自定义模型入口 |
| Personal User登录入口 | Safari加载官方trae.ai登录页，邮箱、GitHub、Google选项可见；没有填写或提交真实凭据 |
| 原生模型保存、主模型推理、文件工具、取消/切换 | 尚未执行，等待用户在QA VM登录官方账号 |

只读检查发现原生Agent的`database.db`无法由普通SQLite读取（返回file is not a database），不能据此确定具体加密算法，也不解密或修改它。签名包的深链表有MCP/Skill/Agent导入，没有确认可用的模型导入入口；扩展层getWebSocketRpcClient对应的主线程makeRPCClient实现抛出not implemented，不能将同名API当作已经支持的模型写入契约。

TRAE Mac主进程的可执行文件名为Electron，所以不沿用按Trae进程名杀进程的刷新路径；本地新增入口只交给LaunchServices打开，不终止用户会话。安装候选路径与签名身份分开检查，自选路径失效时拒绝静默启动另一安装。

QA VM已在官方登录页面挂起保存，运行进程为零。独立QA目录提供打开/挂起脚本；恢复后若登录页面过期，重新从TRAE的Models页点Log in。此交接不是要求用户提供密码，也不是登录已完成的证据。

## 验证与清理

辅助配置初轮新增36项回归，前端157个文件/1076项通过。安装生命周期续验增加14项安装操作、4项官方下载观察/域名边界测试和6项Rust定位/签名/选项边界测试；最终前端158个文件/1094项、后端110项相关测试（misc97、desktop检测8、TRAE专属5，去除重复执行）通过，typecheck及生产renderer构建通过。构建仍提示既有浏览器数据库较旧及大分包，测试中的既有MSW模拟接口警告不代表原生Tauri/上游请求已通过。

下载包保留供后续核验；官方App只安装在QA VM，宿主未安装。选择与边界见[辅助配置决定](../../.agents/notes/implemented/feature/2026-10-26-trae-official-custom-models.md)及[原生接入提案](../../.agents/notes/proposed/feature/2026-10-26-trae-native-integration.md)。

最终默认feature的`cargo check --lib`、55篇笔记、格式和diff检查通过。宿主只读DMG已卸载，TRAE VM与Accio VM均为suspended、空白基线stopped，本任务测试进程为零；另一项目原有开发服务保留，没有为清零而结束无关进程。没有推送、合并或发布安装包。

## 登录后原生表单与受阻的模拟请求

用户后续亲自在独立VM完成Google登录。重开TRAE后账号仍有效，Models页显示Add Model，Custom Model表单可选协议、Full URL、Model ID、Display Name和API Key。此结果解除登录阻塞，未证明推理或自动导入已完成。没有读取/复制官方登录凭据，截图中出现的账号资料不抄入代码或报告。

第一轮模拟服务只监听guest `127.0.0.1:19473`，固定无效Key、合成模型名、没有任何上游转发，刻意响应503以阻止保存测试模型。自动UI输入存在可复现的修饰键丢失：`super+a`在TextEdit里成为字母a，`colon`及`shift+semicolon`成为分号，直接typeText中的冒号丢失；后续移除多余a，原始只读测试文本未改。屏幕截图缩放下曾把错误分隔符误读为冒号，复核后明确撤回该轮有效地址假设。

该次点击连通测试出现 `Invalid configuration: Provider request body cannot be replayed safely (HTTP Status: 500)`；renderer脱敏摘要记录内部码4028，fixture有效模型请求数为0。这个错误字符串存在于官方custom-model-proxy-client原生库，但不能用格式有误的地址证明TRAE正常请求也失败、官方一定不支持loopback或元衡渠道有问题。未点击Save Directly，未创建有真实权限的模型连接，未发送元衡收费请求。

自动控制还出现noWindowsAvailable、截图失败及全屏/普通窗口切换后坐标状态变化。使用官方控制工具重连、重选窗口、切换显示模式、文本文件复制准备后仍未得到稳定点击/修饰键输入；没有转用未授权的UI注入技术。QA材料包含只读准确URL、5分钟自动退出的模拟服务、脱敏摘要、人工启动入口和填写说明，等待一次人工原生表单操作后继续确认契约。

此前首次挂起恢复出现VZErrorDomain 12 invalid argument。原VM完整磁盘/config/nvram/内存状态先做本机写时复制备份，再将原内存状态重命名保留后冷启动，官方安装和登录流程可继续；未删除原VM、快照或其他VM。后续QA启动加入Tart已提供的`--suspendable`，固定可挂起设备配置；尚不能把该选项的调整当作恢复根因已完全证明。自动验证另有60分钟上限，普通人工打开保持30分钟，收尾仍要主动停止。

本轮末尾已实际完成新配置下的挂起→恢复→guest命令执行：恢复成功。独立模拟服务自检通过，HTTP503及固定标记、请求计数1、dummy鉴权匹配、子进程退出都已断言；摘要显式标记`fixture-self-test-not-trae`，不能计入原生模型成功。真实原生UI测试仍未取得有效地址发送证据。控制工具最后返回`Sky Computer Use native pipe closed before response`，未继续盲点界面。

人工测试仅需打开QA VM、填写合成参数、启动5分钟模拟服务并点击一次Test and Add；不要点Save Directly，也不填写真实Key。模拟入口与说明留在专用本机QA目录，未加入产品代码或发布包。后台探针均有自退和信号清理，收尾主动挂起VM、卸载宿主只读DMG，保留官方登录状态与恢复备份。

## 人工入口关闭反馈与监督修复

用户反馈打开后自行关闭。2026-10-26晚间检查时VM为suspended，没有运行的测试进程；旧run.log中同时有历史正常停止和VZErrorDomain12恢复失败，但缺少每次起止时间与触发原因，不能把旧错误当作本次根因。使用原.command复跑可恢复到已登录TRAE表单，guest安装/资料/共享目录正常，未复现立即关闭。

确认原人工入口与自动run共用30分钟SIGINT/10秒后SIGTERM，没有预告；这会造成无提示停止，但不足以确定用户描述对应哪次事件。现人工.command改走run-manual，60分钟、提前5分钟预告、回车续时，到期/Ctrl-C/HUP/EOF均请求原生挂起；失败不强杀或报假清理。Tart子进程与终端分离进程组但保持父监督，避免Ctrl-C直接中断状态保存。失败及正常完成后的终端保留结果待回车，所有起止/续时/原因写入本机operations.jsonl。

10项监督测试、Node/zsh语法检查通过；两轮实际恢复/guest检查/挂起通过，回车续时、重复启动拒绝且原实例存活、.command错误停留与Ctrl-C后正常停留均实测。修改仅在专用QA启动器，未修改TRAE包、模型配置或其他VM，也未发布客户端。见[人工窗口监督决定](../../.agents/notes/implemented/testing/2026-10-26-trae-manual-vm-lifecycle.md)。

## 正确地址的原生本机请求通过（2026-10-26 20:34，北京时间）

用户要求代填表单后，使用虚拟机内部TextEdit的Edit→Select All/Copy和TRAE的Edit→Paste，把只读测试文本中的完整URL送入请求地址栏；宿主剪贴板共享仍关闭。明确核对两个冒号后，填入合成model和dummy Key，Full URL开启，Chat Completions格式，点击一次Add Model。这个操作绕过修饰键失真，并非修改系统输入设置或注入官方App。

原生UI最终显示 `YUANHENG_QA_LOCAL_ROUTE_VERIFIED_NO_MODEL_SAVED (HTTP Status: 503)`，与只监听guest loopback的夹具响应一致。独立摘要确认仅1条模型请求：北京时间20:34:33.810、`POST /v1/chat/completions`、`application/json`、model精确为`yuanheng-qa-loopback`、dummy Authorization匹配、stream=true，正文357字节，字段为max_tokens/messages/model/stream，messagesCount=1。夹具不记录提示词或真实凭据，origin显式为native-ui-test，与先前self-test分开。

这是TRAE国际版3.6.4原生连通检测能请求本机HTTP地址的有效证据；不能扩展成所有真实任务、流式成功解析、文件工具或元衡全自动接入已通过。先前格式错误地址的500不再作为正确配置的行为参考。故意503阻止自动保存，没有点Save Directly，没有填入真实Key、没有元衡付费推理。

结束时guest断言fixture进程0、19473监听关闭，并核对最终summary的原生请求仍为1。原夹具5分钟边界与SSH监督时间接近，已将夹具自退提前10秒保留刷新摘要窗口；独立结束证据确认此次summary已写入stoppedAt。表单和登录状态保留供后续接入验证。

## Astra 真实原生连通与保存通过（2026-10-26 21:35，北京时间）

用户授权继续后，从宿主现有元衡连接只读获取测试token，在同源public_token查询实际组为`OpenAI · 鹈鹕王`，/v1/models确认`gpt-6-astra`可用。缓存主token组为福利，不能据此判断正在使用的工具token组；此次以token实际查询结果为准，没有创建/更改token或组。

真实Key只在宿主短时转发进程内存使用，通过SSH反向loopback把guest19473接到宿主随机loopback端口。官方TRAE仍填写固定无权限占位Key，不把真实Key交给TRAE官方模型配置服务或写入guest文件。转发固定元衡origin/Chat Completions路径/Astra，单并发、最多8请求、20分钟窗口、每次90秒和最多2048输出tokens；失败即拒绝后续请求，不自动重试。5项合成上游回归验证准确路径/模型/鉴权、来源拒绝、限额、HTTP与不完整流失败停止、取消/并发和敏感字段不进日志；不是产品Core实现。

原生界面使用Full URL、model `gpt-6-astra`、display name `yuanheng qa astra`，点一次Test and Add。摘要记录北京时间21:35:21.164的一条真实请求，HTTP200、finish_reason=stop、[DONE]、responseBytes=1526，usage为prompt_tokens4126/completion_tokens11/total4137。TRAE设置页Custom下出现已启用的`yuanheng qa astra`，证明原生连通测试消费了完整流并成功保存配置。

基础文件任务尚未提交。IDE输入框模型菜单只能观察到顶部内置条目，滚动/End/PageDown未产生可验证的位置变化；切到官方Agent窗口后CUA坐标操作返回noWindowsAvailable，不能确认输入框已选中自定义模型。没有在Auto或内置模型下发送测试，也没有用后台脚本生成result.json来冒充原生工具执行。

合成工作区只创建input.json和guard.txt。独立检查确认input/guard哈希未变、result.json不存在，所以读取/写入/编辑/读回本轮均未验收。原生模型保存是新结果，不能升级为完整Agent可用或一键配置完成；仍需选择这个自定义模型后发送合成任务，并核对真实工具和文件结果。

短时转发已结束，listenerClosed/tunnelClosed均为true，实际付费请求仅1条。TRAE保留的配置只含guest loopback地址与占位Key，转发停止后不可用；后续由助手在准备好界面后限时重启，用户不要把它当常驻生产配置。原始提示词、输出、真实Key和账号资料不写入报告。

## Astra 原生文件任务通过（2026-10-26 23:12—23:24，北京时间）

用户完成模型选择后，截图确认Agent输入框使用`yuanheng qa astra`，模式为Local/Manual Approval。通过原生文件对话框选定合成工作区`/Users/yhqa/trae-yuanheng-qa`；输入只包含随机marker及数值17、23、33，guard另存哈希。任务要求仅使用内置文件工具完成读取、求和、写入、读回、增加verified字段并再次读回，不运行shell或安装软件。提交前独立检查result不存在、input与guard哈希均匹配。

23:12首条原生任务响应HTTP200、finish_reason=tool_calls、工具Read、完整[DONE]。TRAE执行Read 1 file后，下一步收到QA转发器503；报告`live-2026-10-26T15-11-25-893Z.json`保留原失败。转发器收到结束事件仍等待HTTP EOF，并在客户端关闭时标记cancelled_or_timeout，造成后续请求被误锁定。这是QA夹具缺陷，不能据此判断渠道不稳定。原生UI仍保留该错误历史，不删除或把它计成完整任务通过。

先停止临时服务，用合成上游复现两个失败：完整结束事件后HTTP保持打开导致超时、缺少空行的结束事件被误计成功。修复以完整SSE事件作为结束边界，结束下游响应并释放上游读流；分段CRLF、显式error后[DONE]、未完成流、取消、并发、请求预算和敏感输出边界共8项测试通过。没有关闭失败保护、自动重放或扩大请求预算；修改只在本机QA脚本，不是产品Core改动。

23:22由原生输入框继续同一任务，固定Astra/鹈鹕王、占位鉴权、Chat Completions，未换模型或分组。五条模型请求依次产生Write、Read、SearchReplace、Read及最终stop；均HTTP200、完整[DONE]、无failure。原生界面显示Worked for 50s、1 file changed和最终总和73。只读guest验证独立于模型自述，结果如下：

| 独立检查项 | 结果 |
| --- | --- |
| input.json哈希未变 | true |
| guard.txt哈希未变 | true |
| result.json确实存在 | true |
| result.marker与输入随机marker完全一致 | true |
| total为数字73 | 通过 |
| verified为布尔true | 通过 |

成功继续报告为`live-2026-10-26T15-17-42-176Z.json`，累计prompt_tokens113516、completion_tokens217；此前被QA夹具误停的读取另计22043/60，本轮合计6条实际请求（135559输入/277输出tokens）。连同21:35模型保存检测，累计7条实际请求；没有后台重复试费或未记录的自动重试。

此次证明固定Mac国际版、固定模型/分组和受限QA转发下的原生文件工具、流式多步调用、同会话继续可用；不能推广为所有模型、协议、系统、官方云功能或产品Core自动配置已通过。QA转发额外限制输出tokens并设置store=false，产品接入须验证自己的真实请求路径。原生取消与跨模型切换未验收；安全自动导入契约仍未确认，暂不写官方加密数据库或调用猜测的私有模型管理接口。

23:25主动停止短时转发，listenerClosed/tunnelClosed均true；Tart保存snapshot后运行会话退出0。23:27独立检查TRAE VM和Accio VM为suspended、基线stopped、QA相关进程数0、研究DMG未挂载。保留登录、任务、合成文件和旧失败报告供复核，不影响其他项目既有开发服务。没有推送、合并或发布。
