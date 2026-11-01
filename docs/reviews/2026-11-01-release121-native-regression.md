# v0.1.121 签名候选与 Accio 0.37.2 原生回归

验收日期：2026-11-01。范围为 Apple Silicon 专用 macOS QA 虚拟机、Astra 和本地合成文件。候选验收不等于正式 Release 已发布，不扩大到 Intel 真机、Windows Accio、其他模型或官方电商云端工具。

## 构建来源

- PR：[#82](https://github.com/Raymi-Labs/yuanheng-switch/pull/82)。候选提交：`13116c72d05242289ae0db9fee79cb8d73d015a6`。
- [候选构建 41288623986](https://github.com/Raymi-Labs/yuanheng-switch/actions/runs/41288623986)，`candidate_only=true`，产物 `desktop-aarch64-apple-darwin`。
- receipt 的版本、提交、run、target 及归档、更新签名、DMG 的大小和 SHA-256 均已核对。
- 更新归档 SHA-256：`8dbf833a7a281c19d50bff663018fd98a3f2629aa93160baa663704c1d4c36f9`。
- 随包 Core SHA-256：`c03d918a0b54d3884a730ac4cc68a989ab20573f5f470a6b3fa8d272e5d7024e`。
- 首次 Intel 构建在 `stapler validate` 连续三次 Apple CloudKit 网络中断后以错误 68 失败；已通过既有入口重跑失败任务，未跳过签名、公证或产物校验。

## 原生结果

1. 测试机原 GUI 0.1.116、官方 Accio 0.35.3 均先保留备份，再安装候选 GUI/Core 0.1.121 和官方 Accio 0.37.2。两应用 Bundle ID、Team ID、深度签名与版本校验通过，候选 Gatekeeper 通过。替换安装后 Accio profile 原文与安装前完全相同。
2. 产品 Core start 安装随包 Core，实际运行文件摘要匹配；正式管理启动返回 HTTP 200，Core 持有 Accio 子进程，0.37.2 没有被历史实测列表拦截。QA 系统本地网络提示经正常界面处理，未修改宿主权限或网络设置。
3. 原生模型菜单保留 Astra。一个合成任务执行 read → write → read → edit → read；独立磁盘核验 `total=83`、随机 marker 一致、`verified=true`，input 与 guard 的 SHA-256 不变。6 条当前启动范围的 Astra 请求均 HTTP 200、有正输出，结束时活跃请求 0。
4. 单独提交无工具计数任务，在原生界面点击停止。点击前活跃请求 1，点击后首轮查询为 0，界面停止输出。停止记录为 HTTP 200、token 统计 0，不能将它算作第七条完整成功响应，也不据此证明上游停止计费。
5. 候选 GUI 正常打开，显示已有钥匙串记录需要恢复访问。使用产品恢复入口和 QA 机器的随机本地登录密码，经系统两次单次 Allow 恢复原会话；未导出平台秘密、复制宿主会话或重新登录平台账号。这证明交互恢复有效，不代表跨重启免交互恢复。
6. GUI 工作台显示已安装 Accio 0.37.2，无等待适配或禁用提示。显式重新选择同一分组的 Astra 后显示配置已保存、预检通过；随后实际点击 GUI 启动，原生 Accio 打开，Core 子进程归属与 active route 均验证通过。此轮重开未再提交模型请求。

## 配置边界与收尾

安装与首次启动保留业务配置。后续显式 GUI 保存同步了当时的平台目录：移除 `gpt-5.6-luna`、加入 `gpt-6.1-terra`，共 8 个模型；provider 仅 `settingsConfig.modelCatalog` 改变，另有正常生命周期 capability 更新。owner、group、当前 model 均不变。旧收尾脚本的“全部业务 JSON 不变”断言因此失败；核实变化仅来自明确执行的目录同步后，另存字段级审计，不把失败记录改写成升级自动保留的证据。

最终 input/guard 未改，结果文件正确；路由 inactive，测试 Accio、GUI、Core、osascript 进程均为 0。QA 客体正常关机，Tart 报告 guest stopped，监督器退出码 0。原始日志、测试数据库、账号昵称/余额截图、凭据及备份只保存在本地 QA 目录，不提交到仓库。用户日常应用和其他虚拟机未操作。

这次验证的是正式签名候选的升级、配置、启动、单模型文件任务和原生停止。正式标签构建及 GitHub/R2/平台分发须分别核验，不由候选结果推断完成。
