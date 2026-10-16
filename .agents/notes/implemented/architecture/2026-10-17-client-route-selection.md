# Agent Note: 元衡桌面端按用户网络选择官方 API 线路

Status: implemented

## Problem

跳板与 Cloudflare 橙云访问同一 API，用户的运营商、代理和时段不同，固定一个入口无法代表每台电脑的较佳路径。现有端点表单只按一次响应时间排序，不能证明响应正确，也没有持续调度和稳定切换机制。

## Decision

由独立 Core 持有选路器、偏好和探测任务。设置 → 路由新增连接线路卡片，提供自动推荐、固定跳板、固定 CF；工作台只在已确认的线路异常时显示设置入口。用户确认的两条 origin 是 `https://meta-api.vip`（跳板）与 `https://nan.meta-api.vip`（CF）；cn 为重复旧入口，不参与候选。

### 能力复用与影响范围

- 复用现有 SettingsPage/ProxyTabContent、工作台和 React Query，不增加导航标签；旧 EndpointSpeedTest 的一次最低延迟规则不用于自动选择。
- 复用 SQLite settings、CoreSupervisor 和已鉴权本地 Core 管理路由。GUI 停止显示后 Core 继续工作，不会因为打开设置而启动本地路由。
- 复用 RequestForwarder 的原有协议、provider 和凭据解析；每个请求捕获不可变线路快照。只接受精确托管 provider ID/category 和规范 meta HTTPS 模型路径，拒绝用户信息、非443端口、片段、相似域名及控制面路径。
- 被覆盖的是 Core 中经过 RequestForwarder 的托管文本模型 HTTP/SSE 请求，包括既有 reqwest 和原始头 Hyper 路径。图片独立 transport、WebSocket、官方账号、自定义供应商及绕过 Core 的工具不参与；卡片详情明确说明范围。
- 仅替换已构建模型 URL 的 host，模型/分组/provider/认证上下文保持不变。转发前移除 Cookie 和旧 Host，reqwest 使用禁止重定向和隐式重试的连接池；本功能不新增业务请求重试、竞速或跨线重放。进行中的请求及现有 provider 重试继续使用原线路快照。
- 登录、OAuth、充值、控制台和更新下载保持既有地址；不全局放宽 yuanheng_endpoints 的身份判断。
- 活跃笔记检索后，[连接池与安全诊断](../../implemented/bug-fix/2026-10-12-outbound-connection-stability.md)部分相关，继续持有代理快照/连接池/脱敏契约；[更新下载择源](../../implemented/bug-fix/2026-10-12-update-download-failover.md)部分相关，下载可换源规则不能移植到计费生成。其他安装/R2笔记不持有本决定，没有需要归档的同题笔记。

### 不计费探测

newapi 配套端点为 `/api/route-probe` 与 `/api/route-probe/stream`。随机32位十六进制 nonce、service=yuanheng-api、version=1、成功状态、内容类型、no-store 和有界完整正文共同校验；拒绝缓存命中、重定向、挑战页和快速错误。端点不调用模型、不访问账号或消费记录。

每轮独立创建遵循同一出站代理配置的严格 HTTP 客户端，两条线路并发，每条先一次建连请求，再三次计时请求。首请求失败保留，不能被后续热连接速度掩盖。单请求3秒、正文2048字节；记录三次成功数、响应中位数和极差。整轮最多20秒，包含可选短流的预算；不会以三次样本声称长期可用率或模型首字速度。

手动短流检查验证三个 sequence=0..2 事件、身份、nonce、完整结束及至少150ms抵达间隔（服务端间隔350ms）；最长4秒、正文4096字节。已确认的缓冲/中断不会被普通HTTP成功覆盖，需短流复测成功或网络换代后清除。

### 调度与切换

Core 启动默认沿用上次选中入口；无记录使用跳板，标记待检测。Core 每5秒检查出站客户端代次及默认本地 IPv4/IPv6 源地址；不保存 SSID、IP 或运营商画像。代理/源地址变化或调度超过30秒间隔时取消旧探测并增加网络代次。不能检测所有VPN内部变化；定时、手动和实际连接错误补足这一边界。

最近15分钟有托管请求、启动或手动操作视为活跃，周期为480–720秒。空闲暂停，恢复请求后重新触发到期检查；状态超过15分钟显示过期。失败轮退避60、120、240、480秒（上限600）；重复检测合并，启动间隔至少5秒。连续两次真实请求连接/超时错误触发不早于前轮30秒后的复测，应用权限/限额/HTTP错误不会直接判成网络故障。本版尚未采集业务流内部的首字和中断信号。

只有首请求与三次计时请求完整成功的候选才能参与，已知短流异常排除。先按100ms极差桶比较稳定性，再比响应中位数；健康线路间须同时改善25%和100ms、至少两轮相隔30秒且距上次切换5分钟。首次启动没有上次切换计时，允许两个独立成功轮后优化。当前线路不可用且另一条探测成功时，自动模式可直接切换后续请求；两条都失败保留选择并退避。固定模式始终尊重偏好。

### 状态与并发契约

