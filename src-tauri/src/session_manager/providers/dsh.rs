//! DSH（DeepSeek Harness）会话读取。
//!
//! 格式取自 DSH 0.2.1 自带的 `dsh-session-persistence-jsonl` 源码与本机会话（2026-11-03）：
//! `$DSH_HOME/sessions/<项目键>/<编码后的会话 id>/session.v4.jsonl.zstd`，由多个 zstd 帧拼接，
//! 首帧只含一行 `{"type":"session", id, cwd, createdAt, ...}` 头部，之后每帧追加若干事件行。
//! 只读：不取 `session.lock`（DSH 的读者同样不碰锁），不改任何文件。

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::session_manager::{SessionMessage, SessionMeta};

use super::utils::{truncate_summary, TITLE_MAX_CHARS};

const PROVIDER_ID: &str = "dsh";
pub const LOG_FILENAME: &str = "session.v4.jsonl.zstd";

pub fn sessions_root() -> PathBuf {
    crate::commands::dsh_install::home().join("sessions")
}

/// 解压整份会话日志（多帧顺序解压）并逐行解析。坏行跳过。
pub fn read_events(path: &Path) -> Result<Vec<Value>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open DSH session: {e}"))?;
    let mut decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|e| format!("Failed to open DSH zstd stream: {e}"))?;
    let mut text = String::new();
    decoder
        .read_to_string(&mut text)
        .map_err(|e| format!("Failed to decompress DSH session: {e}"))?;
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect())
}

fn message_text(content: Option<&Value>) -> String {
    let Some(Value::Array(blocks)) = content else {
        return String::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 只有 `source.kind == "user"` 是用户亲自输入；runtime-context、skill-catalog 等是 DSH 注入的上下文。
fn is_typed_user_message(data: &Value) -> bool {
    data.get("source")
        .and_then(|s| s.get("kind"))
        .and_then(Value::as_str)
        == Some("user")
}

pub fn scan_sessions() -> Vec<SessionMeta> {
    let root = sessions_root();
    let mut sessions = Vec::new();
    let Ok(projects) = std::fs::read_dir(&root) else {
        return sessions;
    };
    for project in projects.flatten() {
        let Ok(dirs) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for dir in dirs.flatten() {
            let log = dir.path().join(LOG_FILENAME);
            if let Some(meta) = parse_session(&log) {
                sessions.push(meta);
            }
        }
    }
    sessions
}

fn parse_session(path: &Path) -> Option<SessionMeta> {
    if !path.is_file() {
        return None;
    }
    let events = read_events(path).ok()?;
    let header = events.first()?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    // 子代理会话不在用户列表里
    if header
        .get("delegationDepth")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        > 0
    {
        return None;
    }
    let session_id = header.get("id").and_then(Value::as_str)?.to_string();
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string);
    let created_at = header.get("createdAt").and_then(Value::as_i64);

    let mut title: Option<String> = None;
    let mut first_user: Option<String> = None;
    let mut last_text: Option<String> = None;
    let mut last_time: Option<i64> = None;
    let mut user_turns = 0usize;
    for event in &events[1..] {
        if let Some(t) = event.get("time").and_then(Value::as_i64) {
            last_time = Some(t);
        }
        let data = event.get("data").unwrap_or(&Value::Null);
        match event.get("type").and_then(Value::as_str) {
            Some("session/title") => {
                title = data
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .filter(|s| !s.trim().is_empty());
            }
            Some("user/message") if is_typed_user_message(data) => {
                let text = message_text(data.get("content"));
                if !text.trim().is_empty() {
                    user_turns += 1;
                    first_user.get_or_insert_with(|| text.clone());
                    last_text = Some(text);
                }
            }
            Some("assistant/message") => {
                let text = message_text(data.get("message").and_then(|m| m.get("content")));
                if !text.trim().is_empty() {
                    last_text = Some(text);
                }
            }
            _ => {}
        }
    }
    // 只有初始化事件、没有任何用户输入的空会话不展示
    if user_turns == 0 {
        return None;
    }
    let title = title
        .or(first_user)
        .map(|t| truncate_summary(&t, TITLE_MAX_CHARS));
    Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id: session_id.clone(),
        title,
        summary: last_text.map(|t| truncate_summary(&t, 160)),
        project_dir: cwd,
        created_at,
        last_active_at: last_time.or(created_at),
        source_path: Some(path.to_string_lossy().to_string()),
        resume_command: Some(format!("dsh tui --resume {session_id}")),
    })
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let events = read_events(path)?;
    let mut messages = Vec::new();
    for event in events.iter().skip(1) {
        let data = event.get("data").unwrap_or(&Value::Null);
        let ts = event.get("time").and_then(Value::as_i64);
        let (role, content) = match event.get("type").and_then(Value::as_str) {
            Some("user/message") if is_typed_user_message(data) => {
                ("user", message_text(data.get("content")))
            }
            Some("assistant/message") => (
                "assistant",
                message_text(data.get("message").and_then(|m| m.get("content"))),
            ),
            Some("tool/call") => {
                let name = data.get("name").and_then(Value::as_str).unwrap_or("tool");
                ("assistant", format!("[Tool: {name}]"))
            }
            Some("tool/result") => (
                "tool",
                message_text(data.get("message").and_then(|m| m.get("content"))),
            ),
            _ => continue,
        };
        if content.trim().is_empty() {
            continue;
        }
        messages.push(SessionMessage {
            role: role.to_string(),
            content,
            ts,
        });
    }
    Ok(messages)
}

