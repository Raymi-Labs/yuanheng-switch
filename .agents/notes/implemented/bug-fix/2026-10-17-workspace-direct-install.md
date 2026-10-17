# Agent Note: 工作台当前工具直接安装

Status: implemented

## Problem

工作台未安装状态的“安装与配置”只调用工具管理导航，用户点击后没有开始安装。useModelSwitchCenter 已提供安装动作，DSH 还具备安装验证后配置和启动续接，但当前工具卡未接入。

## Decision

当前选中工具未安装且有安装能力时，按钮直接调用共享 install 动作；在当前卡展示执行、验证、取消及外部下载安装等待。复用已有跨入口任务锁和取消按钮，不新增后端命令。安装失败保留重试，检测失败和已安装但不受支持时保留重新检测/工具管理入口，避免盲目重装。DSH 沿用安装→运行验证→配置→启动及账号/卸载续接保护；只有官方下载能力的桌面工具清楚标示下载页。

## Existing capabilities and note audit

- FocusToolCard → useModelSwitchCenter.install → settingsApi.runToolLifecycleAction 已有服务链，仅 UI 未接线。
- [工作台单入口](../../implemented/simplification/2026-10-12-workspace-single-tool-controls.md)的未安装跳转决定由本篇替代；工具管理仍负责多工具维护。
- [DSH 安装闭环](../../implemented/bug-fix/2026-10-11-dsh-install-launch.md)、[原生安装取消](../../implemented/bug-fix/2026-10-01-bounded-tool-installation.md)部分相关，复用其下载、事务、互斥和取消，不重新实现。
- 现存下载分发笔记的未提交改动及设计文件不属于本任务。

## Alternatives considered

- 跳到工具管理后自动点击：可复用卡片，但仍跳页、依赖挂载时序，并可能重复触发安装。
- 在工作台独立实现安装：容易展示，但会复制互斥、取消、验证和账号续接逻辑。直接接入现成 hook 改动更小。

## Verification

- 146 个前端文件、940 项测试通过；类型、完整前端格式和 renderer 构建通过。App 集成测试覆盖工作台/工具管理分别安装 DSH 后验证、配置、启动；组件测试覆盖选中 DSH/Codex/Claude、官方桌面下载入口、检测失败/旧快照/已安装但不支持、共享执行/验证/取消状态及重新点击。
- 真实 App 壳的隔离浏览器 IPC 模拟验收通过：工作台点击发送单个安装请求且不跳页；失败提示与重试、取消、成功后配置/启动；工具管理发起后切回工作台仍显示同一安装任务。900×600 窄窗口明暗主题按钮可见，刷新可恢复当前工具。
- 真实 POSIX 安装脚本在独立 /tmp 目录下载 Node.js 时，240 秒收到约 7.98 MB / 51.06 MB 后超时，未进入解压/npm/运行验证；原有用户安装和配置未修改。相同官方文件的系统代理和备用官方路径采样也较慢，未证明网络问题已解决。本次只修复未调用安装入口，不更改固定哈希、下载地址或监督上限；不宣称真实安装已完成。

## Consequences

点击工作台当前未安装工具即可开始原有安装流程，不再强制跳页；任务状态和取消跨入口保持一致。下载失败仍由既有提示说明，当前网络下 DSH 实际安装未验收完成；模拟 IPC 通过不等于第三方包已安装或真实渠道可用。macOS 本机测试不能证明 Windows 真机安装。导航离开原入口继续安装但取消旧账号的自动配置/启动意图，沿用既有约定。

DSH official version selection and managed updates supersede only the fixed DSH version policy; see [official updates](../feature/2026-10-17-dsh-official-updates.md). Existing installation, entry-point and supervision boundaries remain in effect.
