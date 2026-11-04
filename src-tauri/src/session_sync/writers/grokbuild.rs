//! Grok Build 写适配器。
//!
//! 格式取自 Grok Build 1.0.70 自带文档（`~/.grok/docs/user-guide/17-sessions.md`）与本机实测：
//! - 会话目录 `~/.grok/sessions/<URL 编码的 cwd>/<id>/`；编码保留 `A-Za-z0-9-_.~`。
//! - `summary.json` 是索引，`info.id`、`info.cwd` 与 **`current_model_id`** 必填：
//!   缺 `current_model_id` 时 `grok --resume` 报 "Session does not exist"（2026-11-03 逐字段删减实测）。
//! - `updates.jsonl` 驱动 `/resume` 的界面回放，`chat_history.jsonl` 是发给模型的历史；
//!   两份都写，实测任一份单独存在都能续聊。
//!
//! 编码后目录名超过 255 字节时 Grok 改用"slug + 哈希 + `.cwd`"，具体算法未公开，此时拒绝写入。

use std::path::{Path, PathBuf};

use serde_json::json;

use super::{file_fingerprint, format_rfc3339_ms, write_atomic, SessionWriter, TargetRef};
use crate::session_sync::canonical::origin_title_prefix;
use crate::session_sync::CanonicalSession;

pub struct GrokBuildWriter;

const MAX_DIR_NAME_BYTES: usize = 255;
/// 同步会话没有真实模型；Grok 续聊时会改用当前所选模型。
const IMPORTED_MODEL_ID: &str = "grok-4.5";

fn sessions_root() -> PathBuf {
    crate::grok_config::get_grok_config_dir().join("sessions")
}

pub fn encode_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len() * 3);
    for b in cwd.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn session_dir(root: &Path, cwd: &str, target_session_id: &str) -> Result<PathBuf, String> {
    let encoded = encode_cwd(cwd);
    if encoded.len() > MAX_DIR_NAME_BYTES {
        return Err(format!(
            "Project path too long for Grok Build session layout: {cwd}"
        ));
    }
    Ok(root.join(encoded).join(target_session_id))
}

pub fn render_summary(session: &CanonicalSession, target_session_id: &str) -> String {
    let title = format!(
        "{}{}",
        origin_title_prefix(&session.origin_provider),
        session.title
    );
    let updated = format_rfc3339_ms(session.updated_at.max(session.created_at));
    let value = json!({
        "info": {"id": target_session_id, "cwd": session.project_dir},
        "session_summary": title,
        "generated_title": title,
        // 手动标题不会被 Grok 的自动起标题覆盖，来源前缀得以保留
        "title_is_manual": true,
        "created_at": format_rfc3339_ms(session.created_at),
        "updated_at": updated,
        "last_active_at": updated,
        "num_messages": session.turns.len(),
        "num_chat_messages": session.turns.len(),
        "current_model_id": IMPORTED_MODEL_ID,
        "chat_format_version": 1,
    });
    serde_json::to_string_pretty(&value).unwrap_or_default()
}

pub fn render_updates(session: &CanonicalSession, target_session_id: &str) -> String {
    let mut lines = Vec::new();
    let mut prompt_index = 0usize;
    for (index, turn) in session.turns.iter().enumerate() {
        let ts_ms = turn.ts.unwrap_or(session.created_at + index as i64);
        let ts = ts_ms / 1000;
        if turn.role == "user" {
            lines.push(json!({
                "timestamp": ts,
                "method": "session/update",
                "params": {"sessionId": target_session_id, "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": {"type": "text", "text": turn.text},
                    "_meta": {"promptIndex": prompt_index},
                }},
            }));
            prompt_index += 1;
        } else {
            lines.push(json!({
                "timestamp": ts,
                "method": "session/update",
                "params": {"sessionId": target_session_id, "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": turn.text},
                }},
            }));
            lines.push(json!({
                "timestamp": ts,
                "method": "_x.ai/session/update",
                "params": {"sessionId": target_session_id, "update": {
                    "sessionUpdate": "turn_completed",
                    "stop_reason": "end_turn",
                }},
            }));
        }
    }
    join_lines(lines)
}

pub fn render_chat_history(session: &CanonicalSession) -> String {
    let mut lines = Vec::new();
    let mut prompt_index = 0usize;
    for turn in &session.turns {
        if turn.role == "user" {
            lines.push(json!({
                "type": "user",
                "content": [{"type": "text", "text": format!("<user_query>\n{}\n</user_query>", turn.text)}],
                "prompt_index": prompt_index,
            }));
            prompt_index += 1;
        } else {
            lines.push(json!({"type": "assistant", "content": turn.text}));
        }
    }
    join_lines(lines)
}

