# Agent Note: Claude 选路后补齐原始 HTTP Host

Status: implemented

## Problem

Core 0.1.101 的托管 Claude Desktop 请求启用线路选择后返回 Nginx HTML 400。RequestForwarder 在改写目标 URL 后删除旧 Host；reqwest 自动补头，而保留原始大小写的 Hyper raw 路径直接写 HTTP/1.1 字节，没有补头。即使所选线路仍为 meta-api.vip，rewrite 也生效并触发删除。已有模型映射已成功，切换渠道或模型不能修正缺失的 HTTP 头。

## Decision

在 Hyper send_request 发送边界从最终 URI 补齐缺失的 Host，覆盖原始字节路径与 Hyper fallback；保留调用方已提供的 Host，不新增重复值，保留原始头位置、大小写和其他头。URI authority 中的 userinfo 不得进入 Host 或诊断。选路器继续删除旧 Host/Cookie，reqwest、模型映射、凭据、选路策略及重试行为保持原有语义。

复用现有传输层，不增加客户端设置。影响所有经过 Hyper 的文本请求，主要为 Claude 原生 Messages；不改图片和客户端资料。

## Alternatives considered

- 在 forwarder 选路分支直接重新设置 Host：能修当前触发点，但其他缺头调用仍依赖每个调用方正确补齐；采用发送边界统一兜底。
- 把所有 Claude 请求改走 reqwest：自动补 Host，但会失去既有原始请求头大小写/顺序兼容能力，扩大影响。
- 手工关闭选路或换渠道：绕过部分触发条件，无法修复原始 HTTP 请求缺头；不作为产品修复。

## Existing notes

[客户端选路](../../implemented/architecture/2026-10-17-client-route-selection.md)部分重叠，继续持有线路白名单、快照与无跨线重放边界，本篇补齐其 Hyper 发送契约并同步原笔记。[连接稳定性](../../implemented/bug-fix/2026-10-12-outbound-connection-stability.md)部分相关，不改变代理或连接池。Accio 提案及安装进度笔记不持有本契约；不迁入其未提交实现。

## Testing

- 先在未修改发送器的代码上运行真实 loopback HTTP 回归，得到 400（期望 200），确认测试捕获缺 Host 而非仅复述实现。修复后相同回归通过。
- Hyper/TLS 10 项、选路 11 项、forwarder 68 项通过（89 项）。新增覆盖原始 Host 位置/大小写保留、原始 map 缺 Host、HTTP CONNECT 隧道、无 case map 的 Hyper fallback、唯一 Host、请求路径/正文、JSON/SSE 完整响应。
- 真实 Selector 的 Relay/Cloudflare 快照派生最终地址并序列化，核对 Host 对应实际 origin；显式端口、IPv6 方括号、重复执行、显式 Host 保留、无 authority 拒绝及 userinfo 不泄露均通过。
- 最初 Core debug 候选构建、Rust 文件格式、diff 空白与笔记门禁通过。实进程隔离验证中，现用 0.1.101 在跳板/CF × 普通/流式四场景均因缺 Host 返回400；修复版四场景均200且正文/结束标记完整，两版均拒绝错误gateway令牌，测试进程归零。正式发布与本机切换单独核验。现有测试中的 HTTP/TLS 子进程、此次回归服务随测试退出回收，不留下后台进程。

- 基于伙伴 v0.1.106 重跑本地后端全库：2476 通过、3 项既有忽略；前端153文件1023项、类型检查、图像技能145项及分发/苹果签名验证脚本通过。直接 rustfmt 检查改动文件；本机 cargo-fmt/clippy 辅助程序缺失，三平台完整格式和 Clippy 检查交由仓库 CI 核验。
- v0.1.107 隔离 Core 沿用已配置连接发起一次短文本真实 Messages 请求：HTTP200、claude-opus-5-5 返回 OK/end_turn，用量19输入/4输出 token，关闭前活跃0并优雅退出；未替换运行实例。仅含合成测试文字，未发送个人文件、姓名或历史会话。

## Consequences

本地重现和代码验证不能代替安装后的 Claude Desktop 原生验收；切换 Core 会影响活跃连接，需在用户确认的时机安装。源码已迁到伙伴 v0.1.106 的 main（7a456f25）后准备 v0.1.107；保留其图像授权等更新，不包含工作区 Accio 实验改动。
