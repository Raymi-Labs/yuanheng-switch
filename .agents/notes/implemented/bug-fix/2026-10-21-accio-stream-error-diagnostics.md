# Agent Note: Accio 工具任务的流内错误诊断

Status: implemented

## Problem

0.35.3通过产品Core的真实文件读取成功，但两个包含write的任务返回YUANHENG_STREAM_INCOMPLETE且无输出文件。桥接分别收到Responses失败事件及SSE error事件，但原始错误全部缩成同一固定文案，用量只记录外层200/零tokens，无法区分工具参数、上游服务、权限或本地转换问题。聊天成功不能代替Agent基础任务验收。

## Decision

复用既有Accio边缘流转换，在[accio_diagnostics.rs](../../../../src-tauri/src/proxy/accio_diagnostics.rs)只生成固定类别、固定白名单错误code/type、有限词表与本地随机诊断编号；原始消息/工具参数/文件内容/路径/账号/header/capability不记录或回显，未知字段默认丢弃。SSE error、Responses失败和结构化UpstreamError在丢弃内容前有界分类，每次失败最多一条诊断，没有自动重试或上游回退。HTTP错误体解析上限64KiB；消息分类最多4096字符，参数仅保留固定根字段。

服务器过载且code=server_error时显示“上游模型服务过载”，HTTP状态与流错误来源分别保留，避免把503缩成通用模型失败误导用户去修改文件权限。只更新VM诊断Core、不替换宿主服务或GUI登录；旧Core保留供恢复。云端查询由[独立只读提案](../../proposed/feature/2026-10-21-accio-readonly-cloud-queries.md)负责，不以放宽代理解决基础工具错误。

2026-10-23定位到旧Astra任务的502来自Core上游连接失败，而非已收到的上游502响应。Accio调用共享Responses转发链时保留本地ProxyError类型（既有用量错误仍只记录一次），避免先包装成Codex JSON再当成上游HTTP错误。Accio边界按固定类别显示连接、超时、路由、认证或转换失败；网络分类只提取既有transport_error固定标记，不回显错误原文。Codex等其他入口维持原错误响应。此项延续本篇安全分类决定，不修改网络配置或自动重发任务。

## Existing decisions

- [本地产品入口](../feature/2026-10-21-accio-verified-desktop-entry.md)部分重叠：继续使用精确官方版本、受控启动和当前运行scope，错误诊断由本篇接管。
- [干净Mac验收](../../proposed/testing/2026-10-19-accio-clean-macos-vm.md)保留两次失败与读取成功，不把后续成功回写成此前通过。

## Alternatives considered

- 直接开启debug或打印上游错误原文：最快看清报错，但可包含令牌、账号、路径及模型引用正文，不采用。
- 看到失败就切模型/重试：可能暂时成功，却无法解释问题且增加费用，不自动执行。
- 有界白名单分类：可能不足以定位所有未知错误，但可审计隐私边界；先采用，依据实际结果决定是否需要额外取证。

## Verification

Accio相关46项Rust回归通过，其中新用例覆盖SSE/Responses错误、嵌套失败对象、缺字段、超长/恶意消息、敏感字符串、非JSON错误体、过载分类及错误终态仍恰好一个DONE/释放槽位。正常文本/工具终态、取消及三协议往返回归保持通过；不改变其他Agent的错误处理。

VM实际协议对照限定同一write定义与合成短句，不执行工具：luna返回上游HTTP503、code=server_error及服务器过载信息，外层Accio错误仍以SSE200封装；sol返回一次完整合法write调用，file_path/content均符合预期，输入/输出508/48。这只是模型/协议对照，不是原生写文件成功；也不能证明前两次流内失败均为过载。此次两条收费模型请求没有自动重试、没有跨组或换密钥。

诊断Core触发系统局域网权限提示，未代点/绕过。恢复旧Core准备原生对照时，官方0.35.3在启动阶段出现SIGSEGV，报告栈顶为objc_retainAutoreleaseReturnValue及UTMac日志装配函数；没有新文件任务发出。只确定崩溃位置，未确定触发根因，不归责于网关或官方组件质量。原生write及完整电商工作流仍未通过。

收尾恢复原VM Core哈希，活跃0、Accio/helper0、合成input/guard未改，result/minimal输出均不存在；随后正常关机，宿主原服务保留。日志原文、用户凭据和云端账号内容未提交仓库。脱敏证据见干净Mac报告。

2026-10-23新增Core本地错误分类、敏感字符串/未知网络标签拒绝和共享转发链的错误类型保持回归，Accio共55项及Codex相关9项通过；最终Core构建通过。Core返回502与上游真实502在固定字段和文案中区分，不将上游伪造的proxy_error原文当作本地来源。原产品Core的Astra原生读/写/修改/读回两轮任务及独立磁盘校验通过，不能据此宣称新诊断Core已完成原生验收。新Core在VM安装启动后遇宿主锁屏，保留候选版本与恢复路径，确认活跃0后挂起VM，等待用户解锁，不更改系统网络权限。

## Consequences

用户可区分HTTP过载与流内错误并提供无敏感内容的诊断编号，代价是固定词表不能解释所有未知错误；关键词只是证据不是根因证明，上游错误也可能由本地请求格式引起。现有用量中的HTTP200与流终态差异未在本篇重构，不能追加第二条计费记录掩盖。最终HTTP提示改进已本地编译/回归，不冒充已安装发布；初版诊断Core实机检查后已恢复。模型请求可能计费，保留有界次数和失败记录，不触碰外部电商账号或真实文档。
