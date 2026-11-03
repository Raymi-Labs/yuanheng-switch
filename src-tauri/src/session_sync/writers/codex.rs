//! Codex 写适配器（CLI 与 Codex Desktop 共用 `~/.codex`）。
//!
//! 目标：`~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<id>.jsonl`。
//! 格式取自 2026-11-03 探针：一行 `session_meta` + `response_item.message`，
//! `codex resume <id>` 可续聊并回忆内容，Codex 会在首次 resume 时把线程登记进
//! `state_5.sqlite`，本模块不写该库。

use std::path::{Path, PathBuf};

use serde_json::json;
use toml_edit::DocumentMut;

use super::{file_fingerprint, format_rfc3339_ms, write_atomic, SessionWriter, TargetRef};
use crate::session_sync::canonical::origin_title_prefix;
use crate::session_sync::CanonicalSession;

pub struct CodexWriter;

fn sessions_root() -> PathBuf {
    crate::codex_config::get_codex_config_dir().join("sessions")
}

/// 当前 Codex 激活的 provider 标识；同步会话必须落在同一标识下才会出现在
/// 当前供应商的历史列表里。读不到时退回 Codex 内建的 `openai`。
pub fn active_model_provider() -> String {
    crate::codex_config::read_codex_config_text()
        .ok()
        .and_then(|text| text.parse::<DocumentMut>().ok())
        .and_then(|doc| {
            doc.get("model_provider")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "openai".to_string())
}

pub fn target_path(root: &Path, created_at_ms: i64, target_session_id: &str) -> PathBuf {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(created_at_ms)
        .unwrap_or_else(chrono::Utc::now);
    root.join(dt.format("%Y").to_string())
        .join(dt.format("%m").to_string())
        .join(dt.format("%d").to_string())
        .join(format!(
            "rollout-{}-{target_session_id}.jsonl",
            dt.format("%Y-%m-%dT%H-%M-%S")
        ))
}

pub fn render(session: &CanonicalSession, target_session_id: &str, model_provider: &str) -> String {
    let created = format_rfc3339_ms(session.created_at);
    let title = format!(
        "{}{}",
        origin_title_prefix(&session.origin_provider),
        session.title
    );
    let mut lines = vec![json!({
        "timestamp": created,
        "type": "session_meta",
        "payload": {
            "id": target_session_id,
            "timestamp": created,
            "cwd": session.project_dir,
            "originator": "meta-api-sync",
            "cli_version": "meta-api-sync",
            "source": "cli",
            "model_provider": model_provider,
            "instructions": null,
        }
    })
    .to_string()];

    // 把来源标题作为首条 user 行前的说明，Codex 列表用首条 user 文本当标题。
    for (index, turn) in session.turns.iter().enumerate() {
        let ts = turn.ts.unwrap_or(session.created_at + index as i64);
        let text = if index == 0 && turn.role == "user" {
            format!("{title}\n\n{}", turn.text)
        } else {
            turn.text.clone()
        };
        let (role, kind) = if turn.role == "user" {
            ("user", "input_text")
        } else {
            ("assistant", "output_text")
        };
        lines.push(
            json!({
                "timestamp": format_rfc3339_ms(ts),
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": role,
                    "content": [{"type": kind, "text": text}],
                }
            })
            .to_string(),
        );
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

impl SessionWriter for CodexWriter {
    fn write(
        &self,
        session: &CanonicalSession,
        target_session_id: &str,
    ) -> Result<TargetRef, String> {
        let path = target_path(&sessions_root(), session.created_at, target_session_id);
        write_atomic(
            &path,
            &render(session, target_session_id, &active_model_provider()),
        )?;
        Ok(TargetRef {
            session_id: target_session_id.to_string(),
            path: path.to_string_lossy().to_string(),
        })
    }

    fn fingerprint(&self, target: &TargetRef) -> Option<String> {
        file_fingerprint(Path::new(&target.path))
    }

    fn remove(&self, target: &TargetRef) -> Result<(), String> {
        let path = Path::new(&target.path);
        if !path.starts_with(sessions_root()) {
            return Err(format!(
                "Refusing to remove outside Codex sessions: {}",
                path.display()
            ));
        }
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("Failed to remove {}: {e}", path.display()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_sync::CanonicalTurn;

    #[test]
    fn target_path_follows_codex_layout() {
        let p = target_path(Path::new("/r"), 1_700_000_000_000, "abc");
        assert_eq!(
            p,
            PathBuf::from("/r/2023/11/14/rollout-2023-11-14T22-13-20-abc.jsonl")
        );
    }

    #[test]
    fn render_emits_session_meta_then_messages() {
        let session = CanonicalSession {
            origin_provider: "claude".into(),
            origin_session_id: "src".into(),
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
        let out = render(&session, "id", "custom");
        let lines: Vec<serde_json::Value> = out
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["type"], "session_meta");
        assert_eq!(lines[0]["payload"]["model_provider"], "custom");
        assert_eq!(lines[0]["payload"]["cwd"], "/p");
        assert_eq!(lines[1]["payload"]["role"], "user");
        assert_eq!(
            lines[1]["payload"]["content"][0]["text"],
            "[Claude Code] t\n\nq"
        );
        assert_eq!(lines[2]["payload"]["content"][0]["type"], "output_text");
    }
}
