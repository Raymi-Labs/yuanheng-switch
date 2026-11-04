//! OpenCode 写适配器。
//!
//! OpenCode 1.19 把会话存在 SQLite（`opencode.db` 的 session/message/part 表），不直接写库，
//! 而是走它自己的官方命令（2026-11-03 在隔离 HOME 实测）：
//! - `opencode import <file>` 导入 `{info, messages:[{info, parts}]}` JSON，最小字段即可，
//!   导入后 `opencode session list` 可见，`opencode run -s <id>` 续聊时历史随请求发给模型。
//! - 同 ID 再次导入**不会覆盖**（标题和消息保持旧值），所以更新 = `session delete` 后重新导入。
//! - `opencode session delete <id>` 同时删除 session/message/part。
//!
//! - 导入时 OpenCode **忽略 JSON 里的 directory**，按执行命令时的工作目录决定会话归属的项目
//!   （实测从别的目录导入会挂到错误项目，列表看不到，续聊报错）。因此必须在项目目录里执行导入。
//!
//! - 续聊沿用最后一条消息记录的模型；记录一个不存在的模型会让 `opencode run -s` 报
//!   ProviderModelNotFoundError。因此消息里写入用户当前在 OpenCode 配置的 `model`，
//!   读不到时由调用方保证 OpenCode 至少有一个可用默认模型。
//!
//! 会话 ID 必须以 `ses_` 开头（读适配器依赖这一约定），消息与片段分别用 `msg_` / `prt_`。

use std::path::PathBuf;
use std::process::Command;

use rusqlite::Connection;
use serde_json::json;

use super::{SessionWriter, TargetRef};
use crate::session_sync::canonical::origin_title_prefix;
use crate::session_sync::CanonicalSession;

pub struct OpenCodeWriter;

/// 由派生 UUID 生成 OpenCode 风格的 ID（前缀 + 去掉连字符的十六进制）。
pub fn opencode_id(prefix: &str, target_session_id: &str, index: Option<usize>) -> String {
    let hex: String = target_session_id.chars().filter(|c| *c != '-').collect();
    match index {
        None => format!("{prefix}_{hex}"),
        Some(i) => format!("{prefix}_{hex}{i:04}"),
    }
}

pub fn session_id_for(target_session_id: &str) -> String {
    opencode_id("ses", target_session_id, None)
}

/// 用户在 OpenCode 里配置的默认模型 `provider/model`，拆成 (providerID, modelID)。
pub fn configured_model() -> Option<(String, String)> {
    let config = crate::opencode_config::read_opencode_config().ok()?;
    parse_model_ref(config.get("model")?.as_str()?)
}

fn parse_model_ref(value: &str) -> Option<(String, String)> {
    let (provider, model) = value.trim().split_once('/')?;
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    Some((provider.to_string(), model.to_string()))
}

pub fn render(
    session: &CanonicalSession,
    target_session_id: &str,
    model: Option<&(String, String)>,
) -> serde_json::Value {
    let sid = session_id_for(target_session_id);
    let (provider_id, model_id) = model
        .cloned()
        .unwrap_or_else(|| ("opencode".to_string(), "default".to_string()));
    let title = format!(
        "{}{}",
        origin_title_prefix(&session.origin_provider),
        session.title
    );
    let mut messages = Vec::new();
    let mut parent: Option<String> = None;
    for (index, turn) in session.turns.iter().enumerate() {
        let ts = turn.ts.unwrap_or(session.created_at + index as i64);
        let mid = opencode_id("msg", target_session_id, Some(index));
        let pid = opencode_id("prt", target_session_id, Some(index));
        let info = if turn.role == "user" {
            // OpenCode 导入校验要求 user 消息带 model（实测缺失时报 Missing key at ["model"]）
            json!({
                "id": mid, "sessionID": sid, "role": "user", "time": {"created": ts}, "agent": "build",
                "model": {"providerID": provider_id, "modelID": model_id},
            })
        } else {
            json!({
                "id": mid, "sessionID": sid, "role": "assistant",
                "parentID": parent,
                "time": {"created": ts, "completed": ts},
                "modelID": model_id,
                "providerID": provider_id,
                "mode": "build", "agent": "build",
                "path": {"cwd": session.project_dir, "root": "/"},
                "cost": 0,
                "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
                "finish": "stop",
            })
        };
        if turn.role == "user" {
            parent = Some(mid.clone());
        }
        messages.push(json!({
            "info": info,
            "parts": [{"id": pid, "sessionID": sid, "messageID": mid, "type": "text", "text": turn.text}],
        }));
    }
    json!({
        "info": {
            "id": sid,
            "slug": "meta-api-sync",
            "projectID": "global",
            "directory": session.project_dir,
            "title": title,
            "version": "meta-api-sync",
            "time": {"created": session.created_at, "updated": session.updated_at.max(session.created_at)},
        },
        "messages": messages,
    })
}

fn db_path() -> PathBuf {
    crate::session_manager::providers::opencode::get_opencode_base_dir().join("opencode.db")
}

