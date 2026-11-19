# Agent Note: Claude Desktop 路由身份持久化与旧配置迁移

Status: implemented

## Problem

按目录排序重建别名会让目录增删、分组切换或读取失败改变旧会话的目标；只有 Opus 的旧单路由升级后还会失去 Sonnet 别名。

## Decision

沿用 Provider 配置事务，在配置锁内读取旧 Provider，将历史 ID→型号保存到 meta.claudeDesktopRouteHistory。活跃目录只开放当前授权型号；历史 ID 永不回收，型号恢复后复用，退休 ID 在角色回落之前拒绝。旧版路由优先继承，真实 Claude ID 若已被别名占用则分配另一个安全 ID。没有另建数据库或后台同步。

## Existing notes audit

[分组菜单](../../implemented/bug-fix/2026-11-18-claude-desktop-group-model-picker.md)部分重叠：菜单与协议决定保持，排序分配策略由本篇取代。[Claude Code 菜单](../../implemented/bug-fix/2026-11-05-claude-group-model-picker.md)只涉及 CLI；账号模式、Windows 准备、推理档位、令牌恢复、会话同步等检索结果不改变路由身份契约。

## Alternatives considered

- 仅按型号哈希生成 ID：无需历史，但无法恢复旧版已保存的别名；本次选择继承历史。
- 删除型号时释放 ID：存储更少，但旧会话会静默换模型；选择保留占位并拒绝退休请求。
- 保留全部旧路由可调用：旧会话更方便，但绕过当前目录过滤；历史只保留身份，不授予使用权限。

## Verification

Rust 全量 lib 测试 2820 项通过、13 项既有忽略；50 项 Claude Desktop 相关测试通过，包含新增回归：目录新增、删除、退化为单模型、恢复和真实 Claude ID 冲突时不改绑；数据库往返后保留历史；旧 Opus 单路由在 macOS/Windows 经正式配置入口仍可使用原 Sonnet ID；Linux 断言原生入口不支持，并独立验证迁移与数据库持久化。首次 Linux CI 暴露测试误调用不支持的平台入口，已按真实平台契约修正断言，不跳过路由测试。前端 1426 项测试、类型检查与生产 renderer 构建通过。

## Consequences

历史随已保存的 Provider 存续，不承诺删除 Provider/数据库后恢复；历史会随见过的模型增长。原生菜单和真实付费请求仍待验收。
