<div align="center">

# 元衡桌面端

### 把元衡 API 项目接入 Claude Code、Codex 等本地 AI 编程工具

[元衡 API](https://meta-api.com) · [English](README.md) · 中文

</div>

## 产品定位

元衡桌面端不是一个让用户手动收集、添加和切换供应商的工具。

供应商、API Key、模型权限、额度与计费统一在元衡 API 控制台管理；桌面端负责把项目配置安全地应用到本机工具，并提供运行状态、项目快照、MCP、Skills 和会话等本地能力。

## 使用流程

1. 在[元衡控制台](https://meta-api.com/console/token)创建项目令牌并配置可用模型。
2. 由控制台向桌面端下发接入配置，或首次使用时导入本机已有配置作为迁移起点。
3. 在桌面端选择目标工具和项目，应用配置后直接使用 Claude Code、Codex 等客户端。
4. 密钥、模型范围、额度与用量继续回到元衡控制台统一管理。

## 当前能力

- 元衡项目连接状态与控制台直达入口
- Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw、Hermes 本地配置应用
- 项目快照：联动供应商配置、MCP、Skills、提示词与记忆文件
- MCP、Skills、提示词和会话的统一本地管理
- 本地路由、协议转换、故障转移与用量记录
- 保留平台 Deep Link 下发和现有配置导入能力

手动“添加供应商”和“复制供应商”入口已移除。底层导入能力仍保留，用于元衡平台联动与旧配置迁移。

## 本地开发

```bash
pnpm install
pnpm dev
```

常用检查：

```bash
pnpm typecheck
pnpm test:unit
pnpm build:renderer
```

## 数据与兼容

- 默认配置目录：`~/.yuanheng-switch/`
- 数据库、备份与更新协议继续兼容现有 YuanHeng Switch 安装
- 桌面端 Deep Link 协议：`yuanhengswitch://`

## 来源与许可

本项目由 [Raymi Labs](https://github.com/Raymi-Labs/yuanheng-switch) 维护，早期版本由 `nanashiwang` 维护，早期代码基于 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 二次开发。当前产品定位与交互已转向元衡 API 的桌面项目联动。

MIT License
