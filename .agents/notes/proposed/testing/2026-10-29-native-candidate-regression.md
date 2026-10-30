# Agent Note: 默认 Accio 与 TRAE 同级入口的原生候选回归

Status: proposed

## Problem

前端已验证TRAE同级辅助卡片及Accio默认可见，但缺少当前未提交源码的GUI/Core原生编译与候选升级验证。用户要求先完成当前Apple Silicon Mac能完成的测试，同时控制磁盘和后台进程占用。

## Proposal

当前验收边界（2026-10-30）：签名候选的原生Core空闲升级已通过。TRAE向导以真实组件DOM及生产CSS做900×600小窗口检查，滚动区clientHeight=372、scrollHeight=1086，滚轮可从0移至714.5并返回0，末尾步骤和固定关闭按钮可见；安装动作在夹具中省略，不能替代WKWebView/虚拟机输入验收。临时导出代码已移除，预览服务已停止。原生取消、钥匙串跨重启恢复、Intel真机与Windows Accio仍不宣称通过；本笔记保持proposed追踪这些缺口。v0.1.117公告明确TRAE辅助配置及Accio平台/云端工具限制。

v0.1.117发布准备：155项关联前端回归、typecheck、format:check、renderer构建及版本公告一致性检查通过。Bun不可用，笔记三个校验器改由本机Node运行并通过；CI继续使用规定的Bun。最小Rust工具链未安装Clippy，未将本地Clippy记为通过，交由合并前CI执行。当前两台VM均stopped，预览服务退出，无本轮遗留测试进程。

恢复仓库指定Rust 1.95最小工具链，官方HTTPS下载并核对安装器摘要，不改shell配置；复用现有target缓存、限制编译并发。先执行locked GUI/Core check及相关Rust测试，再构建本地候选。候选须有当前源码产物哈希，旧二进制不能替代。

只有候选构建成功才启动已有Accio专用测试VM；用户日常VM不参与。升级前记录脱敏配置摘要与当前包身份，检查无活跃请求，保留小范围应用/配置恢复材料，不克隆整盘。检查原配置保留、TRAE辅助卡片、Accio配置与受控启动、原生请求与取消。真实模型限定用户此前指定Astra、独享或鹈鹕王分组，不自动付费重试；权限或登录需要人工完成时明确交接。收尾正常停止测试VM并确认临时进程0。

## Existing note review

- [默认启用](../../implemented/feature/2026-10-29-accio-default-availability.md)部分重叠，更新其原生验证结果；Windows实现缺口不因编译通过消失。
- [干净Mac测试](2026-10-19-accio-clean-macos-vm.md)保留已有原生证据，本轮复用已登录测试机，不冒充新设备登录验收。
- [TRAE辅助配置](../../implemented/feature/2026-10-26-trae-official-custom-models.md)保持辅助模式，本轮不重试失败的私有保存服务。

## Alternatives considered

- 直接用旧GUI/Core验证：省构建时间，但不能代表本轮源码，拒绝作为候选验收。
- 再建干净VM：隔离好，但新增数十GB且重复已有初装测试；复用已授权专用测试机。
- 只跑前端测试：成本低，但不覆盖默认Rust feature及升级/Core生命周期，不足以完成本轮目标。

## Acceptance criteria

GUI/Core编译、相关原生测试有当前源码证据；候选包与应用身份、升级前后配置一致性分别验证。未完成的签名/发布/真机/付费请求明确区分。测试结束所有本轮临时进程、服务、测试VM停止；不发布安装包、不改生产服务器。

## Risks

工具链和依赖需网络下载，可能受速度或缓存丢失影响。安装和编译占用磁盘，禁止重复建立target。官方应用可能自动联网处理VM设备信息，延续已告知范围，不复制宿主个人账号材料；原始配置、日志和凭据不提交仓库。

## Investigation

从target依赖记录找到先前临时工具链，Rust 1.95.0及标准库仍可用，缺失的是PATH注册、部分工具及registry源码缓存。用本地无网络小程序完成编译/运行校验，rustfmt检查GUI/Core入口通过。停止重复rustup下载，未修改shell启动配置。locked cargo check首次因官方registry HTTP/2连接错误退出；关闭Cargo HTTP多路复用后恢复索引及依赖下载，不替换源或锁文件。

