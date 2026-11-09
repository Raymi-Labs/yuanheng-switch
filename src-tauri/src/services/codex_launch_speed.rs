//! A short-lived, single-use ticket selects a tier for one terminal connection only.
use crate::database::Database;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchSpeed {
    pub tier: String,
    pub model: String,
    pub group: String,
    pub owner: String,
}

impl LaunchSpeed {
    pub fn check(&self, db: &Database) -> Result<(), String> {
        if !matches!(self.tier.as_str(), "priority" | "ultrafast") {
            return Err("无效的付费速度档位".into());
        }
        let cache: Value = serde_json::from_str(
            &db.get_setting("yuanheng_connection_cache")
                .map_err(|e| e.to_string())?
                .unwrap_or_default(),
        )
        .map_err(|_| "请重新登录元衡")?;
        if cache["userId"].as_str() != Some(self.owner.as_str()) || cache["connected"] != true {
            return Err("账号已变化，请重新启动并选择速度".into());
        }
        let id = db
            .get_current_provider("codex")
            .map_err(|e| e.to_string())?
            .ok_or("请先配置Codex终端")?;
        let provider = db
            .get_provider_by_id(&id, "codex")
            .map_err(|e| e.to_string())?
            .ok_or("请先配置Codex终端")?;
        if !super::desktop_service_tiers::managed(&provider)
            || crate::commands::provider_group(&provider).as_deref() != Some(self.group.as_str())
        {
            return Err("终端供应商或分组已变化，请重新启动并选择速度".into());
        }
        super::desktop_service_tiers::validate(
            &provider,
            &json!({"model":self.model,"service_tier":self.tier}),
            Some(&self.owner),
        )
        .map_err(|e| e.to_string())
    }
    pub fn apply(&self, message: &str) -> Result<String, String> {
        let mut v: Value = serde_json::from_str(message).map_err(|_| "无效的CLI消息")?;
        match v["method"].as_str() {
            Some("thread/resume" | "thread/fork") => {
                return Err("付费启动仅用于新对话；恢复旧会话请以标准档启动".into())
            }
            Some("turn/start") => {
                if v["params"]["model"]
                    .as_str()
                    .is_some_and(|m| m != self.model)
                {
                    return Err("模型已变化，请重新启动并选择速度".into());
                }
                if v["params"]["collaborationMode"]["settings"]["model"]
                    .as_str()
                    .is_some_and(|m| m != self.model)
                {
                    return Err("协作模型已变化，请重新选择速度".into());
                }
                for key in ["serviceTier", "serviceTierForTurn"] {
                    if v["params"]
                        .get(key)
                        .is_some_and(|x| !x.is_null() && x.as_str() != Some(self.tier.as_str()))
                    {
                        return Err("CLI档位与本次启动选择不一致，请重新启动；未发送请求".into());
                    }
                }
                v["params"]["model"] = json!(self.model);
                v["params"]["serviceTierForTurn"] = json!(self.tier);
            }
            _ => {}
        }
        Ok(v.to_string())
    }
}

type Ticket = (Instant, LaunchSpeed, Arc<Database>);
fn tickets() -> &'static Mutex<HashMap<String, Ticket>> {
    static TICKETS: OnceLock<Mutex<HashMap<String, Ticket>>> = OnceLock::new();
    TICKETS.get_or_init(Default::default)
}
pub fn issue(scope: LaunchSpeed, db: Arc<Database>) -> Result<String, String> {
    scope.check(&db)?;
    let mut tickets = tickets().lock().map_err(|_| "启动状态不可用")?;
    tickets.retain(|_, (time, _, _)| time.elapsed() < Duration::from_secs(120));
    if tickets.len() >= 32 {
        return Err("待启动终端过多，请稍后重试".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    tickets.insert(token.clone(), (Instant::now(), scope, db));
    Ok(token)
}
pub fn take(authorization: Option<&str>) -> Result<Option<(LaunchSpeed, Arc<Database>)>, String> {
    let Some(authorization) = authorization else {
        return Ok(None);
    };
    let token = authorization
        .strip_prefix("Bearer ")
        .ok_or("无效的启动票据")?;
    let (time, scope, db) = tickets()
        .lock()
        .map_err(|_| "启动状态不可用")?
        .remove(token)
        .ok_or("启动票据已失效，请重新启动")?;
    if time.elapsed() >= Duration::from_secs(120) {
        return Err("启动票据已过期".into());
    }
    scope.check(&db)?;
    Ok(Some((scope, db)))
}

pub fn terminal_command(endpoint: &str, token: Option<&str>) -> String {
    let command = format!("codex --remote {endpoint}");
    let Some(token) = token else {
        return command;
    };
    // Only internally generated UUIDs reach this helper, never user shell text.
    #[cfg(target_os="windows")]
    return format!("$env:YUANHENG_CODEX_LAUNCH='{token}'; {command} --remote-auth-token-env YUANHENG_CODEX_LAUNCH");
    #[cfg(not(target_os = "windows"))]
    format!(
        "YUANHENG_CODEX_LAUNCH='{token}' {command} --remote-auth-token-env YUANHENG_CODEX_LAUNCH"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(tier: &str) -> LaunchSpeed {
        LaunchSpeed {
            tier: tier.into(),
            model: "m".into(),
            group: "g".into(),
            owner: "7".into(),
        }
    }
    #[test]
    fn launch_tiers_are_connection_local_and_never_silently_changed() {
        let message = r#"{"id":1,"method":"turn/start","params":{"input":[]}}"#;
        for tier in ["priority", "ultrafast"] {
            let out: Value = serde_json::from_str(&scope(tier).apply(message).unwrap()).unwrap();
            assert_eq!(out["params"]["serviceTierForTurn"], tier);
        }
        for params in [
            json!({"model":"other"}),
            json!({"serviceTier":"default"}),
            json!({"serviceTierForTurn":"priority"}),
        ] {
            assert!(scope("ultrafast")
                .apply(&json!({"method":"turn/start","params":params}).to_string())
                .is_err());
        }
        assert!(scope("ultrafast")
            .apply(r#"{"method":"thread/resume"}"#)
            .is_err());
        assert!(take(Some("Bearer unknown")).is_err());
        assert!(take(None).unwrap().is_none());
        assert!(terminal_command("ws://127.0.0.1:1234", Some("synthetic"))
            .contains("--remote-auth-token-env YUANHENG_CODEX_LAUNCH"));
    }
}
