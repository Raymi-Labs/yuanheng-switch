# Agent Note: iOS 首发采用无购买入口的 App Store 分发

Status: implemented

## Problem

用户要求直接准备正式上架，接受 iOS 首版暂不支持充值。现有 alpha 在我的、兑换成功、注册和账号网页跳转中可进入购买流程；无签名 archive 和模拟器启动不足以证明商店发布完成。

## Existing capabilities and impact

复用 mobile/ 的账号、聊天、生图、令牌、余额、原生安全存储，以及 GitHub macOS 构建流程。已核对 transport 的固定请求白名单和现有后台账号删除接口、公开隐私政策。新 Apple Distribution 身份已核验并保存在独立 iOS 加密 Secrets；与桌面 Developer ID 分离。

活跃笔记审计：[移动端架构](../../implemented/architecture/2026-10-19-mobile-clients.md)部分重叠，本篇取代其中 iOS 保留网页购买的决定，Android 不变；[安卓官网分发](../../implemented/process/2026-10-19-android-website-delivery.md)仅相邻，继续独立管理 APK。其余签名笔记属于桌面，不被替代。

## Decision

- iOS 使用固定平台能力关闭充值、兑换码与通向购买的注册/控制台跳转；原生白名单同时拒绝，所有用户相同，不使用审核开关。
- 保留已注册用户的原有服务权限；补齐 AI 第三方数据发送同意和可撤回同意，复用后台，不自行创建支付系统。账号删除审计发现现有 DeleteSelf 仅软删除，故不将它包装成彻底删除个人数据；首版不含任何账号创建入口，后续若增加注册，必须先完成数据删除契约。
- iOS 独立版本配置、App Store 描述文件、签名和上传构建；正式包必须核对身份、应用标识、平台、版本和嵌入描述文件。不将上传、TestFlight 或 GitHub Release 称为 App Store 已上架。
- 用户确认首发仅美国，应用免费；审核账号、隐私信息由真实资料决定，不填写虚假资料。商店资料和真机验收缺口明确记录。
- 用 Tauri CLI 2.12.3 官方 XcodeGen 模板固定 iPhone 设备族并在根目录复制隐私清单；本地模板增加维护成本，但避免依赖临时修改生成项目。隐私清单只声明 Rust 运行时的应用容器文件元数据和单调时钟用途，不将其当作服务器数据收集声明。

## Alternatives considered

- 保留网页充值：最少改动，但用户已同意首版去除，且限制首发商店范围。
- 首版接入 IAP：可建立商店内购买路径，但增加支付和额度核对范围，不属于用户当前首发目标。
- 继续仅做 Ad Hoc：可以先测真机，但需要登记设备，不能替代用户要求的正式上架。

## Testing

首轮云端构建在 iOS 初始化阶段发现模板路径按 mobile 工作目录解析，而不是配置文件目录；已将 template 改为 src-tauri/ios.project.yml。失败发生于原生构建和上传前，未产生已上传版本。

云端原生构建还发现 DEVELOPER_DIR 不能约束 cargo-mobile 的全部子进程：日志显示它调用默认 Xcode 16.4，虽然预检查显示 26.3。流程现在同时在临时 runner 上用 xcode-select 选择 26.3，并在最终 IPA 中核对 DTXcode；旧 SDK 产物被校验拦截，未上传 Apple。

本地前端流程与流解析、TypeScript/Vite 构建、Rust 状态/请求边界测试与 clippy、签名元数据拒绝错误平台/团队/证书/过期和调试权限的测试通过。iOS 原生签名构建及模拟器启动在 GitHub macOS runner 上独立核验；结果记录到 mobile/app-store/README.md，未完成时不能宣称成功。本机 Node 25 的实验 Web Storage 与 jsdom 冲突，本地测试通过 NODE_OPTIONS=--no-experimental-webstorage 运行，CI 继续固定 Node 22。

## Consequences

iOS 界面及原生层不提供购买/兑换入口，Android 保留原功能；AI 未同意不发送内容、撤回后阻止后续请求。Apple Distribution 和 App Store profile 已核对团队、App ID、证书、有效期及无设备限制，独立存放于 iOS Secrets。App Store Connect 应用记录已创建，签名包、上传处理、提交审核和公开上架是四个不同状态。

移除购买入口不能保证审核通过；还需审核账号、商店截图、隐私声明和内容安全资料。用户目前无法连接 iPhone，不能宣称已完成真机验收。未擅自创建付费请求、测试额度或操作真实账号删除。