fn join_lines(lines: Vec<serde_json::Value>) -> String {
    let mut out = lines
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    out.push('\n');
    out
}

impl SessionWriter for GrokBuildWriter {
    fn write(
        &self,
        session: &CanonicalSession,
        target_session_id: &str,
    ) -> Result<TargetRef, String> {
        let dir = session_dir(&sessions_root(), &session.project_dir, target_session_id)?;
        write_atomic(
            &dir.join("updates.jsonl"),
            &render_updates(session, target_session_id),
        )?;
        write_atomic(
            &dir.join("chat_history.jsonl"),
            &render_chat_history(session),
        )?;
        // summary 最后写：Grok 以它为索引，避免列出半成品
        let summary = dir.join("summary.json");
        write_atomic(&summary, &render_summary(session, target_session_id))?;
        Ok(TargetRef {
            session_id: target_session_id.to_string(),
            // 与读适配器一致，source_path 指向 summary.json
            path: summary.to_string_lossy().to_string(),
        })
    }

    /// 以对话内容判断是否被续聊；summary 会被 Grok 随时刷新，不纳入指纹。
    fn fingerprint(&self, target: &TargetRef) -> Option<String> {
        let dir = Path::new(&target.path).parent()?;
        if !Path::new(&target.path).exists() {
            return None;
        }
        let updates = file_fingerprint(&dir.join("updates.jsonl")).unwrap_or_default();
        let chat = file_fingerprint(&dir.join("chat_history.jsonl")).unwrap_or_default();
        Some(format!("{updates}|{chat}"))
    }

    fn remove(&self, target: &TargetRef) -> Result<(), String> {
        let summary = Path::new(&target.path);
        let dir = summary
            .parent()
            .ok_or_else(|| format!("Invalid Grok Build target: {}", target.path))?;
        let root = sessions_root();
        if !dir.starts_with(&root) || dir == root {
            return Err(format!(
                "Refusing to remove outside Grok sessions: {}",
                dir.display()
            ));
        }
        if dir.file_name().and_then(|n| n.to_str()) != Some(target.session_id.as_str()) {
            return Err(format!(
                "Grok session directory does not match id: {}",
                dir.display()
            ));
        }
        if dir.exists() {
            std::fs::remove_dir_all(dir)
                .map_err(|e| format!("Failed to remove {}: {e}", dir.display()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_sync::CanonicalTurn;

    #[test]
    fn encodes_like_grok() {
        // 与 Grok 1.0.70 实测生成的目录名一致
        assert_eq!(
            encode_cwd("/private/tmp/grkproj"),
            "%2Fprivate%2Ftmp%2Fgrkproj"
        );
        assert_eq!(
            encode_cwd("/private/tmp/grk sp/中文-x_y.z"),
            "%2Fprivate%2Ftmp%2Fgrk%20sp%2F%E4%B8%AD%E6%96%87-x_y.z"
        );
    }

    #[test]
    fn rejects_paths_needing_hashed_layout() {
        let long = format!("/{}", "a".repeat(300));
        assert!(session_dir(Path::new("/r"), &long, "id").is_err());
    }

    #[test]
    fn summary_has_fields_grok_requires_and_reads_back() {
        let session = CanonicalSession {
            origin_provider: "codex".into(),
            origin_session_id: "s".into(),
            project_dir: "/p".into(),
            title: "t".into(),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_001_000,
            turns: vec![
                CanonicalTurn {
                    role: "user".into(),
                    text: "q".into(),
                    ts: None,
                },
                CanonicalTurn {
                    role: "assistant".into(),
                    text: "a".into(),
                    ts: None,
                },
            ],
        };
        let summary: serde_json::Value =
            serde_json::from_str(&render_summary(&session, "id-1")).unwrap();
        assert_eq!(summary["info"]["id"], "id-1");
        assert_eq!(summary["info"]["cwd"], "/p");
        assert!(summary["current_model_id"].is_string());
        assert_eq!(summary["generated_title"], "[Codex] t");

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("summary.json"),
            render_summary(&session, "id-1"),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("chat_history.jsonl"),
            render_chat_history(&session),
        )
        .unwrap();
        let messages = crate::session_manager::providers::grokbuild::load_messages(
            &dir.path().join("summary.json"),
        )
        .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].content, "a");
    }
}
