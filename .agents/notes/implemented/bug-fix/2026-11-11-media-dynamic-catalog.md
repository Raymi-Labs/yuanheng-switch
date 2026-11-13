# Agent Note: 创作目录按模型家族刷新与视频参数保留

Status: implemented

## Problem

服务器分组已包含Seedance，但客户端profile只接受精确型号，刷新后仍丢弃。UI与Rust双层按固定尺寸/时长名单拒绝用户参数，部分视频payload还遗漏resolution和参考图。

## Decision

复用授权分组目录和真实令牌权限复验；profile按明确媒体家族/token识别新型号，保留已知默认值及Veo退役，文本模型不混入。进入页面、切换分组、窗口回焦重新读取，刷新模型读取当前组，刷新分组重取授权分组快照；无自动轮询目录。视频尺寸/比例、分辨率、时长改成格式校验与建议值，Seedance映射到metadata，统一视频与xAI传递参考图。图片既有实现不扩大。原账号/分组/单次提交/鉴权content下载保持。

## Alternatives considered

- 每加一个型号改白名单最快，但无法满足目录自动更新。
- 所有模型当视频会把文本模型混入且生成错误协议；限定媒体家族识别，不宣称任意未知协议自动适配。
- 删除校验但不改请求构造会无声丢参数，必须同时覆盖前端与原生payload。

## Testing

真实目录解析夹具含新Seedance且文本/Veo不出现；新型号与显式1080p/时长/参考图构造正确。组件刷新出现新型号且保持旧选择/参数；前后端格式校验一致。现有任务恢复、下载、单次提交回归通过。无收费生成，不发布或部署。

## Consequences

不带媒体标识的任意别名仍无法从字符串目录推断协议；新协议仍需适配。参数放行不保证上游接受。新行为需编译客户端后使用，当前运行客户端不会因源码修改热更新。

## Verification

Frontend parameter regression and native catalog regression failed before the fix. After the fix: 38 native media tests, 79 frontend media/parameter/save tests, TypeScript and renderer build passed. Local HTTP catalog fixtures verify new Seedance visibility and text/Veo exclusion; payload tests check reference data, 1080p, duration and pixel-to-ratio normalization. Browser inspection with synthetic IPC confirmed Seedance selection and retention of 21:9/1080p/30 seconds after refresh. No paid generation or app installation was performed.

## Related notes

This supersedes exact model filtering in [catalog filtering](2026-11-09-media-group-catalog-filter.md) and video preset restrictions in [P1/P2](../../implemented/feature/2026-11-10-media-studio-p1-p2.md). Existing image options, authorization, saved records and content download remain. Video reference limits (16 files, 10 MiB each, 64 MiB total) are local resource protection, not claims about provider capabilities.
