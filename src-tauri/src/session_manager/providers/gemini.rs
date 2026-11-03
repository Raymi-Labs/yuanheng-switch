use std::path::Path;

use serde_json::Value;

use crate::session_manager::{SessionMessage, SessionMeta};

use super::utils::{parse_timestamp_to_ms, truncate_summary};

const PROVIDER_ID: &str = "gemini";

pub fn scan_sessions() -> Vec<SessionMeta> {
    let gemini_dir = crate::gemini_config::get_gemini_dir();
    let tmp_dir = gemini_dir.join("tmp");
    if !tmp_dir.exists() {
        return Vec::new();
    }

    let mut sessions = Vec::new();

    // Iterate over project directories: tmp/<project_name>/chats/session-*.json
    let project_dirs = match std::fs::read_dir(&tmp_dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    for entry in project_dirs.flatten() {
        let chats_dir = entry.path().join("chats");
        if !chats_dir.is_dir() {
            continue;
        }

        let chat_files = match std::fs::read_dir(&chats_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        let project_root_file = entry.path().join(".project_root");
        let project_dir = std::fs::read_to_string(project_root_file).ok();

        for file_entry in chat_files.flatten() {
            let path = file_entry.path();
            // Gemini CLI 0.6x+ 以 JSONL 记录会话；旧版为单个 JSON。两种都读。
            if !matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("json") | Some("jsonl")
            ) {
                continue;
            }
            if let Some(meta) = parse_session(&path) {
                sessions.push(SessionMeta {
                    project_dir: project_dir.clone(),
                    ..meta
                });
            }
        }
    }

    sessions
}

/// 把 JSONL 会话记录合并成与旧版 JSON 相同的对象：首个带 sessionId 的行为元数据，
/// `$set` 行更新元数据，`$rewindTo` 截断其后的消息，`$patch` 改写已有消息，其余带 id 的
/// 行是消息（同 id 后写覆盖先写）。与 Gemini CLI 自身的 JSONL 累加器规则一致。
fn read_session_value(path: &Path) -> Result<Value, String> {
    let data = std::fs::read_to_string(path).map_err(|e| format!("Failed to read session: {e}"))?;
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return serde_json::from_str(&data)
            .map_err(|e| format!("Failed to parse session JSON: {e}"));
    }
    let mut meta = serde_json::Map::new();
    let mut order: Vec<String> = Vec::new();
    let mut messages: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for line in data.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(obj) = record.as_object() else {
            continue;
        };
        if let Some(set) = obj.get("$set").and_then(Value::as_object) {
            for (k, v) in set {
                meta.insert(k.clone(), v.clone());
            }
            continue;
        }
        if let Some(rewind) = obj.get("$rewindTo").and_then(Value::as_str) {
            if let Some(idx) = order.iter().position(|id| id == rewind) {
                for removed in order.drain(idx..) {
                    messages.remove(&removed);
                }
            } else {
                order.clear();
                messages.clear();
            }
            continue;
        }
        if let Some(patch) = obj.get("$patch").and_then(Value::as_object) {
            let mut updates: Vec<&serde_json::Map<String, Value>> = vec![patch];
            if let Some(list) = patch.get("updates").and_then(Value::as_array) {
                updates.extend(list.iter().filter_map(Value::as_object));
            }
            for update in updates {
                let Some(id) = update.get("id").and_then(Value::as_str) else {
                    continue;
                };
                if let (Some(existing), Some(content)) =
                    (messages.get_mut(id), update.get("content"))
                {
                    existing["content"] = content.clone();
                }
            }
            if let Some(ids) = patch.get("removeIds").and_then(Value::as_array) {
                for id in ids.iter().filter_map(Value::as_str) {
                    messages.remove(id);
                    order.retain(|o| o != id);
                }
            }
            continue;
        }
        if obj.contains_key("sessionId") && !obj.contains_key("type") {
            for (k, v) in obj {
                meta.insert(k.clone(), v.clone());
            }
            continue;
        }
        if let Some(id) = obj.get("id").and_then(Value::as_str) {
            if !messages.contains_key(id) {
                order.push(id.to_string());
            }
            messages.insert(id.to_string(), record.clone());
        }
    }
    let list: Vec<Value> = order
        .iter()
        .filter_map(|id| messages.get(id).cloned())
        .collect();
    meta.insert("messages".to_string(), Value::Array(list));
    Ok(Value::Object(meta))
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let value = read_session_value(path)?;

    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "No messages array found".to_string())?;

    let mut result = Vec::new();
    for msg in messages {
        let role = match msg.get("type").and_then(Value::as_str) {
            Some("gemini") => "assistant",
            Some("user") => "user",
            Some("info") | Some("error") => continue,
            Some(_) | None => continue,
        };

        let mut content = content_text(msg.get("content"));
        // Gemini CLI 注入的环境上下文不是用户发言
        if role == "user" && content.trim_start().starts_with("<session_context>") {
            continue;
        }

        // Append tool call names from the optional toolCalls array
        if let Some(Value::Array(calls)) = msg.get("toolCalls") {
            for call in calls {
                if let Some(name) = call.get("name").and_then(Value::as_str) {
                    if !content.is_empty() {
                        content.push('\n');
                    }
                    content.push_str(&format!("[Tool: {name}]"));
                }
            }
        }

        if content.trim().is_empty() {
            continue;
        }

        let ts = msg.get("timestamp").and_then(parse_timestamp_to_ms);

        result.push(SessionMessage {
            role: role.to_string(),
            content,
            ts,
        });
    }

    Ok(result)
}

