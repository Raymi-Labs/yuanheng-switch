use crate::services::native_plugins::{self, InstallPlan, PluginStatus, Verification};
fn custom(app: &tauri::AppHandle, tool: &str) -> Option<String> {
    crate::app_store::get_desktop_app_path_from_store(app, tool)
}
#[tauri::command]
pub async fn get_native_plugins(
    app: tauri::AppHandle,
    tool: String,
) -> Result<PluginStatus, String> {
    let path = custom(&app, &tool);
    native_plugins::status(tool, path).await
}
#[tauri::command]
pub async fn plan_native_plugin(
    app: tauri::AppHandle,
    tool: String,
    target_id: String,
    source: Option<String>,
    builtin_id: Option<String>,
) -> Result<InstallPlan, String> {
    let path = custom(&app, &tool);
    native_plugins::plan(tool, path, target_id, source, builtin_id).await
}
#[tauri::command]
pub async fn install_native_plugin(
    app: tauri::AppHandle,
    tool: String,
    target_id: String,
    token: String,
) -> Result<(), String> {
    let path = custom(&app, &tool);
    native_plugins::install(tool, path, target_id, token).await
}
#[tauri::command]
pub async fn native_plugin_action(
    app: tauri::AppHandle,
    tool: String,
    target_id: String,
    id: String,
    action: String,
) -> Result<Verification, String> {
    let path = custom(&app, &tool);
    native_plugins::action(tool, path, target_id, id, action).await
}
