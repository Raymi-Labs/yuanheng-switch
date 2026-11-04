//! Managed reasoning defaults. Native session overrides remain authoritative.
use super::*;

pub(super) fn configuration_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.try_lock()
        .map_err(|_| "另一个工具配置操作尚未结束，请稍后重试".into())
}

pub(super) fn tool_levels(app: &str, model: &str, levels: &[String]) -> Vec<String> {
    static RULES: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    let rules = RULES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../src/data/agent-reasoning-controls.json"
        ))
        .expect("reasoning capability rules")
    });
    let Some(rule) = rules.get(app) else {
        return Vec::new();
    };
    if rule["modelPrefixes"].as_array().is_some_and(|prefixes| {
        !prefixes
            .iter()
            .filter_map(Value::as_str)
            .any(|p| model.starts_with(p))
    }) {
        return Vec::new();
    }
    levels
        .iter()
        .filter(|level| {
            level.as_str() != "auto"
                && rule["levels"].as_array().is_none_or(|accepted| {
                    accepted.iter().any(|a| a.as_str() == Some(level.as_str()))
                })
        })
        .cloned()
        .collect()
}

pub(super) fn resolve(
    app: &str,
    model: &str,
    requested: Option<&str>,
    catalog: &HashMap<String, Vec<String>>,
) -> Result<String, String> {
    let level = resolve_reasoning_level(requested, model, catalog)?;
    let levels = catalog
        .get(model)
        .cloned()
        .unwrap_or_else(|| fallback_reasoning_levels(model));
    if level != "auto" && !tool_levels(app, model, &levels).contains(&level) {
        return Err(format!(
            "{app} 当前原生配置不支持模型 {model} 的推理等级 {level}；请使用自动或工具支持的档位"
        ));
    }
    Ok(level)
}

