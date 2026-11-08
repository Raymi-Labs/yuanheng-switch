use super::*;

// Deliberately no Debug: the key is only serialized for the transient guide.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginGuide {
    api_key: String,
    group: String,
}

fn oauth_login_material_present(path: &std::path::Path) -> Result<bool, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let auth: Value = serde_json::from_slice(&bytes)
                .map_err(|_| "无法确认 Codex 登录状态，请检查后重新应用配置".to_string())?;
            if !auth.is_object() {
                return Err("无法确认 Codex 登录状态，请检查后重新应用配置".into());
            }
            // API key login does not restore ChatGPT account features. Metadata
            // such as last_refresh is not evidence of OAuth credentials either.
            Ok(auth["auth_mode"].as_str() != Some("apikey")
                && ["access_token", "refresh_token", "id_token"]
                    .iter()
                    .any(|key| {
                        auth.get("tokens")
                            .and_then(|tokens| tokens.get(*key))
                            .and_then(Value::as_str)
                            .is_some_and(|token| !token.trim().is_empty())
                    }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("无法读取 Codex 登录状态，请检查后重新应用配置".into()),
    }
}

fn prepare(state: &AppState, user_id: &str) -> Result<Option<CodexLoginGuide>, String> {
    let connection = read_cached_status(state)?;
    if !connection.connected
        || user_id.is_empty()
        || connection.user_id.as_deref() != Some(user_id)
        || get_yuanheng_secret(state, USER_ID_KEY)?.as_deref() != Some(user_id)
        || get_yuanheng_secret(state, SESSION_COOKIE_KEY)?.is_none_or(|s| s.is_empty())
    {
        return Err("账号已变更，请重新应用 Codex 配置".into());
    }
    if !managed_codex_surface_route_active(&state.db, CodexSurface::Desktop)
        || oauth_login_material_present(&crate::codex_config::get_codex_auth_path())?
    {
        return Ok(None);
    }
    let provider = managed_codex_provider_for_namespace(state, CHATGPT_DESKTOP_NAMESPACE)?
        .ok_or_else(|| "请先应用 Codex 桌面配置".to_string())?;
    if provider.settings_config["yuanhengLoginGuideOwner"].as_str() != Some(user_id) {
        return Err("请为当前账号重新应用 Codex 配置".into());
    }
    let group =
        provider_group(&provider).ok_or_else(|| "请重新选择 Codex 分组并应用配置".to_string())?;
    let api_key = stored_tool_credential(state, CHATGPT_DESKTOP_NAMESPACE, &group, None)?
        .ok_or_else(|| "请重新应用 Codex 配置以准备令牌".to_string())?;
    if get_yuanheng_secret(state, USER_ID_KEY)?.as_deref() != Some(user_id) {
        return Err("账号已变更，请重新应用 Codex 配置".into());
    }
    Ok(Some(CodexLoginGuide { api_key, group }))
}

#[tauri::command]
pub async fn get_codex_login_guide(
    state: State<'_, AppState>,
    user_id: String,
) -> Result<Option<CodexLoginGuide>, String> {
    let _guard = codex_account_mode_switch_lock().lock().await;
    prepare(&state, &user_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn codex_login_guide_distinguishes_login_from_empty_or_unknown_auth() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        assert!(!oauth_login_material_present(&path).unwrap());
        for auth in [
            json!({}),
            json!({"auth_mode": "apikey", "OPENAI_API_KEY": null}),
            json!({"OPENAI_API_KEY": "synthetic"}),
            json!({"last_refresh": "2026-11-09"}),
            json!({"tokens": {"access_token": " "}}),
            json!({"auth_mode": "apikey", "tokens": {"access_token": "stale"}}),
        ] {
            std::fs::write(&path, auth.to_string()).unwrap();
            assert!(!oauth_login_material_present(&path).unwrap());
        }
        for auth in [
            json!({"tokens": {"refresh_token": "synthetic"}}),
            json!({"tokens": {"access_token": "synthetic"}}),
        ] {
            std::fs::write(&path, auth.to_string()).unwrap();
            assert!(oauth_login_material_present(&path).unwrap());
        }
        for text in ["broken-json", "null", "[]"] {
            std::fs::write(&path, text).unwrap();
            assert!(oauth_login_material_present(&path).is_err());
        }
    }

    #[tokio::test]
    #[serial]
    async fn codex_login_guide_uses_configured_desktop_key_and_preserves_auth() {
        let (_home, state) = super::super::tests::isolated_state();
        persist_connection(
            &state,
            "session=synthetic",
            "42",
            "sk-general",
            1,
            &YuanhengConnectionStatus::default(),
        )
        .unwrap();
        assert!(prepare(&state, "42").unwrap().is_none());
        let mut config = state.db.get_proxy_config().await.unwrap();
        config.listen_port = 0;
        state.db.update_proxy_config(config).await.unwrap();
        state.proxy_service.start().await.unwrap();
        configure_codex_surface(
            &state,
            CodexSurface::Desktop,
            "sk-desktop",
            "test-model",
            &["test-model".into()],
            "premium",
            "auto",
        )
        .await
        .unwrap();
        let guide = prepare(&state, "42").unwrap().unwrap();
        assert_eq!(guide.api_key, "sk-desktop");
        assert_eq!(guide.group, "premium");
        assert!(!crate::codex_config::get_codex_auth_path().exists());
        assert!(prepare(&state, "other").is_err());
        let auth = crate::codex_config::get_codex_auth_path();
        let api_auth = r#"{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-existing"}"#;
        std::fs::write(&auth, api_auth).unwrap();
        assert!(prepare(&state, "42").unwrap().is_some());
        assert_eq!(std::fs::read_to_string(&auth).unwrap(), api_auth);
        let original = r#"{"tokens":{"access_token":"synthetic-official"}}"#;
        std::fs::write(&auth, original).unwrap();
        assert!(prepare(&state, "42").unwrap().is_none());
        assert_eq!(std::fs::read_to_string(&auth).unwrap(), original);
        std::fs::remove_file(&auth).unwrap();
        persist_connection(
            &state,
            "session=other",
            "43",
            "sk-other",
            2,
            &YuanhengConnectionStatus::default(),
        )
        .unwrap();
        assert!(
            prepare(&state, "43").is_err(),
            "old provider must not reveal another account's key"
        );
        state.proxy_service.stop().await.unwrap();
    }
}
