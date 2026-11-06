# Agent 推理等级与实际生效边界

工作台和工具管理共用[工具能力表](../../src/data/agent-reasoning-controls.json)，与账号模型目录声明的档位取交集。模型支持不等于工具能传递；未适配的组合显示说明，不给出假成功。只修改本地配置不发送模型请求。

| 工具 | 写入位置／传输方式 | 生效与限制 |
| --- | --- | --- |
| Codex / Codex Desktop | 既有`model_reasoning_effort`与会话桥接 | 官方账号模式不接管；沿用原有隔离和启动规则 |
| Claude Desktop | 既有本地代理按协议写入`output_config.effort`、`reasoning.effort`或`reasoning_effort` | 保留原路由规则 |
| Claude Code | 托管provider的`env.CLAUDE_CODE_EFFORT_LEVEL` | 当前官方程序包含low/medium/high/xhigh/max；环境变量具有自己的优先级，工具内改为auto不一定覆盖它。应在元衡改回auto后重启工具 |
| Gemini CLI | `modelConfigs.customAliases[模型].modelConfig.generateContentConfig.thinkingConfig.thinkingLevel` | 当前接通Gemini 3离散档位；具体可选档位还取模型目录交集。Gemini 2.5用数值budget，本轮不编造低/中/高到token数的映射；非Gemini模型不把GPT effort塞进Gemini参数。旧budget与level互斥，保留includeThoughts等其他字段 |
| Grok Build | 所选`model.<id>.supports_reasoning_effort`及`reasoning_effort` | 不改其他模型条目，不改聊天后端 |
| OpenCode | 所选模型`options.reasoningEffort` | 保留现有OpenAI-compatible provider；原生agent/session variant可覆盖默认 |
| OpenClaw | 所选模型`agents.defaults.models[provider/model].params.thinking`；provider模型声明推理能力 | `none`对应原生off；仅在模型声明支持none时声明off→none映射。工具会话/agent设置可优先于此模型默认 |
| Hermes | `agent.reasoning_overrides[模型]`字典形式enabled/effort | **Hermes按模型名匹配，同名模型经其他供应商使用时也可能受影响**；不是账号级或provider级隔离。该原生语义明确提示，保留原字段供恢复 |
| WorkBuddy | `models.json`的`supportsReasoning`、`reasoning.supportedEfforts`和所选模型`reasoning.defaultEffort` | 当前官方包接受minimal/low/medium/high/xhigh/max，不宣称none/ultra能传递。会话及全局reasoningEffort/alwaysThinkingEnabled优先于模型默认；元衡不覆盖其全局设置 |
| DSH | desktop/web托管profile的`agent-default-model.config.reasoningEffort`，`llm-pi-ai`模型的`reasoningEfforts`声明 | `none`对应off，精确wire值来自声明；只替换已有元衡托管块，沿用hash与恢复机制。旧会话可保留自己模型和effort |
| Accio | 已有配置profile的reasoning，经现有本地路由补`reasoning.effort` | 只作用于元衡选中的模型且原请求没有显式reasoning；不覆盖原生选档、不污染其他模型；保留macOS平台边界 |
| TRAE | 原有辅助配置向导 | 没有已验证的外部自动写入入口；明确在工具内核对，不生成假设置或宣称已应用 |

## 自动与恢复

“自动”不是强制低档或关闭思考：删除本次元衡显式设置，或者恢复接管前的原生值。原生工具自身仍可能有默认档位、环境变量和会话覆盖。

Gemini、OpenClaw和Hermes的额外字段有本地归属记录：保存原值、实际写入值及字段路径；切模型/自动恢复旧字段。发生外部修改时拒绝覆盖并提示核对。配置失败尝试恢复本次推理修改，恢复失败不会被吞掉。解绑/恢复工具时按同一归属记录恢复；不删除用户其他设置。

既有Claude/Grok/OpenCode配置采用原provider投影及备份机制。WorkBuddy从实际模型条目回读等级，DSH随配置记录保存等级，不再固定报告auto。此状态确认的是配置，不证明上游接受或实际用了多少推理token。

## 依据与验证范围

- [Gemini CLI 模型配置](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/generation-settings.md)及`modelConfigService`：别名必须可解析到实际模型，不能只写thinkingConfig形成空别名。
- [Grok Build 配置参考](https://docs.x.ai/build/settings/reference.md)。
- [OpenCode 模型设置](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/models.mdx)。
- [OpenClaw thinking](https://github.com/openclaw/openclaw/blob/main/docs/tools/thinking.md)。
- [Hermes 配置样例](https://github.com/NousResearch/hermes-agent/blob/main/cli-config.yaml.example)。
- [DSH默认模型源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-default-model/src/index.ts)及[pi-ai配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md)。
- WorkBuddy已安装官方发行包的`models.md`与`ModelConfigAgentRunInterceptor.configureThinkingSettings`确认实际消费字段和级别顺序；Claude Code已安装官方包确认effort环境变量及接受档位。仅静态读取程序文件，没有读取账号配置/聊天记录或运行它们。

测试使用合成模型、凭据和隔离目录，涵盖两处UI、实际原生配置输出、高→低→自动、切模型、错误档位、外部编辑、失败回滚及Accio实际请求补缺省边界。未向真实模型发请求，未声称各Agent新旧版本和上游付费推理全量实测。
