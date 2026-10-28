# Agent Note: 合并伙伴更新时兼容两种 v21 数据库

Status: implemented

## Problem

伙伴正式主分支 v0.1.107 使用 schema 21 增加 skills.enabled_dsh/enabled_workbuddy；未发布的本地 Accio 原型也把版本从20改为21，但只增加accio_work_runtime。旧Accio数据库的版本已经是21，CREATE TABLE IF NOT EXISTS不会为已有skills表补列，直接选用伙伴迁移分支会跳过新增技能列。纯内存SQLite已重现缺列错误。另有同一账号持久化位置的两类撤销逻辑与测试插入冲突，不能选一边丢另一边。

## Decision

以伙伴8dcea556的功能为基准，保留其20→21迁移；本地集成版使用22，21→22幂等补齐伙伴的技能列及Accio设备表。正式v21、本地实验v21、v20、首次初始化、重复迁移均收敛到同一结构，既有技能启用值及Accio快照不改。迁移沿用现有savepoint和版本递增，不增加独立数据库或后台修库入口。

账号持久化先复用伙伴的图像连接撤销，再执行Accio的账号匹配和撤销；同账号正常刷新保留两者，不同账号撤销旧图像引用及Accio快照。保留两边Core生命周期、测试与文档，不扩展Accio默认开关和图片目标列表。源码同步与迁移验证均在本地，不更新运行中的GUI/Core、QA虚拟机或用户数据库。

## Existing note review

- [主模型桥接](../../proposed/feature/2026-10-18-accio-primary-model-bridge.md)部分重叠：本篇替代其原型schema21分配，设备表、同步排除和凭据边界保留。
- [多应用图像技能](../../implemented/feature/2026-10-23-multi-app-image-skill.md)部分重叠：保留伙伴正式21迁移，仅向后增加兼容层。
- [独立图像分组](../../implemented/bug-fix/2026-10-23-independent-image-group.md)部分重叠：图像凭据撤销和隔离语义保留，与Accio账号撤销组合验证。
- [Core进程所有权](../../implemented/bug-fix/2026-10-19-accio-core-process-ownership.md)部分重叠：冲突只涉及测试插入位置，不改变其进程持有规则。

## Alternatives considered

- 只将20→21两个分支合为一段：新升级可用，但已标记21的实验库仍跳过，不能覆盖现有QA数据。
- 在create_tables里每次无条件补列且保留21：能修复缺列，但隐藏结构变化，无法通过版本明确区分，也不走既有升级备份路径。
- 升到22并收敛两种21：多一条幂等迁移，但保留伙伴已发布语义，利用既有事务与备份，并能测试历史路径。

## Verification

正式21/实验21/20、部分技能列、缺表、首次建表、重复执行均通过；12种历史结构组合保留已有技能开关及Accio快照。使用同名索引制造第二步DDL失败，验证前一步补列及user_version整体回滚。组合账号回归确认同账号刷新保留两类连接，换号/主动断开后旧图片内存快照不能重新同步，Accio配置清除。

带Accio实验feature的完整Rust测试通过2537项单元测试、116项集成测试，4项需手动条件的既有测试跳过；前端155个文件1040项、图片helper145项、类型与renderer构建通过。伙伴的Claude Host修复、图像分组和多应用生命周期回归包含在完整检查内。源码合并保留全部上游提交与本地Accio文件，未推送或发布。此前原生Accio文件任务成功不能代替本轮集成后实机验收。

## Consequences

迁移到22后旧正式Core仅支持21，将按既有保护拒绝更高版本数据库；未来运行候选版前须保留升级前备份，本轮不触发真实迁移。未知表结构仍应报错并回滚，不以删表或丢数据自动修复。TRAE仅调研现有能力，不在本次兼容调整中新增工具或承诺一键接入。
