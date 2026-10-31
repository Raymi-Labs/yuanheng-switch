# Agent Note: 媒体保存对话框独立文件类型

Status: implemented

## Problem

v0.1.120媒体保存复用数据库save_file_dialog，其原生filter固定SQL。用户实际得到有效MP4内容但文件名为.mp4.sql；前端mock绕过了原生filter，未覆盖真实契约。

## Decision

增加媒体专用保存命令，扩展名白名单mp4/png/jpg/webp映射对应filter，JPEG允许jpg/jpeg。默认文件名只接受basename且后缀一致。保存后不静默更换路径，避免绕过用户覆盖确认；导出前核对目标扩展名与实际媒体类型，不符拒绝并提示重新选择。数据库SQL对话框不改。

## Alternatives considered

- 修改通用SQL窗口：变更少，但会破坏数据库导出入口的默认类型。
- 写出时静默去掉.sql：可掩盖窗口问题，但目标路径已变，可能覆盖未经确认的文件；不采用。

## Verification

原生媒体22项通过，覆盖实际媒体MIME到扩展名映射、四种filter不包含SQL、双后缀/缺失后缀/不匹配拒绝及大写/JPEG别名接受。前端及跨层契约27项通过：真实API模块invoke专用命令、前端不再调用SQL窗口、生产builder调用媒体filter、原生注册命令、视频/图片类型、取消不导出。源码连接断言不等于真实系统窗口点击验收，不将其称为已完成原生UI测试。

用户目录再次检查时正确.mp4已存在，旧.mp4.sql已消失，因此安全改名操作拒绝覆盖，没有改动该文件；file仍识别为MP4，大小2790756字节。不得宣称本轮完成改名或播放验收。

类型、renderer构建、GUI/Core Clippy（lib/bins、-D warnings）、格式、diff及81篇笔记检查通过。结束测试/构建进程0残留。本轮仅本地修复，未发布安装包。

## Consequences

Mac/Windows原生窗口行为需安装包验收；自动测试不再只mock窗口字符串。更新前旧客户端仍存在错误，改源代码不代表已安装版本更新。
