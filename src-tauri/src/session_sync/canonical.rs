//! 通用会话格式与读侧清洗。
//!
//! 只保留 user / assistant 文本；工具调用折叠为一行 assistant 说明；
//! 各客户端注入的上下文、元行、thinking、附件全部丢弃。

use serde::{Deserialize, Serialize};

use crate::session_manager::{SessionMessage, SessionMeta};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalTurn {
    /// "user" | "assistant"
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSession {
    pub origin_provider: String,
    pub origin_session_id: String,
    pub project_dir: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub turns: Vec<CanonicalTurn>,
}

const MAX_TURN_CHARS: usize = 20_000;

/// 各客户端注入到 user 消息里的上下文前缀；命中即整条丢弃。
const INJECTED_USER_PREFIXES: &[&str] = &[
    "# AGENTS.md instructions",
    "# Context from my IDE setup:",
    "<app-context>",
    "<environment_context>",
    "<user_instructions>",
    "<local-command-caveat>",
    "<command-name>",
    "<command-message>",
    "<local-command-stdout>",
    "<external_codex_apps_open_page>",
    "<codex_apps_client_time_context>",
    "<turn_aborted>",
];

/// 整段被包裹的标签块（起止标签都在同一条消息内时剥离）。
const STRIPPED_BLOCKS: &[(&str, &str)] = &[
    ("<system-reminder>", "</system-reminder>"),
    ("<local-command-caveat>", "</local-command-caveat>"),
    ("<environment_context>", "</environment_context>"),
    ("<app-context>", "</app-context>"),
];

fn strip_blocks(text: &str) -> String {
    let mut out = text.to_string();
    for (open, close) in STRIPPED_BLOCKS {
        while let Some(start) = out.find(open) {
            let Some(end_rel) = out[start..].find(close) else {
                break;
            };
            let end = start + end_rel + close.len();
            out.replace_range(start..end, "");
        }
    }
    out.trim().to_string()
}

fn is_injected_user_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    INJECTED_USER_PREFIXES
        .iter()
        .any(|p| trimmed.starts_with(p))
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push_str("\n…");
    out
}

/// 把现有 `load_messages` 的输出清洗为通用轮次。
pub fn from_messages(meta: &SessionMeta, messages: &[SessionMessage]) -> CanonicalSession {
    let mut turns: Vec<CanonicalTurn> = Vec::new();

    for message in messages {
        let role = message.role.as_str();
        let text = message.content.trim();
        if text.is_empty() {
            continue;
        }
        match role {
            "user" => {
                let cleaned = strip_blocks(text);
                if cleaned.is_empty() || is_injected_user_text(&cleaned) {
                    continue;
                }
                push_turn(&mut turns, "user", cleaned, message.ts);
            }
            "assistant" => {
                let cleaned = fold_tool_marker(text);
                if cleaned.is_empty() {
                    continue;
                }
                push_turn(&mut turns, "assistant", cleaned, message.ts);
            }
            // tool 结果、system、developer 等一律丢弃
            _ => continue,
        }
    }

    // 末尾若以 user 收尾，保留（目标工具续聊时用户可直接接上）；
    // 开头若以 assistant 开始，去掉，避免目标工具把孤立回复当首轮。
    while turns.first().map(|t| t.role.as_str()) == Some("assistant") {
        turns.remove(0);
    }

    let created_at = meta
        .created_at
        .or_else(|| turns.first().and_then(|t| t.ts))
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    let updated_at = meta
        .last_active_at
        .or_else(|| turns.last().and_then(|t| t.ts))
        .unwrap_or(created_at);

    let title = meta
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            turns
                .iter()
                .find(|t| t.role == "user")
                .map(|t| t.text.lines().next().unwrap_or("").to_string())
        })
        .unwrap_or_else(|| meta.session_id.clone());
    let title = truncate_chars(title.trim(), 80);

    CanonicalSession {
        origin_provider: meta.provider_id.clone(),
        origin_session_id: meta.session_id.clone(),
        project_dir: meta.project_dir.clone().unwrap_or_default(),
        title,
        created_at,
        updated_at,
        turns,
    }
}

/// 现有适配器把工具调用表示为 `[Tool: name]`；折叠为自然语言说明。
fn fold_tool_marker(text: &str) -> String {
    let trimmed = text.trim();
    if let Some(rest) = trimmed.strip_prefix("[Tool: ") {
        if let Some(name) = rest.strip_suffix(']') {
            return format!("（调用了工具 {name}）");
        }
    }
    trimmed.to_string()
}

