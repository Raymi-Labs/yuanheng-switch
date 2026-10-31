//! Isolated Accio runtime profile. No AppType, MCP, Skills or official files.
use crate::{database::Database, provider::Provider};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) mod installation;
pub(crate) mod releases;
mod runtime;
pub(crate) use runtime::{LaunchRequest, Runtime};

pub const SCOPE: &str = "accio-work";
pub const EXPERIMENTAL_ENABLED: bool = cfg!(feature = "accio-work-experimental");

// Deliberately no Debug: the profile contains the upstream credential and local
// capability. The latter lives in a private URL because Accio has no auth-header
// override. YuanHeng never logs it. The official app may log its own gateway URL;
// warn before launch, rotate each launch, and revoke when the child exits.
#[derive(Clone, Serialize, Deserialize)]
pub struct Profile {
    pub owner: String,
    pub model: String,
    pub group: String,
    pub reasoning: String,
    pub models: Vec<String>,
    pub provider: Provider,
    pub capability: String,
    #[serde(default)]
    pub active: bool,
}

impl Profile {
    /// Correlates local usage with this account/group and controlled launch.
    /// A one-way digest is never accepted as the capability and is not sent to
    /// an upstream as a client session/cache key.
    pub(crate) fn request_log_scope(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        hash.update(b"yuanheng-accio-activation-v1");
        for value in [&self.capability, &self.owner, &self.group] {
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value.as_bytes());
        }
        format!("accio-{:x}", hash.finalize())
    }
    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn revision(&self) -> Result<String, String> {
        use sha2::{Digest, Sha256};
        let value = serde_json::to_value(self).map_err(|_| "无法确认 Accio 配置版本")?;
        let canonical = crate::proxy::json_canonical::canonical_json_string(&value);
        Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.owner.is_empty()
            || self.group.is_empty()
            || self.models.is_empty()
            || self.models.len() > 4096
            || !self.models.contains(&self.model)
            || self
                .models
                .iter()
                .any(|m| m.is_empty() || m.len() > 1024 || m.chars().any(char::is_control))
            || self.capability.len() != 64
            || !self.capability.bytes().all(|b| b.is_ascii_hexdigit())
            || !matches!(
                self.reasoning.as_str(),
                "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
            )
        {
            return Err("Accio 元衡配置无效，请重新配置".into());
        }
        let catalog = self
            .provider
            .settings_config
            .pointer("/modelCatalog/models")
            .and_then(Value::as_array)
            .ok_or("Accio 模型目录缺失")?;
        let mut ids = std::collections::BTreeSet::new();
        for entry in catalog {
            let model = entry
                .get("model")
                .and_then(Value::as_str)
                .ok_or("Accio 模型目录无效")?;
            if !ids.insert(model)
                || !matches!(
                    entry.get("apiFormat").and_then(Value::as_str),
                    Some("openai_chat" | "openai_responses" | "anthropic")
                )
            {
                return Err("Accio 模型协议目录无效".into());
            }
        }
        if ids.len() != self.models.len()
            || !self.models.iter().all(|model| ids.contains(model.as_str()))
        {
            return Err("Accio 分组目录与转发目录不一致，请重新配置".into());
        }
        let (url, key) = self
            .provider
            .resolve_usage_credentials(&crate::AppType::Codex);
        if self.provider.id != crate::commands::MANAGED_PROVIDER_ID
            || self.provider.category.as_deref() != Some("managed")
            || !crate::yuanheng_endpoints::is_managed_endpoint(&url, &["", "/v1"], true)
            || key.trim().is_empty()
            || key == "PROXY_MANAGED"
            || crate::commands::provider_group(&self.provider).as_deref() != Some(&self.group)
            || self.provider.meta.as_ref().is_some_and(|m| {
                m.provider_type.is_some()
                    || m.is_full_url == Some(true)
                    || !m.custom_endpoints.is_empty()
                    || m.local_proxy_request_overrides.is_some()
            })
        {
            return Err("Accio 只能使用当前元衡托管分组".into());
        }
        let adapter = crate::proxy::providers::get_adapter(&crate::AppType::Codex);
        if !adapter
            .extract_base_url(&self.provider)
            .ok()
            .is_some_and(|url| {
                crate::yuanheng_endpoints::is_managed_endpoint(&url, &["", "/v1"], true)
            })
            || adapter
                .extract_auth(&self.provider)
                .is_none_or(|auth| auth.api_key != key)
        {
            return Err("Accio 凭据或实际端点不一致，请重新配置".into());
        }
        Ok(())
    }

    pub fn authorizes(&self, capability: &str) -> bool {
        // Fixed-size, constant-work comparison; no user/device identity involved.
        if capability.len() != 64 {
            return false;
        }
        self.capability
            .bytes()
            .zip(capability.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
    }

    pub fn catalog(&self) -> Value {
        json!([{"provider":"yuanheng","providerDisplayName":"YuanHeng",
            "modelList":self.models.iter().map(|model| json!({
                "modelCode":model,"modelName":model,"modelDisplayName":model,
                "modelDesc":"通过元衡所选分组计费；不是免费模型",
                "visible":true,"isDefault":model == &self.model
            })).collect::<Vec<_>>()
        }])
    }
}

