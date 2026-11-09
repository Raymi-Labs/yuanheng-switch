#![allow(non_snake_case)]

use tauri::State;

use crate::session_sync::{self, PendingSummary, SessionSyncState, SyncOutcome, SyncScope};
use crate::store::AppState;

#[tauri::command]
pub async fn get_session_sync_targets() -> Result<Vec<String>, String> {
    Ok(session_sync::writable_providers()
        .iter()
        .map(|s| s.to_string())
        .collect())
}

#[tauri::command]
pub async fn check_session_sync(
    state: State<'_, AppState>,
    targetProvider: String,
    scope: Option<SyncScope>,
) -> Result<PendingSummary, String> {
    let db = state.db.clone();
    let scope = scope.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        session_sync::check_pending(&db, &targetProvider, &scope)
    })
    .await
    .map_err(|e| format!("Failed to check session sync: {e}"))?
}

#[tauri::command]
pub async fn run_session_sync(
    state: State<'_, AppState>,
    targetProvider: String,
    scope: Option<SyncScope>,
) -> Result<SyncOutcome, String> {
    let db = state.db.clone();
    let scope = scope.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        session_sync::run_sync(&db, &targetProvider, &scope)
    })
    .await
    .map_err(|e| format!("Failed to run session sync: {e}"))?
}

#[tauri::command]
pub async fn undo_session_sync(
    state: State<'_, AppState>,
    targetProvider: String,
    targetSessionId: String,
) -> Result<bool, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_sync::undo_sync(&db, &targetProvider, &targetSessionId)
    })
    .await
    .map_err(|e| format!("Failed to undo session sync: {e}"))?
}

#[tauri::command]
pub async fn list_session_sync_states(
    state: State<'_, AppState>,
) -> Result<Vec<SessionSyncState>, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || session_sync::list_states(&db))
        .await
        .map_err(|e| format!("Failed to list session sync states: {e}"))?
}

#[tauri::command]
pub async fn get_session_sync_prefs(
    state: State<'_, AppState>,
) -> Result<session_sync::prefs::SessionSyncPrefs, String> {
    Ok(session_sync::prefs::load(&state.db))
}

#[tauri::command]
pub async fn set_session_sync_prefs(
    state: State<'_, AppState>,
    prefs: session_sync::prefs::SessionSyncPrefs,
) -> Result<session_sync::prefs::SessionSyncPrefs, String> {
    session_sync::prefs::save(&state.db, &prefs)?;
    Ok(session_sync::prefs::load(&state.db))
}

#[tauri::command]
pub async fn mute_session_sync_directories(
    state: State<'_, AppState>,
    targetProvider: String,
    projectDirs: Vec<String>,
) -> Result<session_sync::prefs::SessionSyncPrefs, String> {
    session_sync::prefs::mute(&state.db, &targetProvider, &projectDirs)
}

/// 启动前检测：总开关关闭时直接返回空；否则只看启动目录（未给目录时看全部），
/// 并剔除"不再提醒"的目录与只剩分叉的目录。
#[tauri::command]
pub async fn check_session_sync_before_launch(
    state: State<'_, AppState>,
    targetProvider: String,
    projectDir: Option<String>,
) -> Result<PendingSummary, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_sync::check_before_launch(&db, &targetProvider, projectDir.as_deref())
    })
    .await
    .map_err(|e| format!("Failed to check session sync: {e}"))?
}

#[tauri::command]
pub async fn preview_project_sync(
    sourceProvider: String,
    targetProvider: String,
) -> Result<session_sync::projects::ProjectSyncPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session_sync::projects::preview(&sourceProvider, &targetProvider)
    })
    .await
    .map_err(|e| format!("Failed to preview project sync: {e}"))?
}

#[tauri::command]
pub async fn run_project_sync(
    sourceProvider: String,
    targetProvider: String,
) -> Result<session_sync::projects::ProjectSyncOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session_sync::projects::sync(&sourceProvider, &targetProvider)
    })
    .await
    .map_err(|e| format!("Failed to run project sync: {e}"))?
}

#[tauri::command]
pub async fn repair_codex_project_map(
    expected: Option<String>,
) -> Result<session_sync::projects::codex_local_map::CodexProjectMapRepairResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session_sync::projects::codex_local_map::repair_codex_project_map(expected)
    })
    .await
    .map_err(|e| format!("恢复 Codex 项目列表失败: {e}"))?
}

#[tauri::command]
pub async fn check_project_sync_before_launch(
    state: State<'_, AppState>,
    targetProvider: String,
) -> Result<Option<session_sync::projects::ProjectSyncPreview>, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_sync::projects::preview_before_launch(&db, &targetProvider)
    })
    .await
    .map_err(|e| format!("Failed to check project sync: {e}"))
}

#[tauri::command]
pub async fn mute_project_sync(
    state: State<'_, AppState>,
    targetProvider: String,
) -> Result<session_sync::prefs::SessionSyncPrefs, String> {
    session_sync::prefs::mute_project_target(&state.db, &targetProvider)
}
