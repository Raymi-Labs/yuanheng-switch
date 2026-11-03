//! Codex 写适配器（CLI 与 Codex Desktop 共用 `~/.codex`）。
//!
//! 目标：`~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<id>.jsonl`。
//! 格式对齐 Codex 自己的 `externalAgentConfig/import`（从 Claude Code 导入会话）产物：
//! `session_meta` + 一个 `task_started … task_complete` 轮次，每条消息同时写
//! `event_msg`（桌面列表与预览读它）和 `response_item`（续聊发给模型的历史）。
//!
//! 只写文件时 `codex resume <id>` 已可续聊，但 Codex Desktop 列表要等索引库
//! `state_5.sqlite` 登记后才显示（2026-11-03 实测）。登记由 [`register_threads`]
//! 调用 Codex 自己的 app-server `thread/read` 完成，本模块不直接写该库。

use std::path::{Path, PathBuf};

use serde_json::json;
use toml_edit::DocumentMut;

use super::{file_fingerprint, format_rfc3339_ms, write_atomic, SessionWriter, TargetRef};
use crate::session_sync::canonical::label_first_user_message;
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
    let started_s = session.created_at / 1000;
    let turn_id = "meta-api-sync-turn-1";
    let mut lines = vec![
        json!({
            "timestamp": created,
            "type": "session_meta",
            "payload": {
                "session_id": target_session_id,
                "id": target_session_id,
                "timestamp": created,
                "cwd": session.project_dir,
                "originator": "meta-api-sync",
                "cli_version": "meta-api-sync",
                // 与 Codex 官方导入一致；桌面列表默认展示该来源类别
                "source": "vscode",
                "model_provider": model_provider,
            }
        }),
        json!({
            "timestamp": created,
            "type": "event_msg",
            "payload": {
                "type": "task_started",
                "turn_id": turn_id,
                "started_at": started_s,
                "model_context_window": null,
                "collaboration_mode_kind": "default",
            }
        }),
    ];

    // 来源标题放在首条用户消息前，Codex 列表用首条用户文本当标题。
    let mut last_ts = session.created_at;
    for (index, turn) in session.turns.iter().enumerate() {
        let ts = turn.ts.unwrap_or(session.created_at + index as i64);
        last_ts = last_ts.max(ts);
        let stamp = format_rfc3339_ms(ts);
        let text = if index == 0 && turn.role == "user" {
            label_first_user_message(session, &turn.text)
        } else {
            turn.text.clone()
        };
        if turn.role == "user" {
            lines.push(json!({"timestamp": stamp, "type": "event_msg", "payload": {
                "type": "user_message", "message": text,
                "local_images": [], "local_audio": [], "text_elements": [],
            }}));
            lines.push(
                json!({"timestamp": stamp, "type": "response_item", "payload": {
                    "type": "message", "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                }}),
            );
        } else {
            lines.push(json!({"timestamp": stamp, "type": "event_msg", "payload": {
                "type": "agent_message", "message": text,
                "phase": null, "memory_citation": null,
            }}));
            lines.push(
                json!({"timestamp": stamp, "type": "response_item", "payload": {
                    "type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": text}],
                }}),
            );
        }
    }
    lines.push(json!({
        "timestamp": format_rfc3339_ms(last_ts),
        "type": "event_msg",
        "payload": {
            "type": "task_complete",
            "turn_id": turn_id,
            "last_agent_message": null,
            "started_at": started_s,
            "completed_at": last_ts / 1000,
        }
    }));

    let mut out = lines
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    out.push('\n');
    out
}

/// 让 Codex 把新写入的线程登记进自己的索引库，使其出现在 Codex Desktop 列表。
///
/// 启动一次 `codex app-server --stdio`，对每个线程发 `thread/read`；Codex 读取时会自行
/// 修复并登记元数据。尽力而为：找不到 codex、超时或失败都只少登记，文件本身已可续聊。
pub fn register_threads(thread_ids: &[String]) -> usize {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    if thread_ids.is_empty() {
        return 0;
    }
    let Some(executable) = locate_codex() else {
        log::info!("[session-sync] 未找到 codex，跳过桌面列表登记");
        return 0;
    };
    let mut child = match Command::new(&executable)
        .args(["app-server", "--stdio"])
        .env("CODEX_HOME", crate::codex_config::get_codex_config_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            log::warn!("[session-sync] 启动 codex app-server 失败: {e}");
            return 0;
        }
    };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return 0;
    };

    let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let wait_for = |id: u64| -> Option<serde_json::Value> {
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(msg) if msg.get("id").and_then(|v| v.as_u64()) == Some(id) => return Some(msg),
                Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return None,
            }
        }
        None
    };
    let mut send = |value: serde_json::Value| -> bool {
        writeln!(stdin, "{value}")
            .and_then(|_| stdin.flush())
            .is_ok()
    };

    let mut registered = 0;
    let initialized = send(json!({"id": 1, "method": "initialize", "params": {
        "clientInfo": {"name": "meta-api-session-sync", "version": env!("CARGO_PKG_VERSION")}
    }})) && wait_for(1).is_some()
        && send(json!({"method": "initialized"}));
    if initialized {
        for (offset, thread_id) in thread_ids.iter().enumerate() {
            let id = 2 + offset as u64;
            if !send(json!({"id": id, "method": "thread/read",
                "params": {"threadId": thread_id, "includeTurns": false}}))
            {
                break;
            }
            match wait_for(id) {
                Some(reply) if reply.get("result").is_some() => registered += 1,
                Some(reply) => log::warn!("[session-sync] 登记线程 {thread_id} 失败: {reply}"),
                None => break,
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    registered
}

fn locate_codex() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("META_API_CODEX_BIN") {
        return Some(PathBuf::from(path));
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    // 从 Dock 启动的应用 PATH 往往不含这些常见安装位置
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        dirs.push(PathBuf::from(extra));
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
    }
    let names: &[&str] = if cfg!(windows) {
        &["codex.cmd", "codex.exe"]
    } else {
        &["codex"]
    };
    dirs.into_iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
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

    fn after_batch(&self, written: &[TargetRef]) {
        let ids: Vec<String> = written.iter().map(|t| t.session_id.clone()).collect();
        let registered = register_threads(&ids);
        log::info!(
            "[session-sync] Codex 桌面列表登记 {registered}/{}",
            ids.len()
        );
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
        assert_eq!(lines[1]["payload"]["type"], "task_started");
        assert_eq!(lines[2]["payload"]["type"], "user_message");
        assert_eq!(lines[2]["payload"]["message"], "[Claude Code] t\n\nq");
        assert_eq!(lines[3]["payload"]["role"], "user");
        assert_eq!(
            lines[3]["payload"]["content"][0]["text"],
            "[Claude Code] t\n\nq"
        );
        assert_eq!(lines[4]["payload"]["type"], "agent_message");
        assert_eq!(lines[5]["payload"]["content"][0]["type"], "output_text");
        assert_eq!(lines.last().unwrap()["payload"]["type"], "task_complete");
        assert_eq!(lines[0]["payload"]["source"], "vscode");
    }
}
