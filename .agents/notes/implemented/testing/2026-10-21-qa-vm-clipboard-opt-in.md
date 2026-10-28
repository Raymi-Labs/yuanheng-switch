# Agent Note: 用户授权的 QA 虚拟机剪贴板共享

Status: implemented

## Problem

干净Mac验收默认禁用宿主与guest剪贴板，阻止用户把合成测试提示粘贴到Accio。用户已明确要求开启复制粘贴；这翻转原隔离决定的剪贴板部分，不能只删除参数后假设跨机同步已验证。

## Decision

保留原run/run-test/provision的无剪贴板隔离模式，新增仅人工入口使用的run-manual共享模式，让现有“打开测试虚拟机.command”选用它。另有“打开隔离测试虚拟机.command”调用run-test。仅固定QA VM使用，音频/USB和宿主目录隔离保持不变。

guest原本没有剪贴板组件，现安装固定版本官方Tart guest agent 0.15.0。macOS压缩包SHA-256为`eb47f402f18e742a8ea96344115ca776179f9c4c67494bc0c46a10a68db280b7`，二进制SHA-256为`8bbbffe09d207164cbabc06a2b2f5085e041290e75247d28db0a0e1fa852646e`；codesign严格验证全部架构、Apple信任链、标识`tart-guest-agent`与Cirrus Labs Team ID `9M2P8L4D89`通过。guest用户域LaunchAgent仅传`--run-vdagent`，不启用RPC、磁盘调整或debug，输出丢弃到/dev/null，不安装宿主服务。

风险已向用户明确提示：共享开启时，复制的密码、令牌或个人信息可能进入VM。本次不读取或输出原剪贴板；图形工具失败时不以服务运行替代复制成功。测试结束关闭VM，保留用户登录及guest组件供下次人工启动使用。人工窗口最长60分钟，避免原20分钟外层时限压缩15分钟模型验收窗口；这不是对上次收尾失败根因的判断。

## Existing decisions

[干净Mac验收](../../proposed/testing/2026-10-19-accio-clean-macos-vm.md)部分被取代，仅人工剪贴板模式变化；空白基线、宿主账号隔离、未知版本门禁与零遗留要求仍有效。初始无剪贴板历史不改写。本篇不扩大为Accio模型兼容或手动测试锁清理。

## Alternatives considered

- 保持全部禁用，要求手打或传文本文件：隔离最严格，但无法满足用户明确的复制粘贴需求。
- 全面删除所有模式的禁用参数：实现短，但自动测试和首次provision也会意外共享，超出用户人工验收范围。
- 人工入口显式共享、隔离入口保留：复用Tart现有能力，成本是维护两种启动模式和guest组件；采用此方案。

## Testing

启动前确认工作VM已停止，不强制结束用户任务。Node合成测试覆盖人工启用、run/run-test/provision继续禁用、USB/音频隔离和只读共享目录不变；Node/shell语法检查通过。guest重新启动后LaunchAgent自动运行，lsof确认打开`/dev/tty.com.redhat.spice.0`；只读采样CPU0.0%、RSS21296KiB。初始错误使用了不支持的log-level选项，已移除，最终配置与重启运行均核对。

初次使用空白文本界面验证时CUA返回screen capture failed，当时未完成真实双向复制粘贴；不将服务运行当成该项通过。该阶段最终guest正常关机，测试进程归零，宿主原服务不改动。

用户反馈仍不可用后，在其手动运行的共享模式VM中验证真实文本传输：先明确告知会用合成文本替换当前剪贴板，不读取原内容；宿主pbcopy写入独立标记，guest GUI/Aqua临时LaunchAgent通过pbpaste仅比较该标记，匹配true，再写入不同guest标记，宿主仅比较结果也为true。原文不输出，未发送模型请求。SSH直接launchctl asuser第一次权限不足，不作为失败链路证据；GUI会话下命令成功。临时check job退出并bootout后确认无检测进程，用户预先打开的VM与所需剪贴板服务保留，非本轮测试残留。

CUA在Accio空输入框尝试Command-V时只出现字母v，测试字母随后移除；坐标点击仍返回noWindowsAvailable，Shift-Tab也未得到预期逆向焦点。因此当前只确认共享的双向文本通路通过、自动GUI快捷键传递存在独立异常，不能推定用户的粘贴失败原因相同，Accio实际粘贴仍需菜单操作对照。没有再次重启或重装，也没有宣称最终输入体验已修复。

用户随后亲自确认复制粘贴已可用，人工输入项据此通过。该回执不替代Accio模型路由验收；普通打开VM或官方Accio不自动启用元衡连接，CUA坐标控制仍是独立工具限制。

## Consequences

用户下次从原人工入口开机即可使用已准备的共享配置，无须重装元衡或Accio。代价是剪贴板共享降低宿主和guest的数据隔离，只对人工入口启用仍不能阻止用户主动复制敏感内容；提供显式隔离入口作为回退。只运行所需组件，升级时需复核签名、固定哈希及开关契约；脚本或agent启动成功不等于跨机复制实测通过。
