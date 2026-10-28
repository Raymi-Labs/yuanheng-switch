use super::yuanheng::YuanhengDiagnosticReport;
use crate::database::Database;
use serde::{Deserialize, Serialize};
use std::time::Instant;

/// One bounded, ephemeral snapshot. Never persists account credentials or logs.
pub struct DiagnosticSnapshot {
    pub owner: String,
    pub captured: Instant,
    pub report: YuanhengDiagnosticReport,
}

impl DiagnosticSnapshot {
    pub fn matches(&self, owner: &str, id: &str) -> bool {
        self.matches_at(owner, id, Instant::now())
    }

    fn matches_at(&self, owner: &str, id: &str, now: Instant) -> bool {
        self.owner == owner
            && now
                .checked_duration_since(self.captured)
                .is_some_and(|age| age.as_secs() < SNAPSHOT_TTL_SECS)
            && self.report.snapshot_id.as_deref() == Some(id)
    }
}

pub const SNAPSHOT_TTL_SECS: u64 = 15 * 60;
const TOOLS: [&str; 12] = [
    "claude",
    "claude-desktop",
    "codex",
    "chatgpt-desktop",
    "workbuddy",
    "dsh",
    "accio-work",
    "gemini",
    "grokbuild",
    "opencode",
    "openclaw",
    "hermes",
];

pub fn safe_tool(value: &str) -> &str {
    if value == "grok" {
        return "grokbuild";
    }
    if TOOLS.contains(&value) {
        value
    } else {
        "other-tool"
    }
}

/// Arbitrary aliases can contain names/tokens. Export recognizable model IDs only.
pub fn safe_model(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let recognized = [
        "gpt-",
        "o1",
        "o3",
        "o4",
        "claude-",
        "deepseek-",
        "gemini-",
        "grok-",
        "qwen",
        "glm-",
        "mimo-",
        "kimi-",
        "doubao-",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix));
    let safe_parts = lower.split(['-', '.', '_', ':']).all(|part| {
        [
            "gpt", "claude", "deepseek", "gemini", "grok", "qwen", "glm", "mimo", "kimi", "doubao",
            "o1", "o3", "o4", "4o", "v3", "v4", "k2", "sol", "luna", "terra", "mini", "nano",
            "pro", "max", "plus", "flash", "lite", "preview", "latest", "thinking", "reasoner",
            "chat", "codex", "instant", "turbo", "fast", "sonnet", "opus", "haiku", "seed",
            "audio", "image", "tts", "instruct", "coder", "exp",
        ]
        .contains(&part)
            || (!part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part.len() <= 4 || (part.len() == 8 && part.starts_with("20"))))
            || part.strip_prefix("qwen").is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.len() <= 2
                    && suffix.bytes().all(|b| b.is_ascii_digit())
            })
    });
    if !recognized
        || !safe_parts
        || value.len() > 100
        || lower.contains("sk-")
        || value
            .chars()
            .any(|ch| !ch.is_ascii_alphanumeric() && !"-._:".contains(ch))
    {
        "[custom-model]".into()
    } else {
        value.to_string()
    }
}

pub fn hide_account_label(model: &str, labels: &[&str]) -> String {
    let lowered = model.to_lowercase();
    if labels.iter().any(|label| {
        let label = label.trim();
        label.chars().count() >= 2 && lowered.contains(&label.to_lowercase())
    }) {
        "[custom-model]".into()
    } else {
        safe_model(model)
    }
}

pub fn safe_version(value: &str) -> Option<String> {
    let version = value
        .trim_start_matches('v')
        .split(['-', '+', ' '])
        .next()?;
    let parts: Vec<_> = version.split('.').collect();
    (parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 12 && part.bytes().all(|b| b.is_ascii_digit())
        }))
    .then(|| version.to_string())
}