离线检查已通过：Accio 0.35.3已核验官方worker的15项协议回归（2个合成请求、外部请求0、计时器残留0）；Apple发布工具及签名验证脚本22项；GUI/Core feature契约3项；发布管线、Accio开关和连接提示31项；版本一致性检查通过。这些不等于当前候选原生编译、签名公证或安装升级验收。

## Native results and remaining gates

2026-10-30用户完成本轮登录恢复后的27400dc3签名候选升级验收：点击前核对GUI哈希6a8a9a…，运行Core仍为旧6d61dc…，原业务配置一致、routeActive=false、active0。CUA在原生工作台点击Accio启动一次，随后只读核对current切为新签名Core e23f97…、routeActive=true，Accio进程1，原生客户端显示“Accio已由元衡启动”。没有手动运行Core start/升级或调用管理launch接口。这证明本次原生客户端启动路径完成了旧Core→新Core→Accio启动；不将其推广为并发忙碌或其他平台真机验收。检查中一次active=1，随后0；最近模型请求记录未新增，因此本轮无模型生成费用。结束确认active0，准确结束Accio/GUI、通过新Core stop并等待退出；最终三进程0、routeInactive=true、与安装前模型/分组/provider等业务配置一致，签名候选及登录材料保留。guest正常shutdown、run-manual exitCode0。Core自动升级缺口原生验收通过，钥匙串跨重启继承、取消及向导滚动仍不据此判通过。

2026-10-30用户确认运行修复候选后重新启动专用VM。只读核验GUI进程来自Applications，文件SHA256为6a8a9a…（27400dc3候选）；运行Core仍为6d61dc…旧候选，业务配置与升级前备份相同、routeActive=false、activeRequests=0。截图确认GUI再次停在“恢复本机登录”页；CUA切换显示器后可见页面，但坐标动作仍报noWindowsAvailable，未点击启动或手动升级Core。保留run-manual（60分钟监督上限）及共享剪贴板交接用户完成登录；无推理或临时探针进程，不将尚未登录的状态记作自动升级失败/通过。

2026-10-30修复候选run40987603919/27400dc34d44f34657d7a80f50478f6094be512a下载后，receipt提交/run/目标及三个附件摘要通过。更新归档SHA256645bb7fdeb65ac45192d819be539796f85f401d49b2d527aba65c702f0dd87f7；GUI为6a8a9a7de61926374847e8817835e068b2c9fd9e6336e1df9a79bff316639309，Core为e23f97ac3069e755b553946646b271dedbc2ef540e96a5b00a6779681e662640。宿主及guest精确Bundle ID/Team ID的codesign、Gatekeeper通过，宿主stapler通过。新签名Core隔离生命周期回归通过，模型转发0、Core退出true。专用VM安装时保留旧Core6d61dc…运行及health200，仅关闭旧GUI，备份App/SQLite后换新App，Accio profile逐字一致。新GUI尚未启动；需要电脑操作工具对首次运行本次新下载软件的即时确认。等待前guest正常shutdown、run-manual exitCode0，保留原current及登录资料。尚未证明修复候选的原生自动升级成功。

Accio绕过随包Core升级的缺口已按[启动前版本检查](../../implemented/bug-fix/2026-10-30-accio-core-upgrade-before-launch.md)本地修复，59项Accio及51项Core相关测试、GUI/Core检查通过。此变更尚未进入已下载的496f7f44签名候选，原生升级回归必须使用后续新候选，不能沿用旧包结果。

2026-10-30用户要求再测：同一签名候选重开后仍出现钥匙串恢复页，不能认定单次授权已持久保留，也不能仅凭页面断定账号过期；未再读取或导出钥匙串。签名Core hash6d61dc…保持正确、health200、API无鉴权GET401且证书校验通过。为独立测取消，通过现有认证管理接口以保存的Astra/鹈鹕王profile启动Accio返回200（明确不算GUI登录通过）。已有测试会话打开，CUA输入发生顺序错位，随后窗口操作报noWindowsAvailable、screen capture failed及timeoutReached，未发送该草稿；前后请求记录相同、active0，本轮没有新增模型费用。取消和向导滚动保持未验收。