pub(super) fn project(app: &AppType, model: &str, level: &str, settings: &mut Value) {
    match app {
        AppType::Claude if level != "auto" => {
            settings["env"]["CLAUDE_CODE_EFFORT_LEVEL"] = json!(level);
        }
        AppType::OpenCode if level != "auto" => {
            settings["models"][model]["options"] = json!({"reasoningEffort":level});
        }
        AppType::OpenClaw => {
            let catalog = load_local_reasoning_profiles();
            if let Some(models) = settings["models"].as_array_mut() {
                for entry in models {
                    let id = entry["id"].as_str().unwrap_or_default();
                    let supported = reasoning_profile_for_model(id, &catalog)
                        .map(|p| p.supported_levels)
                        .unwrap_or_default();
                    if !supported.is_empty() {
                        entry["reasoning"] = json!(true);
                        entry["compat"] = json!({"supportedReasoningEfforts":supported,"supportsReasoningEffort":true});
                        if supported.iter().any(|s| s == "none") {
                            entry["compat"]["reasoningEffortMap"] = json!({"off":"none"});
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

pub(super) fn workbuddy_model(
    model: &str,
    selected: &str,
    level: &str,
    catalog: &HashMap<String, crate::model_reasoning::ReasoningProfile>,
) -> Value {
    let mut value = json!({"id":model,"name":model,"vendor":MANAGED_PROVIDER_DISPLAY_NAME,
        "url":format!("{OPENAI_BASE_URL}/chat/completions"),"maxInputTokens":200000,
        "maxOutputTokens":8192,"supportsToolCall":true,"supportsImages":true});
    let levels = reasoning_profile_for_model(model, catalog)
        .map(|p| tool_levels("workbuddy", model, &p.supported_levels))
        .unwrap_or_default();
    value["supportsReasoning"] = json!(!levels.is_empty());
    if !levels.is_empty() {
        value["reasoning"] = json!({"supportedEfforts":levels});
    }
    if model == selected && level != "auto" {
        value["reasoning"]["defaultEffort"] = json!(level);
    }
    value
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct OwnedField {
    path: Vec<String>,
    before: Option<Value>,
    written: Value,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct Change {
    prior: Option<OwnedField>,
    next: Option<OwnedField>,
}
fn key(app: &str) -> String {
    format!("yuanheng_reasoning_owned_v1_{app}")
}
fn read(app: &str) -> Result<Value, String> {
    match app {
        "gemini" => {
            let p = crate::gemini_config::get_gemini_settings_path();
            if p.exists() {
                crate::config::read_json_file(&p).map_err(|e| e.to_string())
            } else {
                Ok(json!({}))
            }
        }
        "openclaw" => crate::openclaw_config::read_openclaw_config().map_err(|e| e.to_string()),
        "hermes" => serde_json::to_value(
            crate::hermes_config::read_hermes_config().map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string()),
        _ => Err("不支持的推理配置目标".into()),
    }
}
fn write(app: &str, expected: &Value, value: &Value) -> Result<(), String> {
    if read(app)? != *expected {
        return Err("工具配置在读取后发生变化，请重试；未覆盖外部修改".into());
    }
    match app {
        "gemini" => {
            crate::config::write_json_file(&crate::gemini_config::get_gemini_settings_path(), value)
                .map_err(|e| e.to_string())
        }
        "openclaw" => crate::openclaw_config::write_reasoning_agents(
            expected,
            value.get("agents").unwrap_or(&json!({})),
        )
        .map(|_| ())
        .map_err(|e| e.to_string()),
        "hermes" => crate::hermes_config::write_reasoning_agent(
            expected,
            value.get("agent").unwrap_or(&json!({})),
        )
        .map(|_| ())
        .map_err(|e| e.to_string()),
        _ => Err("不支持的推理配置目标".into()),
    }
}
fn at<'a>(root: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(root, |v, k| v.get(k))
}
fn set(root: &mut Value, path: &[String], value: Option<Value>) -> Result<(), String> {
    let (last, parents) = path.split_last().ok_or("空推理配置路径")?;
    let mut node = root;
    for k in parents {
        if node.is_null() {
            *node = json!({});
        }
        node = node
            .as_object_mut()
            .ok_or("推理配置父字段不是对象，原配置保留")?
            .entry(k)
            .or_insert_with(|| json!({}));
    }
    let map = node
        .as_object_mut()
        .ok_or("推理配置字段不是对象，原配置保留")?;
    if let Some(v) = value {
        map.insert(last.clone(), v);
    } else {
        map.remove(last);
    }
    Ok(())
}
fn restore_field(value: &mut Value, field: &OwnedField) -> Result<(), String> {
    if at(value, &field.path) != Some(&field.written) {
        return Err("工具内推理配置已被修改，已保留；请先核对设置再应用".into());
    }
    set(value, &field.path, field.before.clone())
}
fn desired(app: &str, model: &str, level: &str) -> Option<(Vec<String>, Value)> {
    if level == "auto" {
        return None;
    }
    let (path, value) = match app {
        "gemini" => (
            vec!["modelConfigs", "customAliases", model],
            json!({"modelConfig":{"model":model,"generateContentConfig":{"thinkingConfig":{"thinkingLevel":level.to_uppercase()}}}}),
        ),
        "hermes" => (
            vec!["agent", "reasoning_overrides", model],
            json!({"enabled":level != "none", "effort":level}),
        ),
        "openclaw" => (
            vec![
                "agents",
                "defaults",
                "models",
                "__model__",
                "params",
                "thinking",
            ],
            json!(if level == "none" { "off" } else { level }),
        ),
        _ => return None,
    };
    Some((
        path.into_iter()
            .map(|k| {
                if k == "__model__" {
                    format!("{MANAGED_PROVIDER_ID}/{model}")
                } else {
                    k.to_string()
                }
            })
            .collect(),
        value,
    ))
}
pub(super) fn apply(
    state: &AppState,
    app: &str,
    model: &str,
    level: &str,
) -> Result<Option<Change>, String> {
    if !matches!(app, "gemini" | "hermes" | "openclaw") {
        return Ok(None);
    }
    let saved = state.db.get_setting(&key(app)).map_err(|e| e.to_string())?;
    let prior: Option<OwnedField> = saved
        .filter(|s| !s.is_empty())
        .map(|s| serde_json::from_str(&s).map_err(|_| "推理配置归属记录损坏".to_string()))
        .transpose()?;
    let desired = desired(app, model, level);
    if prior.is_none() && desired.is_none() {
        return Ok(None);
    }
    let expected = read(app)?;
    let mut value = expected.clone();
    if let Some(field) = &prior {
        restore_field(&mut value, field)?;
    }
    let next = desired
        .map(|(path, mut written)| {
            let before = at(&value, &path).cloned();
            if app == "gemini" {
                let mut merged = before.clone().unwrap_or_else(|| json!({}));
                if !merged.is_object() {
                    return Err("Gemini模型别名不是对象，原配置保留".to_string());
                }
                let target = merged.pointer("/modelConfig/model").and_then(Value::as_str);
                if target.is_some_and(|id| id != model) {
                    return Err("Gemini已有别名指向其他模型，原配置保留".into());
                }
                set(
                    &mut merged,
                    &["modelConfig".into(), "model".into()],
                    Some(json!(model)),
                )?;
                let mut thinking = merged
                    .pointer("/modelConfig/generateContentConfig/thinkingConfig")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let fields = thinking
                    .as_object_mut()
                    .ok_or("Gemini thinkingConfig不是对象，原配置保留")?;
                fields.remove("thinkingBudget");
                fields.insert("thinkingLevel".into(), json!(level.to_uppercase()));
                set(
                    &mut merged,
                    &[
                        "modelConfig".into(),
                        "generateContentConfig".into(),
                        "thinkingConfig".into(),
                    ],
                    Some(thinking),
                )?;
                written = merged;
            }
            Ok(OwnedField {
                before,
                path,
                written,
            })
        })
        .transpose()?;
    if let Some(field) = &next {
        set(&mut value, &field.path, Some(field.written.clone()))?;
    }
    write(app, &expected, &value)?;
    let change = Change { prior, next };
    if let Err(e) = save(state, app, change.next.as_ref()) {
        rollback(state, app, &change)?;
        return Err(e);
    }
    Ok(Some(change))
}
fn save(state: &AppState, app: &str, field: Option<&OwnedField>) -> Result<(), String> {
    let text = field
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    state
        .db
        .set_setting(&key(app), &text)
        .map_err(|e| e.to_string())
}
pub(super) fn rollback(state: &AppState, app: &str, change: &Change) -> Result<(), String> {
    let expected = read(app)?;
    let mut value = expected.clone();
    if let Some(next) = &change.next {
        restore_field(&mut value, next)?;
    }
    if let Some(prior) = &change.prior {
        set(&mut value, &prior.path, Some(prior.written.clone()))?;
    }
    write(app, &expected, &value)?;
    save(state, app, change.prior.as_ref())
}
pub(super) fn restore(state: &AppState, app: &str) -> Result<(), String> {
    let _guard = configuration_lock()?;
    apply(state, app, "", "auto").map(|_| ())
}

pub(super) fn current(state: &AppState, app: &str, selected: &str) -> bool {
    if !matches!(app, "gemini" | "hermes" | "openclaw") {
        return true;
    }
    let Ok(saved) = state.db.get_setting(&key(app)) else {
        return false;
    };
    let Some(text) = saved.filter(|s| !s.is_empty()) else {
        return selected == "auto";
    };
    let Ok(field) = serde_json::from_str::<OwnedField>(&text) else {
        return false;
    };
    if selected == "auto" {
        return false;
    }
    let matches_selection = match app {
        "gemini" => {
            field
                .written
                .pointer("/modelConfig/generateContentConfig/thinkingConfig/thinkingLevel")
                .and_then(Value::as_str)
                == Some(selected.to_uppercase().as_str())
        }
        "hermes" => field.written["effort"].as_str() == Some(selected),
        "openclaw" => {
            field.written.as_str() == Some(if selected == "none" { "off" } else { selected })
        }
        _ => false,
    };
    matches_selection
        && read(app).is_ok_and(|value| at(&value, &field.path) == Some(&field.written))
}

pub(super) fn projection_current(provider: &Provider, app: &AppType) -> bool {
    let level = provider_reasoning(provider).unwrap_or_else(|| "auto".into());
    let Some(model) = provider_model(provider, app) else {
        return false;
    };
    let actual = match app {
        AppType::Claude => provider.settings_config["env"]["CLAUDE_CODE_EFFORT_LEVEL"]
            .as_str()
            .map(str::to_string),
        AppType::OpenCode => provider.settings_config["models"][&model]["options"]
            ["reasoningEffort"]
            .as_str()
            .map(str::to_string),
        AppType::GrokBuild => provider.settings_config["config"]
            .as_str()
            .and_then(|s| toml::from_str::<toml::Value>(s).ok())
            .and_then(|v| {
                v.get("model")?
                    .get(&model)?
                    .get("reasoning_effort")?
                    .as_str()
                    .map(str::to_string)
            }),
        _ => return true,
    };
    actual == if level == "auto" { None } else { Some(level) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capabilities_never_claim_ignored_native_levels() {
        let all = vec!["low".into(), "ultra".into(), "max".into()];
        assert_eq!(
            tool_levels("workbuddy", "gpt-6-astra", &all),
            vec!["low", "max"]
        );
        assert_eq!(
            tool_levels("gemini", "gpt-6-astra", &all),
            Vec::<String>::new()
        );
        assert_eq!(tool_levels("gemini", "gemini-3-pro", &all), vec!["low"]);
        assert!(resolve(
            "workbuddy",
            "gpt-6-astra",
            Some("ultra"),
            &HashMap::from([("gpt-6-astra".into(), all)])
        )
        .is_err());
    }
    #[test]
    fn workbuddy_consumed_fields_are_per_model_and_auto_omits_effort() {
        let catalog = HashMap::new();
        let high = workbuddy_model("gpt-6-astra", "gpt-6-astra", "high", &catalog);
        assert_eq!(high["reasoning"]["defaultEffort"], "high");
        assert_eq!(high["supportsReasoning"], true);
        assert!(
            workbuddy_model("gpt-6-sol", "gpt-6-astra", "high", &catalog)["reasoning"]
                .get("defaultEffort")
                .is_none()
        );
        assert!(
            workbuddy_model("gpt-6-astra", "gpt-6-astra", "auto", &catalog)["reasoning"]
                .get("defaultEffort")
                .is_none()
        );
    }
    #[test]
    fn field_restore_preserves_neighbors_and_refuses_external_edit() {
        let path = vec![
            "agent".into(),
            "reasoning_overrides".into(),
            "gpt-6-astra".into(),
        ];
        let field = OwnedField {
            path: path.clone(),
            before: Some(json!("low")),
            written: json!({"enabled":true,"effort":"high"}),
        };
        let mut v = json!({"agent":{"reasoning_overrides":{"gpt-6-astra":field.written,"other":"medium"},"max_turns":99}});
        restore_field(&mut v, &field).unwrap();
        assert_eq!(at(&v, &path), Some(&json!("low")));
        assert_eq!(v["agent"]["max_turns"], 99);
        assert!(restore_field(&mut v, &field).is_err());
    }
    #[test]
    #[serial_test::serial]
    fn native_config_roundtrip_changes_effort_and_auto_clears_it() {
        let (_home, state) = super::super::tests::isolated_state();
        for (app, model) in [
            (AppType::Claude, "claude-sonnet-5"),
            (AppType::GrokBuild, "gpt-6-astra"),
            (AppType::OpenCode, "gpt-6-astra"),
        ] {
            for level in ["high", "low", "auto"] {
                configure_tool_with_models(
                    &state,
                    app.clone(),
                    "synthetic-key",
                    model,
                    &[model.into(), "other-model".into()],
                    "synthetic",
                    level,
                )
                .unwrap();
                let actual = match app {
                    AppType::Claude => crate::config::read_json_file::<Value>(
                        &crate::config::get_claude_settings_path(),
                    )
                    .unwrap()["env"]["CLAUDE_CODE_EFFORT_LEVEL"]
                        .as_str()
                        .map(str::to_string),
                    AppType::GrokBuild => {
                        let text =
                            std::fs::read_to_string(crate::grok_config::get_grok_config_path())
                                .unwrap();
                        let v: toml::Value = toml::from_str(&text).unwrap();
                        v["model"][model]
                            .get("reasoning_effort")
                            .and_then(toml::Value::as_str)
                            .map(str::to_string)
                    }
                    AppType::OpenCode => crate::opencode_config::get_providers().unwrap()
                        [MANAGED_PROVIDER_ID]["models"][model]["options"]["reasoningEffort"]
                        .as_str()
                        .map(str::to_string),
                    _ => unreachable!(),
                };
                assert_eq!(
                    actual,
                    if level == "auto" {
                        None
                    } else {
                        Some(level.into())
                    },
                    "{}",
                    app.as_str()
                );
            }
        }
    }
    #[test]
    #[serial_test::serial]
    fn auxiliary_settings_preserve_neighbors_restore_original_and_reject_external_edits() {
        let (_home, state) = super::super::tests::isolated_state();
        for (app, model) in [
            ("gemini", "gemini-3-pro"),
            ("hermes", "gpt-6-astra"),
            ("openclaw", "gpt-6-astra"),
        ] {
            let (_, wanted) = desired(app, model, "high").unwrap();
            let path = desired(app, model, "high").unwrap().0;
            let before = read(app).unwrap();
            let change = apply(&state, app, model, "high").unwrap().unwrap();
            assert_eq!(at(&read(app).unwrap(), &path), Some(&wanted));
            assert!(current(&state, app, "high"));
            rollback(&state, app, &change).unwrap();
            assert_eq!(at(&read(app).unwrap(), &path), at(&before, &path));
            apply(&state, app, model, "low").unwrap();
            apply(&state, app, "other-model", "high").unwrap();
            assert_eq!(at(&read(app).unwrap(), &path), at(&before, &path));
            restore(&state, app).unwrap();
            apply(&state, app, model, "high").unwrap();
            let old = read(app).unwrap();
            let mut modified = old.clone();
            set(&mut modified, &path, Some(json!("external"))).unwrap();
            write(app, &old, &modified).unwrap();
            assert!(!current(&state, app, "high"));
            assert!(apply(&state, app, model, "auto").is_err());
            assert_eq!(read(app).unwrap(), modified);
        }
    }
    #[test]
    #[serial_test::serial]
    fn real_tool_writers_do_not_drop_auxiliary_reasoning() {
        let (_home, state) = super::super::tests::isolated_state();
        for (app, model) in [
            (AppType::Gemini, "gemini-3-pro"),
            (AppType::OpenClaw, "gpt-6-astra"),
            (AppType::Hermes, "gpt-6-astra"),
        ] {
            for level in ["high", "low", "auto"] {
                configure_tool_with_models(
                    &state,
                    app.clone(),
                    "synthetic-key",
                    model,
                    &[model.into()],
                    "synthetic",
                    level,
                )
                .unwrap();
                assert!(
                    current(&state, app.as_str(), level),
                    "{} {level}",
                    app.as_str()
                );
                if level == "auto" {
                    assert!(state
                        .db
                        .get_setting(&key(app.as_str()))
                        .unwrap()
                        .unwrap_or_default()
                        .is_empty());
                }
            }
        }
    }
    #[test]
    #[serial_test::serial]
    fn workbuddy_roundtrip_reports_actual_effort_and_keeps_other_models_automatic() {
        let (_home, state) = super::super::tests::isolated_state();
        for level in ["high", "low", "auto"] {
            configure_workbuddy_reasoning(
                &state,
                "synthetic-key",
                "gpt-6-astra",
                &["gpt-6-astra".into(), "gpt-6-sol".into()],
                "synthetic",
                level,
            )
            .unwrap();
            let v = read_workbuddy_config().unwrap();
            assert_eq!(
                v["models"][0]["reasoning"]["defaultEffort"].as_str(),
                if level == "auto" { None } else { Some(level) }
            );
            assert!(v["models"][1]["reasoning"].get("defaultEffort").is_none());
            let status = workbuddy_status(&state, &YuanhengConnectionStatus::default());
            assert_eq!(status.reasoning.as_deref(), Some(level));
        }
    }
    #[test]
    #[serial_test::serial]
    fn dsh_reasoning_is_in_both_native_profiles_and_restores_cleanly() {
        let (_home, state) = super::super::tests::isolated_state();
        for level in ["high", "low", "auto"] {
            dsh::configure_reasoning(
                &state,
                "synthetic-key",
                "gpt-6-astra",
                &["gpt-6-astra".into()],
                "synthetic",
                level,
            )
            .unwrap();
            let home = crate::commands::dsh_install::home();
            for surface in ["desktop", "web"] {
                let text = std::fs::read_to_string(
                    home.join(format!("profiles/{surface}/cordis.patch.yml")),
                )
                .unwrap();
                let v: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
                assert_eq!(
                    v[1]["config"]["reasoningEffort"].as_str(),
                    if level == "auto" { None } else { Some(level) }
                );
            }
            assert_eq!(
                dsh::status(&state, &YuanhengConnectionStatus::default())
                    .reasoning
                    .as_deref(),
                Some(level)
            );
        }
        assert!(dsh::restore(&state).unwrap());
    }
    #[test]
    #[serial_test::serial]
    fn failed_native_configuration_rolls_reasoning_back_without_losing_user_fields() {
        let (_home, state) = super::super::tests::isolated_state();
        let path = crate::gemini_config::get_gemini_settings_path();
        let original = json!({"modelConfigs":{"customAliases":{"gemini-3-pro":{"modelConfig":{"model":"gemini-3-pro","generateContentConfig":{"temperature":0.3}}}}},"mcpServers":{"keep":{"command":"synthetic"}}});
        crate::config::write_json_file(&path, &original).unwrap();
        // Deterministic write failure, not a credential validation assumption.
        std::fs::create_dir_all(crate::gemini_config::get_gemini_env_path()).unwrap();
        let result = configure_tool_with_models(
            &state,
            AppType::Gemini,
            "",
            "gemini-3-pro",
            &["gemini-3-pro".into()],
            "synthetic",
            "high",
        );
        assert!(result.is_err());
        let now = read("gemini").unwrap();
        assert_eq!(now["modelConfigs"], original["modelConfigs"]);
        assert_eq!(now["mcpServers"], original["mcpServers"]);
        assert!(state
            .db
            .get_setting(&key("gemini"))
            .unwrap()
            .unwrap_or_default()
            .is_empty());
    }
    #[test]
    #[serial_test::serial]
    fn auxiliary_writer_rejects_stale_snapshot_before_overwriting() {
        let (_home, _state) = super::super::tests::isolated_state();
        for app in ["gemini", "hermes", "openclaw"] {
            let expected = read(app).unwrap();
            let mut newer = expected.clone();
            newer["agent"] = json!({"customSetting":123});
            write(app, &expected, &newer).unwrap();
            if app == "openclaw" {
                // this writer intentionally only writes the agents section
                let now = read(app).unwrap();
                let mut changed = now.clone();
                changed["agents"] = json!({"customSetting":456});
                write(app, &now, &changed).unwrap();
            }
            assert!(write(app, &expected, &expected).is_err(), "{app}");
        }
    }
}
