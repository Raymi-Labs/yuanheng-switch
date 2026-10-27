# YuanHeng Desktop — Project Instructions

主仓库为 `Raymi-Labs/yuanheng-switch`，常规提交和发布使用该仓库。原 `nanashiwang/yuanheng-switch` 由 GitHub 自动重定向，不要重建同名仓库。应用标识、签名公钥和分发域名保持兼容。迁移约定见 [发布说明](docs/release-announcements.md#公司仓库与旧版本兼容)。

Read README.md and the existing architecture/build documentation relevant to the task.


## Capability review and decision notes

- Start from the business outcome, not the first page or implementation mentioned. Use [the capability map](docs/FEATURE_MAP.md), then verify current UI/entry points, routes, permissions, services and data sources for the affected scope.
- Before implementation, briefly describe existing capabilities, real alternatives, reuse/extension/migration choices and affected entry points. Explain why an independent new implementation is needed. Do not expand small fixes into unrelated rewrites.
- For non-trivial behavior, architecture, contract or tooling decisions, use the [project-local Skill](.agents/skills/write-notes-like-deepseek/SKILL.md) and [workflow guide](docs/AGENT_NOTES.md). Search active notes first: `rg --hidden --glob '!**/archived/**' '<topic>' .agents/notes`. Update an existing owner note when its rationale still holds.
- New decisions start in proposed; move and rewrite them as implemented only after implementation and relevant verification, in the same commit as the change. Record genuine alternatives and costs; do not invent historical rationale or create notes for purely mechanical edits.
- User instructions and existing project rules take precedence over imported Skill defaults. Continue within existing authorization without repeated approval gates; ask only for material unresolved decisions or actions outside that scope. This workflow does not grant deployment, release or cross-project write permission.
- Validate complete affected user flows and adjacent entry points, including shared definitions, filtering, permissions and failure behavior where relevant. Structural note checks do not prove design quality or guarantee all important decisions were recorded.
- Update affected capability-map entries and notes alongside code. Run `bash .agents/verify-notes.sh` plus the existing checks required for the change. Existing architecture, language, build, release and subdirectory rules remain in force.

Project-specific context: pnpm remains the application package manager. Existing Tauri/Rust checks and signed release workflows remain unchanged.
