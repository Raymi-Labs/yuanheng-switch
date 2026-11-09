use super::*;
use crate::database::CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID as OFFICIAL;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDesktopAccountModeStatus {
    mode: String,
    yuanheng_available: bool,
    restart_required: bool,
}

pub(super) fn status(state: &AppState) -> Result<ClaudeDesktopAccountModeStatus, String> {
    if !cfg!(any(target_os = "macos", windows)) {
        return Ok(ClaudeDesktopAccountModeStatus {
            mode: "unknown".into(),
            yuanheng_available: false,
            restart_required: false,
        });
    }
    let mode = crate::claude_desktop_config::account_mode().map_err(|e| e.to_string())?;
    let saved = state
        .db
        .get_provider_by_id(MANAGED_PROVIDER_ID, "claude-desktop")
        .map_err(|e| e.to_string())?;
    Ok(ClaudeDesktopAccountModeStatus {
        mode: mode.into(),
        yuanheng_available: saved
            .as_ref()
            .is_some_and(|p| provider_has_credentials(p, &AppType::ClaudeDesktop)),
        restart_required: false,
    })
}

pub(super) fn is_official(state: &AppState) -> bool {
    status(state).is_ok_and(|s| s.mode == "official")
}

fn switch(
    state: &AppState,
    mode: &str,
    expected: Option<&str>,
) -> Result<ClaudeDesktopAccountModeStatus, String> {
    let _guard = reasoning::configuration_lock()?;
    if !matches!(mode, "official" | "yuanheng") {
        return Err("不支持的 Claude Desktop 使用方式".into());
    }
    let before = status(state)?;
    if expected.is_some_and(|value| value != before.mode) {
        return Err("Claude Desktop 配置刚刚被其他程序修改，请重新检测后再切换".into());
    }
    let app = AppType::ClaudeDesktop;
    let previous_local = crate::settings::get_current_provider(&app);
    let previous_db = state
        .db
        .get_current_provider(app.as_str())
        .map_err(|e| e.to_string())?;
    let id = if mode == "official" {
        OFFICIAL
    } else {
        MANAGED_PROVIDER_ID
    };
    if mode == "official" {
        state
            .db
            .ensure_official_seed_by_id(OFFICIAL, app.clone())
            .map_err(|e| e.to_string())?;
    } else if !before.yuanheng_available {
        return Err("请先为 Claude Desktop 选择模型并应用一次元衡配置".into());
    }
    let provider = state
        .db
        .get_provider_by_id(id, app.as_str())
        .map_err(|e| e.to_string())?
        .ok_or("Claude Desktop 配置不存在")?;
    let result = crate::claude_desktop_config::apply_account_provider(&state.db, &provider, || {
        state.db.set_current_provider(app.as_str(), id)?;
        crate::settings::set_current_provider(&app, Some(id))
    });
    if let Err(error) = result {
        let restore_db = match previous_db.as_deref() {
            Some(id) => state.db.set_current_provider(app.as_str(), id),
            None => state.db.clear_current_provider(app.as_str()),
        };
        let restore_local = crate::settings::set_current_provider(&app, previous_local.as_deref());
        if let Err(restore) = restore_db.and(restore_local) {
            return Err(format!("{error}；供应商状态恢复失败：{restore}"));
        }
        return Err(error.to_string());
    }
    remember_tool_configured_at(state, app.as_str());
    let mut result = status(state)?;
    if result.mode != mode {
        return Err("Claude Desktop 配置写入后核验失败".into());
    }
    result.restart_required = true;
    Ok(result)
}

#[tauri::command]
pub fn get_claude_desktop_account_mode(
    state: State<'_, AppState>,
) -> Result<ClaudeDesktopAccountModeStatus, String> {
    status(&state)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn switch_claude_desktop_account_mode(
    state: State<'_, AppState>,
    mode: String,
    expectedMode: Option<String>,
) -> Result<ClaudeDesktopAccountModeStatus, String> {
    if !matches!(mode.as_str(), "official" | "yuanheng") {
        return Err("不支持的 Claude Desktop 使用方式".into());
    }
    let before = status(&state)?;
    if expectedMode
        .as_deref()
        .is_some_and(|value| value != before.mode)
    {
        return Err("Claude Desktop 配置刚刚被其他程序修改，请重新检测后再切换".into());
    }
    if mode == "yuanheng" {
        if !before.yuanheng_available {
            return Err("请先为 Claude Desktop 选择模型并应用一次元衡配置".into());
        }
        state
            .proxy_service
            .start()
            .await
            .map_err(|e| format!("启动本地路由失败：{e}"))?;
    }
    switch(&state, &mode, expectedMode.as_deref())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial]
    fn claude_account_mode_roundtrip_preserves_saved_relay_and_official_skips_repair() {
        let (_home, state) = super::super::tests::isolated_state();
        assert_eq!(status(&state).unwrap().mode, "official");
        assert!(switch(&state, "yuanheng", None).is_err());
        configure_tool_with_models(
            &state,
            AppType::ClaudeDesktop,
            "synthetic",
            "claude-sonnet-5",
            &["claude-sonnet-5".into()],
            "saved-group",
            "auto",
        )
        .unwrap();
        let original = state
            .db
            .get_provider_by_id(MANAGED_PROVIDER_ID, "claude-desktop")
            .unwrap()
            .unwrap();
        assert_eq!(status(&state).unwrap().mode, "yuanheng");
        assert!(switch(&state, "official", Some("official")).is_err());
        let official = switch(&state, "official", Some("yuanheng")).unwrap();
        assert_eq!(official.mode, "official");
        assert!(official.restart_required);
        assert!(configure_tool_with_models(
            &state,
            AppType::ClaudeDesktop,
            "late-token",
            "claude-sonnet-5",
            &["claude-sonnet-5".into()],
            "late-group",
            "auto"
        )
        .is_err());
        assert_eq!(status(&state).unwrap().mode, "official");
        let tool = tool_status(
            &state,
            AppType::ClaudeDesktop,
            &YuanhengConnectionStatus::default(),
        );
        assert!(tool.supported && tool.configured && !tool.needs_update);
        assert_eq!(
            switch(&state, "yuanheng", Some("official")).unwrap().mode,
            "yuanheng"
        );
        let restored = state
            .db
            .get_provider_by_id(MANAGED_PROVIDER_ID, "claude-desktop")
            .unwrap()
            .unwrap();
        assert_eq!(original.settings_config, restored.settings_config);
        assert_eq!(original.notes, restored.notes);
    }
}