pub fn load(db: &Database) -> Result<Option<Profile>, String> {
    let raw: Option<String> = db
        .conn
        .lock()
        .map_err(|_| "Accio 数据库繁忙")?
        .query_row(
            "SELECT payload FROM accio_work_runtime WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "无法读取 Accio 配置")?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let profile: Profile = serde_json::from_str(&raw).map_err(|_| "Accio 配置损坏，请重新配置")?;
    profile.validate()?;
    Ok(Some(profile))
}

pub fn load_active(db: &Database) -> Result<Profile, String> {
    // Explicit disconnect/account switch deletes the profile. Like other tool
    // credentials, an expired console session alone is not a model-token revoke.
    load(db)?
        .filter(|p| p.active)
        .ok_or_else(|| "请从元衡启动 Accio，或重新配置已断开的连接".into())
}

#[cfg(test)]
pub fn save(db: &Database, profile: &Profile) -> Result<(), String> {
    profile.validate()?;
    let payload = serde_json::to_string(profile).map_err(|_| "无法保存 Accio 配置")?;
    db.conn
        .lock()
        .map_err(|_| "Accio 数据库繁忙")?
        .execute(
            "INSERT OR REPLACE INTO accio_work_runtime (id,payload) VALUES (1,?1)",
            [payload],
        )
        .map(|_| ())
        .map_err(|_| "无法保存 Accio 配置".into())
}

/// Preserve a running lease only for the same account. Merge under the DB lock
/// so a configuration update cannot resurrect a lease revoked by process exit.
pub fn save_configuration(db: &Database, mut profile: Profile) -> Result<(), String> {
    profile.validate()?;
    let conn = db.conn.lock().map_err(|_| "Accio 数据库繁忙")?;
    let previous: Option<String> = conn
        .query_row(
            "SELECT payload FROM accio_work_runtime WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "无法读取 Accio 配置")?;
    let previous = previous
        .and_then(|raw| serde_json::from_str::<Profile>(&raw).ok())
        .filter(|p| p.owner == profile.owner && p.validate().is_ok());
    profile.active = previous.as_ref().is_some_and(|p| p.active);
    profile.capability = previous
        .map(|p| p.capability)
        .unwrap_or_else(new_capability);
    conn.execute(
        "INSERT OR REPLACE INTO accio_work_runtime (id,payload) VALUES (1,?1)",
        [serde_json::to_string(&profile).map_err(|_| "无法保存 Accio 配置")?],
    )
    .map(|_| ())
    .map_err(|_| "无法保存 Accio 配置".into())
}

#[cfg(test)]
pub fn activate(db: &Database) -> Result<Profile, String> {
    let revision = load(db)?.ok_or("请先配置 Accio")?.revision()?;
    activate_revision(db, &revision)
}

#[cfg(any(target_os = "macos", test))]
fn activate_revision(db: &Database, expected_revision: &str) -> Result<Profile, String> {
    let conn = db.conn.lock().map_err(|_| "Accio 数据库繁忙")?;
    let raw: String = conn
        .query_row(
            "SELECT payload FROM accio_work_runtime WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "请先配置 Accio")?;
    let mut profile: Profile = serde_json::from_str(&raw).map_err(|_| "Accio 配置损坏")?;
    profile.validate()?;
    if profile.revision()? != expected_revision {
        return Err("Accio 配置已变化，请重新选择后启动".into());
    }
    profile.capability = new_capability();
    profile.active = true;
    conn.execute(
        "UPDATE accio_work_runtime SET payload = ?1 WHERE id = 1",
        [serde_json::to_string(&profile).map_err(|_| "无法激活 Accio 网关")?],
    )
    .map_err(|_| "无法激活 Accio 网关")?;
    Ok(profile)
}

/// A new Core never adopts a persisted live marker or pending launch request.
pub(crate) fn reset_for_core_start(db: &Database) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|_| "Accio 数据库繁忙")?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload FROM accio_work_runtime WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "无法读取 Accio 配置")?;
    if let Some(raw) = raw {
        let mut profile: Profile = serde_json::from_str(&raw).map_err(|_| "Accio 配置损坏")?;
        profile.active = false;
        profile.capability = new_capability();
        conn.execute(
            "UPDATE accio_work_runtime SET payload = ?1 WHERE id = 1",
            [serde_json::to_string(&profile).map_err(|_| "无法撤销旧 Accio 连接")?],
        )
        .map_err(|_| "无法撤销旧 Accio 连接")?;
    }
    Ok(())
}

