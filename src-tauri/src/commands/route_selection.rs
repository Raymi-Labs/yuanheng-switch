use crate::{
    core_daemon::CoreSupervisor,
    route_selection::{Policy, Status},
    store::AppState,
};

async fn call(
    state: &AppState,
    action: &str,
    body: Option<serde_json::Value>,
) -> Result<Status, String> {
    CoreSupervisor::new(crate::config::get_app_config_dir())
        .route_request(&state.db, action, body)
        .await
}

#[tauri::command]
pub async fn get_yuanheng_route_status(
    state: tauri::State<'_, AppState>,
) -> Result<Status, String> {
    call(&state, "", None).await
}
#[tauri::command]
pub async fn set_yuanheng_route_policy(
    state: tauri::State<'_, AppState>,
    policy: Policy,
    revision: u64,
) -> Result<Status, String> {
    call(
        &state,
        "/policy",
        Some(serde_json::json!({"policy":policy,"revision":revision})),
    )
    .await
}
#[tauri::command]
pub async fn probe_yuanheng_routes(
    state: tauri::State<'_, AppState>,
    stream: bool,
) -> Result<Status, String> {
    call(&state, "/probe", Some(serde_json::json!({"stream":stream}))).await
}
#[tauri::command]
pub async fn cancel_yuanheng_route_probe(
    state: tauri::State<'_, AppState>,
    operation_id: String,
) -> Result<Status, String> {
    call(
        &state,
        "/cancel",
        Some(serde_json::json!({"operationId":operation_id})),
    )
    .await
}
