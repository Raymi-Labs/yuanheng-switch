# Agent Note: Meta API 应用名称与旧安装兼容

Status: implemented

## Problem

用户要求桌面、Android 和 iOS 应用统一叫 Meta API，官网为 meta-api.com。旧桌面名称参与 Windows 安装注册表和分发文件名，直接全局替换会导致重复安装与下载失败。

## Existing capabilities and impact

复用现有五语言 UI、Tauri 打包、集中发布器和手机构建。公司迁移笔记与本改动部分重叠，继续遵守[身份和下载兼容](../../implemented/process/2026-10-27-raymi-repository-migration.md)；[iOS 发布](../../implemented/process/2026-10-23-ios-app-store-release.md)继续拥有签名、商店审核边界。没有新服务或新数据迁移。

## Decision

应用显示名称改为 Meta API，平台服务称谓仍可使用元衡 / YuanHeng API。桌面 productName 改名，发布器继续输出旧 YuanHeng.Desktop 文件名供官网与 R2 使用。Windows 使用与锁定 CLI 2.8.1 一致的 NSIS 模板，只保留旧安装注册表和默认目录，并按目标检查迁移本应用快捷方式。升级 CLI 时须同步审查模板差异。

macOS 更新器去掉归档顶层目录并替换当前应用路径，因此自动更新可以保留旧目录名而内容和菜单显示新名；手动安装新 Meta API.app 时用户应退出并移走旧应用副本。自动启动注册名、应用 ID、Keychain、数据库、deep link、Core 和更新公钥保持兼容。

Android 保留包名和证书，递增 versionCode；iOS 保留 ASCII 构建产品名称 YuanHeng，通过 CFBundleDisplayName 显示 Meta API，商店构建号递增。手机官网导航使用 .com，账号 API 保留 .vip。既有 iOS 商店条目名称和审核状态不由 Git 构建自动修改。

## Alternatives considered

- 只改网页标题：改动最小，但系统菜单、安装和手机桌面继续显示旧名，无法满足统一应用名称。
- 全局替换内部标识与附件：命名彻底统一，但影响凭据、旧安装发现和官网分发；本次以显示名与稳定技术身份分离。
- 保留 Windows productName 并用安装钩子改快捷方式：无需模板副本，但安装向导和卸载显示仍需补丁且前期升级识别难统一，选用锁定版本的小差异模板。

## Verification

桌面 1,203 项前端测试、类型、格式与 renderer 构建通过；发布管线 21 项覆盖新产品名和历史产物恢复，R2 12 项、macOS 包校验 11 项通过。手机 40 项前端测试、构建、15 项 Rust 测试与 clippy 通过；桌面 clippy 通过。NSIS 模板与锁定 CLI 原版差异仅包含旧安装身份及归属快捷方式处理。首次测试使用本机 Node 25 时受其全局 localStorage 实现影响，关闭实验 Web Storage 后测试全部通过，CI 沿用 Node 20/22。

三平台正式打包、Android 签名包及 iOS 模拟器归档由 GitHub Actions 分别核验，发布结果独立记录。

## Consequences

Windows 安装模板需随 CLI 维护；CI 打包不等于旧 Windows 真机覆盖安装。iOS 归档成功不等于公开上架。macOS 自动更新后目录名可能保持旧名。