代码复核发现Accio GUI入口`accio_work::launch`仅在proxy未运行时调用start，已运行时直接进入CoreSupervisor::launch_accio，而后者调用status并不执行ensure_running，因此无法在此路径保证检查随包Core更新；与上一轮旧测试Core被继续使用的现象一致。此为待修实现缺口，不等同所有启动路径都不更新Core。收尾脚本增加Core stop后最多10秒等待退出；实际Accio/GUI/Core均停止、route inactive、业务配置与签名安装前一致，签名候选保留。guest正常shutdown，run-manual exitCode0。

2026-10-30签名候选实际推理续验：用户完成钥匙串、本地网络授权后，原生工作台显示已登录、原模型/分组正确；不是无交互登录继承。将Tart从副显示器移至内建显示器恢复坐标操作。原生菜单显示TRAE正确SVG、同级卡片及辅助弹窗；滚轮两次未观察到位移，滚动仍待验证。通过GUI预检/启动确认打开Accio，核对运行Core为签名产物6d61dc…、health200，原生模型菜单选中gpt-6-astra并显示分组其他模型。输入固定无工具/无文件提示，只提交一次，原生回复`yh-signed-astra-ok`；Core记录标题和正文两条HTTP200（507/14与34426/10输入/输出token）。第二次提交有界200行无工具生成用于取消，观察active=1后点击按钮时已完整输出200行；最终HTTP200、34475/1416 token、active=0，因此取消测试未成立，不能写作停止通过，未再收费重试。总计三条新模型请求均为Astra，包含后台标题请求。

收尾在active=0后结束精确匹配的Accio/GUI并执行签名Core stop。立即进程检查仍见退出中的Core，后续复查Accio/GUI/Core均0、routeInactive；业务配置与先前备份只有capability不同。保留签名候选与正常授权，不覆盖用户刚恢复的钥匙串。guest正常shutdown，监督器run-manual exitCode0；本轮无新增VM、无宿主常驻测试进程。真实短回复通过；签名身份重开登录继承、原生取消、Core自动升级旧测试实例以及向导滚动仍为未完成项。

2026-10-30用户完成钥匙串恢复后，签名v0.1.116 GUI进入工作台，原Astra/鹈鹕王配置可见；原生工具菜单包含TRAE同级项、正确SVG及辅助向导。虚拟机在副显示器的变形缩略画面使CUA坐标不可用，移到内建显示器后恢复可操作。向导打开通过，滚动调用未观察到位移，仍保留滚动验收缺口。第一次GUI启动Accio实际复用了旧测试Core（e3a22…），未算作签名Core验收；确认零活跃请求后结束未发消息的Accio，使用签名Core产品start更新，运行hash变为6d61dc…、版本0.1.116、health200。再次通过GUI启动Accio成功，但新Core弹出本地网络权限，尚未代为批准，也没有发送模型提示。当前停止于用户系统授权，真实请求/取消仍未完成；旧Core自动升级为何未发生需独立追查，不能隐去手动更新步骤。

签名候选run 40875452709（提交496f7f4454ebfc9f8801de799fe4985f62a7a80d）三个平台成功，发布和分发任务跳过。下载Apple Silicon附件并按receipt核对版本0.1.116、run、提交及全部3个文件大小/SHA256。更新归档SHA256 `eedd0302145fabda29bf7e2ca5be04b323519b4f72398f11dd70bdbb6e0e2abe`；候选GUI SHA256 `b1b932e6c73eb90c45d39f7fe7177db3e5d335d9e18e0650341abff4354e7910`，Core SHA256 `6d61dc8a47e9cac7d9ebaf20b249281c53992415e0e2f094ddbcd4a46dc185ed`。宿主codesign deep/strict、arm64、runtime、签名时间戳、公证stapler和Gatekeeper均通过，Team ID GY42242ZWS。测试机内再次验证精确Bundle ID/Team ID与Gatekeeper后替换App，保留previous.app、旧Core路径及SQLite备份，Accio profile在替换前后完全一致。签名候选尚未启动，不能称为登录继承成功；电脑操作工具要求新下载软件首次GUI运行即时确认，停在该步骤。专用VM已正常shutdown，监督器exitCode0；日常VM未启动，无模型请求。原始本地安装脚本及下载材料未纳入仓库。