pub fn path_category(path: &str) -> &'static str {
    let path = path.replace('\\', "/").to_ascii_lowercase();
    if path.contains("/windowsapps/") {
        "microsoft-store"
    } else if path.starts_with("//wsl") {
        "wsl"
    } else if path.starts_with("/users/") || path.starts_with("/home/") || path.contains(":/users/")
    {
        "user-directory"
    } else if path.starts_with("/applications/")
        || path.starts_with("/usr/")
        || path.starts_with("/opt/")
        || path.contains(":/program files/")
    {
        "system-directory"
    } else {
        "custom-directory"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupportRequest {
    pub tool: String,
    pub model: String,
    pub at: i64,
    pub status: u16,
    pub latency_ms: u64,
    pub first_token_ms: Option<u64>,
    pub streaming: bool,
    pub error_present: bool,
}

pub fn latest_request_failures(
    requests: &[SupportRequest],
    configured_at: &std::collections::HashMap<String, i64>,
) -> usize {
    let mut seen = std::collections::HashSet::new();
    requests
        .iter()
        .filter(|request| {
            seen.insert(request.tool.as_str())
                && configured_at
                    .get(&request.tool)
                    .is_some_and(|at| request.at > *at)
                && (!(200..300).contains(&request.status) || request.error_present)
        })
        .count()
}

/// Narrow projection: never loads headers, prompts, names, IDs, error bodies or costs.
pub fn recent_requests(
    db: &Database,
    since: i64,
    until: i64,
) -> Result<Vec<SupportRequest>, String> {
    let conn = db.conn.lock().map_err(|_| "无法读取请求记录")?;
    let mut stmt = conn.prepare(
        "SELECT app_type, model, created_at, status_code, latency_ms, first_token_ms, is_streaming,
            CASE WHEN error_message IS NOT NULL AND error_message != '' THEN 1 ELSE 0 END
         FROM proxy_request_logs
         WHERE COALESCE(data_source, 'proxy') = 'proxy' AND created_at >= ?1 AND created_at <= ?2
         AND created_at - CAST((MAX(latency_ms, 0) + 999) / 1000 AS INTEGER) > ?1
         ORDER BY created_at DESC, rowid DESC LIMIT 20"
    ).map_err(|_| "无法读取请求记录")?;
    let rows = stmt
        .query_map(rusqlite::params![since, until], |row| {
            let tool: String = row.get(0)?;
            let model: String = row.get(1)?;
            let status: i64 = row.get(3)?;
            Ok(SupportRequest {
                tool: safe_tool(&tool).to_string(),
                model: safe_model(&model),
                at: row.get(2)?,
                status: u16::try_from(status).unwrap_or(0),
                latency_ms: row.get::<_, i64>(4)?.max(0) as u64,
                first_token_ms: row
                    .get::<_, Option<i64>>(5)?
                    .map(|value| value.max(0) as u64),
                streaming: row.get(6)?,
                error_present: row.get(7)?,
            })
        })
        .map_err(|_| "无法读取请求记录")?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "无法读取请求记录".into())
}

pub fn safe_checks(report: &YuanhengDiagnosticReport) -> Vec<serde_json::Value> {
    report
        .checks
        .iter()
        .take(24)
        .map(|check| {
            // Titles can contain custom group/account labels. Do not export raw text.
            let id = if let Some(tool) = check.id.strip_prefix("tool_credential:") {
                format!("tool_credential:{}", safe_tool(tool))
            } else if [
                "connection",
                "session",
                "credential",
                "model_catalog",
                "local_route",
                "tools",
                "timeout",
                "recent_requests",
                "codex_history",
                "claude_desktop_gateway",
                "claude_desktop_environment",
                "core_diagnostics",
                "core_version",
                "core_request_flow",
            ]
            .contains(&check.id.as_str())
            {
                check.id.clone()
            } else {
                "other-check".into()
            };
            let status = match check.status.as_str() {
                "ok" => "ok",
                "error" => "error",
                _ => "warning",
            };
            let action = check.action.as_deref().filter(|value| {
                [
                    "login",
                    "repair_credentials",
                    "repair_tools",
                    "configure_tools",
                ]
                .contains(value)
            });
            serde_json::json!({"id": id, "status": status, "action": action})
        })
        .collect()
}