pub fn revoke(db: &Database, capability: &str) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|_| "Accio 数据库繁忙")?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload FROM accio_work_runtime WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "无法读取 Accio 配置")?;
    if let Some(raw) = raw {
        let mut profile: Profile = serde_json::from_str(&raw).map_err(|_| "Accio 配置损坏")?;
        if profile.authorizes(capability) {
            profile.active = false;
            conn.execute(
                "UPDATE accio_work_runtime SET payload = ?1 WHERE id = 1",
                [serde_json::to_string(&profile).map_err(|_| "无法撤销 Accio 网关")?],
            )
            .map_err(|_| "无法撤销 Accio 网关")?;
        }
    }
    Ok(())
}

pub fn remove(db: &Database) -> Result<bool, String> {
    db.conn
        .lock()
        .map_err(|_| "Accio 数据库繁忙")?
        .execute("DELETE FROM accio_work_runtime WHERE id = 1", [])
        .map(|rows| rows > 0)
        .map_err(|_| "无法撤销 Accio 配置".into())
}

pub fn new_capability() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[cfg(any(target_os = "macos", test))]
fn gateway_origin(port: u16, capability: &str) -> String {
    // GATEWAY_BASE_URL is the gateway root. The official desktop factory adds
    // /api/llm/config/v2 and /api/adk/llm itself, unlike the lower-level SDK.
    format!("http://127.0.0.1:{port}/accio-work/{capability}")
}

#[cfg(target_os = "macos")]
async fn bounded_output(
    command: &mut tokio::process::Command,
) -> Result<std::process::Output, String> {
    command.kill_on_drop(true);
    tokio::time::timeout(std::time::Duration::from_secs(20), command.output())
        .await
        .map_err(|_| "Accio 身份检查超时")?
        .map_err(|_| "无法检查 Accio 官方应用".into())
}

#[cfg(target_os = "macos")]
pub async fn launch(app: &tauri::AppHandle) -> Result<(), String> {
    if !EXPERIMENTAL_ENABLED {
        return Err("Accio 主模型接入仍在实机验收，当前构建未启用".into());
    }
    use tauri::Manager;
    let state = app.state::<crate::store::AppState>();
    load(&state.db)?.ok_or("请先配置 Accio Work")?;
    let path = installation::preflight(app).await?;
    // Also protect the cold-start path before it can start/upgrade Core.
    installation::require_not_running().await?;
    if !state.proxy_service.is_running().await {
        state.proxy_service.start().await?;
    }
    if !state.proxy_service.uses_managed_core() {
        return Err("Accio 需要独立 Core，请重新打开元衡后再启动".into());
    }
    crate::core_daemon::CoreSupervisor::new(crate::config::get_app_config_dir())
        .launch_accio(&state.db, path)
        .await
}

#[cfg(not(target_os = "macos"))]
pub async fn launch(_app: &tauri::AppHandle) -> Result<(), String> {
    Err("当前平台的 Accio 主模型桥接尚未验收，请勿使用实验性配置".into())
}

