//! Gemini CLI 写适配器。
//!
//! 格式取自 Gemini CLI 0.66 自身源码（chatRecordingService / projectRegistry）：
//! - 项目目录 `~/.gemini/tmp/<短标识>/`，其中 `.project_root` 记录项目绝对路径；
//!   Gemini 启动时会按这个标记反查已有目录，所以复用或新建都能被识别。
//! - 会话文件 `chats/session-<YYYY-MM-DDTHH-MM>-<id前8位>.jsonl`：首行元数据
//!   （sessionId、projectHash = sha256(项目路径)、startTime、lastUpdated、kind），
//!   之后每行一条消息，`type` 为 `user` 或 `gemini`，`content` 为 `[{text}]`。
//!
//! 本模块不写 `projects.json` 注册表，Gemini 下次在该目录启动时会按标记自行登记。

use std::path::{Path, PathBuf};

use serde_json::json;
use sha2::{Digest, Sha256};

use super::{
    file_fingerprint, format_rfc3339_ms, line_uuid, write_atomic, SessionWriter, TargetRef,
};
use crate::session_sync::canonical::{label_first_user_message, origin_title_prefix};
use crate::session_sync::CanonicalSession;

pub struct GeminiWriter;

const PROJECT_ROOT_FILE: &str = ".project_root";

fn tmp_root() -> PathBuf {
    crate::gemini_config::get_gemini_dir().join("tmp")
}

/// 与 Gemini 的 slugify 一致：小写，非字母数字转 `-`，合并并去掉首尾 `-`。
pub fn slugify(text: &str) -> String {
    let lowered: String = text
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                c
            } else {
                '-'
            }
        })
        .collect();
    let mut out = String::with_capacity(lowered.len());
    for c in lowered.chars() {
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed
    }
}

/// Gemini 在 macOS / Windows 上比较路径时忽略大小写。
fn same_project(a: &str, b: &str) -> bool {
    let a = a.trim().trim_end_matches('/');
    let b = b.trim().trim_end_matches('/');
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// 找到已归属该项目的目录；没有则按 Gemini 规则认领一个新短标识。
pub fn resolve_project_dir(root: &Path, project_dir: &str) -> Result<PathBuf, String> {
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let marker = entry.path().join(PROJECT_ROOT_FILE);
            if let Ok(owner) = std::fs::read_to_string(&marker) {
                if same_project(&owner, project_dir) {
                    return Ok(entry.path());
                }
            }
        }
    }
    let base = Path::new(project_dir)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let slug = slugify(&base);
    for counter in 0..1000 {
        let candidate = if counter == 0 {
            slug.clone()
        } else {
            format!("{slug}-{counter}")
        };
        let dir = root.join(&candidate);
        let marker = dir.join(PROJECT_ROOT_FILE);
        if marker.exists() {
            continue;
        }
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
        std::fs::write(&marker, project_dir)
            .map_err(|e| format!("Failed to write {}: {e}", marker.display()))?;
        return Ok(dir);
    }
    Err(format!("No free Gemini project slot for {project_dir}"))
}

pub fn project_hash(project_dir: &str) -> String {
    format!("{:x}", Sha256::digest(project_dir.as_bytes()))
}

pub fn file_name(created_at_ms: i64, target_session_id: &str) -> String {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(created_at_ms)
        .unwrap_or_else(chrono::Utc::now);
    let short: String = target_session_id.chars().take(8).collect();
    format!("session-{}-{short}.jsonl", dt.format("%Y-%m-%dT%H-%M"))
}

