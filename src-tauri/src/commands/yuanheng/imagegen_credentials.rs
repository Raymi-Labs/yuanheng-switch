//! Read-only, application-bound image credentials. The returned Provider is a
//! request-local transport value; it is never persisted or added to failover.
use super::*;
use crate::database::Database;
use rusqlite::OptionalExtension;

const CHANGED: &str = "当前工具的元衡配置已变化，请核对后重新配置";
const UNAVAILABLE: &str = "无法读取当前工具的元衡图像配置";

pub(crate) fn imagegen_provider(db: &Database, surface: &str) -> Result<Option<Provider>, String> {
    let key = match surface {
        "dsh" => dsh::imagegen_credential(db).map_err(|_| CHANGED.to_string())?,
        "workbuddy" => workbuddy_credential(db)?,
        "claude" | "gemini" | "grokbuild" | "opencode" | "hermes" => {
            let app = surface.parse::<AppType>().map_err(|_| UNAVAILABLE)?;
            core_tool_credential(db, &app)?
        }
        // Codex keeps its existing provider selection and native OAuth path.
        // In particular, an unknown namespace must never borrow Codex's key.
        _ => return Err("该工具不支持元衡自动图像路由".into()),
    };
    key.map(provider_from_key).transpose()
}

pub(super) fn provider_from_key(key: String) -> Result<Provider, String> {
    if !valid_platform_key(&key) {
        return Err("当前工具缺少有效的元衡 API 凭据".into());
    }
    let mut provider = Provider::with_id(
        MANAGED_PROVIDER_ID.into(),
        MANAGED_PROVIDER_DISPLAY_NAME.into(),
        json!({"base_url": OPENAI_BASE_URL, "auth": {"OPENAI_API_KEY": key}}),
        None,
    );
    provider.category = Some("managed".into());
    Ok(provider)
}

pub(super) fn valid_platform_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    !key.is_empty()
        && key.len() <= 4096
        && key.trim() == key
        && !key.chars().any(char::is_whitespace)
        && ![
            "PROXY_MANAGED",
            "YOUR_API_KEY",
            "YOUR_OPENAI_API_KEY",
            "YOUR_TOKEN",
            "PLACEHOLDER",
        ]
        .iter()
        .any(|marker| upper.contains(marker))
        && !["eyJ", "ya29.", "sk-ant-oat", "{", "$"]
            .iter()
            .any(|prefix| key.starts_with(prefix))
        && reqwest::header::HeaderValue::from_str(&format!("Bearer {key}")).is_ok()
}

fn setting(db: &Database, key: &str) -> Result<Option<String>, String> {
    db.get_setting(key)
        .map(|value| value.filter(|s| !s.trim().is_empty()))
        .map_err(|_| UNAVAILABLE.into())
}

fn workbuddy_credential(db: &Database) -> Result<Option<String>, String> {
    // A preserved previous state is the existing ownership marker. It is not
    // read for credentials and must disappear when the tool is restored.
    if setting(db, PREVIOUS_WORKBUDDY_CONFIG_KEY)?.is_none() {
        return Ok(None);
    }
    let (Some(model), Some(_group)) = (
        setting(db, WORKBUDDY_MODEL_KEY)?,
        setting(db, WORKBUDDY_GROUP_KEY)?,
    ) else {
        return Ok(None);
    };
    let config = read_workbuddy_config().ok_or(CHANGED)?;
    if !workbuddy_config_matches(&config, &model) {
        return Err(CHANGED.into());
    }
    let models = config["models"].as_array().ok_or(CHANGED)?;
    let key = models
        .iter()
        .find(|item| item["id"].as_str() == Some(&model))
        .and_then(|item| item["apiKey"].as_str())
        .ok_or(CHANGED)?;
    // YuanHeng projects one tool/group credential across the entire catalog.
    // Mixed keys or duplicate model IDs would make the actual UI selection
    // ambiguous, so never choose one row arbitrarily after an external edit.
    let mut ids = BTreeSet::new();
    if !models.iter().all(|item| {
        item["apiKey"].as_str() == Some(key)
            && item["id"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && ids.insert(id))
    }) {
        return Err(CHANGED.into());
    }
    Ok(Some(key.to_owned()))
}

