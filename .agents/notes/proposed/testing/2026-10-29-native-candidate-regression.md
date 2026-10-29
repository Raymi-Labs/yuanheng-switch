# Agent Note: 默认 Accio 与 TRAE 同级入口的原生候选回归

Status: proposed

## Problem

前端已验证TRAE同级辅助卡片及Accio默认可见，但缺少当前未提交源码的GUI/Core原生编译与候选升级验证。用户要求先完成当前Apple Silicon Mac能完成的测试，同时控制磁盘和后台进程占用。

## Proposal

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

2026-10-29后续网络复查：系统代理端口已变化，旧代理端口连接失败不作为当前链路失败证据。宿主使用当前系统代理GET /v1/models返回401、TLS verify=0；专用VM同一路径无鉴权GET亦401、TLS verify=0，首页HEAD 200，先前TLS错误未再复现。HEAD /v1/models返回404不表示GET API不可用。候选Core hash正确、health200、active_connections=0；Accio未运行，候选GUI重开仍停在登录恢复页，旧连接缓存不证明实时认证成功。未重复发送付费模型请求，真实推理/原生取消仍待登录恢复。复查后专用VM正常关机、监督器exitCode0，未留下测试进程。

用户恢复登录并手动启动Accio后提交一次hi，截图显示诊断`7d2a3868eb87`。只读核对：候选Core hash正确、routeActive=true、Astra/鹈鹕王配置正确，日志为core_error/local_transport_error/502/network=unknown。未重放模型请求。测试机对当前来源meta-api.vip的HEAD先一次200，随后根路径和/v1/models分别复现TLS SSL_ERROR_SYSCALL及握手超时；HTTP/1.1和HTTP/2均失败。宿主同域名的直连及显式现有代理HEAD也复现SSL_ERROR_SYSCALL，未携带鉴权。DNS为代理Fake-IP范围198.18地址；这证明独立于Accio请求格式的HTTPS链路故障，不单独证明是代理节点或目标站点原因，也不能断言Core本地网络权限被拒绝。活跃请求0，用户手动操作中的测试机保留运行；未改系统代理、DNS、证书或钥匙串权限。真实成功响应和原生取消仍待网络恢复后的单次验证。

2026-10-29当前源码的`cargo check --locked --lib --bins`及`cargo build --locked --bins`通过；默认feature下Accio 57项和TRAE 8项Rust回归通过。采用同一工具链、同一target，未更新Cargo.lock。Tauri debug app打包成功，版本0.1.115、Bundle ID保持原值、架构arm64，包含本轮前端和Core。本机无有效Developer ID签名身份，候选是本地功能包，不是已公证正式安装包，也未生成发布更新清单。

候选App内GUI SHA256 `98e437e1a0224be42a6258356db9bd7dcd5c10af5851b0aca83a891661227042`，Core SHA256 `e3a22fd78b88e0ef0e2100f7249109c839be2b4791eff55787d1f73e93ae1925`，归档SHA256 `a1b8f376805d2f80bb9a0be9c343ac918e6ebd4253a28c69608aacc09a36fca3`。打包前Core及最终App内Core分别执行隔离生命周期脚本，孤立active拒绝、重复实例不改配置、外部Origin拒绝、崩溃重启不复活旧授权、撤销节流全部通过；模型转发0、Core退出true。

已有专用测试VM从GUI 0.1.97升级至候选0.1.115，只备份旧App及SQLite，不克隆整盘。候选GUI正常显示版本，但因本地签名与原登录访问条件不一致，显示“本机登录信息需要恢复访问”；未批准系统权限、未读取钥匙串秘密或重建登录。App替换及初次启动后Accio profile摘要完全不变。通过产品Core start安装候选Core，健康检查及运行文件hash确认一致；首次管理启动使用Core启动前revision而返回409，调查确认仅运行capability被更新。重新读取当前profile后，管理启动返回200，原生Accio 0.35.3窗口出现。该路径验证后端受控启动，不冒充GUI“配置/启动”按钮验收。

macOS随后显示候选Core本地网络权限弹窗，未在未确认情况下点击。未提交真实模型提示，因此本轮真实请求、原生停止和完整GUI/TRAE向导仍未通过；此前离线协议取消测试不能替代。仍需正式签名包或用户手动恢复登录及授权后继续。

收尾终止准确匹配的测试App进程；原Core第一次恢复启动未成功，延迟后重新start成功，核对健康与原文件hash，随后stop。恢复旧App，模型/分组/provider等业务配置与升级前完全相同，仅运行capability按生命周期更新且active=false。候选App和小范围备份保留在专用测试机目录，原始记录只保存在本地。guest正常shutdown，Tart返回`guest has stopped the virtual machine`且监督器exitCode=0。用户日常VM未启动。本提案因权限及原生请求缺口保持proposed。