2026-10-29后续网络复查：系统代理端口已变化，旧代理端口连接失败不作为当前链路失败证据。宿主使用当前系统代理GET /v1/models返回401、TLS verify=0；专用VM同一路径无鉴权GET亦401、TLS verify=0，首页HEAD 200，先前TLS错误未再复现。HEAD /v1/models返回404不表示GET API不可用。候选Core hash正确、health200、active_connections=0；Accio未运行，候选GUI重开仍停在登录恢复页，旧连接缓存不证明实时认证成功。未重复发送付费模型请求，真实推理/原生取消仍待登录恢复。复查后专用VM正常关机、监督器exitCode0，未留下测试进程。

用户恢复登录并手动启动Accio后提交一次hi，截图显示诊断`7d2a3868eb87`。只读核对：候选Core hash正确、routeActive=true、Astra/鹈鹕王配置正确，日志为core_error/local_transport_error/502/network=unknown。未重放模型请求。测试机对当前来源meta-api.vip的HEAD先一次200，随后根路径和/v1/models分别复现TLS SSL_ERROR_SYSCALL及握手超时；HTTP/1.1和HTTP/2均失败。宿主同域名的直连及显式现有代理HEAD也复现SSL_ERROR_SYSCALL，未携带鉴权。DNS为代理Fake-IP范围198.18地址；这证明独立于Accio请求格式的HTTPS链路故障，不单独证明是代理节点或目标站点原因，也不能断言Core本地网络权限被拒绝。活跃请求0，用户手动操作中的测试机保留运行；未改系统代理、DNS、证书或钥匙串权限。真实成功响应和原生取消仍待网络恢复后的单次验证。

2026-10-29当前源码的`cargo check --locked --lib --bins`及`cargo build --locked --bins`通过；默认feature下Accio 57项和TRAE 8项Rust回归通过。采用同一工具链、同一target，未更新Cargo.lock。Tauri debug app打包成功，版本0.1.115、Bundle ID保持原值、架构arm64，包含本轮前端和Core。本机无有效Developer ID签名身份，候选是本地功能包，不是已公证正式安装包，也未生成发布更新清单。

候选App内GUI SHA256 `98e437e1a0224be42a6258356db9bd7dcd5c10af5851b0aca83a891661227042`，Core SHA256 `e3a22fd78b88e0ef0e2100f7249109c839be2b4791eff55787d1f73e93ae1925`，归档SHA256 `a1b8f376805d2f80bb9a0be9c343ac918e6ebd4253a28c69608aacc09a36fca3`。打包前Core及最终App内Core分别执行隔离生命周期脚本，孤立active拒绝、重复实例不改配置、外部Origin拒绝、崩溃重启不复活旧授权、撤销节流全部通过；模型转发0、Core退出true。

已有专用测试VM从GUI 0.1.97升级至候选0.1.115，只备份旧App及SQLite，不克隆整盘。候选GUI正常显示版本，但因本地签名与原登录访问条件不一致，显示“本机登录信息需要恢复访问”；未批准系统权限、未读取钥匙串秘密或重建登录。App替换及初次启动后Accio profile摘要完全不变。通过产品Core start安装候选Core，健康检查及运行文件hash确认一致；首次管理启动使用Core启动前revision而返回409，调查确认仅运行capability被更新。重新读取当前profile后，管理启动返回200，原生Accio 0.35.3窗口出现。该路径验证后端受控启动，不冒充GUI“配置/启动”按钮验收。

macOS随后显示候选Core本地网络权限弹窗，未在未确认情况下点击。未提交真实模型提示，因此本轮真实请求、原生停止和完整GUI/TRAE向导仍未通过；此前离线协议取消测试不能替代。仍需正式签名包或用户手动恢复登录及授权后继续。

收尾终止准确匹配的测试App进程；原Core第一次恢复启动未成功，延迟后重新start成功，核对健康与原文件hash，随后stop。恢复旧App，模型/分组/provider等业务配置与升级前完全相同，仅运行capability按生命周期更新且active=false。候选App和小范围备份保留在专用测试机目录，原始记录只保存在本地。guest正常shutdown，Tart返回`guest has stopped the virtual machine`且监督器exitCode=0。用户日常VM未启动。本提案因权限及原生请求缺口保持proposed。
