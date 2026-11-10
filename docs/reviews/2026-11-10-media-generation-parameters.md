# 图片视频参数依据与验收边界

核对日期：2026-11-10。下面是本轮新增控件的依据，不是对平台所有渠道可用性的保证。没有调用收费生成来试规格。

| 型号 | 新开放入口 | 协议 |
| --- | --- | --- |
| GPT Image 1 / 1.5 / 2 | auto/low/medium/high质量，PNG/JPEG/WebP格式，auto/opaque/transparent背景，JPEG/WebP压缩质量0–100；保留既有尺寸并加auto | Images JSON与edits multipart均传对应字段，透明背景禁止JPEG |
| GPT Image 2.5 Sunburst / Flare | 上述选项加xhigh/max质量；常用竖横高分辨率、自定义尺寸 | 16倍数、1:3至3:1、单边≤3840、面积655360–8294400；>2560×1440为实验范围 |
| Gemini 3.1 Flash Image | 512/1K/2K/4K；官方比例包括超宽/超高1:4、4:1、1:8、8:1 | generationConfig.imageConfig.imageSize / aspectRatio |
| Gemini 3 Pro Image | 1K/2K/4K，1:1、16:9、9:16、2:3、3:2、3:4、4:3、4:5、5:4、21:9 | 同上 |
| Gemini 2.5 Flash Image | 固定1K，补官方比例；不把3系列可变分辨率套给它 | 同上，保持既有通道 |
| Grok Imagine Video | 480p/720p、1–15秒、官方比例；1.5文生视频额外1080p | 既有平台视频接口内传resolution/aspect_ratio/duration |
| Muse / Snow / Omni | 保持已适配时长与尺寸，直接展示控件 | 不假定供应商兼容其他视频参数 |

## 一手来源

- [OpenAI图像生成指南](https://platform.openai.com/docs/guides/image-generation)：Customize Image Output与Size and quality options。首次访问developers路径返回403，使用此官方platform路径成功取得正文。
- [Gemini图片生成](https://ai.google.dev/gemini-api/docs/image-generation)：按型号的Aspect ratios and image size表。3.1 Flash的512档位枚举是`512`，不是`512px`。
- [xAI视频生成](https://docs.x.ai/developers/model-capabilities/video/generation)：Configuration中的Duration、Aspect Ratio与Resolution。
- Muse/Omni沿用仓库既有适配与用户提供的上游规格，见[使用指南](../guides/media-studio.md)。

本轮保留已有模型名单、参考图限制和结果解码路径。没有新增SVG输出、批量结果、多图变体或视频音轨控制；这些不是本次六项P1/P2范围，不能混入现有单成品记录而假装已适配。

## 路由语义

账号共享令牌由平台routing_config决定真实路由与费用。页面分组只筛模型目录，不是请求级锁组。代码复查覆盖ensure_shared_api_token与提交前令牌/v1/models校验；不改写平台规则。历史里的组属于用户选择快照，不是服务端结算证明。本轮未使用生产账号实际生成与对账。

## 隐私

提示词默认不保存；用户勾选后保存到账号隔离的本地`.prompt`文件（Unix文件0600、目录0700），不进入数据库JSON、数据库同步导出、参数偏好或日志。参考图不保存。WebDAV/S3现有同步仅处理db.sql与skills.zip，不包含媒体目录。操作系统或用户自行备份整个数据目录不在此保证内；这不是加密存储。删除描述清理当前文件，不能宣称擦除系统备份。
