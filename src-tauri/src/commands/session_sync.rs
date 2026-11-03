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
