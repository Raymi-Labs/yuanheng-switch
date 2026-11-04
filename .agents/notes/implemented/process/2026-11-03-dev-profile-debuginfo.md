# Agent Note: 本地 debug 构建只保留行号调试信息

Status: implemented

## Problem

2026-11-03 开发机磁盘只剩 14G，其中 `src-tauri/target/debug` 占 251G（`cargo clean --profile dev` 报告删除 260,971 个文件、367.3GiB 逻辑大小）。清理后约 1.5 小时内，日常 `cargo test` 又让它涨回 5.2G。原因是 cargo 只追加不回收：近 60 天 215 个提交中有 88 个改动 `Cargo.lock`，依赖树 777 个 crate，每次版本或 feature 变化都会生成新哈希产物，旧产物保留。Cargo.toml 此前没有 `[profile.dev]`，所有产物和每个集成测试二进制都带完整 DWARF。

## Existing capabilities and impact

只影响 `src-tauri` 的 dev/test profile：本地 `pnpm tauri dev`、`cargo test` / `cargo clippy` 以及 CI 中 ci.yml 的 `cargo test` / `cargo clippy`。`[profile.release]` 不变，签名候选、正式包和更新器产物不受影响。`mobile/src-tauri`、`mobile/native` 是独立 crate，不继承此配置。已检索 active notes，没有关于 cargo profile 或调试信息的记录。

## Decision

`[profile.dev]` 设 `debug = "line-tables-only"`，`[profile.dev.package."*"]` 设 `debug = false`。本项目代码保留文件和行号，panic backtrace 与测试失败栈仍可定位；第三方依赖不生成调试信息。需要 lldb 查看局部变量时，单次构建临时加 `CARGO_PROFILE_DEV_DEBUG=true`，不改文件。

## Alternatives considered

- **全局 `~/.cargo/config.toml`**：一处覆盖本机全部 Rust 项目，但不进仓库，其他协作者和 worktree 得不到同样配置；本仓库的问题需要随代码走。
- **`debug = false` 全关**：体积最小，但 panic backtrace 失去行号，排查测试失败代价过高。
- **只靠定期 `cargo clean` / `cargo-sweep`**：不改配置，但只回收旧产物，单次构建体积不变；可作为补充，不能替代。

## Verification

同一台 Apple Silicon 开发机、rustc 1.95.0，从空目录各执行一次 `cargo test --no-run`：当前配置 `target/debug` 为 4.2G、耗时 141 秒；用 `--config` 恢复完整调试信息、独立 target 目录的对照构建为 6.8G、耗时 143 秒。随后完整 `cargo test` 全部通过（库测试 2663 项通过、9 项忽略，集成测试均通过）。最小 crate 使用同一 profile 时，`RUST_BACKTRACE=1` 的 panic 栈仍输出 `src/main.rs:行:列`。

## Consequences

- **收益**：单次完整 debug/test 构建产物约减少 38%（6.8G → 4.2G），编译耗时基本不变；依赖反复变动时累积的旧产物按同一比例变小。
- **代价与已知上限**：本地调试器看不到局部变量，也不能单步进入依赖源码；旧哈希产物仍会随依赖变动累积，体积再次异常时用 `cargo clean --profile dev` 或 cargo-sweep 清理。
