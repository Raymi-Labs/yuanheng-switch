# 元衡 AI — iOS 1.0.0 商店发布

App Store Connect 应用 ID：`6826138396`；Bundle ID：`com.nanashiwang.yuanhengmobile`；团队：`GY42242ZWS`。应用名称“元衡 AI”，主要语言为简体中文，用户选择首发仅美国、免费分发，审核通过后自动发布。当前仅创建应用记录和准备资料，**尚未提交审核或公开上架**。

## 构建

[iOS App Store](../../.github/workflows/ios-app-store.yml) 仅允许从 main 手动执行。使用 Xcode 26.3、Node 22、pnpm 10.12.3、Rust 1.95。版本取自 `src-tauri/tauri.ios.conf.json`；`build_number` 每次上传递增。默认只构建与核验，开启 `upload` 才使用已有 `APPLE_ID` / `APPLE_PASSWORD` 将包上传 Apple；上传不等于提交审核。

三个 iOS Secrets 分别为 `YUANHENG_IOS_CERTIFICATE_BASE64`、`YUANHENG_IOS_CERTIFICATE_PASSWORD`、`YUANHENG_IOS_MOBILE_PROVISION`。证书及描述文件匹配当前应用；本地私钥、密码、描述文件不入库，桌面 Developer ID 不变。IPA 校验通过才复制进 artifacts，旁附 SHA256 与验证 JSON；签名导出使用 app-store-connect，不能用于官网直接安装。GitHub 版本标签使用 `ios-v1.0.0`，不触发桌面 v* 或改变安卓官网分发。

`ios.project.yml` 基于 Tauri CLI 2.12.3 官方模板，仅增加 iPhone 设备族和根隐私清单，升级 CLI 时须检查模板差异。`PrivacyInfo.xcprivacy` 的文件时间戳 C617.1 用于应用容器/资源元数据，系统启动时间 35F9.1 用于 Rust 网络超时/事件计时；无指纹识别、广告追踪 SDK。该清单不代替 App Store 的数据收集申报或公开隐私政策。

## 首版说明

- 保留已有账号登录/2FA、AI 聊天、生图、额度查询、令牌管理。
- iOS 移除充值、兑换码、注册、控制台网页入口，原生层同时拒绝；无审核专用开关。
- AI 内容发送前明确征求同意，按当前账号生效；撤回同意取消本机等待并阻止后续生成。已发送任务仍可能在服务端继续处理。
- Android 的官网充值和兑换继续可用；本次不发布同版本号的新 APK。

## 提审条件与当前状态

| 项目 | 状态 |
| --- | --- |
| Apple Distribution + App Store profile | 已创建并核对，profile UUID a39ed151-0af7-4314-8d08-78eb72471e44 |
| App Store Connect 应用记录和 1.0.0 草稿 | 已创建 |
| 本地流程、类型、Rust 与签名边界检查 | 已通过 |
| iOS 正式签名 IPA / 模拟器启动 | 待本次 CI 核验 |
| Apple 上传处理 | 未执行 |
| 专用普通审核账号、额度和联系人 | 待维护者提供，不在仓库记录密码 |
| 实际功能截图、真机登录/相册/模型请求 | 待验收；不以模拟数据截图冒充 |
| 名称、简介、关键词、分类、版权、审核备注 | 已保存；简体中文，Productivity / Graphics & Design |
| 隐私政策与支持链接 | 已保存官网隐私政策与排障文档；支持页面仍需补可公开的联系方式 |
| 年龄分级 | 已填写问卷并按成人目标用户覆盖为 18+；旧系统显示 17+，不代表已核实所有模型的内容过滤 |
| 隐私数据收集声明 | 已保存已确认类型的草稿，尚未发布；上游图像/内容留存等仍需核实 |
| 第三方内容权利声明 | 待维护者确认实际授权，不代为虚构权利归属 |
| App Review | 未提交 |

现有后台 DeleteSelf 是软删除，不能声称会清除所有关联个人数据。首版仅已有账号登录；增加注册前需先落实完整账号删除与保留规则。现有公开隐私政策含账户、请求/用量与服务提供方条款，但移动端 AI 服务方、留存期限和直接联系途径仍需结合真实运营资料核对。

## 资料交接

审核联系人姓名、电话、邮箱，以及有可用额度的普通审核账号由维护者直接填写 App Store Connect 的 App Review Information；账号密码不得写进仓库。审核账号使用与普通用户相同的功能和权限，不能添加审核专用后门。商店免费分发不等于 AI 调用免费，模型调用仍消耗账号已有额度。

App Privacy 当前草稿含 User ID、Other User Content、Other Usage Data、Other Diagnostic Data。可核对的依据包括账号/令牌标识、令牌名称、模型与额度日志、请求错误日志；后端代码也有违规文本加密留证能力。这是已确认部分，不是完整公开声明。发布前还须核对实际部署配置、第三方服务商的提示词/参考图留存及用途，补全用途、身份关联和追踪回答，不能默认无收集或零留存。

Content Rights 页面要求声明第三方内容是否具备必要使用权，需由维护者基于实际服务授权确认。现有支持链接为 https://meta-api.vip/docs/troubleshooting，包含排障方法，但尚缺可直接联系的客服地址；补齐后再完成提审。截图须来自真实 iOS 界面，当前浏览器中的合成账号 UI 验收截图不作为商店截图。

参考：[Apple 审核指南](https://developer.apple.com/app-store/review/guidelines/)、[Tauri iOS 签名](https://v2.tauri.app/distribute/sign/ios/)、[Apple 账号删除要求](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion)。