#[cfg(test)]
pub(crate) fn synthetic_profile() -> Profile {
    let mut provider = Provider::with_id(
        crate::commands::MANAGED_PROVIDER_ID.into(),
        "YuanHeng".into(),
        json!({"auth":{"OPENAI_API_KEY":"synthetic-accio-key"},"config":format!("model_provider = \"custom\"\nmodel = \"synthetic-model\"\n[model_providers.custom]\nbase_url = \"{}\"\nwire_api = \"responses\"\n",crate::yuanheng_endpoints::API_URL),"modelCatalog":{"models":[{"model":"synthetic-model","apiFormat":"openai_responses"}]}}),
        None,
    );
    provider.category = Some("managed".into());
    provider.notes = Some("由元衡桌面端自动维护 | group=synthetic-group | reasoning=auto".into());
    Profile {
        owner: "synthetic-owner".into(),
        model: "synthetic-model".into(),
        group: "synthetic-group".into(),
        reasoning: "auto".into(),
        models: vec!["synthetic-model".into()],
        provider,
        capability: new_capability(),
        active: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accio_launch_revision_is_stable_after_round_trip_and_changes_with_configuration() {
        let profile = synthetic_profile();
        let revision = profile.revision().unwrap();
        let encoded = serde_json::to_string(&profile).unwrap();
        let restored: Profile = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored.revision().unwrap(), revision);
        let mut changed = restored;
        changed.reasoning = "low".into();
        assert_ne!(changed.revision().unwrap(), revision);
        changed.reasoning = profile.reasoning.clone();
        changed.capability = new_capability();
        assert_ne!(changed.revision().unwrap(), revision);
    }

    #[test]
    fn accio_desktop_factory_adds_api_to_gateway_root_exactly_once() {
        let base = gateway_origin(15721, "synthetic-capability");
        assert_eq!(
            format!("{base}/api/llm/config/v2"),
            "http://127.0.0.1:15721/accio-work/synthetic-capability/api/llm/config/v2"
        );
        assert_eq!(
            format!("{base}/api/adk/llm/generateContent"),
            "http://127.0.0.1:15721/accio-work/synthetic-capability/api/adk/llm/generateContent"
        );
    }
    #[test]
    #[serial_test::serial]
    fn accio_profile_is_device_local_and_disconnect_revokes_it() {
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                match &self.0 {
                    Some(v) => std::env::set_var("YUANHENG_SWITCH_TEST_HOME", v),
                    None => std::env::remove_var("YUANHENG_SWITCH_TEST_HOME"),
                }
            }
        }
        let home = tempfile::tempdir().unwrap();
        let _restore = Restore(std::env::var_os("YUANHENG_SWITCH_TEST_HOME"));
        std::env::set_var("YUANHENG_SWITCH_TEST_HOME", home.path());
        let db = Database::memory().unwrap();
        let profile = synthetic_profile();
        save(&db, &profile).unwrap();
        assert!(load_active(&db).unwrap().authorizes(&profile.capability));
        assert!(!profile.authorizes(&"0".repeat(64)));
        let sync = db.export_sql_string_for_sync().unwrap();
        assert!(!sync.contains("synthetic-accio-key"));
        assert!(!sync.contains(&profile.capability));
        let other = Database::memory().unwrap();
        other
            .save_provider(
                "claude",
                &Provider::with_id(
                    "synthetic-sync-provider".into(),
                    "Synthetic".into(),
                    json!({}),
                    None,
                ),
            )
            .unwrap();
        db.import_sql_string_for_sync(&other.export_sql_string_for_sync().unwrap())
            .unwrap();
        assert_eq!(load_active(&db).unwrap().capability, profile.capability);
        let next = activate(&db).unwrap();
        assert_ne!(next.capability, profile.capability);
        revoke(&db, &profile.capability).unwrap();
        assert!(load_active(&db).is_ok());
        revoke(&db, &next.capability).unwrap();
        assert!(load_active(&db).is_err());
        save_configuration(&db, profile.clone()).unwrap();
        assert!(load_active(&db).is_err());
        assert!(remove(&db).unwrap());
        assert!(load_active(&db).is_err());
        assert!(db.get_all_providers("codex").unwrap().is_empty());
    }
    #[test]
    fn accio_rejects_official_auth_modes_and_cross_group_metadata() {
        let mut profile = synthetic_profile();
        profile.models.push("not-in-upstream-catalog".into());
        assert!(profile.validate().is_err());
        profile.models.pop();
        profile.group = "another-group".into();
        assert!(profile.validate().is_err());
        profile.group = "synthetic-group".into();
        profile.provider.meta = Some(crate::provider::ProviderMeta {
            provider_type: Some("codex_oauth".into()),
            ..Default::default()
        });
        assert!(profile.validate().is_err());
    }

    #[test]
    fn accio_usage_scope_changes_for_launch_account_and_group_without_exposing_secrets() {
        let profile = synthetic_profile();
        let scope = profile.request_log_scope();
        assert!(scope.starts_with("accio-"));
        assert_eq!(scope.len(), 70);
        assert!(!scope.contains(&profile.capability));
        let mut changed = profile.clone();
        changed.capability = new_capability();
        assert_ne!(scope, changed.request_log_scope());
        changed = profile.clone();
        changed.owner = "another-account".into();
        assert_ne!(scope, changed.request_log_scope());
        changed = profile.clone();
        changed.group = "another-group".into();
        assert_ne!(scope, changed.request_log_scope());
        changed = profile.clone();
        changed.model = "another-default".into();
        assert_eq!(scope, changed.request_log_scope());
    }
}
