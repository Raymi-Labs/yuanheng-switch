# Agent Note: 视频参数一致性和任务号别名

Status: implemented

## Problem

Omni1080p型号继承通用720p分辨率默认，与1920x1080冲突。像素size和resolution可独立编辑形成矛盾，比例未转为兼容接口需要的size。提交只读id导致仅返回task_id的任务无法继续查询。

## Decision

Omni1080p独立默认；编辑分辨率同步像素，编辑像素同步短边分辨率，未知分辨率保留比例不猜像素。原生边界拒绝矛盾像素/Np，比例与Np只有整数可表示时才推导size。兼容提交接受id或task_id，双字段矛盾/非法类型拒绝为未知状态，不重发。

## Alternatives considered

- 只改默认不能覆盖用户后续编辑。
- 忽略冲突交给上游可能产生非预期规格或计费；客户端保持单一对应值，IPC仍验证。
- 盲取第一个任务号可能查询错任务；相同双字段接受，冲突保留未知并停止。

## Testing

默认1080p回归先失败再通过；组件输入与请求一致，原生尺寸及别名矩阵通过。服务端另库同时修复Muse门禁/补竖屏，客户端不部署或收费生成。

## Consequences

未知分辨率不保证上游支持；原生不替用户改非法IPC请求，页面明确维持一致。原任务记录和下载权限不变。

## Verification

40 native media tests pass. Frontend tests exercise resolution editing and exact submit values, defaults and inconsistent IPC inputs, plus original account/group/recovery/save protections. TypeScript and Clippy pass. Server adapter and billing-wire verification run in Raymi-Labs/meta-api independently; neither local result implies production deployment. No generation API calls.

## Related notes

Extends [dynamic media catalog](2026-11-11-media-dynamic-catalog.md), preserving its model-family, ownership and download boundaries.
