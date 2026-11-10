# Agent Note: Codex 页面上下文兼容 HTTP Responses

Status: implemented

## Problem

Codex Desktop 在新会话首条用户消息前注入 namespace=agent 的 codex_apps_open_page 与 codex_apps_selected_page_part_N_of_M。这些 function_call_output 只有输出项 id、name、output，没有 call_id 或配套 function_call。Meta API HTTP 网关因此拒绝请求，报 call_id 缺失；用户即使只输入 hello 也无法开始会话。已检查本机两条失败会话的结构（不保存用户正文），以及网关 ValidateFunctionCallOutputContext。

## Decision

复用 forwarder 的 Codex 模型映射后、协议转换前入口，仅在非官方且非 Codex OAuth 上游，将上述精确名称、agent 命名空间、缺失/空 call_id、字符串 output 的页面通知转为 user input_text。保留内容、顺序与名称标签，声明为外部上下文数据；不提升为 developer 指令、不伪造调用、不丢弃历史。未知工具、有效 call_id、非字符串输出保持原样，交给原路径校验。兼容 Responses、Chat 和 Anthropic 转换。

活跃笔记检索 previous_response_id/call_id/WebSocket：线路选择笔记只管网络入口，与本协议适配无关；CLI速度笔记只管启动票据；TRAE提案只管其会话桥接，无需归档。此修复不涉及续接缓存，不改 previous_response_id。

## Alternatives considered

- 补造 call_id 与 function_call：能通过部分网关校验，但会伪造模型从未发起的工具调用。
- 删除页面通知：改动少，但丢失用户所选页面上下文。
- 启用 WebSocket：需要独立连接生命周期，且这些通知并非某次响应的真实工具回执，不能解决身份语义。

## Testing

Rust全库2744项通过、12项既有忽略。新增4项回归涵盖精确通知识别、正文与顺序、幂等历史回放、真实工具配对、未知缺失ID输出不改、官方/OAuth/其他客户端旁路，以及三协议本地HTTP出站连续发送。TypeScript检查、renderer构建与版本校验通过。前端180文件1342项测试通过；本机Node25原生webstorage与jsdom存储spy冲突，需以NODE_OPTIONS=--no-experimental-webstorage匹配CI Node20行为（首轮5项失败，兼容运行全过）。真实上游与安装验收另行记录，不将合成HTTP成功等同于原生Codex端到端完成。

## Consequences

只适配已证实的页面通知；将来新增通知需要单独证据。user级外部数据保留信任边界，真实模型输出需与合成回归分别记录。
