# 元衡移动端

独立的 Android / iOS Tauri 2 客户端，首版 `0.1.0-alpha.1`。React 本地界面 + Rust 网络层 + Kotlin / Swift 原生安全存储和相册桥接；不是 SwiftUI/Kotlin 全原生界面。复用元衡账号、额度和模型服务，不包含桌面 Core、工具配置或本机代理。

## 功能

- 账号密码登录、两步验证、安全保存会话、退出与按账号隔离的本机聊天历史。
- 流式 AI 聊天、模型与分组选择、停止生成、历史删除与复制。
- 文生图、单张参考图编辑、系统相册保存；图片暂存在当前页面，重要图片请保存。
- 查看余额、创建令牌、设置额度/有效期/模型限制、查看密钥、停用/启用。
- 兑换码核销、充值额度/套餐权益结果区分；需要领取的权益跳转官网处理。
- **Android 和 iPhone 都通过系统浏览器打开现有官网充值**。返回后重新查询余额，浏览器可能需要单独登录。不会把登录 cookie 或令牌拼进网址。

## 本地开发

需要 Node.js 22、pnpm 10.12.3、Rust 1.95。Android 需要 Java 17、SDK 36、NDK 28.2.13676358；iOS 需要完整 Xcode（仅 Command Line Tools 不够）。

```sh
cd mobile
pnpm install --frozen-lockfile
pnpm test
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm tauri android init --ci
pnpm tauri icon src-tauri/icons/icon.png
pnpm android:dev
# macOS + Xcode
pnpm tauri ios init --ci
pnpm ios:dev
```

`pnpm dev` 只能预览界面；登录、请求、相册需在 Tauri 容器运行。前端不含演示账号或假余额。浏览器验收使用临时 IPC 模拟，不能替代真机和真实后台验收。独立 `pnpm-workspace.yaml` 和 lockfile 保持桌面依赖不变。

## 构建与分发

[Mobile Build](../.github/workflows/mobile.yml) 独立验证两端，并使用 `mobile-v*` 版本标签，避免触发桌面 `v*` 发布。

- Android：首版 Android 10+、ARM64 APK，首版 versionCode=1（后续 alpha 必须递增）、固定 release keystore 签名，校验签名和 16 KB zip 对齐。Secrets：`YUANHENG_ANDROID_KEYSTORE_BASE64`、`YUANHENG_ANDROID_KEYSTORE_PASSWORD`；PKCS12 alias 为 `yuanheng`。必须保留同一签名密钥，后续更新才能覆盖安装。下载后核对 SHA256，在浏览器安装权限中允许当前下载来源。
- iOS：CI 编译 iPhone 和 ARM64 模拟器 archive。`*-device-unsigned.xcarchive.zip` **未签名，不能直接安装**；模拟器 archive 用于 Xcode 模拟器。真机安装 / TestFlight / App Store 分发仍需有效的 iOS 开发者签名、匹配 `com.nanashiwang.yuanhengmobile` 的描述文件以及选定的发行渠道。现有 macOS Developer ID 证书不能替代这些条件。
- 本轮按用户要求保留网页充值。发行地区和苹果审核是独立事项；没有审核隐藏逻辑，也不将测试构建说成已上架。普通中国区 iPhone 不能把网站上的 unsigned archive 当作 APK 安装。

## 接口与数据边界

Rust 只允许固定 `https://meta-api.vip` 和操作白名单；不接受前端任意 URL、不跟随 HTTP 重定向。账号请求复用后台 session + New-Api-User，生图临时 key 只留在 Rust。Android 会话用 Keystore AES/GCM 加密且禁止系统备份；iOS 使用 ThisDeviceOnly Keychain。聊天历史是按账号隔离的设备本地文本，用户可在历史页删除；退出不会清空历史。

后台登录若启用 Turnstile，人机验证需要另行接入，首版会显示后台拒绝，不能绕过；开发时官网状态显示该开关关闭。聊天和生图取消仅停止客户端等待，不保证服务端停止计费，不自动重试收费请求。生图首版要求模型支持 OpenAI images 的 `b64_json` 返回。App 退到后台可能暂停任务。

## 当前验收边界

类型、前端构建、流程/流解析测试和 Rust 状态/边界测试在本地执行；原生目标通过 CI 单独确认。真实账号登录、模型收费请求、充值到账、兑换核销、相册授权和软键盘表现仍需真机验收；测试不自动创建账号、扣款或使用真实兑换码。
