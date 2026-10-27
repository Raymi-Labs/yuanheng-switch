# Agent Note: 公司仓库迁移与客户端下载连续性

Status: implemented

## Problem

元衡项目需要迁入 Raymi-Labs。客户端下载包含安装包入口、自动更新、R2 分发、历史 Release 和官网备用链接；只推送 Git 不能保留发布附件和既有签名配置。

## Decision

使用 GitHub 仓库转移保留仓库身份、完整历史、Release、Actions Secrets 与旧 URL 跳转；新主仓库为 Raymi-Labs/yuanheng-switch。本地 origin 和现行维护入口同步更新。保留应用标识、更新公钥、用户目录、安装包名称及 meta-api.vip / R2 路径。

新版本生成公司仓库地址。下载器识别新旧两个精确 GitHub 路径并返回新仓库候选；R2 历史补发接受原清单中精确旧仓库 URL，不改写已发布资产。官网桌面及 Android 的备用链接同步到新仓库。组织要求完整 SHA 和限定 Actions 来源，迁移前核对并适配现有发布依赖，不能以降低组织保护换取通过。

## Existing decisions

- [R2 分发](../../implemented/architecture/2026-10-13-r2-desktop-delivery.md)：部分重叠，保留整包摘要、不可变对象和最后发布清单的顺序。
- [三源下载](../../implemented/architecture/2026-10-17-direct-download-selection.md)：部分重叠，保留择源、Range 续传及原公钥验签；本篇拥有仓库迁移兼容边界。
- [集中发布标签权限](../../implemented/bug-fix/2026-10-13-release-existing-tag-target.md)：无决定变化，继续验证标签 SHA 并复用现有发布器。

## Alternatives considered

- 新建组织仓库并推送 Git：保留个人仓库容易回退，但历史 Release、附件与签名 Secrets 不随 Git 复制，旧客户端还会继续读取旧仓库 latest；完整转移更符合下载连续性。
- 仅依赖 GitHub 重定向：可以保住旧客户端，但后续分发校验的仓库白名单与公司 Actions 来源限制仍会失败，需要同步源码和工作流。

## Verification

GitHub 仓库 ID 1307689660 保持不变，新旧 API 地址均解析到 Raymi-Labs/yuanheng-switch。转移前后 97 个 Release、838 个附件的 ID、名称、大小和摘要逐一一致；17 个仓库 Secrets 和 1 个 Variable 的名称完整保留，没有导出密钥。所有外部 Action 固定到核验过的完整 SHA；组织允许列表只新增用户明确批准的 7 个固定提交，保留原来源限制及 SHA 要求。

本地 1043 项前端测试、类型检查、格式检查及 renderer 构建通过；11 项 Rust 下载测试通过（真实下载测试单独执行），12 项 R2 和 6 项镜像恢复测试通过。actionlint 通过。官网下载辅助函数测试、格式检查、ESLint、完整前端构建与笔记检查通过；本机缺少 /usr/bin/chromium，网站构建跳过了预渲染。正式签名构建、GitHub Release、R2/平台分发与官网部署需分别核验，不能由源码提交替代。

## Consequences

仓库转移保留发布历史和旧客户端入口；新版本直接使用公司地址。组织默认分支要求通过 PR 合入，后续升级 Action 必须同步核验完整 SHA 和允许列表。旧命名空间不得重新创建同名仓库，以免破坏 GitHub 重定向。保留历史清单中的旧 URL，不能将迁移当作覆盖不可变版本的理由。应用标识及公钥不随公司仓库改名，避免本地数据与更新链断开。
