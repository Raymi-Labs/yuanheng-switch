# Agent Note: DSH 默认安装与启动官方桌面端

Status: implemented

## Problem

工作台和工具管理的 DSH 安装按钮安装私有 npm Web 运行时，用户期望官方独立桌面端。旧托管 Web / PATH CLI 优先级还会遮挡已经安装的桌面应用，下载后的检测可能提前完成。

## Decision

复用桌面下载安装观察流程。Windows 打开官方 x64 EXE；Mac 先选择 Apple 芯片或 Intel DMG，不依据 UA 猜芯片。取消选择不下载、不配置；官网打开成功后才显示等待安装。其他平台明确暂无桌面安装包，不退回 npm 安装。

自动检测与默认启动仅认桌面应用，不以旧托管 Web 或 PATH CLI 认定桌面端已就绪。显式自选源码的 Desktop 启动继续支持；纯 Web 源码只供显式 Web 入口使用，不完成桌面安装检测，也不遮挡自动发现的桌面应用；本机 Web 只能由独立 Web 按钮触发，保留旧运行时与用户目录。安装后复用实时预检、拥有权保护、账号/页面续接保护，配置成功后以既有重启并应用流程启动桌面端，覆盖官方安装器已先打开应用的情况；成功后清除待重启标记。桌面版本更新交给官方应用，不比较 npm latest。原有配置冲突不因安装方式改变而绕过。

## Note audit

- [旧安装决定](../../implemented/bug-fix/2026-10-11-dsh-install-launch.md)与[官方 npm 更新](../../implemented/feature/2026-10-17-dsh-official-updates.md)：默认安装路线被本篇部分取代；隔离运行时保留给已有 Web，配置/历史数据不删除。
- [共享进度](../../implemented/feature/2026-10-18-tool-install-progress.md)与[直接安装](../../implemented/bug-fix/2026-10-17-workspace-direct-install.md)：复用官网观察语义和两入口，不伪造下载进度。
- [配置拥有权](../../implemented/bug-fix/2026-10-18-dsh-runtime-config-ownership.md)：继续有效，不放宽校验。

## Alternatives considered

- 继续默认 npm Web：可隔离运行时，但不符合用户指定的桌面端体验。
- 元衡下载并静默安装 EXE/挂载复制 DMG：步骤更少，但重复官方安装器、升级、签名与权限流程；先复用现有官网下载观察流程，保留用户对安装位置的选择。
- 只替换下载链接：修改小，但旧 Web 抢占检测/启动、npm 更新误提示仍存在，因此同步校正完整入口。

## Verification

本地前端 157 个文件、1045 项测试通过：两入口真实 App 组件模拟 IPC 验证选择 Apple/Intel 官方包后配置并调用桌面启动；独立 Windows 下载、Mac 取消/关闭/重试、超时与迟到检测、账号切换和页面卸载不续接、配置/目录失败不启动均覆盖。库存缓存升级验证拒绝旧 Web 判断，桌面更新面板不调用 npm 更新。

DSH 相关 Rust 23 项通过，新增磁盘旧 Web 安装 fixture 验证不误报桌面，以及桌面版本不查询 npm 通道；原配置保护与显式 Web 回归继续通过。完整 Rust lib 2514 项通过、3 项原有忽略。TypeScript、Prettier、renderer 构建、版本公告检查通过。三种官方固定安装包经 HTTPS HEAD 返回 200；没有执行用户机器上的官方安装器，也没有声称 Windows 真机或真实模型调用验收。正式签名包和分发结果由发布流水线另行核验。扩展 `clippy --all-targets` 发现既有 core_diagnostics 与 secure_storage 测试代码的两项 lint；未扩展本次业务改动范围，仓库正式命令 `cargo clippy -- -D warnings` 通过。

## Consequences

官方下载依赖网络且需用户完成系统安装，元衡无法展示浏览器真实下载进度。Intel 固定下载包与 Apple 芯片包可能不同版本，不把固定 URL 冒充版本号。macOS 当前网络可访问三种官方安装包；Windows 安装/运行需要单独真机验收。上游未来配置格式变动仍可能触发保护。
