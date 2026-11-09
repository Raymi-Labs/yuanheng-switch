# Agent Note: 撤回误做的移动速度档位，回归桌面范围

Status: implemented

## Problem

用户要桌面Codex/Agent加速接入，先前误将实现范围收窄为安卓内置聊天并发布alpha.5。用户明确要求撤回安卓版本、改做桌面。

## Decision

撤回合并74c3b680的移动源码改动，恢复alpha.4源码，不发布降版本安装包、不触碰用户手机数据。alpha.5 GitHub Release改草稿保留产物备份，R2仅移除该版两个固定对象；核对草稿、大小、SHA256并用ETag条件删除，其他版本和桌面latest不变。标签和历史提交保留，不复用版本号。代码复用既有分发客户端，不引入本机密钥或远端登录。删除不能远程卸载用户已下载内容，公开CDN结果另验。

桌面另按原生Codex能力和元衡Core链路实现，禁止将原移动代码算作桌面交付，禁止未经证据承诺原生UltraFast菜单或跨会话全局付费开关。

## Alternatives considered

- 只隐藏Release：操作少，但R2直链仍可下载，不足。
- 删除所有安卓版本：能消除误包但破坏已确认alpha.4，无授权且不必要。
- 固定目标撤回并保留草稿备份：满足用户撤回要求、可恢复，采用。

## Verification

撤回脚本离线覆盖非草稿拒绝、备份不匹配拒绝、已不存在幂等、不同内容不删除。GitHub已改草稿；R2操作及公开地址结果以执行回执核对，不先称完成。本地没有启动模型或手机运行时。

## Consequences

GitHub草稿无法通过GET release-by-tag获取，改为CLI草稿列表解析；隔离撤回job拥有读取草稿所需contents:write，正常分发仍contents:read。成功作业42564970769逐个核对并删除alpha.5两个R2对象、HEAD确认源站不存在；公开sha256为404，APK旧URL部分边缘节点仍HIT（immutable缓存），带新查询参数回源为404。本机/仓库未找到可用Zone Cache Purge凭据，不能宣称CDN已清除；需管理员对该精确APK URL执行单文件purge，不能purge everything或删除其他版本。

已有手机安装无法远程卸载；alpha.4为回退基线，未来正式移动版本必须使用更高versionCode。新增定向撤回入口仅接受alpha.5，GitHub凭据和R2凭据只在既有CI Secrets中使用。原移动feature的提交保留Git历史，当前能力地图随撤回恢复。