fn locate_opencode() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("META_API_OPENCODE_BIN") {
        return Some(PathBuf::from(path));
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        dirs.push(PathBuf::from(extra));
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".opencode/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
    }
    let names: &[&str] = if cfg!(windows) {
        &["opencode.cmd", "opencode.exe"]
    } else {
        &["opencode"]
    };
    dirs.into_iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}

fn run_opencode(args: &[&str], cwd: Option<&str>) -> Result<(), String> {
    let exe = locate_opencode()
        .ok_or_else(|| "未找到 opencode 命令，请先在工具管理中安装 OpenCode".to_string())?;
    let mut command = Command::new(&exe);
    command.args(args);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    // npm 安装的入口是 node 脚本；从 Dock 启动时 PATH 可能不含 node 所在目录
    if let Some(parent) = exe.parent() {
        let current = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![parent.to_path_buf()];
        paths.extend(std::env::split_paths(&current));
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("PATH", joined);
        }
    }
    let output = command
        .output()
        .map_err(|e| format!("运行 opencode 失败: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "opencode {} 失败: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// 只读查询会话当前的消息数与最后更新时间，作为"是否被续聊"的指纹。
fn db_fingerprint(session_id: &str) -> Option<String> {
    let path = db_path();
    if !path.exists() {
        return None;
    }
    let conn = Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let exists: i64 = conn
        .query_row(
            "SELECT count(*) FROM session WHERE id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .ok()?;
    if exists == 0 {
        return None;
    }
    let (count, last): (i64, Option<i64>) = conn
        .query_row(
            "SELECT count(*), max(time_created) FROM message WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()?;
    Some(format!("{count}:{}", last.unwrap_or(0)))
}

impl SessionWriter for OpenCodeWriter {
    fn write(
        &self,
        session: &CanonicalSession,
        target_session_id: &str,
    ) -> Result<TargetRef, String> {
        let sid = session_id_for(target_session_id);
        // 同 ID 导入不覆盖：先删掉本模块此前生成的旧版本
        if db_fingerprint(&sid).is_some() {
            run_opencode(&["session", "delete", &sid], None)?;
        }
        if !std::path::Path::new(&session.project_dir).is_dir() {
            return Err(format!(
                "项目目录不存在，OpenCode 无法归属: {}",
                session.project_dir
            ));
        }
        let file = tempfile::Builder::new()
            .prefix("meta-api-opencode-")
            .suffix(".json")
            .tempfile()
            .map_err(|e| format!("创建临时文件失败: {e}"))?;
        let model = configured_model();
        std::fs::write(
            file.path(),
            render(session, target_session_id, model.as_ref()).to_string(),
        )
        .map_err(|e| format!("写入临时文件失败: {e}"))?;
        let path = file.path().to_string_lossy().to_string();
        run_opencode(&["import", &path], Some(&session.project_dir))?;
        Ok(TargetRef {
            session_id: sid.clone(),
            path: format!("sqlite:{}:{sid}", db_path().display()),
        })
    }

    fn fingerprint(&self, target: &TargetRef) -> Option<String> {
        db_fingerprint(&target.session_id)
    }

    fn remove(&self, target: &TargetRef) -> Result<(), String> {
        if !target.session_id.starts_with("ses_") {
            return Err(format!("Not an OpenCode session id: {}", target.session_id));
        }
        if db_fingerprint(&target.session_id).is_none() {
            return Ok(());
        }
        run_opencode(&["session", "delete", &target.session_id], None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_sync::CanonicalTurn;

    #[test]
    fn ids_follow_opencode_prefixes() {
        let id = "0d9c5a7e-1111-5222-8333-444455556666";
        assert_eq!(session_id_for(id), "ses_0d9c5a7e111152228333444455556666");
        assert_eq!(
            opencode_id("msg", id, Some(3)),
            "msg_0d9c5a7e1111522283334444555566660003"
        );
    }

    #[test]
    fn render_matches_import_shape() {
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
        let model = ("meta".to_string(), "gpt-x".to_string());
        let v = render(
            &session,
            "0d9c5a7e-1111-5222-8333-444455556666",
            Some(&model),
        );
        assert_eq!(v["info"]["title"], "[Codex] t");
        assert_eq!(v["info"]["directory"], "/p");
        let msgs = v["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1]["info"]["parentID"], msgs[0]["info"]["id"]);
        assert_eq!(msgs[1]["parts"][0]["text"], "a");
        assert_eq!(msgs[0]["parts"][0]["sessionID"], v["info"]["id"]);
        assert_eq!(msgs[0]["info"]["model"]["providerID"], "meta");
        assert_eq!(msgs[1]["info"]["modelID"], "gpt-x");
    }

    #[test]
    fn parses_configured_model_reference() {
        assert_eq!(
            parse_model_ref("yuanheng/claude-opus"),
            Some(("yuanheng".into(), "claude-opus".into()))
        );
        assert_eq!(parse_model_ref("no-slash"), None);
        assert_eq!(parse_model_ref("/x"), None);
    }
}
