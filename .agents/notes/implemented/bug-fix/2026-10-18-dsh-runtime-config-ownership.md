# Agent Note: DSH 自身保存后的托管配置校验

Status: implemented

## Problem

DSH 0.2.0-rc.2 启动会把 flat credentials 迁移到 version 1 / refs，并添加浏览器会话 records。设置保存会重排 YAML、把欢迎提示配置放进元衡标记内；在 DSH 中切换模型也修改默认模型。原实现比较整个标记文本 hash，因此正常启动之后凭据复用、重新配置和恢复全部被阻止。本机只读比对确认凭据迁移、Web profile 的目录内模型切换和欢迎页设置同时出现。

## Decision

复用现有配置事务、锁和原子写入。凭据按单个引用校验，重建旧 writer 的 key hash 来验证旧记录；读写 version 1，兼容旧 flat，并保留其他 refs / records。profile 仍以旧 hash 为证明，通过原 writer 的规范输出消除缩进变化，允许目录内且路由匹配的默认模型选择；接口、供应商配置、未知模型和外部覆盖仍拒绝。DSH 填进标记中的非托管行在重配/恢复时保留在标记外。未知凭据 schema 拒绝写入。复用配置/启动入口，不新建安装流程。

## Existing capabilities and note audit

- [安装启动](../../implemented/bug-fix/2026-10-11-dsh-install-launch.md)部分相关，保留安装与进程监督职责。
- [Claude 策略](../../implemented/bug-fix/2026-10-13-dsh-claude-stream-policy.md)部分相关，保留旧策略可迁移及非托管供应商保护，本笔记接管运行时格式变化的兼容边界。
- 官方更新、工作台直接安装笔记仅入口相关，不改变其决定。Codex 设置修复与下载 failover 无关。

## Alternatives considered

- 删除完整性校验：可立即放行，但会将凭据发送到已变更的接口，且覆盖用户供应商设置。
- 每次启动前重写旧配置：实现简单，但 DSH 会再次迁移，浏览器会话和用户偏好容易丢失。
- 仅接受 YAML 等价：可处理缩进，但不能兼容凭据 schema、欢迎页保存和目录内模型切换。

## Verification

- DSH 定向测试 21 项通过，覆盖旧 hash、格式迁移、目录内切换、凭据复用、重配、直接恢复、其他 refs/records/偏好保留、key/接口/未知模型及外部覆盖拒绝、锁与中断恢复。
- 本机配置经脱敏后导入隔离测试，原凭据 fingerprint 相等，生产校验函数通过；未修改用户的配置文件。
- 官方 npm DSH 0.2.0-rc.2 在临时 DSH_HOME 实际启动，浏览器完成欢迎提示与目录内模型切换；写回的凭据和 profile 再导入生产函数校验通过。未使用真实凭据、未发送模型推理请求；浏览器与测试进程已关闭。
- 前端 965 项、原生 2522 项通过（3 项原有跳过），类型检查、renderer 构建、格式及笔记检查通过。按仓库固定 Rust 1.95 运行 Clippy `-D warnings` 与 DSH 定向测试通过；本机另装的 stable 1.97 新增 lint 命中两个无关旧文件，未混入该修复。新生成的 version 1 凭据由官方 DSH reader 解析通过。Release 与客户端实际升级分别核实。

## Consequences

已有配置可直接读取，不靠关闭安全校验放行。仅兼容核实过的 version 1 和现有 profile writer，未知 schema 仍失败；未来上游 schema 变化需要新增兼容验证。凭据和被 DSH 放进标记的非托管行重新序列化可能调整注释/排版，但保留其他引用、records 和偏好值；原有 profile 标记外文本不重写。真实模型连通性与本次磁盘兼容验证分开报告。
