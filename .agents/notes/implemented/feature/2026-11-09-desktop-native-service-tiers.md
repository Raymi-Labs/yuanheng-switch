# Agent Note: 桌面Codex原生速度档位

Status: implemented

## Problem

用户明确桌面Codex为目标，移动alpha.5属于范围错误且已要求撤回。现有桌面生成的Codex目录将service_tiers强制清空，无法显示后端授权档位。

## Decision

复用桌面/CLI受管Codex目录和Core转发。在配置时通过本人会话查询模型/分组能力，只有有效2/6倍率返回才生成原生ModelServiceTier条目（priority Fast×2、ultrafast UltraFast×6），默认标准，不在配置写付费全局档位。切账号/组清除旧能力；失败仅生成标准。原生对话负责选择/保存/重试快照，Core按受管provider账号、组、模型能力检查并在最终出站体上拒绝改档/丢档；付费请求不由Core整流重试或故障切换。

官方文档URL两次返回403，未据此猜测；本机官方Codex二进制隔离导出schema证明ModelServiceTier的id/name/description以及turn/start的serviceTier/serviceTierForTurn。独立CODEX_HOME、合成模型目录和本地HTTP验证model/list返回Fast/UltraFast，三次原生turn实际发出省略/priority/ultrafast。无个人登录/配置读取，无付费请求，进程退出。协议证据不冒充所有旧版GUI菜单验收。

## Alternatives considered

- 全局service_tier写入配置：简单但跨新对话收费污染，拒绝。
- 模型别名模拟档位：可跨旧Agent，但改变模型标识且新增映射，原生已有独立档位字段无需采用。
- 原生service_tiers投影与出站检查：复用已有能力，保持真实模型ID，采用。

## Verification

本人能力查询不暴露Key；未知/禁用能力不提供付费条目；模型/组/账号隔离；标准不注入付费值；付费字段原样到Meta，转换或覆盖不得升降档；Core不自动重发。原生合成请求、Rust目录/转发测试通过，进程归零。其他Agent未验证不泛称支持。

官方codex-cli 0.166.0-alpha.5.1实际app-server使用独立HOME/CODEX_HOME、无真实凭据和loopback假模型，完成6个请求：标准省略、priority、单轮ultrafast、随后继承原priority、明确default、全新线程标准；每轮仅一次传输，退出后子进程/服务/临时目录清理。Core真实本地HTTP回归确认ultrafast完整到达上游、503后即使还有provider也只一次请求。目录测试确认原生两个档位且默认null，账号/组/模型/倍率异常及出站删改拒绝。Codex相关554项通过、2项已有忽略；桌面相关76项通过。首次发现新增零重试字段破坏历史alias归属识别，修复仅精确接受生成的0值，保留用户非零改动，随后账号模式往返回归通过。

GUI/Core编译、Clippy与前端类型/生产构建已验证。新增schema标识使旧配置提示需重新应用；能力查询最多4并发/单次3秒/整批10秒、响应64KiB，失败不继承旧账号/组的付费能力。没有全局轮询，目录更新通过明确重新配置。取消/失败是否收费仍按服务端日志，不以响应回显作为加速证明。

## Consequences

付费请求失败虽然不再尝试下一provider，仍按原错误分类释放半开探测名额/记录供应商故障，并计入请求失败统计；局部HTTP回归确认503只有一次出站，同时失败计数及熔断器失败计数均为1，防止提前返回绕过资源清理。该补验与Clippy通过。

能力查询User-Agent使用目标Codex客户端范围（codex_cli_rs/yuanheng-desktop），与服务端DetectClient对codex_cli_rs前缀规则一致，避免通用管理UA把仅允许Codex的渠道漏掉；仍使用本人会话且无权限扩大。局部HTTP桩核对client scope/用户头及64KiB响应上限，循环服务关闭。

补验官方运行时对503的自动重试策略：共7次合成请求，最后付费priority返回503仍只有一次出站，原生进程/HTTP/临时配置清理完成。最终Codex回归554通过、2忽略，相关前端52通过，Clippy lib/bins通过。仅客户端内部与原生协议验证，不宣称实际GUI点击或真实Muze加速/计费验收。发布版本准备0.2.8，桌面安装包构建/公证/分发结果另行核验。

模型目录是配置时快照，实际能力变更最终由Meta服务端再次校验；旧目录需在元衡重新应用并重开Codex刷新。官方GUI对动态菜单的显示依赖版本，不能仅凭schema保证所有版本相同。桌面账号控制台分组与原生模型菜单职责保持分离。真实2/6计费验收仍未运行。