/// 删除整个会话目录；只接受 sessions 根下两层深、且日志头 id 匹配的目录。
pub fn delete_session(root: &Path, path: &Path, session_id: &str) -> Result<bool, String> {
    let events = read_events(path)?;
    let header_id = events
        .first()
        .and_then(|h| h.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if header_id != session_id {
        return Err(format!(
            "DSH session ID mismatch: expected {session_id}, found {header_id}"
        ));
    }
    let dir = path
        .parent()
        .ok_or_else(|| format!("Invalid DSH session path: {}", path.display()))?;
    if dir.parent().and_then(Path::parent) != Some(root) {
        return Err(format!(
            "Refusing to delete DSH directory outside its root: {}",
            dir.display()
        ));
    }
    std::fs::remove_dir_all(dir)
        .map_err(|e| format!("Failed to delete DSH session {}: {e}", dir.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_log(path: &Path, header: &str, body: &[&str]) {
        let mut out = zstd::stream::encode_all(format!("{header}\n").as_bytes(), 0).unwrap();
        let joined: String = body.iter().map(|l| format!("{l}\n")).collect();
        out.extend(zstd::stream::encode_all(joined.as_bytes(), 0).unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, out).unwrap();
    }

    #[test]
    fn reads_multi_frame_log_and_skips_injected_context() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p/s/session.v4.jsonl.zstd");
        write_log(
            &path,
            r#"{"type":"session","version":4,"id":"session-1","createdAt":10,"cwd":"/work","isSeeded":false,"delegationDepth":0}"#,
            &[
                r#"{"type":"user/message","seq":0,"time":11,"data":{"content":[{"type":"text","text":"你好"}],"source":{"kind":"user"},"role":"user","id":"u"}}"#,
                r#"{"type":"user/message","seq":1,"time":12,"data":{"content":[{"type":"text","text":"Current runtime context"}],"source":{"kind":"runtime-context"},"role":"user","id":"c"}}"#,
                r#"{"type":"session/title","seq":2,"time":13,"data":{"title":"问候","messageSeqs":[0],"source":{"kind":"fallback"}}}"#,
                r#"{"type":"assistant/message","seq":3,"time":14,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":"思考"},{"type":"text","text":"你好！"}],"id":"a"}}}"#,
            ],
        );
        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.session_id, "session-1");
        assert_eq!(meta.project_dir.as_deref(), Some("/work"));
        assert_eq!(meta.title.as_deref(), Some("问候"));
        assert_eq!(meta.last_active_at, Some(14));
        let messages = load_messages(&path).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "你好");
        assert_eq!(messages[1].content, "你好！");
    }

    #[test]
    fn hides_empty_and_delegated_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("p/a/session.v4.jsonl.zstd");
        write_log(
            &empty,
            r#"{"type":"session","version":4,"id":"session-a","createdAt":1,"cwd":"/w","delegationDepth":0}"#,
            &[r#"{"type":"session/end-seed","seq":0,"time":2,"data":{}}"#],
        );
        assert!(parse_session(&empty).is_none());
        let child = dir.path().join("p/b/session.v4.jsonl.zstd");
        write_log(
            &child,
            r#"{"type":"session","version":4,"id":"session-b","createdAt":1,"cwd":"/w","delegationDepth":1}"#,
            &[
                r#"{"type":"user/message","seq":0,"time":2,"data":{"content":[{"type":"text","text":"x"}],"source":{"kind":"user"},"role":"user","id":"u"}}"#,
            ],
        );
        assert!(parse_session(&child).is_none());
    }
}
