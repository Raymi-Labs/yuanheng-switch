//! 目标客户端写适配器。每个客户端一个文件，实现 [`SessionWriter`]。

pub mod claude;
pub mod codex;
pub mod dsh;
pub mod gemini;
pub mod grokbuild;
pub mod opencode;

use sha2::{Digest, Sha256};
use std::path::Path;

use super::CanonicalSession;

/// 写入后的目标定位：会话 ID + 文件路径（或 SQLite 定位串）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetRef {
    pub session_id: String,
    pub path: String,
}

pub trait SessionWriter: Send + Sync {
    /// 创建或整体重写目标会话；永远不触碰非本模块生成的文件。
    fn write(
        &self,
        session: &CanonicalSession,
        target_session_id: &str,
    ) -> Result<TargetRef, String>;
    /// 目标当前指纹；目标不存在返回 None。
    fn fingerprint(&self, target: &TargetRef) -> Option<String>;
    fn remove(&self, target: &TargetRef) -> Result<(), String>;
    /// 一批写完后的收尾（例如让目标客户端登记索引）；默认无操作，失败不影响结果。
    fn after_batch(&self, _written: &[TargetRef]) {}
}

const WRITABLE: &[&str] = &["claude", "codex", "gemini", "grokbuild", "opencode", "dsh"];
const READABLE: &[&str] = &[
    "claude",
    "codex",
    "gemini",
    "grokbuild",
    "opencode",
    "dsh",
    "openclaw",
    "hermes",
];

pub fn writable_providers() -> &'static [&'static str] {
    WRITABLE
}

pub fn is_readable_source(provider_id: &str) -> bool {
    READABLE.contains(&provider_id)
}

pub fn writer_for(provider_id: &str) -> Result<Box<dyn SessionWriter>, String> {
    match provider_id {
        "claude" => Ok(Box::new(claude::ClaudeWriter)),
        "codex" => Ok(Box::new(codex::CodexWriter)),
        "gemini" => Ok(Box::new(gemini::GeminiWriter)),
        "grokbuild" => Ok(Box::new(grokbuild::GrokBuildWriter)),
        "opencode" => Ok(Box::new(opencode::OpenCodeWriter)),
        "dsh" => Ok(Box::new(dsh::DshWriter)),
        other => Err(format!("Session sync target not supported yet: {other}")),
    }
}

/// 文件指纹：大小 + 全文 SHA-256，用于判断目标是否被续聊。
pub(crate) fn file_fingerprint(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let digest = Sha256::digest(&bytes);
    Some(format!("{}:{:x}", bytes.len(), digest))
}

/// 原子写入：先写临时文件再 rename。
pub(crate) fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid target path: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "session".to_string())
    ));
    std::fs::write(&tmp, content).map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to move {} into place: {e}", path.display())
    })
}

pub(crate) fn format_rfc3339_ms(ts_ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ts_ms)
        .unwrap_or_else(chrono::Utc::now)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// 同一会话内按序号派生稳定的行 UUID，重写时不漂移。
pub(crate) fn line_uuid(target_session_id: &str, index: usize) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("{target_session_id}:{index}").as_bytes(),
    )
    .to_string()
}