pub fn config_locations() -> Vec<serde_json::Value> {
    let configs = [
        ("claude", crate::config::get_claude_settings_path()),
        ("codex", crate::codex_config::get_codex_config_path()),
        ("gemini", crate::gemini_config::get_gemini_settings_path()),
        ("grokbuild", crate::grok_config::get_grok_config_path()),
        (
            "opencode",
            crate::opencode_config::get_opencode_config_path(),
        ),
        (
            "openclaw",
            crate::openclaw_config::get_openclaw_config_path(),
        ),
        ("hermes", crate::hermes_config::get_hermes_config_path()),
    ];
    configs
        .iter()
        .map(|(tool, path)| {
            let location = path.to_string_lossy();
            let network_path = location.starts_with("\\\\") || location.starts_with("//");
            serde_json::json!({
                "tool": tool, "exists": if network_path { None } else { Some(path.is_file()) },
                "locationCategory": path_category(&location),
                "path": "[local-path-hidden]",
                "networkPathNotProbed": network_path,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_and_arbitrary_models_never_export_names_or_secrets() {
        assert_eq!(safe_tool("grok"), "grokbuild");
        for path in [
            "/Users/Alice/private/project",
            "C:\\Users\\Alice\\secret",
            "\\\\wsl$\\Private\\home\\Bob",
        ] {
            assert!(!path_category(path).contains("Alice"));
            assert!(!path_category(path).contains("Bob"));
        }
        for model in [
            "Alice",
            "张三",
            "sk-super-secret",
            "gpt-/Users/Alice",
            "gpt-alice@example.com",
            "gpt-sk-token",
            "gpt-5-private-person",
        ] {
            assert_eq!(safe_model(model), "[custom-model]");
        }
        assert_eq!(safe_model("gpt-5.6-sol"), "gpt-5.6-sol");
        assert_eq!(
            hide_account_label("gpt-5-alice", &["Alice"]),
            "[custom-model]"
        );
        assert_eq!(safe_version("1.2.3-secret-name"), Some("1.2.3".into()));
        assert_eq!(
            path_category("C:\\Program Files\\WindowsApps\\package\\Codex.exe"),
            "microsoft-store"
        );
    }

    #[test]
    fn reports_export_codes_not_raw_messages_or_group_labels() {
        let report = YuanhengDiagnosticReport {
            status: "warning".into(),
            checked_at: 1,
            ready_tools: 0,
            attention_tools: vec![],
            checks: vec![super::super::yuanheng::YuanhengDiagnosticCheck {
                id: "tool_credential:codex".into(),
                status: "error".into(),
                title: "Alice secret-group".into(),
                message: "Bearer token C:\\Users\\Alice".into(),
                action: None,
            }],
            support_json: None,
            snapshot_id: None,
        };
        let json = serde_json::to_string(&safe_checks(&report)).unwrap();
        for forbidden in ["Alice", "Bearer", "secret-group", "Users"] {
            assert!(!json.contains(forbidden));
        }
        assert!(json.contains("tool_credential:codex"));
    }

    #[test]
    fn snapshots_reject_wrong_owner_id_and_expiry() {
        let captured = Instant::now();
        let snapshot = DiagnosticSnapshot {
            owner: "session-one".into(),
            captured,
            report: YuanhengDiagnosticReport {
                status: "ok".into(),
                checked_at: 1,
                ready_tools: 0,
                attention_tools: vec![],
                checks: vec![],
                support_json: Some("{\"safe\":true}".into()),
                snapshot_id: Some("one".into()),
            },
        };
        assert!(snapshot.matches("session-one", "one"));
        assert!(!snapshot.matches("session-two", "one"));
        assert!(!snapshot.matches("session-one", "other"));
        let after_expiry = captured + std::time::Duration::from_secs(SNAPSHOT_TTL_SECS + 1);
        assert!(!snapshot.matches_at("session-one", "one", after_expiry));
    }

    #[test]
    fn latest_success_supersedes_old_failures_but_http_200_with_stream_error_is_not_success() {
        let mut requests = vec![
            SupportRequest {
                tool: "codex".into(),
                model: "gpt-5".into(),
                at: 20,
                status: 200,
                latency_ms: 1,
                first_token_ms: None,
                streaming: true,
                error_present: false,
            },
            SupportRequest {
                tool: "codex".into(),
                model: "gpt-5".into(),
                at: 10,
                status: 401,
                latency_ms: 1,
                first_token_ms: None,
                streaming: true,
                error_present: true,
            },
        ];
        let mut configured = std::collections::HashMap::from([("codex".into(), 0)]);
        assert_eq!(latest_request_failures(&requests, &configured), 0);
        requests[0].error_present = true;
        assert_eq!(latest_request_failures(&requests, &configured), 1);
        configured.insert("codex".into(), 21);
        assert_eq!(latest_request_failures(&requests, &configured), 0);
    }

    #[test]
    fn request_projection_is_bounded_read_only_and_excludes_sessions_and_old_account_traffic() {
        let db = Database::memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            // Isolated minimal schema ensures the query cannot depend on private columns.
            conn.execute_batch("DROP TABLE proxy_request_logs;
                CREATE TABLE proxy_request_logs (
                    app_type TEXT, model TEXT, created_at INTEGER, status_code INTEGER,
                    latency_ms INTEGER, first_token_ms INTEGER, is_streaming BOOLEAN, data_source TEXT, error_message TEXT
                );").unwrap();
            for at in 101..130 {
                conn.execute("INSERT INTO proxy_request_logs VALUES ('codex','gpt-5.6-sol',?1,401,50,20,1,'proxy','private bearer token')", [at]).unwrap();
            }
            conn.execute_batch(
                "INSERT INTO proxy_request_logs VALUES
                ('claude','private-user',129,200,0,0,1,'session',NULL),
                ('codex','sk-secret',100,200,0,0,1,'proxy',NULL),
                ('codex','old-account',110,200,20000,0,1,'proxy',NULL);",
            )
            .unwrap();
        }
        let changes = || {
            db.conn
                .lock()
                .unwrap()
                .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
                .unwrap()
        };
        let before = changes();
        let rows = recent_requests(&db, 100, 129).unwrap();
        assert_eq!(rows.len(), 20);
        assert!(rows
            .iter()
            .all(|row| row.model == "gpt-5.6-sol" && row.status == 401));
        assert_eq!(rows[0].at, 129);
        assert!(rows[0].error_present);
        assert!(!serde_json::to_string(&rows).unwrap().contains("bearer"));
        assert_eq!(changes(), before);
    }
}
