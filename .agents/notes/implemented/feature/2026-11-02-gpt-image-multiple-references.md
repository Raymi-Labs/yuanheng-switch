# Agent Note: GPT Image参考图跟随官方多图能力

Status: implemented

## Problem

用户明确要求跟随官方能力，不因未实测就先限制。当前GPT Image前端单图替换、后端images拒绝和multipart单文件都把已支持多图的接口缩成1图。粘贴功能沿用该限制，需要翻转这个决定。

## Decision

GPT Image系列参考图按官方编辑API最多16张，选择/粘贴追加并可排序删除。单张继续兼容image字段，多张发送重复image[]，选择/images/edits；无图仍走generations。images与reference互斥。Muse继续4张/24MB独立约束，Gemini本轮不据GPT规格推断多图能力。

2026-11-02读取[官方编辑API](https://developers.openai.com/api/reference/resources/images/methods/edit)，明确GPT Image至多16张，列出Sunburst/Flare，multipart示例为多个image[]。官方[图片指南](https://developers.openai.com/api/docs/guides/image-generation)说明编辑图和mask小于50MB；GPT文件输入按PNG/JPEG/WebP、小于50MiB校验，不再套用初版10MB。仍保留已存在的8192边长/1677万像素/128MiB解码预算，它们是本机资源防护，不称为官方模型限制。服务端OpenAI适配器和元衡技能脚本已经支持重复image[]；不修改服务器、不发真实收费请求。

切换到容量较小或格式不兼容的模型时保留整个草稿并提示调整，禁止生成直到满足所选型号，不静默删图。切到不支持参考图的模型仍沿用现有清空提示。图片读取和生成互斥、账号切换丢弃旧读取保持。

项目AGENTS同步用户偏好：按官方范围开放，实际不兼容后依据具体证据收窄；保留资源防护并清楚区分。

部分取代[粘贴入口](../../implemented/feature/2026-11-02-media-reference-paste.md)的GPT单图替换，以及[初始参考图流程](../../implemented/feature/2026-10-31-image-to-video-workflow.md)的GPT数量/文件类型/体积限制；其他模型及作品转视频缩放不改。

## Alternatives considered

- 维持单图或先开放4图：实现更少，但无官方依据，违背用户明确偏好。
- 只改前端：仍被原生校验拒绝且无法正确构造编辑请求，不采用。
- 所有型号一律16图：协议能力不同，不能以GPT规则替代Muse/Gemini规格；仅拓展本次核实的GPT系列。

## Verification

前端43项通过（媒体页31、型号边界及翻译7、保存契约5）；原生媒体24项通过，覆盖Sunburst/Flare 16张/17张边界、全部multipart字段和顺序、WebP、混合字段/坏图拒绝、生成与编辑路由，以及26MB总量不套用Muse门槛。TypeScript、前端格式及生产renderer构建通过。切页签测试发现中间空型号清图，修复后保留草稿并正确提示新型号容量；未为测试截断图片。Rust首次因旧缓存保留搬迁前路径失败，使用独立target重新编译通过。Clippy发现新函数多余生命周期标注，移除后复验。没有调用真实收费生成或读取真实剪贴板；原生WebView及供应商16图真实效果不由单元测试推断。

## Consequences

官方接口能力不代表所有中转供应商均实测支持；真实上游拒绝时如实显示错误，不自动重发或回退单图。16张大文件增加IPC/base64内存峰值；不新增低于官方的合计数量/大小门槛，不放开解码资源防护。
