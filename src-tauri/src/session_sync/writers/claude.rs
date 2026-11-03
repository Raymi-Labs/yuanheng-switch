//! Claude Code 写适配器。
//!
//! 目标：`~/.claude/projects/<编码 cwd>/<id>.jsonl`。格式取自 2026-11-03 探针：
//! 一行 `custom-title` + 交替的 user/assistant 行（`parentUuid` 链、`cwd`、
//! `sessionId`、`timestamp`），`claude --resume <id>` 可续聊并回忆内容。

use std::path::{Path, PathBuf};

use serde_json::json;

use super::{
    file_fingerprint, format_rfc3339_ms, line_uuid, write_atomic, SessionWriter, TargetRef,
};
use crate::session_sync::canonical::origin_title_prefix;
use crate::session_sync::CanonicalSession;

pub struct ClaudeWriter;

/// Claude Code 的项目目录编码：非字母数字一律替换为 `-`
/// （本机 6 个已注册项目目录全部按此规则命中）。
pub fn encode_project_dir(dir: &str) -> String {
    dir.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn projects_root() -> PathBuf {
    crate::config::get_claude_config_dir().join("projects")
}

pub fn target_path(root: &Path, project_dir: &str, target_session_id: &str) -> PathBuf {
    root.join(encode_project_dir(project_dir))
        .join(format!("{target_session_id}.jsonl"))
}

pub fn render(session: &CanonicalSession, target_session_id: &str) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(session.turns.len() + 1);
    let title = format!(
        "{}{}",
        origin_title_prefix(&session.origin_provider),
        session.title
    );
    lines.push(
        json!({
            "type": "custom-title",
            "customTitle": title,
            "sessionId": target_session_id,
        })
        .to_string(),
    );

    let mut parent: Option<String> = None;
    for (index, turn) in session.turns.iter().enumerate() {
        let uuid = line_uuid(target_session_id, index);
        let ts = turn.ts.unwrap_or(session.created_at + index as i64);
        let timestamp = format_rfc3339_ms(ts);
        let line = if turn.role == "user" {
            json!({
                "parentUuid": parent,
                "isSidechain": false,
                "userType": "external",
                "cwd": session.project_dir,
                "sessionId": target_session_id,
                "version": "meta-api-sync",
                "gitBranch": "",
                "type": "user",
                "message": {"role": "user", "content": turn.text},
                "uuid": uuid,
                "timestamp": timestamp,
            })
        } else {
            json!({
                "parentUuid": parent,
                "isSidechain": false,
                "userType": "external",
                "cwd": session.project_dir,
                "sessionId": target_session_id,
                "version": "meta-api-sync",
                "gitBranch": "",
                "type": "assistant",
                "message": {
                    "id": format!("msg_sync_{index}"),
                    "type": "message",
                    "role": "assistant",
                    "model": format!("{}-import", session.origin_provider),
                    "content": [{"type": "text", "text": turn.text}],
                    "stop_reason": "end_turn",
                    "stop_sequence": null,
                    "usage": {"input_tokens": 0, "output_tokens": 0},
                },
                "requestId": format!("req_sync_{index}"),
                "uuid": uuid,
                "timestamp": timestamp,
            })
        };
        lines.push(line.to_string());
        parent = Some(uuid);
    }

    let mut out = lines.join("\n");
    out.push('\n');
    out
}

impl SessionWriter for ClaudeWriter {
    fn write(
        &self,
        session: &CanonicalSession,
        target_session_id: &str,
    ) -> Result<TargetRef, String> {
        let path = target_path(&projects_root(), &session.project_dir, target_session_id);
        write_atomic(&path, &render(session, target_session_id))?;
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
        if !path.starts_with(projects_root()) {
            return Err(format!(
                "Refusing to remove outside Claude projects: {}",
                path.display()
            ));
        }
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("Failed to remove {}: {e}", path.display()))?;
        }
        // Claude 续聊后会创建同名 sidecar 目录；仅当它由本会话派生时清理。
        if let Some(stem) = path.file_stem() {
            let sidecar = path.parent().unwrap_or(Path::new("")).join(stem);
            if sidecar.is_dir() {
                let _ = std::fs::remove_dir_all(&sidecar);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_sync::CanonicalTurn;

    #[test]
    fn encodes_like_claude_code() {
        assert_eq!(
            encode_project_dir("/Users/me/Documents/Projects/hengshu - ai"),
            "-Users-me-Documents-Projects-hengshu---ai"
        );
        assert_eq!(
            encode_project_dir("/private/tmp/x_y.z"),
            "-private-tmp-x-y-z"
        );
    }

    #[test]
    fn render_chains_parent_uuids_and_titles() {
        let session = CanonicalSession {
            origin_provider: "codex".into(),
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
        let out = render(&session, "11111111-1111-5111-8111-111111111111");
        let lines: Vec<serde_json::Value> = out
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["customTitle"], "[Codex] t");
        assert!(lines[1]["parentUuid"].is_null());
        assert_eq!(lines[2]["parentUuid"], lines[1]["uuid"]);
        assert_eq!(lines[2]["message"]["content"][0]["text"], "a");
        // 重写时行 UUID 稳定
        assert_eq!(
            out,
            render(&session, "11111111-1111-5111-8111-111111111111")
        );
    }
}
