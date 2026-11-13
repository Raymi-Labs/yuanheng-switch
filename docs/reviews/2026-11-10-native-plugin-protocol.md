# Codex 原生插件协议与验证

## 依据

- 官方使用说明：https://learn.chatgpt.com/docs/plugins?surface=app
- 官方打包说明：https://developers.openai.com/plugins/build/plugins
- 2026-11-10读取：API key登录可安装部分支持插件，某些OAuth流程仍不可用；本地市场与公共目录分离；安装不会授予外部权限。
- 本机CLI 0.167.0的plugin命令帮助与app-server生成JSON Schema；桌面内置引擎0.166.0-alpha.5.1实际隔离调用。未复制CodexPlusPlus代码、插件缓存或素材。

## 实现契约

管理调用只有initialize、plugin/read/install/uninstall、config/read/value/write和skills/list；短生命周期进程、每请求30秒、单操作90秒、每行4MiB及整次8MiB响应限额；静默拒绝原生审批请求，不自动授权。关闭远程目录开关仅作为该管理子进程参数，不写入用户设置。

原生市场存放`.agents/plugins/marketplace.json`，包位于同一根下`package`；使用内容摘要派生的自有市场名，不使用OpenAI保留名。原生缓存和enabled由原生接口维护；配置写入带用户层expectedVersion。配置内容变化触发版本拒绝；仅注释变化不一定改变原生语义版本，安装计划另使用文件字节摘要保护确认阶段。

Package portable字段与兼容overlay按官方格式识别；扫描拒绝路径逃逸、符号链接、特殊文件、凭据文件、无效身份与过大内容，保留脚本执行权限并显示脚本风险。检查市场JSON及已安装副本，防止来源改写和用户修改被覆盖。摘要是完整性标识，不冒充作者签名。

## 本机隔离证据

- 无真实auth.json、模拟第三方provider地址为127.0.0.1不可用端口，不发送turn/start。
- 桌面内置引擎完成注册、安装、plugin/read、skills/list、禁用/启用、卸载/重装；模型provider保持不变。
- 配置实际字段被外部修改后，旧expectedVersion写入拒绝并保留原文件。
- 独立合成MCP样本由桌面引擎发现并执行ping，返回SYNTHETIC_MCP_OK；这是直接工具调用，不证明模型自主选工具或正在运行GUI聊天已加载。
- 可复现命令：`YH_PLUGIN_TEST_BINARY=<本机引擎> cargo test --manifest-path src-tauri/Cargo.toml --lib services::native_plugins::tests::native_roundtrip -- --ignored --test-threads=1`；`python3 scripts/test-native-plugin-mcp.py --engine <本机引擎>`。只在显式本机验收使用，不将个人凭据加入CI。

## 对抗性边界

不复制官方登录、伪造订阅、绕过插件账号要求。既有Skills/MCP继续由原入口管理；本地插件管理不改伙伴提供商ID、模型、速度、平台令牌或历史。远程来源/社区审核、其他Agent原生插件Adapter、真实OAuth与Windows原生运行是后续工作，不作为本批完成声明。
