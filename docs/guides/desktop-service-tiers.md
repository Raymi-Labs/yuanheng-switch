# Codex 桌面原生速度档位

此功能针对元衡配置的Codex桌面端（以及独立Codex终端profile），不在安卓聊天或桌面全局配置中开启付费档位。

在元衡选择账号、分组和模型并重新应用配置后，客户端查询本人 `/api/user/service-tiers`，把实际返回的Fast×2/UltraFast×6写入Codex模型目录的`service_tiers`。重新打开支持动态serviceTiers的Codex后，使用原生模型参数里的速度选项；分组仍在元衡选择。未返回能力、未部署接口或渠道关闭时仅标准，不根据模型名或渠道1657硬编码。

默认配置为标准。具体对话及单次发送的档位由Codex原生机制控制，与推理强度分离；不写入付费的全局默认。Fast请求为priority，UltraFast为ultrafast，标准省略service_tier。倍率是费用而非速度保证；实际扣费由Meta服务端处理。

本机Core核对账号、模型、分组能力快照并检查最终出站字段；被参数覆盖/转换改档或改模型时拒绝发送。付费请求Core不自动整流重发、不切其他provider；托管Codex provider的请求及断流自动重试均设为0。用户手动重试由原生会话保留所选档位，Meta再次确认路由与计费。能力目录是配置时快照，过期支持信息可能仍显示，实际不可用不会静默降档；在元衡重新应用配置并重开Codex可更新目录。

## 验证边界

本机官方codex-cli 0.166.0-alpha.5.1的app-server schema支持ModelServiceTier `{id,name,description}`、turn/start的serviceTier与serviceTierForTurn。隔离CODEX_HOME/合成目录/loopback服务验证：标准省略字段、Fast=priority、UltraFast=ultrafast、单轮覆盖不改变线程原档位、新线程标准。未改官方程序、未读取个人会话、未调用付费模型。可重复脚本：`node scripts/test-codex-service-tiers.cjs <官方Codex可执行文件绝对路径>`。

该验证不等同所有旧版官方GUI菜单验收；旧版可能忽略动态档位目录，需要更新官方客户端。其他Agent的原生速度入口尚未验证，不泛称全Agent支持。官方文档站读取返回403，以上结构以官方运行时实际导出和出站证据为准，不把推测当作官方文档结论。

安卓alpha.5属于此前误交付，GitHub已改草稿、R2源对象已删除；部分CDN缓存仍需清除，已安装的手机版本无法远程卸载。alpha.4保持可用。