/// 相邻同角色轮次合并，避免目标工具收到连续两条同角色消息。
fn push_turn(turns: &mut Vec<CanonicalTurn>, role: &str, text: String, ts: Option<i64>) {
    let text = truncate_chars(&text, MAX_TURN_CHARS);
    if let Some(last) = turns.last_mut() {
        if last.role == role {
            last.text.push_str("\n\n");
            last.text.push_str(&text);
            if last.ts.is_none() {
                last.ts = ts;
            }
            return;
        }
    }
    turns.push(CanonicalTurn {
        role: role.to_string(),
        text,
        ts,
    });
}

/// 同步生成的会话标题前缀，让用户在目标工具里一眼看出来源。
pub fn origin_title_prefix(provider_id: &str) -> &'static str {
    match provider_id {
        "codex" => "[Codex] ",
        "claude" => "[Claude Code] ",
        "gemini" => "[Gemini] ",
        "grokbuild" => "[Grok Build] ",
        "opencode" => "[OpenCode] ",
        "openclaw" => "[OpenClaw] ",
        "hermes" => "[Hermes] ",
        "dsh" => "[DSH] ",
        _ => "[同步] ",
    }
}

/// 用于"首条用户消息即标题"的客户端（Codex、Gemini）：给首条消息加上来源标记。
/// 标题本就取自这条消息开头时只加前缀，避免列表里出现重复的一段话。
pub fn label_first_user_message(session: &CanonicalSession, text: &str) -> String {
    let prefix = origin_title_prefix(&session.origin_provider);
    let title = session.title.trim_end_matches('…').trim();
    if title.is_empty() || text.trim_start().starts_with(title) {
        format!("{prefix}{text}")
    } else {
        format!("{prefix}{}\n\n{text}", session.title)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> SessionMessage {
        SessionMessage {
            role: role.to_string(),
            content: content.to_string(),
            ts: Some(1),
        }
    }

    fn meta() -> SessionMeta {
        SessionMeta {
            provider_id: "codex".into(),
            session_id: "s".into(),
            title: None,
            summary: None,
            project_dir: Some("/p".into()),
            created_at: Some(10),
            last_active_at: Some(20),
            source_path: None,
            resume_command: None,
        }
    }

    #[test]
    fn drops_injected_context_and_tool_results() {
        let messages = vec![
            msg(
                "user",
                "# AGENTS.md instructions for /p\n<INSTRUCTIONS>x</INSTRUCTIONS>",
            ),
            msg(
                "user",
                "<system-reminder>hidden</system-reminder>真正的问题",
            ),
            msg("assistant", "[Tool: shell]"),
            msg("tool", "output lines"),
            msg("assistant", "回答"),
        ];
        let s = from_messages(&meta(), &messages);
        assert_eq!(s.turns.len(), 2);
        assert_eq!(s.turns[0].role, "user");
        assert_eq!(s.turns[0].text, "真正的问题");
        assert_eq!(s.turns[1].role, "assistant");
        assert_eq!(s.turns[1].text, "（调用了工具 shell）\n\n回答");
        assert_eq!(s.title, "真正的问题");
    }

    #[test]
    fn leading_assistant_turns_are_removed() {
        let messages = vec![
            msg("assistant", "hi"),
            msg("user", "q"),
            msg("assistant", "a"),
        ];
        let s = from_messages(&meta(), &messages);
        assert_eq!(s.turns.len(), 2);
        assert_eq!(s.turns[0].role, "user");
    }

    #[test]
    fn labels_first_message_without_repeating_title() {
        let mut s = from_messages(
            &meta(),
            &[msg("user", "修复登录问题"), msg("assistant", "好")],
        );
        assert_eq!(
            label_first_user_message(&s, "修复登录问题"),
            "[Codex] 修复登录问题"
        );
        s.title = "自定义标题".into();
        assert_eq!(
            label_first_user_message(&s, "修复登录问题"),
            "[Codex] 自定义标题\n\n修复登录问题"
        );
    }

    #[test]
    fn prefers_meta_title() {
        let m = SessionMeta {
            title: Some("自定义标题".into()),
            ..meta()
        };
        let s = from_messages(&m, &[msg("user", "q")]);
        assert_eq!(s.title, "自定义标题");
    }
}
