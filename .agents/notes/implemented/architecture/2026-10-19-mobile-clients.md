# Agent Note: 元衡 Android 与 iOS 独立客户端

Status: implemented

## Problem

用户需要在手机直接聊天、生图、查看余额、创建令牌、使用兑换码，并明确要求两个平台都打开现有官网充值。现有桌面应用主要配置本机 AI 工具，不能将桌面 Core、进程管理和窗口插件直接搬到手机。

## Existing capabilities and impact

已核对 [桌面账号命令](../../../../src-tauri/src/commands/yuanheng.rs)、[桌面配置](../../../../src-tauri/tauri.conf.json) 与本地 newapi 的 router/api-router.go、router/relay-router.go、controller/user.go、controller/token.go、controller/image_playground.go。后台已有登录/2FA、本人余额、可用模型/分组、令牌增删改查、统一兑换和聊天/生图接口；金额与权限仍由后台决定。移动端不复制后台业务代码。

活跃笔记检索：没有移动端归属笔记。[客户端线路选择](../../implemented/architecture/2026-10-17-client-route-selection.md)仅相邻，不改变桌面线路；[桌面工作台](../../implemented/simplification/2026-10-12-workspace-single-tool-controls.md)仅相邻，不改其工具入口。其余安装、更新、DSH、macOS 凭据笔记不被替代。

## Decision

- 新建 mobile/ 下的 React + Tauri 2 应用，共享现有技术栈但独立 Cargo、平台工程、应用标识、版本和发布流程；桌面构建不加载移动端模块。
- 本地界面通过有限 Rust IPC 访问固定元衡 HTTPS origin；会话凭据存 iOS Keychain / Android Keystore 加密存储，不写 localStorage、不传给网页。退出和账号切换使旧请求结果失效。
- 聊天支持 SSE、停止和按账号保存本机历史；生图按用户显式操作发起，不自动重试可能计费的请求；支持原生图片保存。
- 令牌只操作当前账号；创建时使用服务器返回的可选组，额度和有效期显式设置。兑换沿用后台核销，展示重复/失效/套餐待领取等真实结果。
- 两个平台充值都用系统浏览器打开固定官网 /console/topup，不把会话放 URL；返回时从后台刷新余额，不以浏览器返回判定到账。浏览器可能需要单独登录。
- 如实提供网站充值与兑换功能，不加入审核隐藏开关。iOS 上架地区、审核结论、签名和设备安装分别验收；本次实现不承诺中国区 App Store 通过，不擅自替换为 IAP 或 PWA。

## Alternatives considered

- 直接改造桌面入口：最大化代码复用，但无关 Core、托盘、子进程、桌面工具和凭据路径形成移动构建依赖；独立入口降低桌面回归范围。
- React Native / Swift + Kotlin：更直接的原生 UI，但要重新建立 UI 体系和双平台契约；当前 React/Tauri 基础适合先实现本地打包客户端。
- iPhone PWA：官网分发更简单，用户明确选择 iPhone 原生安装包，因此不采用。
- 苹果内购：可为相应商店分发提供另一支付路径，用户明确选择现有网页充值，本轮不新增另一套支付和账本。

## Validation

本地移动前端类型检查、Vite 构建与流解析/页面回归通过；Rust 测试和 clippy 通过。验证覆盖金额单位、兑换失败/待领取权益、2FA、网站充值不虚增余额、模拟聊天流与图片保存入口、会话 epoch、并发与取消、受限 URL 和错误凭据过滤。页面使用临时 IPC 模拟做窄屏和暗色浏览器验收，模拟不会进入交付代码。320/390px 浅色/暗色和 320×480 压缩高度检查通过；聊天不再用固定最小高度挤占输入区，发送按钮保持在底栏上方。构建目标包含 Safari 15 / Chrome 80；请求 ID 使用 getRandomValues，避免旧 WebView 或自定义 scheme 缺少 randomUUID，动态视口高度保留 vh 回退。独立 Mobile Build CI 已完成 Android ARM64 APK 签名，以及 iPhone / ARM64 模拟器无签名 archive 编译。下载后核对 APK 的 SHA256、ARM64 原生库、插件 dex，以及 iOS 两份 archive 的 platform、bundle ID 和版本元数据；Android 二进制 manifest 的 minSdk=29、targetSdk=37、allowBackup=false 已核对。CI 的模拟器启动检查会安装应用，直接检查 simctl 返回的宿主 PID 与可执行程序名（不依赖可能遗漏 UIKit 应用的 launchctl bootstrap 域），并在失败时同样保留截图、stdout/stderr、系统日志与新产生的崩溃报告，仍不代表真机收费流程验收。

## Consequences

桌面和手机版本、依赖、原生构建隔离，代价是 UI 实现和锁文件独立维护。mobile 自有空 PostCSS 配置，阻止工具向上搜索并加载桌面 Tailwind；CI 首次空环境暴露的依赖串用已据此修复。iOS Swift Package 使用 5.5 manifest 以声明 iOS 15；首轮原生编译已暴露并修正 5.3/.v15 不兼容。Android SDK setup 显式只安装 platform-tools，避免上游默认引用已删除的 tools 包。根 Vitest 排除 mobile 子项目，防止桌面测试初始化污染移动测试。pnpm 固定 10.12.3；本机 pnpm 11 安装错误不通过改动桌面依赖解决。

登录凭据只保存在平台安全存储；聊天历史为按账号隔离的本机文本。停止生成不承诺取消后台收费。首版不做跨设备同步或后台持续生成；图片结果需保存相册，生图模型需支持 b64_json。

本机仅有 Command Line Tools，没有完整 Xcode、Java/Android SDK 和有效 iOS 签名身份；使用 CI 编译目标。Android 使用独立持久 release keystore 并验证签名，iOS 真机无签名 archive 不能称为可安装 IPA。模拟器由 Xcode 默认签名流程生成完整 bundle 资源封印和链接时的模拟权限，打包前严格验证签名，产物命名 simulator-adhoc；真机 archive 仍保持 unsigned。仅在打包后手动追加 iOS entitlements 的模拟器包被 SBMainWorkspace 拒绝启动，因此不用该方式代替 Xcode 模拟权限处理，也不通过禁用安全存储来掩盖错误。iOS 单独配置 ASCII productName=YuanHeng，CFBundleDisplayName 仍为元衡；打包校验两者。CI 崩溃报告与 dSYM 符号化定位到 wry::wkwebview::platform_webview_version → NSBundle bundleWithIdentifier → __CFBundleCopyFrameworkURLForExecutablePath → CFRelease(NULL)，与上游中文 productName 问题 [#9178](https://github.com/tauri-apps/tauri/issues/9178)、同栈 [#13996](https://github.com/tauri-apps/tauri/issues/13996) 一致。采用平台配置隔离文件名和显示名，避免引入 WebView 依赖分叉或改动桌面/Android 名称。macOS Developer ID secrets 不视作 iOS 发行资格。真实账号、收费模型、充值到账、兑换码和相册授权仍需真机验证；不为自动验收产生费用。当前官网 status 的 Turnstile 开关关闭，如将来启用，需补人机验证流程而非绕过。