/// Gemini content may be a plain string or an array of {text: ...} objects
fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub fn delete_session(_root: &Path, path: &Path, session_id: &str) -> Result<bool, String> {
    let meta = parse_session(path).ok_or_else(|| {
        format!(
            "Failed to parse Gemini session metadata: {}",
            path.display()
        )
    })?;

    if meta.session_id != session_id {
        return Err(format!(
            "Gemini session ID mismatch: expected {session_id}, found {}",
            meta.session_id
        ));
    }

    std::fs::remove_file(path).map_err(|e| {
        format!(
            "Failed to delete Gemini session file {}: {e}",
            path.display()
        )
    })?;

    Ok(true)
}

fn parse_session(path: &Path) -> Option<SessionMeta> {
    let value = read_session_value(path).ok()?;
    // 子代理会话不在用户的会话列表里
    if value.get("kind").and_then(Value::as_str) == Some("subagent") {
        return None;
    }

    let session_id = value.get("sessionId").and_then(Value::as_str)?.to_string();

    let created_at = value.get("startTime").and_then(parse_timestamp_to_ms);
    let last_active_at = value.get("lastUpdated").and_then(parse_timestamp_to_ms);

    // Derive title from first user message
    let title = value
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|msgs| {
            msgs.iter()
                .filter(|m| m.get("type").and_then(Value::as_str) == Some("user"))
                .map(|m| content_text(m.get("content")))
                .find(|s| {
                    let t = s.trim();
                    !t.is_empty()
                        && !t.starts_with("<session_context>")
                        && !t.starts_with("<hook_context>")
                        && !t.starts_with('/')
                })
                .map(|s| truncate_summary(&s, 160))
        });

    let source_path = path.to_string_lossy().to_string();

    Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id: session_id.clone(),
        title: title.clone(),
        summary: title,
        project_dir: None, // (optionally) populated later
        created_at,
        last_active_at: last_active_at.or(created_at),
        source_path: Some(source_path),
        resume_command: Some(format!("gemini --resume {session_id}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn delete_session_removes_json_file() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session-2026-03-06T10-17-test.json");
        std::fs::write(
            &path,
            r#"{
              "sessionId": "gemini-session-123",
              "startTime": "2026-03-06T10:17:58.000Z",
              "lastUpdated": "2026-03-06T10:20:00.000Z",
              "messages": [
                {
                  "id": "msg-1",
                  "timestamp": "2026-03-06T10:17:58.000Z",
                  "type": "user",
                  "content": "hello"
                }
              ]
            }"#,
        )
        .expect("write session");

        delete_session(temp.path(), &path, "gemini-session-123").expect("delete session");

        assert!(!path.exists());
    }

    #[test]
    fn load_messages_handles_array_content() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.json");
        std::fs::write(
            &path,
            r#"{
              "sessionId": "test",
              "messages": [
                {"id":"1","timestamp":"2026-03-06T10:00:00Z","type":"user","content":[{"text":"hello"}]},
                {"id":"2","timestamp":"2026-03-06T10:00:01Z","type":"gemini","content":"world"},
                {"id":"3","timestamp":"2026-03-06T10:00:02Z","type":"info","content":"system info"},
                {"id":"4","timestamp":"2026-03-06T10:00:03Z","type":"error","content":"MCP ERROR"}
              ]
            }"#,
        )
        .expect("write");

        let msgs = load_messages(&path).expect("load");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "hello");
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].content, "world");
    }

    #[test]
    fn load_messages_includes_tool_calls() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("session.json");
        std::fs::write(
            &path,
            r#"{
              "sessionId": "test",
              "messages": [
                {"id":"1","timestamp":"2026-03-10T08:24:50Z","type":"gemini","content":"","toolCalls":[{"id":"call_1","name":"web_search","args":{"query":"test"}}]},
                {"id":"2","timestamp":"2026-03-10T08:25:00Z","type":"gemini","content":"Here are the results.","toolCalls":[{"id":"call_2","name":"web_fetch","args":{"url":"http://example.com"}}]}
              ]
            }"#,
        )
        .expect("write");

        let msgs = load_messages(&path).expect("load");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "assistant");
        assert!(msgs[0].content.contains("[Tool: web_search]"));
        assert_eq!(msgs[1].role, "assistant");
        assert!(msgs[1].content.contains("Here are the results."));
        assert!(msgs[1].content.contains("[Tool: web_fetch]"));
    }
}