fn core_tool_credential(db: &Database, app: &AppType) -> Result<Option<String>, String> {
    if !app.is_additive_mode() {
        // Unlike get_effective_current_provider this lookup never cleans up or
        // writes settings. A stale explicit selection fails closed.
        let selected = match crate::settings::get_current_provider(app) {
            Some(id) => Some(id),
            None => db
                .get_current_provider(app.as_str())
                .map_err(|_| UNAVAILABLE)?,
        };
        if selected.as_deref() != Some(MANAGED_PROVIDER_ID) {
            return Ok(None);
        }
    }
    let Some(provider) = db
        .get_provider_by_id(MANAGED_PROVIDER_ID, app.as_str())
        .map_err(|_| UNAVAILABLE)?
    else {
        return Ok(None);
    };
    if provider.category.as_deref() != Some("managed")
        || provider.uses_managed_account_auth()
        || provider_group(&provider).is_none()
        || provider
            .meta
            .as_ref()
            .and_then(|meta| meta.live_config_managed)
            == Some(false)
    {
        return Ok(None);
    }
    let (base, key) = inline_credentials(&provider.settings_config, app)?;
    if !is_managed_endpoint(&base, &["", "/v1"], false) || !valid_platform_key(&key) {
        return Err(CHANGED.into());
    }
    let live = crate::services::provider::read_live_settings(app.clone()).map_err(|_| CHANGED)?;
    let active = match app {
        AppType::OpenCode => {
            // Additive providers have no DB "current" flag. Require the actual
            // live entry, and honor explicit provider filters/default selection.
            let allowed = !list_contains(&live, "disabled_providers", MANAGED_PROVIDER_ID)
                && live.get("enabled_providers").is_none_or(|list| {
                    list.as_array().is_some_and(|items| {
                        items
                            .iter()
                            .any(|item| item.as_str() == Some(MANAGED_PROVIDER_ID))
                    })
                })
                && live.get("model").is_none_or(|model| {
                    model.as_str().is_some_and(|model| {
                        model.split_once('/').is_some_and(|(id, model)| {
                            id == MANAGED_PROVIDER_ID && !model.is_empty()
                        })
                    })
                });
            allowed
                && live
                    .get("provider")
                    .and_then(|items| items.get(MANAGED_PROVIDER_ID))
                    .is_some_and(|entry| credentials_match(entry, app, &base, &key))
        }
        AppType::Hermes => {
            let selected = live.pointer("/model/provider").and_then(Value::as_str)
                == Some(MANAGED_PROVIDER_ID);
            let no_override = live.pointer("/model/base_url").is_none_or(|url| {
                url.as_str()
                    .is_some_and(|url| url.trim_end_matches('/') == base)
            }) && live
                .pointer("/model/api_key")
                .is_none_or(|value| value.as_str() == Some(&key));
            // YuanHeng writes custom_providers, never the read-only providers
            // dictionary. Duplicate names make effective precedence ambiguous.
            let entries = live
                .get("custom_providers")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter(|entry| entry["name"].as_str() == Some(MANAGED_PROVIDER_ID))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            selected
                && no_override
                && entries.len() == 1
                && credentials_match(entries[0], app, &base, &key)
        }
        AppType::Claude | AppType::Gemini | AppType::GrokBuild => {
            let auth_active = !matches!(app, AppType::Gemini)
                || live
                    .pointer("/config/security/auth/selectedType")
                    .and_then(Value::as_str)
                    == Some("gemini-api-key");
            let (live_base, live_key) = inline_credentials(&live, app)?;
            auth_active
                && ((live_base == base && live_key == key)
                    || (live_key == LOCAL_PROXY_TOKEN && owned_takeover(db, app, &live_base)?))
        }
        _ => false,
    };
    if !active {
        return Err(CHANGED.into());
    }
    Ok(Some(key))
}

fn list_contains(value: &Value, field: &str, id: &str) -> bool {
    value.get(field).is_some_and(|list| {
        // Invalid filters must not accidentally enable an image capability.
        list.as_array()
            .is_none_or(|items| items.iter().any(|item| item.as_str() == Some(id)))
    })
}

fn inline_credentials(settings: &Value, app: &AppType) -> Result<(String, String), String> {
    // Grok's general resolver can consult process environment variables. The
    // managed image route accepts only the persisted inline tool credential.
    if matches!(app, AppType::GrokBuild) {
        let model = settings
            .get("config")
            .and_then(Value::as_str)
            .and_then(crate::grok_config::extract_model_config)
            .ok_or(CHANGED)?;
        return Ok((model.base_url, model.api_key.ok_or(CHANGED)?));
    }
    let provider = Provider::with_id(String::new(), String::new(), settings.clone(), None);
    Ok(provider.resolve_usage_credentials(app))
}

fn credentials_match(settings: &Value, app: &AppType, base: &str, key: &str) -> bool {
    inline_credentials(settings, app)
        .is_ok_and(|(live_base, live_key)| live_base == base && live_key == key)
}

