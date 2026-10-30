# Agent Note: Accio 启动前确认随包 Core

Status: implemented

## Problem

签名候选原生验收发现GUI可启动Accio但仍使用旧测试Core。Accio入口仅在代理未运行时调用start，CoreSupervisor::launch_accio只查status；已运行Core绕过ensure_running升级逻辑。单纯将条件改成无条件重启又会中断其他Agent请求或正在运行的Accio。

## Decision

在CoreSupervisor的Accio启动入口先确认官方Accio进程未运行，再复用ensure_running_from完成空闲升级/忙碌延后/失败回退。正式构建要求返回的Core协议及二进制身份与随包文件相符；升级延后时不发Accio启动POST，提示等待现有请求结束。开发构建维持不替换同协议已运行Core的规则。只在Core就绪之后重新读取profile/revision，避免升级导致capability轮换后提交旧revision。启动POST只发一次，不自动重试。

## Existing note review

- [原生候选回归](../../proposed/testing/2026-10-29-native-candidate-regression.md)为缺陷证据，保留手动升级和未通过项。
- [Core健康恢复](../../implemented/bug-fix/2026-10-26-core-health-recovery.md)继续作为升级/回退实现，复用而不复制服务管理。
- [默认Accio入口](../../implemented/feature/2026-10-29-accio-default-availability.md)不扩展Windows能力或发布范围。

## Alternatives considered

- GUI代理start改为无条件调用：可触发升级，但容易在Accio已运行时先重启Core，且其他管理调用仍绕开检查。
- 无条件关闭旧Core：容易得到新版本，但会中断其他Agent，拒绝。
- 在Accio受控启动边界复用升级并核对结果：启动调用方一致，原服务升级保护沿用；忙碌时明确等待，采用。

## Verification

Accio59项及Core相关51项回归通过（两个集合有交集）；GUI/Core locked offline cargo check通过。新增本机HTTP夹具覆盖旧Core忙碌时不调用启动/停服、当前Core仅一次POST、协议不匹配拒绝、开发构建保留同协议Core、错误启动不重试。升级顺序夹具模拟旧协议Core在shutdown后切至新身份并轮换capability，实际执行版本目录切换与等待就绪，验证事件为upgrade→launch、请求revision等于升级后profile。夹具不调用launchctl或真实Accio、不修改用户数据库；服务任务均abort并await回收。

首次原有两项转发回归因工具链包装脚本携带已经关闭的出站代理而失败，清除测试进程HTTP(S)/ALL_PROXY后离线重跑全部通过，未修改系统代理。新增轮换夹具最初误用保留同账号capability的save_configuration，导致不能模拟轮换；改为仅测试使用的save并验证轮换前后revision不同后通过。不隐藏这些失败原因。尚未重建签名候选或在真实旧Core升级环境完成原生回归；这些测试不代表Windows支持、钥匙串继承或原生取消通过。

## Consequences

已运行Accio须先退出；活跃请求期间新的Accio启动可能需要稍后再点。进程检查后仍有外部启动竞争，由Core原有二次检查处理。原Core升级过程的跨进程竞争和系统签名权限不由本修复消除。
