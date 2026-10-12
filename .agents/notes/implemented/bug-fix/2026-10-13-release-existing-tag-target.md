# Agent Note: 已存在正式标签的 Release 创建目标

Status: implemented

## Problem

v0.1.77 三平台产物均成功，但集中发布创建草稿收到 HTTP 403。任务实际有 Contents:write；标签构建期间 main 新增工作流，创建时冗余的 target_commitish 指向旧提交，触发 GitHub 额外工作流权限检查。

## Existing capabilities and impact

[集中发布器](../../../../scripts/desktop-release.mjs) 已独立解引用并核验远程标签 SHA，正式版本要求已有标签；[恢复入口](../../../../.github/workflows/finalize-desktop-release.yml) 可绑定原 run、提交、公告和产物，不必重新编译。已有 macOS 签名与 R2 笔记各自负责安装包身份和分发，不拥有草稿创建的 API 参数。

[GitHub 官方说明](https://docs.github.com/en/rest/releases/releases#create-a-release) 明确：target_commitish 相对默认分支改变工作流时需 Workflows:write；已有 tag 时该字段不决定标签位置。复用已有标签校验和发布器，不添加凭据或权限。

## Decision

正式标签创建草稿省略 --target，保留 --verify-tag 和独立 SHA 校验；手动分支预发布仍显式使用构建 SHA 创建标签。正常与恢复入口共用该行为。校验失败时保持无远端写入。

## Alternatives considered

- 使用带 workflow 权限的个人令牌：能够操作旧 target，但正式标签不需要该字段，不值得引入额外长期凭据。
- 手工预建草稿：可解救当前版本，但下一次并行提交工作流后仍会失败，选择修复公共发布器。

## Verification

集中发布与恢复来源的 18 项回归通过，新增模拟默认分支工作流前进后的 403 边界；确认正式版不传 target、仍校验远程标签且通过全部资产验证，手动预发布继续指定构建 SHA，错误标签在任何写入前拒绝。Node 语法与 TypeScript 检查通过。v0.1.77 原 run 38283419437 三平台全部成功，Intel 装订重试第二次成功，app/updater/DMG 均通过最终公证和 Gatekeeper；首次收尾创建草稿 403，恢复沿用原产物，未重新打包或改标签。

## Consequences

正式发布不再对已有标签使用冗余提交目标；主分支在构建期间更新工作流不会因此要求额外令牌权限。Release 元数据 target_commitish 可以保留分支名，产物归属继续由独立标签 SHA 和 receipt 校验，不将该元数据当作构建提交证明。预发布创建新标签仍需要提交目标，相关权限限制仍适用。