fn owned_takeover(db: &Database, app: &AppType, base: &str) -> Result<bool, String> {
    // Existing async getters initialize missing rows. This SELECT is strictly
    // read-only and checks the current per-app flag, never an old backup.
    let row: Option<(bool, String, u16)> = db
        .conn
        .lock()
        .map_err(|_| UNAVAILABLE)?
        .query_row(
            "SELECT enabled, listen_address, listen_port FROM proxy_config WHERE app_type = ?1",
            [app.as_str()],
            |row| Ok((row.get::<_, i32>(0)? != 0, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| UNAVAILABLE)?;
    let Some((true, host, port)) = row else {
        return Ok(false);
    };
    if port == 0 {
        return Ok(false);
    }
    let host = match host.as_str() {
        "0.0.0.0" | "127.0.0.1" => "127.0.0.1",
        "::" | "::1" | "[::1]" => "[::1]",
        "localhost" => "localhost",
        _ => return Ok(false),
    };
    let suffix = if matches!(app, AppType::GrokBuild) {
        "/grokbuild/v1"
    } else {
        ""
    };
    Ok(base.trim_end_matches('/') == format!("http://{host}:{port}{suffix}"))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::Arc;

    pub struct TestHome {
        pub dir: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
        hermes_home: Option<std::ffi::OsString>,
    }

    impl TestHome {
        pub fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let previous = std::env::var_os("YUANHENG_SWITCH_TEST_HOME");
            let hermes_home = std::env::var_os("HERMES_HOME");
            std::env::set_var("YUANHENG_SWITCH_TEST_HOME", dir.path());
            std::env::set_var("HERMES_HOME", dir.path().join(".hermes"));
            crate::settings::reload_settings().unwrap();
            Self {
                dir,
                previous,
                hermes_home,
            }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("YUANHENG_SWITCH_TEST_HOME", value),
                None => std::env::remove_var("YUANHENG_SWITCH_TEST_HOME"),
            }
            match self.hermes_home.take() {
                Some(value) => std::env::set_var("HERMES_HOME", value),
                None => std::env::remove_var("HERMES_HOME"),
            }
            let _ = crate::settings::reload_settings();
        }
    }

    pub fn install(db: &Arc<Database>, surface: &str, key: &str) {
        let models: Vec<String> = vec!["gpt-6.1-sol".into()];
        if surface == "dsh" {
            dsh::configure(
                &AppState::new(db.clone()),
                key,
                &models[0],
                &models,
                "test-group",
            )
            .unwrap();
        } else if surface == "workbuddy" {
            configure_workbuddy(
                &AppState::new(db.clone()),
                key,
                &models[0],
                &models,
                "test-group",
            )
            .unwrap();
        } else {
            let app = surface.parse::<AppType>().unwrap();
            let provider =
                managed_provider_with_models(&app, key, &models[0], &models, "test-group", "auto")
                    .unwrap();
            db.save_provider(surface, &provider).unwrap();
            if !app.is_additive_mode() {
                db.set_current_provider(surface, MANAGED_PROVIDER_ID)
                    .unwrap();
                crate::settings::set_current_provider(&app, Some(MANAGED_PROVIDER_ID)).unwrap();
            }
            crate::services::provider::write_live_with_common_config(db, &app, &provider).unwrap();
            if matches!(app, AppType::Hermes) {
                crate::hermes_config::apply_switch_defaults(
                    MANAGED_PROVIDER_ID,
                    &provider.settings_config,
                )
                .unwrap();
            }
        }
    }

    pub fn enable(db: &Database, surface: &str, enabled: bool) {
        let mut skill = db
            .get_installed_skill("builtin:meta-api-imagegen")
            .unwrap()
            .unwrap_or(crate::app_config::InstalledSkill {
                id: "builtin:meta-api-imagegen".into(),
                name: "Image fixture".into(),
                description: None,
                directory: "meta-api-imagegen".into(),
                repo_owner: None,
                repo_name: None,
                repo_branch: None,
                readme_url: None,
                apps: Default::default(),
                installed_at: 0,
                content_hash: None,
                updated_at: 0,
            });
        crate::services::skill::ImagegenTarget::parse(surface)
            .unwrap()
            .set_enabled(&mut skill.apps, enabled);
        db.save_skill(&skill).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{install, TestHome};
    use super::*;
    use std::sync::Arc;

    const TARGETS: &[&str] = &[
        "claude",
        "gemini",
        "grokbuild",
        "opencode",
        "hermes",
        "dsh",
        "workbuddy",
    ];

    #[test]
    #[serial_test::serial]
    fn image_credentials_require_each_tools_live_managed_configuration() {
        let _home = TestHome::new();
        let db = Arc::new(Database::memory().unwrap());
        for target in TARGETS {
            assert!(imagegen_provider(&db, target).unwrap().is_none());
            let key = format!("sk-only-{target}");
            install(&db, target, &key);
            let before = db
                .conn
                .lock()
                .unwrap()
                .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
                .unwrap();
            let provider = imagegen_provider(&db, target).unwrap().unwrap();
            assert_eq!(provider.settings_config["auth"]["OPENAI_API_KEY"], key);
            assert_eq!(provider.settings_config["base_url"], OPENAI_BASE_URL);
            assert_eq!(
                db.conn
                    .lock()
                    .unwrap()
                    .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                before,
                "lookup must not write {target}"
            );
        }
        for target in ["unknown", "codex-other", "chatgpt", ""] {
            assert!(imagegen_provider(&db, target).is_err());
        }
    }

    #[test]
    #[serial_test::serial]
    fn historical_or_oauth_providers_and_stale_selection_are_not_image_accounts() {
        let home = TestHome::new();
        let db = Arc::new(Database::memory().unwrap());
        for target in ["claude", "gemini", "grokbuild", "opencode", "hermes"] {
            install(&db, target, &format!("sk-{target}"));
            let mut provider = db
                .get_provider_by_id(MANAGED_PROVIDER_ID, target)
                .unwrap()
                .unwrap();
            let original = provider.clone();
            provider.category = Some("custom".into());
            db.save_provider(target, &provider).unwrap();
            assert!(imagegen_provider(&db, target).unwrap().is_none());
            provider = original.clone();
            provider
                .meta
                .get_or_insert_with(Default::default)
                .provider_type = Some("codex_oauth".into());
            db.save_provider(target, &provider).unwrap();
            assert!(imagegen_provider(&db, target).unwrap().is_none());
            db.save_provider(target, &original).unwrap();
        }
        crate::settings::set_current_provider(&AppType::Claude, Some("deleted-provider")).unwrap();
        let settings_path = home.dir.path().join(".yuanheng-switch/settings.json");
        let before = std::fs::read(&settings_path).ok();
        assert!(imagegen_provider(&db, "claude").unwrap().is_none());
        assert_eq!(
            crate::settings::get_current_provider(&AppType::Claude).as_deref(),
            Some("deleted-provider")
        );
        assert_eq!(std::fs::read(settings_path).ok(), before);
    }

    #[test]
    #[serial_test::serial]
    fn additive_filters_default_selection_and_live_edits_fail_closed() {
        let _home = TestHome::new();
        let db = Arc::new(Database::memory().unwrap());
        install(&db, "opencode", "sk-open");
        let original = crate::opencode_config::read_opencode_config().unwrap();
        for patch in [
            json!({"disabled_providers":[MANAGED_PROVIDER_ID]}),
            json!({"enabled_providers":["other"]}),
            json!({"model":"other/text"}),
            json!({"provider":{}}),
        ] {
            let mut live = original.clone();
            for (key, value) in patch.as_object().unwrap() {
                live[key] = value.clone();
            }
            crate::opencode_config::write_opencode_config(&live).unwrap();
            assert!(imagegen_provider(&db, "opencode").is_err());
        }
        crate::opencode_config::write_opencode_config(&original).unwrap();
        install(&db, "hermes", "sk-hermes");
        let mut model = crate::hermes_config::get_model_config().unwrap().unwrap();
        model.provider = Some("other".into());
        crate::hermes_config::set_model_config(&model).unwrap();
        assert!(imagegen_provider(&db, "hermes").is_err());
        install(&db, "gemini", "sk-gemini");
        crate::gemini_config::write_google_oauth_settings().unwrap();
        assert!(imagegen_provider(&db, "gemini").is_err());
        install(&db, "claude", "sk-claude");
        let path = crate::config::get_claude_settings_path();
        let mut live: Value = crate::config::read_json_file(&path).unwrap();
        live["env"]["ANTHROPIC_AUTH_TOKEN"] = json!("sk-external-modification");
        crate::config::write_json_file(&path, &live).unwrap();
        assert!(imagegen_provider(&db, "claude").is_err());
    }

    #[test]
    #[serial_test::serial]
    fn desktop_credentials_require_owned_current_files_and_survive_no_restore() {
        let home = TestHome::new();
        let db = Arc::new(Database::memory().unwrap());
        install(&db, "workbuddy", "sk-workbuddy");
        let original = read_workbuddy_config().unwrap();
        for pointer in ["/models/0/url", "/models/0/vendor"] {
            let mut live = original.clone();
            *live.pointer_mut(pointer).unwrap() = json!("external-secret-value");
            crate::config::write_json_file(&workbuddy_config_path(), &live).unwrap();
            let error = imagegen_provider(&db, "workbuddy").unwrap_err();
            assert!(!error.contains("external-secret-value"));
        }
        let mut duplicate = original.clone();
        duplicate["models"]
            .as_array_mut()
            .unwrap()
            .push(original["models"][0].clone());
        crate::config::write_json_file(&workbuddy_config_path(), &duplicate).unwrap();
        assert!(imagegen_provider(&db, "workbuddy").is_err());
        crate::config::write_json_file(&workbuddy_config_path(), &original).unwrap();
        restore_workbuddy_config(&AppState::new(db.clone())).unwrap();
        assert!(imagegen_provider(&db, "workbuddy").unwrap().is_none());

        install(&db, "dsh", "sk-dsh");
        let path = home.dir.path().join(".dsh/.credentials.yaml");
        let original = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, original.replace("sk-dsh", "sk-external-secret")).unwrap();
        let error = imagegen_provider(&db, "dsh").unwrap_err();
        assert!(!error.contains("sk-external-secret"));
        std::fs::write(path, original).unwrap();
        dsh::restore(&AppState::new(db.clone())).unwrap();
        assert!(imagegen_provider(&db, "dsh").unwrap().is_none());
    }

    #[test]
    fn api_credentials_never_accept_oauth_or_placeholders() {
        for key in [
            "",
            "PROXY_MANAGED",
            "YOUR_API_KEY",
            "sk-YOUR_API_KEY",
            "eyJjwt.secret",
            "ya29.secret",
            "sk-ant-oat-secret",
            "{\"access_token\":\"secret\"}",
            "${API_KEY}",
            "sk-key\nheader",
        ] {
            assert!(!valid_platform_key(key));
        }
        assert!(valid_platform_key("sk-isolated-fixture"));
    }

    #[test]
    #[serial_test::serial]
    fn owned_text_takeover_uses_real_key_and_rejects_stale_ports_or_flags() {
        let _home = TestHome::new();
        let db = Arc::new(Database::memory().unwrap());
        for target in ["claude", "gemini", "grokbuild"] {
            install(&db, target, &format!("sk-{target}"));
            let app = target.parse::<AppType>().unwrap();
            let mut live = crate::services::provider::read_live_settings(app.clone()).unwrap();
            let base = if target == "grokbuild" {
                "http://127.0.0.1:15721/grokbuild/v1"
            } else {
                "http://127.0.0.1:15721"
            };
            match app {
                AppType::Claude => {
                    live["env"]["ANTHROPIC_BASE_URL"] = json!(base);
                    live["env"]["ANTHROPIC_AUTH_TOKEN"] = json!(LOCAL_PROXY_TOKEN);
                    crate::config::write_json_file(
                        &crate::config::get_claude_settings_path(),
                        &live,
                    )
                    .unwrap();
                }
                AppType::Gemini => {
                    let mut env = crate::gemini_config::read_gemini_env().unwrap();
                    env.insert("GOOGLE_GEMINI_BASE_URL".into(), base.into());
                    env.insert("GEMINI_API_KEY".into(), LOCAL_PROXY_TOKEN.into());
                    crate::gemini_config::write_gemini_env_atomic(&env).unwrap();
                }
                AppType::GrokBuild => {
                    let text = live["config"]
                        .as_str()
                        .unwrap()
                        .replace(OPENAI_BASE_URL, base)
                        .replace(&format!("sk-{target}"), LOCAL_PROXY_TOKEN);
                    std::fs::write(crate::grok_config::get_grok_config_path(), text).unwrap();
                }
                _ => unreachable!(),
            }
            assert!(imagegen_provider(&db, target).is_err());
            db.conn.lock().unwrap().execute("UPDATE proxy_config SET enabled=1, listen_address='127.0.0.1', listen_port=15721 WHERE app_type=?1", [target]).unwrap();
            let provider = imagegen_provider(&db, target).unwrap().unwrap();
            assert_eq!(
                provider.settings_config["auth"]["OPENAI_API_KEY"],
                format!("sk-{target}")
            );
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE proxy_config SET listen_port=15722 WHERE app_type=?1",
                    [target],
                )
                .unwrap();
            assert!(imagegen_provider(&db, target).is_err());
        }
    }
}