pub fn render(session: &CanonicalSession, target_session_id: &str) -> String {
    let mut lines = vec![json!({
        "sessionId": target_session_id,
        "projectHash": project_hash(&session.project_dir),
        "startTime": format_rfc3339_ms(session.created_at),
        "lastUpdated": format_rfc3339_ms(session.updated_at.max(session.created_at)),
        "kind": "main",
        "summary": format!("{}{}", origin_title_prefix(&session.origin_provider), session.title),
    })
    .to_string()];
    for (index, turn) in session.turns.iter().enumerate() {
        let ts = turn.ts.unwrap_or(session.created_at + index as i64);
        // Gemini 列表用首条用户消息当标题，带上来源前缀便于辨认
        let text = if index == 0 && turn.role == "user" {
            label_first_user_message(session, &turn.text)
        } else {
            turn.text.clone()
        };
        let kind = if turn.role == "user" {
            "user"
        } else {
            "gemini"
        };
        let mut line = json!({
            "id": line_uuid(target_session_id, index),
            "timestamp": format_rfc3339_ms(ts),
            "type": kind,
            "content": [{"text": text}],
        });
        if kind == "gemini" {
            line["model"] = json!(format!("{}-import", session.origin_provider));
        }
        lines.push(line.to_string());
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

impl SessionWriter for GeminiWriter {
    fn write(
        &self,
        session: &CanonicalSession,
        target_session_id: &str,
    ) -> Result<TargetRef, String> {
        let dir = resolve_project_dir(&tmp_root(), &session.project_dir)?;
        let path = dir
            .join("chats")
            .join(file_name(session.created_at, target_session_id));
        write_atomic(&path, &render(session, target_session_id))?;
        Ok(TargetRef {
            session_id: target_session_id.to_string(),
            path: path.to_string_lossy().to_string(),
        })
    }

    fn fingerprint(&self, target: &TargetRef) -> Option<String> {
        let path = Path::new(&target.path);
        if let Some(fp) = file_fingerprint(path) {
            return Some(fp);
        }
        // Gemini 续聊旧 .json 时会改写成同名 .jsonl；本模块只写 .jsonl，这里兜底
        let alt = PathBuf::from(format!("{}l", target.path));
        file_fingerprint(&alt)
    }

    fn remove(&self, target: &TargetRef) -> Result<(), String> {
        let path = Path::new(&target.path);
        if !path.starts_with(tmp_root()) {
            return Err(format!(
                "Refusing to remove outside Gemini tmp: {}",
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
    fn slugify_matches_gemini() {
        assert_eq!(slugify("My Project_v2"), "my-project-v2");
        assert_eq!(slugify("--中文--"), "project");
        assert_eq!(slugify("hengshu - ai"), "hengshu-ai");
    }

    #[test]
    fn project_hash_is_sha256_of_path() {
        // 与 Gemini 实测生成的会话文件一致
        assert_eq!(
            project_hash("/private/tmp/gmproj"),
            "314d3e936d39aeda797a3d8bd61323095a8f4969ab899c8c605030b19aa069eb"
        );
    }

    #[test]
    fn reuses_existing_marker_and_claims_free_slug() {
        let root = tempfile::tempdir().unwrap();
        let existing = root.path().join("app");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join(PROJECT_ROOT_FILE), "/work/other/app").unwrap();

        let reused = resolve_project_dir(root.path(), "/work/other/app").unwrap();
        assert_eq!(reused, existing);
        // 同名不同路径 → app-1
        let claimed = resolve_project_dir(root.path(), "/work/mine/app").unwrap();
        assert_eq!(claimed, root.path().join("app-1"));
        assert_eq!(
            std::fs::read_to_string(claimed.join(PROJECT_ROOT_FILE)).unwrap(),
            "/work/mine/app"
        );
    }

    #[test]
    fn rendered_file_reads_back_through_gemini_reader() {
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
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join(file_name(session.created_at, "abcdef12-0000"));
        std::fs::write(&path, render(&session, "abcdef12-0000")).unwrap();
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            "session-2023-11-14T22-13-abcdef12.jsonl"
        );
        let messages = crate::session_manager::providers::gemini::load_messages(&path).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "[Codex] t\n\nq");
        assert_eq!(messages[1].role, "assistant");
    }
}
