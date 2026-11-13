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
        let provider = self.check_identity(db)?;
        super::desktop_service_tiers::validate(
            &provider,
            &json!({"model":self.model,"service_tier":self.tier}),
            Some(&self.owner),
        )
        .map_err(|e| e.to_string())
    }

    pub fn check_identity(&self, db: &Database) -> Result<crate::provider::Provider, String> {
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
        let config = provider.settings_config["config"]
            .as_str()
            .and_then(|text| text.parse::<toml::Value>().ok());
        if config
            .as_ref()
            .and_then(|c| c.get("model"))
            .and_then(toml::Value::as_str)
            != Some(self.model.as_str())
        {
            return Err("终端模型已变化，请重新启动并选择速度".into());
        }
        Ok(provider)
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

pub async fn refresh_for_launch<F>(
    db: &Database,
    scope: &LaunchSpeed,
    query: F,
) -> Result<(), String>
where
    F: std::future::Future<Output = Result<Vec<Value>, String>>,
{
    let before = scope.check_identity(db)?;
    let tiers = query.await?;
    let mut provider = scope.check_identity(db)?;
    if provider.settings_config != before.settings_config || provider.notes != before.notes {
        return Err("启动期间配置已变化，请重新启动；未发送请求".into());
    }
    if tiers
        .iter()
        .any(|row| !matches!(row["id"].as_str(), Some("priority" | "ultrafast")))
    {
        return Err("速度能力响应无效，未启动".into());
    }
    let old = &provider.settings_config["yuanhengServiceTiers"];
    let mut models = if old["owner"] == scope.owner && old["group"] == scope.group {
        old["models"].as_object().cloned().unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    models.insert(scope.model.clone(), json!(tiers));
    provider.settings_config["yuanhengServiceTiers"] =
        json!({"owner":scope.owner,"group":scope.group,"models":models});
    provider.settings_config["yuanhengServiceTiersSchema"] = json!(1);
    let rows = provider
        .settings_config
        .pointer_mut("/modelCatalog/models")
        .and_then(Value::as_array_mut)
        .ok_or("终端模型目录缺失，请重新应用配置")?;
    let row = rows
        .iter_mut()
        .find(|r| r["model"] == scope.model)
        .ok_or("当前模型不在终端目录中，请重新应用配置")?;
    row["serviceTiers"] = json!(tiers);
    db.save_provider("codex", &provider)
        .map_err(|e| e.to_string())?;
    // An explicit negative response revokes the old row rather than retaining stale permission.
    scope.check(db)
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
    fn empty_database() -> Database {
        let db = Database::memory().unwrap();
        db.set_setting(
            "yuanheng_connection_cache",
            r#"{"userId":"7","connected":true}"#,
        )
        .unwrap();
        let mut p = crate::provider::Provider::with_id(
            crate::commands::MANAGED_PROVIDER_ID.into(),
            "synthetic".into(),
            json!({"config":"model=\"m\"","modelCatalog":{"models":[{"model":"m","serviceTiers":[]}]},"yuanhengServiceTiers":{"owner":"7","group":"g","models":{}}}),
            None,
        );
        p.category = Some("managed".into());
        p.notes = Some("group=g".into());
        db.save_provider("codex", &p).unwrap();
        db.set_current_provider("codex", &p.id).unwrap();
        db
    }
    #[tokio::test]
    async fn empty_snapshot_is_refreshed_before_paid_launch_and_core_validation() {
        let db = empty_database();
        let s = scope("ultrafast");
        assert!(s.check(&db).is_err());
        refresh_for_launch(&db, &s, async {
            Ok(vec![json!({"id":"ultrafast","name":"UltraFast ×6"})])
        })
        .await
        .unwrap();
        s.check(&db).unwrap();
        let p = db
            .get_provider_by_id(crate::commands::MANAGED_PROVIDER_ID, "codex")
            .unwrap()
            .unwrap();
        super::super::desktop_service_tiers::validate(
            &p,
            &json!({"model":"m","service_tier":"ultrafast"}),
            Some("7"),
        )
        .unwrap();
        assert_eq!(
            p.settings_config["modelCatalog"]["models"][0]["serviceTiers"][0]["id"],
            "ultrafast"
        );
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

    #[tokio::test]
    async fn refresh_failure_and_revocation_never_reuse_paid_permission() {
        let db = empty_database();
        let s = scope("priority");
        let before = db
            .get_provider_by_id(crate::commands::MANAGED_PROVIDER_ID, "codex")
            .unwrap()
            .unwrap();
        assert!(refresh_for_launch(&db, &s, async { Err("timeout".into()) })
            .await
            .is_err());
        assert_eq!(
            db.get_provider_by_id(&before.id, "codex")
                .unwrap()
                .unwrap()
                .settings_config,
            before.settings_config
        );
        refresh_for_launch(&db, &s, async { Ok(vec![json!({"id":"priority"})]) })
            .await
            .unwrap();
        assert!(refresh_for_launch(&db, &s, async { Ok(vec![]) })
            .await
            .is_err());
        assert!(s.check(&db).is_err());
        let after = db.get_provider_by_id(&before.id, "codex").unwrap().unwrap();
        assert_eq!(
            after.settings_config["yuanhengServiceTiers"]["models"]["m"],
            json!([])
        );
    }

    #[tokio::test]
    async fn refresh_rejects_account_group_model_and_config_changes_during_query() {
        for change in ["account", "group", "model", "config"] {
            let db = empty_database();
            let s = scope("priority");
            let result = refresh_for_launch(&db, &s, async {
                if change == "account" {
                    db.set_setting(
                        "yuanheng_connection_cache",
                        r#"{"userId":"8","connected":true}"#,
                    )
                    .unwrap();
                } else {
                    let mut p = db
                        .get_provider_by_id(crate::commands::MANAGED_PROVIDER_ID, "codex")
                        .unwrap()
                        .unwrap();
                    match change {
                        "group" => p.notes = Some("group=other".into()),
                        "model" => p.settings_config["config"] = json!("model=\"other\""),
                        _ => p.settings_config["externalChange"] = json!(true),
                    }
                    db.save_provider("codex", &p).unwrap();
                }
                Ok(vec![json!({"id":"priority"})])
            })
            .await;
            assert!(result.is_err(), "{change}");
            let p = db
                .get_provider_by_id(crate::commands::MANAGED_PROVIDER_ID, "codex")
                .unwrap()
                .unwrap();
            assert_eq!(
                p.settings_config["yuanhengServiceTiers"]["models"],
                json!({}),
                "{change}"
            );
        }
    }

    #[tokio::test]
    async fn invalid_identity_never_queries_and_unrelated_models_are_preserved() {
        let db = empty_database();
        let mut s = scope("priority");
        s.group = "wrong".into();
        assert!(
            refresh_for_launch(&db, &s, async { panic!("must not query wrong scope") })
                .await
                .is_err()
        );
        s.group = "g".into();
        let mut p = db
            .get_provider_by_id(crate::commands::MANAGED_PROVIDER_ID, "codex")
            .unwrap()
            .unwrap();
        p.settings_config["yuanhengServiceTiers"]["models"]["unrelated"] =
            json!([{"id":"ultrafast"}]);
        p.settings_config["auth"] = json!({"synthetic":"keep"});
        db.save_provider("codex", &p).unwrap();
        refresh_for_launch(&db, &s, async { Ok(vec![json!({"id":"priority"})]) })
            .await
            .unwrap();
        let after = db.get_provider_by_id(&p.id, "codex").unwrap().unwrap();
        assert_eq!(after.settings_config["auth"], p.settings_config["auth"]);
        assert_eq!(
            after.settings_config["yuanhengServiceTiers"]["models"]["unrelated"],
            p.settings_config["yuanhengServiceTiers"]["models"]["unrelated"]
        );
    }
}