SQLite `yuanheng_route_policy_v1` 仅保存 policy(mode/fixedRouteId) 和 selected。不保存探测评分、凭据和网络画像。写盘成功后才改变运行时策略/线路，失败保留旧选择。Core重启后评分未知，冷却计时重新建立。

IPC为 get_yuanheng_route_status、set_yuanheng_route_policy、probe_yuanheng_routes、cancel_yuanheng_route_probe。每个状态带revision、networkGeneration、operationId；策略更新比较revision，取消比较operationId，完成结果比较任务和网络代次。策略变化取消旧任务。GUI通过已有本地HTTP桥接每15秒读状态，检测中1秒；不新增跨进程事件通道。切换前取消在途GUI查询，成功/失败后均重新读Core，防止旧窗口覆盖新策略。

Core停止或旧版不支持时显示明确状态且禁用模式编辑；保存失败保留旧单选；重测/取消/过期保留历史数值并标注。检测只发往两个内置origin，无凭据、无遥测上传。

## Alternatives considered

- **只用 Cloudflare 橙云负载均衡**：统一入口、无需升级客户端，但所有请求先进入 CF；不能绕过用户到 CF 的坏路径。Dynamic Steering 使用监控节点的 RTT，不是逐用户实测。[代理模式](https://developers.cloudflare.com/load-balancing/understand-basics/proxy-modes/)与[动态调度](https://developers.cloudflare.com/load-balancing/understand-basics/traffic-steering/steering-policies/dynamic-steering/)已在方案调研中核对。
- **DNS-only 统一域名分流**：可覆盖未安装桌面端的客户，是保留的服务端补充；受缓存、解析器与入口证书/Host 配置约束，无法替代当前电脑的实时路径比较。
- **复用旧弹窗的一次最低延迟选择**：改动少，但缺少成功响应验证、稳定窗口、持续观测与工具生效范围，容易选中快速错误页。
- **自动改写每个外部工具的 URL**：能覆盖不经 Core 的工具，但增加配置覆盖、重启与回滚风险；首版限定本地托管链路，外部直连工具明确显示不适用。
- **每个生成请求并行竞速**：可能降低尾延迟，但会造成重复推理/计费和流式状态冲突，拒绝采用；只对不计费探测并发。
- **第一版直接上线远程动态清单**：运维更新快，但增加签名、回滚和启动依赖；先使用两条明确授权的内置入口，再独立设计清单更新。

## Testing

- Rust 全库2396项通过、3项既有忽略；本模块11项覆盖白名单/请求快照、固定模式/重启、revision冲突、两轮门槛/冷却、快速错误、全失败退避、取消/旧网络、实际HTTP缓存/nonce/重定向/正文上限，以及实际短流缓冲/中断。
- 前端146文件931项通过；本地 Node25 需 `NODE_OPTIONS=--no-experimental-webstorage` 避免原生localStorage影响既有测试替身。新增卡片测试覆盖保存失败保留偏好、固定模式重新检测、取消操作ID和Core停止/恢复。
- 类型检查、Rust格式/Clippy、renderer与Core构建以及笔记检查作为本轮发布门禁。
- 真实App壳在本地隔离IPC模拟数据下验收正常/固定/检测/取消/保存失败、首次未测/过期/全失败/Core停止、工作台异常跳转和键盘单选；浅色/暗色、900px/1440px及五语言无卡片溢出，刷新可恢复。模拟数据不代表线上网络测量。
- 使用临时配置目录运行本轮已构建的 Core，通过本机系统代理访问线上两入口：启动自动检测正常、手动短流两路均成功、固定 CF 偏好在进程重启后保留。一轮曾出现 CF 冷连接超时，Core 保留正常跳板；后续一轮两路均为3/3成功且短流正常。测试未改动用户配置、未调用模型；结果只代表当时网络。
- [v0.1.92](https://github.com/nanashiwang/yuanheng-switch/releases/tag/v0.1.92) 对应 `694680e5`；同提交的 [CI](https://github.com/nanashiwang/yuanheng-switch/actions/runs/38974360477) 与 [发布工作流](https://github.com/nanashiwang/yuanheng-switch/actions/runs/38974418694) 全部成功。macOS 双架构签名/公证和 Windows 构建完成；GitHub 9个附件、源站8个版本附件、R2的5个二进制分段下载与文件大小均核验，自动更新清单6个平台别名/签名/中文说明一致。2026-10-17 07:10（UTC+8）线上更新版本确认为0.1.92。

## Consequences

自动选择追求可用与稳定，不承诺每时每刻最快。轻量探测无法证明模型/分组权限、模型首字速度及整体上游健康；同一上游故障不能通过换线修复。公共IP共享限流可能造成暂时不可确认，客户端退避且不给失败候选虚假评分。

服务端代码和客户端发布分开验收。用户另行授权后，newapi生产已部署 `main-135966d`，保留compat.42回退与完整MySQL备份。两入口公开探测均200、nonce/服务身份匹配、no-store；CF为DYNAMIC。短流0/1/2完整且相邻抵达347–351ms，未见整批缓冲。该验收只覆盖开发机当时网络，真实账号模型请求和三网晚高峰效果仍须独立评估；其他未部署环境显示端点未提供并保留原线路。回滚可固定跳板，恢复既有新请求路径；已开始请求不迁移。
