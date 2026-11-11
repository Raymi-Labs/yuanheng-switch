# Agent Note: Codex 升级保留已有托管身份

Status: implemented

## Problem

稳定桶修复仍在 prepare 时优先选择 custom 或专用桶，将升级前的 yuanheng-switch-official 活跃身份换掉。新引擎严格比较 ID，两张同名 OpenAI 表仍会导致旧聊天无法恢复。

## Decision

复用配置投影、所有权判定和模式事务，优先保留 previous 中已托管的活跃 ID，仅首次配置选择默认桶。自愈、官方切换、返回中转和清理均不改变原身份。外部占用报错且不覆盖。已经存在的混合历史不通过启动副作用迁移；本轮不修改运行中的用户数据库。

## Alternatives considered

- 继续固定 custom：首次安装简单，但升级会改变身份，正是本次回归来源。
- 自动统一所有历史：会同时改写 SQLite、会话文件和运行中状态，需要独立离线恢复流程，不能混在配置投影里。

## Verification

四种已托管身份均经过刷新、官方、清理及返回流程保持原 ID；外部配置保护与既有回归通过。Codex 相关 Rust 回归 576 通过、3 项既有忽略；本机引擎隔离合成 custom 和旧官方 ID 恢复通过，未调用模型。类型检查、前端生产构建、21 项发布脚本测试通过。

## Consequences

已被此前版本分裂的历史仍需恢复到对应 ID 或离线迁移，不能声称所有旧聊天已恢复。现有历史迁移固定 custom，不能直接用于专用桶用户。

## Related notes

检索现有笔记后确认 [稳定桶决定](2026-11-10-codex-stable-provider-bucket.md) 部分被取代：稳定身份目标保留，升级时强制桶选择取消。认证、页面上下文、项目恢复决定无须改变。
