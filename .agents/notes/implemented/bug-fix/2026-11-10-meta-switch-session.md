# Agent Note: 切换 Meta API 前验证账号会话

Status: implemented

## Problem

切换和工具配置继续使用过期登录缓存，平台返回未登录且未提供 access token；刷新入口已有清理处理，但这些入口没有复用，用户重试仍显示相同原始错误。

## Decision

复用本人账号查询、会话错误识别和既有清理入口，在切入 Meta API 与配置工具前验证；失败时复核请求账号，避免旧请求清理新登录。前端在完成或失败后重新读取连接状态。官方模式切换不需要平台登录。

## Alternatives considered

- 仅改错误文字：改动小，但仍保留过期缓存和重复重试，放弃。
- 每次切换重新创建令牌：无法修复账号 Cookie 失效且增加凭据副作用，放弃。
- 复用现有会话校验：多一次本人查询，但能在配置写入前拒绝过期会话，采用。

## Verification

隔离 HTTP 回归覆盖平台原始未登录响应、旧请求与新会话、离线保留会话和 API 令牌保留；前端 5 项回归覆盖切换／配置失败后的连接缓存刷新。类型检查和 renderer 生产构建通过。真实用户账号与两步验证未代为操作。

## Consequences

新增账号查询需要联网；网络和非会话权限失败不得清理登录。真实用户两步验证仍需本人完成。

## Related notes

[密码登录凭据独立](../../implemented/bug-fix/2026-10-10-password-login-keychain-independence.md)部分重叠，沿用其清理机制；统一令牌与 Codex 官方登录笔记不改变。
