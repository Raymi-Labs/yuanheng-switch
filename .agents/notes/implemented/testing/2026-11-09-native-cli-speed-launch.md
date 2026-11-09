# Agent Note: 原生终端验证速度启动而非仅协议模拟

Status: implemented

## Problem

已有WebSocket假进程及app-server协议测试不能证明官方TUI接受启动命令。用户要求安装后直接选择并启动，必须实际运行原生终端确认链路。

## Decision

显式设置YUANHENG_NATIVE_CODEX后运行opt-in Rust测试：隔离HOME/CODEX_HOME及合成账号、内存数据库，真实官方TUI经元衡WebSocket桥接到真实官方app-server，再到本机HTTP桩；不使用个人配置或收费模型。PTY驱动仅信任测试新建的临时目录，不改用户真实workspace权限。

该测试发现官方0.166.0-alpha.5.1拒绝带路径的remote地址。生产票据改由官方remote-auth-token-env参数提供Bearer认证，URL只包含loopback host/port。票据仍120秒、单次消费、连接级隔离；命令环境赋值分别使用POSIX及PowerShell语法，不向任何外部服务传票据。

## Alternatives considered

- 继续只依赖协议测试：快，但无法发现TUI命令参数校验，拒绝。
- 修改官方程序接受路径：维护成本高且无必要，拒绝。
- 使用官方原生认证参数并实际跑TUI：最小兼容改动，采用。

## Verification

失败证据为invalid remote address，修复后原生终端显示UltraFast×6，业务模型请求一次且service_tier=ultrafast。原生TUI还自动生成单独会话标题请求，同样携带ultrafast；测试分别识别标题与业务请求，不把标题误认为重试，也不承诺每条消息只计一次上游调用。测试18秒有界，终止并等待PTY子进程、桥接子进程和HTTP桩，临时配置自动清理。

## Consequences

依赖本机官方二进制的测试默认忽略，显式命令才运行，不下载或修改官方程序。Mac原生TUI通过，不等同Windows真机点按钮或生产渠道结算。Windows命令使用既有PowerShell封装，仍交CI构建验证；支持旧版CLI的边界取决于官方remote-auth-token-env支持。准备v0.2.12沿用签名发布流程，包含伙伴v0.2.11修复。
