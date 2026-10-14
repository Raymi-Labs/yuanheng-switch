#[cfg(any(target_os = "macos", test))]
pub(crate) mod credential_session;
mod dsh;
use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;
use std::time::Duration;
#[cfg(target_os = "macos")]
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, COOKIE, SET_COOKIE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::webview::{Cookie, NewWindowResponse};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use toml_edit::DocumentMut;

use crate::app_config::AppType;
use crate::model_capabilities::{is_image_generation_only_model, yuanheng_model_api_format};
use crate::model_reasoning::{
    fallback_reasoning_profile, load_local_reasoning_profiles, reasoning_profile_for_model,
    REASONING_LEVELS,
};
use crate::provider::{
    ClaudeDesktopMode, ClaudeDesktopModelRoute, LocalProxyRequestOverrides, Provider, ProviderMeta,
};
use crate::services::ProviderService;
use crate::store::AppState;

use crate::yuanheng_endpoints::{
    is_managed_endpoint, API_URL as OPENAI_BASE_URL, BASE_URL, COOKIE_DOMAIN, PULSE_URL, TOPUP_URL,
};
const TOPUP_WINDOW_LABEL: &str = "yuanheng-topup";
const PULSE_WINDOW_LABEL: &str = "yuanheng-pulse";
const TOPUP_CLOSED_EVENT: &str = "yuanheng-topup-closed";
pub(crate) const MANAGED_PROVIDER_ID: &str = "yuanheng-managed";
const MANAGED_PROVIDER_DISPLAY_NAME: &str = "YuanHeng";
const MANAGED_PROVIDER_AI_LABEL: &str = "YuanHeng AI";
const TOKEN_KEY: &str = "yuanheng_access_token";
const USER_ID_KEY: &str = "yuanheng_user_id";
const SESSION_COOKIE_KEY: &str = "yuanheng_session_cookie";
const PENDING_SESSION_COOKIE_KEY: &str = "yuanheng_pending_session_cookie";
const API_TOKEN_KEY: &str = "yuanheng_api_token";
const API_TOKEN_ID_KEY: &str = "yuanheng_api_token_id";
const API_TOKEN_GROUP_KEY: &str = "yuanheng_api_token_group";
const CACHE_KEY: &str = "yuanheng_connection_cache";
const PREVIOUS_PROVIDER_KEY_PREFIX: &str = "yuanheng_previous_provider_";
const PREVIOUS_HERMES_MODEL_KEY: &str = "yuanheng_previous_hermes_model";
const PREVIOUS_WORKBUDDY_CONFIG_KEY: &str = "yuanheng_previous_workbuddy_config";
const WORKBUDDY_MODEL_KEY: &str = "yuanheng_workbuddy_model";
const WORKBUDDY_GROUP_KEY: &str = "yuanheng_workbuddy_group";
const TOOL_CONFIGURED_AT_KEY_PREFIX: &str = "yuanheng_tool_configured_at_";
const CHATGPT_DESKTOP_NAMESPACE: &str = "chatgpt-desktop";
const LOCAL_PROXY_TOKEN: &str = "PROXY_MANAGED";
const NO_PREVIOUS_VALUE: &str = "__none__";
const CODEX_OFFICIAL_PROVIDER_ID: &str = crate::database::CODEX_OFFICIAL_PROVIDER_ID;
const CODEX_OFFICIAL_LOGIN_REQUIRED: &str = "未检测到 OpenAI 官方登录。中转账号请使用“元衡中转”；如需官方模式，请先在 Codex 中登录 ChatGPT 官方账号";

/// Shared, bounded catalog sync. A failed refresh never destroys the last good
/// account-scoped price book, and pricing failure cannot prevent tool use.
#[tauri::command]
pub async fn get_platform_pricing(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<crate::services::platform_pricing::PriceBook, String> {
    use crate::services::platform_pricing::{self, PriceBook};
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let cached = platform_pricing::load(&state.db).map_err(|e| e.to_string())?;
    if !force.unwrap_or(false) {
        if let Some(book) = cached.as_ref().filter(|b| !b.stale) {
            return Ok(book.clone());
        }
    }
    let connection = read_cached_status(&state)?;
    let account_id = connection.user_id.clone();
    let result = async {
        let client = yuanheng_client()?;
        let cookie = if connection.connected {
            get_yuanheng_secret(&state, SESSION_COOKIE_KEY)?
        } else {
            None
        };
        let pricing_url = format!("{BASE_URL}/api/pricing");
        let status_url = format!("{BASE_URL}/api/status");
        let (pricing, status) = tokio::try_join!(
            fetch_json(
                &client,
                &pricing_url,
                cookie.as_deref(),
                account_id.as_deref()
            ),
            fetch_json(&client, &status_url, None, None)
        )?;
        let mut book = PriceBook::from_api(&pricing, &status, account_id.clone())?;
        // User-group ratios may override public ratios; never invent a default 1.
        if connection.connected {
            let groups_value = fetch_json(
                &client,
                &format!("{BASE_URL}/api/user/self/groups"),
                cookie.as_deref(),
                account_id.as_deref(),
            )
            .await?;
            let groups = parse_user_groups(&groups_value)?;
            book.groups = groups
                .into_iter()
                .filter_map(|g| {
                    g.ratio
                        .filter(|r| r.is_finite() && *r >= 0.0)
                        .map(|r| (g.id, r.to_string()))
                })
                .collect();
        }
        if read_cached_status(&state)?.user_id != account_id {
            return Err("账号已切换，请重新同步报价".to_string());
        }
        book.selected_group = state
            .db
            .get_setting(platform_pricing::GROUP_KEY)
            .map_err(|e| e.to_string())?
            .filter(|s| !s.is_empty());
        state
            .db
            .set_setting(
                platform_pricing::CACHE_KEY,
                &serde_json::to_string(&book).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        Ok(book)
    }
    .await;
    match result {
        Ok(book) => Ok(book),
        Err(error) => match cached {
            Some(mut book) if read_cached_status(&state)?.user_id == book.account_id => {
                book.stale = true;
                book.sync_error = Some(error);
                Ok(book)
            }
            _ => Err(error),
        },
    }
}

#[tauri::command]
pub fn set_platform_quote_group(
    state: State<'_, AppState>,
    group: Option<String>,
) -> Result<(), String> {
    use crate::services::platform_pricing;
    if let Some(group) = &group {
        let book = platform_pricing::load(&state.db)
            .map_err(|e| e.to_string())?
            .ok_or("请先同步平台报价")?;
        if !book.groups.contains_key(group) {
            return Err("报价分组不可用，请重新同步".into());
        }
    }
    state
        .db
        .set_setting(
            platform_pricing::GROUP_KEY,
            group.as_deref().unwrap_or_default(),
        )
        .map_err(|e| e.to_string())
}

fn codex_account_mode_switch_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengAccount {
    pub username: String,
    pub display_name: String,
    pub group: String,
    pub remaining_usd: f64,
    pub used_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengConnectionStatus {
    pub connected: bool,
    #[serde(default)]
    pub session_only: bool,
    pub base_url: String,
    pub user_id: Option<String>,
    pub account: Option<YuanhengAccount>,
    pub models: Vec<String>,
    #[serde(default)]
    pub terminal_models: Vec<String>,
    #[serde(default)]
    pub image_generation_models: Vec<String>,
    #[serde(default)]
    pub groups: Vec<YuanhengGroupOption>,
    #[serde(default)]
    pub model_groups: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub reasoning_levels: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub reasoning_defaults: HashMap<String, String>,
    pub announcement: Option<String>,
    pub last_synced_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengGroupOption {
    pub id: String,
    pub description: String,
    pub ratio: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengAnnouncement {
    pub id: String,
    pub content: String,
    pub extra: Option<String>,
    pub publish_date: String,
    #[serde(rename = "type")]
    pub announcement_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengAnnouncementFeed {
    pub enabled: bool,
    pub announcements: Vec<YuanhengAnnouncement>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengAuthResult {
    pub requires_two_factor: bool,
    pub connection: Option<YuanhengConnectionStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengToolStatus {
    pub app: String,
    pub supported: bool,
    pub configured: bool,
    pub needs_update: bool,
    pub model: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    pub recommended_model: Option<String>,
    pub message: Option<String>,
    pub runtime_warning: Option<String>,
    pub runtime_status: Option<YuanhengRuntimeStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengRuntimeStatus {
    pub state: String,
    pub title: String,
    pub message: String,
    pub downloaded_bytes: u64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengToolConfigureResult {
    pub app: String,
    pub configured: bool,
    pub model: Option<String>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountModeStatus {
    /// yuanheng / official / unknown
    pub mode: String,
    pub official_login_available: bool,
    pub yuanheng_available: bool,
    pub restart_required: bool,
    #[serde(default)]
    pub history_repair_needed: bool,
    #[serde(default)]
    pub history_conflicts: Vec<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengPreflightCheck {
    pub id: String,
    pub status: String,
    pub title: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengToolPreflight {
    pub app: String,
    pub model: String,
    pub group: String,
    pub status: String,
    pub source_protocol: String,
    pub target_protocol: String,
    pub streaming_supported: bool,
    pub tool_call: String,
    pub reasoning_supported: bool,
    pub image_input: String,
    pub checks: Vec<YuanhengPreflightCheck>,
    pub message: String,
    pub requires_configuration: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengToolActivationStatus {
    pub app: String,
    pub configured_at: Option<i64>,
    pub config_written: bool,
    pub route_required: bool,
    pub route_ready: bool,
    pub request_received: bool,
    pub request_succeeded: bool,
    pub last_request_at: Option<i64>,
    pub last_status_code: Option<u16>,
    pub last_model: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengDisconnectResult {
    pub disconnected: bool,
    pub restored_tools: Vec<String>,
    pub removed_tools: Vec<String>,
    pub retained_tools: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengDiagnosticCheck {
    pub id: String,
    pub status: String,
    pub title: String,
    pub message: String,
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengDiagnosticReport {
    pub status: String,
    pub checked_at: i64,
    pub ready_tools: usize,
    pub attention_tools: Vec<String>,
    pub checks: Vec<YuanhengDiagnosticCheck>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
}

impl Default for YuanhengConnectionStatus {
    fn default() -> Self {
        Self {
            connected: false,
            session_only: false,
            base_url: BASE_URL.to_string(),
            user_id: None,
            account: None,
            models: Vec::new(),
            terminal_models: Vec::new(),
            image_generation_models: Vec::new(),
            groups: Vec::new(),
            model_groups: HashMap::new(),
            reasoning_levels: HashMap::new(),
            reasoning_defaults: HashMap::new(),
            announcement: None,
            last_synced_at: None,
        }
    }
}

fn response_message(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn is_yuanheng_session_auth_error(error: &str) -> bool {
    let normalized = error.trim().to_ascii_lowercase();
    normalized.contains("未登录")
        || normalized.contains("登录状态已失效")
        || normalized.contains("登录会话已过期")
        || normalized.contains("access token 无效")
        || normalized.contains("session expired")
        || normalized.contains("not logged in")
}

const YUANHENG_SECURE_KEYS: [&str; 5] = [
    TOKEN_KEY,
    USER_ID_KEY,
    SESSION_COOKIE_KEY,
    PENDING_SESSION_COOKIE_KEY,
    API_TOKEN_KEY,
];

/// 将旧版本写入 SQLite 的认证凭据迁移到系统凭据库。
///
/// 迁移顺序是“先写入并回读系统凭据，再删除 SQLite 旧值”，这样在系统凭据库
/// 暂时不可用时不会丢失凭据；调用方也会收到错误并停止继续使用认证状态。
fn migrate_legacy_yuanheng_secret(state: &AppState, key: &str) -> Result<(), String> {
    let legacy = state
        .db
        .get_setting(key)
        .map_err(|error| error.to_string())?;
    let Some(legacy) = legacy else {
        return Ok(());
    };

    if legacy.is_empty() {
        state
            .db
            .delete_setting(key)
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    match crate::secure_storage::get_secret(key)? {
        Some(existing) if existing != legacy => {
            return Err(format!("系统凭据与 SQLite 旧凭据冲突: {key}"));
        }
        Some(_) => {}
        None => {
            crate::secure_storage::set_secret(key, &legacy)?;
        }
    }

    // An earlier write/read may have populated the process cache. On every
    // attempt, including retries, verify the actual store before deleting the
    // only legacy copy; a cached match is not proof the item is still stored.
    if !crate::secure_storage::verify_secret(key, &legacy)? {
        return Err(format!("系统凭据写入校验失败: {key}"));
    }

    state
        .db
        .delete_setting(key)
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn migrate_legacy_yuanheng_secrets(state: &AppState) -> Result<(), String> {
    #[cfg(any(target_os = "macos", test))]
    if credential_session::has_session(state)? {
        return Ok(());
    }
    for key in YUANHENG_SECURE_KEYS {
        migrate_legacy_yuanheng_secret(state, key)?;
    }
    Ok(())
}

/// 读取认证凭据，并兼容尚未执行启动迁移的旧安装。
fn get_yuanheng_secret(state: &AppState, key: &str) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "macos", test))]
    {
        if key == PENDING_SESSION_COOKIE_KEY {
            return Ok(state
                .yuanheng_login
                .lock()
                .map_err(|_| "本机登录状态不可用")?
                .pending
                .clone());
        }
        if let Some(value) = credential_session::get(state, key)? {
            return Ok(value);
        }
    }
    migrate_legacy_yuanheng_secret(state, key)?;
    crate::secure_storage::get_secret(key)
}

#[cfg(not(any(target_os = "macos", test)))]
fn set_yuanheng_secret(key: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        crate::secure_storage::delete_secret(key)
    } else {
        crate::secure_storage::set_secret(key, value)
    }
}

fn set_pending_yuanheng_session(state: &AppState, value: &str) -> Result<(), String> {
    #[cfg(any(target_os = "macos", test))]
    {
        state
            .yuanheng_login
            .lock()
            .map_err(|_| "本机登录状态不可用")?
            .pending = Some(value.into());
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", test)))]
    {
        set_yuanheng_secret(PENDING_SESSION_COOKIE_KEY, value)?;
        state
            .db
            .delete_setting(PENDING_SESSION_COOKIE_KEY)
            .map_err(|e| e.to_string())
    }
}

fn delete_yuanheng_secret(state: &AppState, key: &str) -> Result<(), String> {
    crate::secure_storage::delete_secret(key)?;
    state
        .db
        .delete_setting(key)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn invalidate_yuanheng_session(state: &AppState) -> Result<(), String> {
    #[cfg(any(target_os = "macos", test))]
    if credential_session::has_session(state)? {
        return credential_session::clear(state);
    }
    for key in [
        TOKEN_KEY,
        USER_ID_KEY,
        SESSION_COOKIE_KEY,
        PENDING_SESSION_COOKIE_KEY,
    ] {
        delete_yuanheng_secret(state, key)?;
    }
    // 设备 API Token 在会话失效时仍可保留，但绝不能继续残留在 SQLite。
    state
        .db
        .delete_setting(API_TOKEN_KEY)
        .map_err(|error| error.to_string())?;
    state
        .db
        .delete_setting(CACHE_KEY)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn quota_to_usd(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or_default() / 500_000.0
}

fn parse_account(value: &Value) -> Result<YuanhengAccount, String> {
    if value.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(response_message(value).unwrap_or_else(|| "元衡账号验证失败".to_string()));
    }
    let data = value
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| "元衡账号响应缺少 data".to_string())?;
    Ok(YuanhengAccount {
        username: data
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        display_name: data
            .get("display_name")
            .or_else(|| data.get("displayName"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        group: data
            .get("group")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_string(),
        remaining_usd: quota_to_usd(data.get("quota")),
        used_usd: quota_to_usd(data.get("used_quota")),
    })
}

fn collect_model_names(value: &Value, output: &mut BTreeSet<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_model_names(item, output);
            }
        }
        Value::Object(map) => {
            for key in ["model_name", "modelName", "model"] {
                if let Some(name) = map.get(key).and_then(Value::as_str) {
                    let name = name.trim();
                    if !name.is_empty() && name.len() <= 120 {
                        output.insert(name.to_string());
                    }
                }
            }
            if let Some(data) = map.get("data") {
                collect_model_names(data, output);
            }
        }
        _ => {}
    }
}

fn parse_user_models(value: &Value) -> Result<Vec<String>, String> {
    if value.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(response_message(value).unwrap_or_else(|| "读取账号模型失败".to_string()));
    }
    let models = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "账号模型响应格式异常".to_string())?;
    Ok(models
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty() && model.len() <= 120)
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

fn parse_user_groups(value: &Value) -> Result<Vec<YuanhengGroupOption>, String> {
    if value.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(response_message(value).unwrap_or_else(|| "读取账号分组失败".to_string()));
    }
    let groups = value
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| "账号分组响应格式异常".to_string())?;
    let mut result = groups
        .iter()
        .map(|(id, details)| YuanhengGroupOption {
            id: id.to_string(),
            description: details
                .get("desc")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string(),
            ratio: details.get("ratio").and_then(Value::as_f64),
        })
        .collect::<Vec<_>>();
    result.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(result)
}

fn yuanheng_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("创建元衡客户端失败: {e}"))
}

fn with_session(
    mut request: reqwest::RequestBuilder,
    session_cookie: Option<&str>,
    user_id: Option<&str>,
) -> reqwest::RequestBuilder {
    if let Some(cookie) = session_cookie {
        request = request.header(COOKIE, cookie);
    }
    if let Some(user_id) = user_id {
        request = request.header("New-Api-User", user_id);
    }
    request
}

async fn parse_json_response(response: reqwest::Response) -> Result<(Value, HeaderMap), String> {
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取元衡响应失败: {e}"))?;
    let value: Value = serde_json::from_str(&body)
        .map_err(|_| format!("元衡返回了非 JSON 响应 (HTTP {status})"))?;
    if !status.is_success() {
        return Err(
            response_message(&value).unwrap_or_else(|| format!("元衡请求失败 (HTTP {status})"))
        );
    }
    Ok((value, headers))
}

async fn fetch_json(
    client: &reqwest::Client,
    url: &str,
    session_cookie: Option<&str>,
    user_id: Option<&str>,
) -> Result<Value, String> {
    let request = client
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", "yuanheng-desktop/0.1");
    let response = with_session(request, session_cookie, user_id)
        .send()
        .await
        .map_err(|e| format!("连接元衡失败: {e}"))?;
    parse_json_response(response).await.map(|(value, _)| value)
}

async fn fetch_user_models(
    client: &reqwest::Client,
    session_cookie: &str,
    user_id: &str,
    group: Option<&str>,
) -> Result<Vec<String>, String> {
    fetch_user_models_at(client, BASE_URL, session_cookie, user_id, group).await
}

async fn fetch_user_models_at(
    client: &reqwest::Client,
    origin: &str,
    session_cookie: &str,
    user_id: &str,
    group: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut request = client
        .get(format!("{origin}/api/user/models"))
        .header("Accept", "application/json")
        .header("User-Agent", "yuanheng-desktop/0.1");
    if let Some(group) = group {
        request = request.query(&[("group", group)]);
    }
    let response = with_session(request, Some(session_cookie), Some(user_id))
        .send()
        .await
        .map_err(|e| format!("读取账号模型失败: {e}"))?;
    let (value, _) = parse_json_response(response).await?;
    parse_user_models(&value)
}

fn parse_api_models(value: &Value) -> Result<Vec<String>, String> {
    let models = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "元衡模型接口响应格式异常".to_string())?;
    let names = models
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .filter(|model| !model.trim().is_empty())
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if names.is_empty() {
        return Err("当前账号没有可用模型".to_string());
    }
    Ok(names)
}

fn partition_model_catalog(models: &[String]) -> (Vec<String>, Vec<String>) {
    models
        .iter()
        .cloned()
        .partition(|model| !is_image_generation_only_model(model))
}

async fn fetch_api_models(
    client: &reqwest::Client,
    api_token: &str,
) -> Result<Vec<String>, String> {
    fetch_api_models_at(client, BASE_URL, api_token).await
}

async fn fetch_api_models_at(
    client: &reqwest::Client,
    origin: &str,
    api_token: &str,
) -> Result<Vec<String>, String> {
    let response = client
        .get(format!("{origin}/v1/models"))
        .header("Accept", "application/json")
        .header("User-Agent", "yuanheng-desktop/0.1")
        .bearer_auth(api_token)
        .send()
        .await
        .map_err(|_| "连接元衡模型接口失败，请检查网络后重试".to_string())?;
    if !response.status().is_success() {
        // 不回显上游原文，防止错误页回显 Authorization/账号信息。
        return Err(format!(
            "模型目录鉴权检查失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let (value, _) = parse_json_response(response).await?;
    parse_api_models(&value)
}

async fn verify_api_token(client: &reqwest::Client, api_token: &str) -> Result<(), String> {
    fetch_api_models(client, api_token).await.map(|_| ())
}

async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: &Value,
    session_cookie: Option<&str>,
    user_id: Option<&str>,
) -> Result<(Value, HeaderMap), String> {
    let request = client
        .post(url)
        .header("Accept", "application/json")
        .header("User-Agent", "yuanheng-desktop/0.1")
        .json(body);
    let response = with_session(request, session_cookie, user_id)
        .send()
        .await
        .map_err(|e| format!("连接元衡失败: {e}"))?;
    parse_json_response(response).await
}

fn ensure_api_success(value: &Value, fallback: &str) -> Result<(), String> {
    if value.get("success").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(response_message(value).unwrap_or_else(|| fallback.to_string()))
    }
}

fn extract_cookie(headers: &HeaderMap, cookie_name: &str) -> Option<String> {
    headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|header| header.to_str().ok())
        .filter_map(|header| header.split(';').next())
        .filter_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            (name == cookie_name && !value.is_empty()).then(|| format!("{name}={value}"))
        })
        .next_back()
}

fn parse_announcement_response(value: &Value) -> Option<String> {
    value
        .get("data")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|notice| !notice.is_empty())
        .map(str::to_string)
}

fn announcement_id(value: Option<&Value>, index: usize) -> String {
    value
        .and_then(|id| {
            id.as_str()
                .map(str::to_string)
                .or_else(|| id.as_i64().map(|id| id.to_string()))
                .or_else(|| id.as_u64().map(|id| id.to_string()))
        })
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| format!("platform-{}", index + 1))
}

fn parse_platform_announcements(value: &Value) -> Option<YuanhengAnnouncementFeed> {
    let data = value.get("data")?.as_object()?;
    let enabled = data
        .get("announcements_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    if !enabled {
        return Some(YuanhengAnnouncementFeed {
            enabled: false,
            announcements: Vec::new(),
            source: "platform".to_string(),
        });
    }

    let items = data.get("announcements")?.as_array()?;
    let mut announcements = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let content = item.get("content")?.as_str()?.trim();
            if content.is_empty() {
                return None;
            }
            let extra = item
                .get("extra")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|extra| !extra.is_empty())
                .map(str::to_string);
            let publish_date = item
                .get("publishDate")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
            let announcement_type = item
                .get("type")
                .and_then(Value::as_str)
                .filter(|kind| {
                    matches!(
                        *kind,
                        "default" | "ongoing" | "success" | "warning" | "error"
                    )
                })
                .unwrap_or("default")
                .to_string();

            Some(YuanhengAnnouncement {
                id: announcement_id(item.get("id"), index),
                content: content.to_string(),
                extra,
                publish_date,
                announcement_type,
            })
        })
        .collect::<Vec<_>>();
    announcements.sort_by(|left, right| {
        let timestamp = |value: &str| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map(|date| date.timestamp_millis())
                .unwrap_or(i64::MIN)
        };
        timestamp(&right.publish_date).cmp(&timestamp(&left.publish_date))
    });
    announcements.truncate(20);

    Some(YuanhengAnnouncementFeed {
        enabled: true,
        announcements,
        source: "platform".to_string(),
    })
}

async fn fetch_legacy_announcement(client: &reqwest::Client) -> Result<Option<String>, String> {
    let value = fetch_json(client, &format!("{BASE_URL}/api/notice"), None, None).await?;
    Ok(parse_announcement_response(&value))
}

async fn fetch_announcements(client: &reqwest::Client) -> Result<YuanhengAnnouncementFeed, String> {
    match fetch_json(client, &format!("{BASE_URL}/api/status"), None, None).await {
        Ok(value) => {
            if let Some(feed) = parse_platform_announcements(&value) {
                return Ok(feed);
            }
        }
        Err(error) => log::warn!("元衡结构化公告同步失败，尝试旧公告接口: {error}"),
    }

    let legacy = fetch_legacy_announcement(client).await?;
    Ok(YuanhengAnnouncementFeed {
        enabled: legacy.is_some(),
        announcements: legacy
            .map(|content| {
                vec![YuanhengAnnouncement {
                    id: "legacy".to_string(),
                    content,
                    extra: None,
                    publish_date: String::new(),
                    announcement_type: "default".to_string(),
                }]
            })
            .unwrap_or_default(),
        source: "legacy".to_string(),
    })
}

fn session_cookie_for_webview(raw: &str) -> Result<Cookie<'static>, String> {
    let (name, value) = raw
        .trim()
        .split_once('=')
        .ok_or_else(|| "元衡登录 Cookie 格式无效，请重新登录".to_string())?;
    if name != "session" || value.is_empty() {
        return Err("元衡登录状态无效，请重新登录".to_string());
    }

    let mut cookie = Cookie::new(name.to_string(), value.to_string());
    cookie.set_domain(COOKIE_DOMAIN);
    cookie.set_path("/");
    cookie.set_secure(true);
    cookie.set_http_only(true);
    Ok(cookie)
}

fn parse_auth_response(value: &Value) -> Result<(bool, Option<String>), String> {
    ensure_api_success(value, "元衡登录失败")?;
    let data = value
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| "元衡登录响应缺少 data".to_string())?;
    let requires_two_factor = data
        .get("require_2fa")
        .or_else(|| data.get("require2fa"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if requires_two_factor {
        return Ok((true, None));
    }
    let user_id = data
        .get("id")
        .and_then(|id| {
            id.as_i64()
                .filter(|id| *id > 0)
                .map(|id| id.to_string())
                .or_else(|| id.as_str().filter(|id| !id.is_empty()).map(str::to_string))
        })
        .ok_or_else(|| "元衡登录响应缺少用户 ID".to_string())?;
    Ok((false, Some(user_id)))
}

const MAX_LOGIN_USERNAME_CHARS: usize = 254;
const MAX_REGISTER_USERNAME_CHARS: usize = 20;

fn validate_username(username: &str, max_chars: usize, error: &str) -> Result<(), String> {
    if username.is_empty()
        || username.chars().count() > max_chars
        || username.contains(['\n', '\r'])
    {
        return Err(error.to_string());
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), String> {
    if !(8..=20).contains(&password.chars().count()) || password.contains(['\n', '\r']) {
        return Err("密码长度必须为 8 到 20 个字符".to_string());
    }
    Ok(())
}

fn validate_login_credentials(username: &str, password: &str) -> Result<(), String> {
    validate_username(
        username,
        MAX_LOGIN_USERNAME_CHARS,
        "登录账号不能为空且不能超过 254 个字符",
    )?;
    validate_password(password)
}

fn validate_registration_credentials(username: &str, password: &str) -> Result<(), String> {
    validate_username(
        username,
        MAX_REGISTER_USERNAME_CHARS,
        "用户名不能为空且不能超过 20 个字符",
    )?;
    validate_password(password)
}

fn device_token_name(device_name: Option<&str>) -> String {
    const PREFIX: &str = "元衡桌面端 - ";
    const MAX_BYTES: usize = 50;
    let device_name = device_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("当前设备");
    let mut name = PREFIX.to_string();
    for character in device_name.chars() {
        if name.len() + character.len_utf8() > MAX_BYTES {
            break;
        }
        name.push(character);
    }
    name
}

fn find_device_token_id(
    value: &Value,
    expected_name: &str,
    expected_group: &str,
    now: i64,
) -> Option<i64> {
    value
        .pointer("/data/items")
        .and_then(Value::as_array)?
        .iter()
        .filter(|item| item.get("name").and_then(Value::as_str) == Some(expected_name))
        .filter(|item| item.get("group").and_then(Value::as_str) == Some(expected_group))
        .filter(|item| item.get("status").and_then(Value::as_i64).unwrap_or(1) == 1)
        .filter(|item| {
            item.get("expired_time")
                .and_then(Value::as_i64)
                .is_none_or(|expired| expired <= 0 || expired > now)
        })
        .filter(|item| {
            item.get("unlimited_quota")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|item| item.get("id").and_then(Value::as_i64))
        .max()
}

fn normalize_api_token(raw: &str) -> Result<String, String> {
    let token = raw.trim();
    if token.is_empty() || token.len() > 4096 || token.contains(['\n', '\r']) {
        return Err("元衡返回了无效的工具凭据".to_string());
    }
    if token.starts_with("sk-") {
        Ok(token.to_string())
    } else {
        Ok(format!("sk-{token}"))
    }
}

#[cfg(test)]
fn token_cache_for_stored_group(group: Option<&str>, token: String) -> HashMap<String, String> {
    let mut cache = HashMap::new();
    if let Some(group) = group.map(str::trim).filter(|group| !group.is_empty()) {
        cache.insert(group.to_string(), token);
    }
    cache
}

// 只从该工具、该分组的元衡托管记录取凭据，不能拿主凭据代替 Desktop 凭据。
fn stored_tool_credential(
    state: &AppState,
    app_name: &str,
    group: &str,
    selected_model: Option<&str>,
) -> Result<Option<String>, String> {
    if app_name == "dsh" {
        return dsh::credential(state, group);
    }
    if app_name == "workbuddy" {
        if state
            .db
            .get_setting(WORKBUDDY_GROUP_KEY)
            .map_err(|e| e.to_string())?
            .as_deref()
            != Some(group)
        {
            return Ok(None);
        }
        let config = read_workbuddy_config();
        let entry = config
            .as_ref()
            .and_then(|value| value.get("models"))
            .and_then(Value::as_array)
            .and_then(|models| {
                models.iter().find(|entry| {
                    selected_model
                        .is_some_and(|model| entry.get("id").and_then(Value::as_str) == Some(model))
                })
            });
        if entry.is_some_and(|model| {
            !model
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|url| is_managed_endpoint(url, &["/v1/chat/completions"], true))
        }) {
            return Err("工具接口已被外部修改，请核对元衡配置后再试".to_string());
        }
        return Ok(entry
            .and_then(|model| model.get("apiKey"))
            .and_then(Value::as_str)
            .filter(|key| !key.trim().is_empty())
            .map(str::to_string));
    }
    let app = if app_name == CHATGPT_DESKTOP_NAMESPACE {
        AppType::Codex
    } else {
        app_name.parse::<AppType>().map_err(|e| e.to_string())?
    };
    let Some(provider) = state
        .db
        .get_provider_by_id(MANAGED_PROVIDER_ID, app_name)
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    if provider_group(&provider).as_deref() != Some(group)
        || provider.category.as_deref() != Some("managed")
    {
        return Ok(None);
    }
    let (base_url, fallback_key) = provider.resolve_usage_credentials(&app);
    if !is_managed_endpoint(&base_url, &["", "/v1"], true) {
        return Err("工具接口已被外部修改，请核对元衡配置后再试".to_string());
    }
    let key = if matches!(app, AppType::Codex) {
        // 与实际转发共用相同优先级，包含历史 env/API Key/bearer 写法。
        crate::proxy::providers::get_adapter(&app)
            .extract_auth(&provider)
            .map(|auth| auth.api_key)
            .unwrap_or_default()
    } else {
        fallback_key
    };
    Ok((!key.trim().is_empty() && key != LOCAL_PROXY_TOKEN).then_some(key))
}

fn is_token_rejected(error: &str) -> bool {
    error.contains("HTTP 401") || error.contains("HTTP 403")
}

fn tool_uses_legacy_endpoint(state: &AppState, app_name: &str, model: &str) -> bool {
    let endpoint = if app_name == "workbuddy" {
        read_workbuddy_config().and_then(|config| {
            config
                .get("models")?
                .as_array()?
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(model))?
                .get("url")?
                .as_str()
                .map(str::to_string)
        })
    } else {
        let app = if app_name == CHATGPT_DESKTOP_NAMESPACE {
            AppType::Codex
        } else {
            let Ok(app) = app_name.parse::<AppType>() else {
                return false;
            };
            app
        };
        state
            .db
            .get_provider_by_id(MANAGED_PROVIDER_ID, app_name)
            .ok()
            .flatten()
            .filter(|provider| provider.category.as_deref() == Some("managed"))
            .map(|provider| provider.resolve_usage_credentials(&app).0)
    };
    endpoint.is_some_and(|endpoint| {
        let paths = ["", "/v1", "/v1/chat/completions"];
        is_managed_endpoint(&endpoint, &paths, true)
            && !is_managed_endpoint(&endpoint, &paths, false)
    })
}

async fn ensure_device_api_token(
    client: &reqwest::Client,
    session_cookie: &str,
    user_id: &str,
    group: &str,
) -> Result<(String, i64), String> {
    let detected_name = crate::services::sync_protocol::detect_system_device_name();
    let token_name = device_token_name(detected_name.as_deref());
    let list_url = format!("{BASE_URL}/api/token/?p=1&size=100");
    let mut list = fetch_json(client, &list_url, Some(session_cookie), Some(user_id)).await?;
    ensure_api_success(&list, "读取元衡工具凭据失败")?;
    let now = chrono::Utc::now().timestamp();
    let token_id = if let Some(id) = find_device_token_id(&list, &token_name, group, now) {
        id
    } else {
        let (created, _) = post_json(
            client,
            &format!("{BASE_URL}/api/token/"),
            &json!({
                "name": token_name.as_str(),
                "expired_time": -1,
                "remain_quota": 0,
                "unlimited_quota": true,
                "model_limits_enabled": false,
                "group": group
            }),
            Some(session_cookie),
            Some(user_id),
        )
        .await?;
        ensure_api_success(&created, "创建本机工具凭据失败")?;
        list = fetch_json(client, &list_url, Some(session_cookie), Some(user_id)).await?;
        ensure_api_success(&list, "读取新建工具凭据失败")?;
        find_device_token_id(&list, &token_name, group, now)
            .ok_or_else(|| "本机工具凭据已创建，但未能读取凭据编号".to_string())?
    };

    let key_value = fetch_json(
        client,
        &format!("{BASE_URL}/api/token/{token_id}/key"),
        Some(session_cookie),
        Some(user_id),
    )
    .await?;
    ensure_api_success(&key_value, "读取本机工具凭据失败")?;
    let key = key_value
        .pointer("/data/key")
        .and_then(Value::as_str)
        .ok_or_else(|| "元衡工具凭据响应缺少 key".to_string())?;
    Ok((normalize_api_token(key)?, token_id))
}

fn fallback_reasoning_levels(model: &str) -> Vec<String> {
    fallback_reasoning_profile(model)
        .map(|profile| profile.supported_levels)
        .unwrap_or_default()
}

fn reasoning_profiles_for_models(
    models: &[String],
) -> (HashMap<String, Vec<String>>, HashMap<String, String>) {
    let catalog = load_local_reasoning_profiles();
    let mut levels = HashMap::new();
    let mut defaults = HashMap::new();
    for model in models {
        let Some(profile) = reasoning_profile_for_model(model, &catalog) else {
            continue;
        };
        if profile.supported_levels.is_empty() {
            continue;
        }
        if let Some(default) = profile.default_level {
            defaults.insert(model.clone(), default);
        }
        levels.insert(model.clone(), profile.supported_levels);
    }
    (levels, defaults)
}

async fn sync_connection(
    client: &reqwest::Client,
    session_cookie: &str,
    user_id: &str,
) -> Result<YuanhengConnectionStatus, String> {
    let account_value = fetch_json(
        client,
        &format!("{BASE_URL}/api/user/self"),
        Some(session_cookie),
        Some(user_id),
    )
    .await?;
    let account = parse_account(&account_value)?;

    let pricing = fetch_json(
        client,
        &format!("{BASE_URL}/api/pricing"),
        Some(session_cookie),
        Some(user_id),
    )
    .await
    .ok();
    let mut model_names = BTreeSet::new();
    if let Some(pricing) = pricing.as_ref() {
        collect_model_names(pricing, &mut model_names);
    }

    let groups_result = fetch_json(
        client,
        &format!("{BASE_URL}/api/user/self/groups"),
        Some(session_cookie),
        Some(user_id),
    )
    .await
    .and_then(|value| parse_user_groups(&value));
    if let Err(error) = &groups_result {
        log::warn!("元衡账号分组同步失败，使用当前分组回退: {error}");
    }
    let groups = groups_result.unwrap_or_else(|_| {
        vec![YuanhengGroupOption {
            id: account.group.clone(),
            description: "当前账号分组".to_string(),
            ratio: None,
        }]
    });

    match fetch_user_models(client, session_cookie, user_id, None).await {
        Ok(models) if !models.is_empty() => {
            log::info!("已同步元衡账号全部模型: {} 个", models.len());
            model_names = models.into_iter().collect();
        }
        Ok(_) => log::warn!("元衡账号模型目录为空，使用定价目录回退"),
        Err(error) => log::warn!("元衡账号模型同步失败，使用定价目录回退: {error}"),
    }

    let group_model_tasks = groups.iter().map(|group| {
        let group_id = group.id.clone();
        async move {
            let models = fetch_user_models(client, session_cookie, user_id, Some(&group_id)).await;
            (group_id, models)
        }
    });
    let mut model_groups: HashMap<String, Vec<String>> = HashMap::new();
    for (group, models) in futures::future::join_all(group_model_tasks).await {
        let Ok(models) = models else {
            continue;
        };
        for model in models {
            model_names.insert(model.clone());
            model_groups.entry(model).or_default().push(group.clone());
        }
    }
    for groups in model_groups.values_mut() {
        groups.sort();
        groups.dedup();
    }

    let notice = match fetch_announcements(client).await {
        Ok(feed) => feed
            .announcements
            .first()
            .map(|announcement| announcement.content.clone()),
        Err(error) => {
            log::warn!("元衡平台公告同步失败: {error}");
            None
        }
    };

    let models: Vec<String> = model_names.into_iter().collect();
    let (terminal_models, image_generation_models) = partition_model_catalog(&models);
    let (reasoning_levels, reasoning_defaults) = reasoning_profiles_for_models(&terminal_models);

    Ok(YuanhengConnectionStatus {
        connected: true,
        session_only: false,
        base_url: BASE_URL.to_string(),
        user_id: Some(user_id.to_string()),
        account: Some(account),
        models,
        terminal_models,
        image_generation_models,
        groups,
        model_groups,
        reasoning_levels,
        reasoning_defaults,
        announcement: notice,
        last_synced_at: Some(chrono::Utc::now().timestamp()),
    })
}

fn persist_connection(
    state: &AppState,
    session_cookie: &str,
    user_id: &str,
    api_token: &str,
    api_token_id: i64,
    status: &YuanhengConnectionStatus,
) -> Result<(), String> {
    #[cfg(any(target_os = "macos", test))]
    {
        credential_session::persist(
            state,
            session_cookie,
            user_id,
            api_token,
            api_token_id,
            status,
        )
    }
    #[cfg(not(any(target_os = "macos", test)))]
    {
        let api_token_group = status
            .account
            .as_ref()
            .map(|account| account.group.trim())
            .filter(|group| !group.is_empty())
            .unwrap_or("default");
        for (key, value) in [
            (SESSION_COOKIE_KEY, session_cookie),
            (USER_ID_KEY, user_id),
            (API_TOKEN_KEY, api_token),
        ] {
            set_yuanheng_secret(key, value)?;
            state
                .db
                .delete_setting(key)
                .map_err(|error| error.to_string())?;
        }
        state
            .db
            .set_setting(API_TOKEN_GROUP_KEY, api_token_group)
            .map_err(|error| error.to_string())?;
        state
            .db
            .set_setting(API_TOKEN_ID_KEY, &api_token_id.to_string())
            .map_err(|error| error.to_string())?;
        state
            .db
            .set_setting(
                CACHE_KEY,
                &serde_json::to_string(status).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        for key in [TOKEN_KEY, PENDING_SESSION_COOKIE_KEY] {
            delete_yuanheng_secret(state, key)?;
        }
        Ok(())
    }
}

async fn finish_authenticated_session(
    state: &AppState,
    client: &reqwest::Client,
    session_cookie: &str,
    user_id: &str,
) -> Result<YuanhengConnectionStatus, String> {
    let status = sync_connection(client, session_cookie, user_id).await?;
    let group = status
        .account
        .as_ref()
        .map(|account| account.group.trim())
        .filter(|group| !group.is_empty())
        .unwrap_or("default");
    let (api_token, api_token_id) =
        ensure_device_api_token(client, session_cookie, user_id, group).await?;
    persist_connection(
        state,
        session_cookie,
        user_id,
        &api_token,
        api_token_id,
        &status,
    )?;
    #[cfg(any(target_os = "macos", test))]
    {
        read_cached_status(state)
    }
    #[cfg(not(any(target_os = "macos", test)))]
    {
        Ok(status)
    }
}

async fn login_with_credentials(
    state: &AppState,
    username: &str,
    password: &str,
) -> Result<YuanhengAuthResult, String> {
    validate_login_credentials(username, password)?;
    let client = yuanheng_client()?;
    let (value, headers) = post_json(
        &client,
        &format!("{BASE_URL}/api/user/login"),
        &json!({ "username": username, "password": password }),
        None,
        None,
    )
    .await?;
    let (requires_two_factor, user_id) = parse_auth_response(&value)?;
    let session_cookie = extract_cookie(&headers, "session")
        .ok_or_else(|| "元衡登录成功，但未返回有效会话".to_string())?;
    if requires_two_factor {
        set_pending_yuanheng_session(state, &session_cookie)?;
        return Ok(YuanhengAuthResult {
            requires_two_factor: true,
            connection: None,
        });
    }
    let user_id = user_id.ok_or_else(|| "元衡登录响应缺少用户 ID".to_string())?;
    let status = finish_authenticated_session(state, &client, &session_cookie, &user_id).await?;
    Ok(YuanhengAuthResult {
        requires_two_factor: false,
        connection: Some(status),
    })
}

fn read_cached_status(state: &AppState) -> Result<YuanhengConnectionStatus, String> {
    #[cfg(any(target_os = "macos", test))]
    if let Some(status) = credential_session::cached_status(state)? {
        return Ok(normalize_cached_status(status));
    }
    let session = get_yuanheng_secret(state, SESSION_COOKIE_KEY)?;
    let token = get_yuanheng_secret(state, API_TOKEN_KEY)?;
    let user_id = get_yuanheng_secret(state, USER_ID_KEY)?;
    if [session.as_deref(), token.as_deref(), user_id.as_deref()]
        .into_iter()
        .any(|value| value.unwrap_or_default().is_empty())
    {
        return Ok(YuanhengConnectionStatus::default());
    }
    let cached = state.db.get_setting(CACHE_KEY).map_err(|e| e.to_string())?;
    let mut status: YuanhengConnectionStatus = cached
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    status.connected = true;
    Ok(normalize_cached_status(status))
}

fn normalize_cached_status(mut status: YuanhengConnectionStatus) -> YuanhengConnectionStatus {
    status.base_url = BASE_URL.to_string();
    (status.terminal_models, status.image_generation_models) =
        partition_model_catalog(&status.models);
    (status.reasoning_levels, status.reasoning_defaults) =
        reasoning_profiles_for_models(&status.terminal_models);
    status
}

fn recommended_model(app: &AppType, models: &[String]) -> Option<String> {
    let score = |model: &str| {
        let lower = model.to_ascii_lowercase();
        match app {
            AppType::Claude | AppType::ClaudeDesktop => {
                if lower.contains("claude") {
                    120
                } else if ["image", "audio", "ocr", "kolors", "sensevoice", "imagen"]
                    .iter()
                    .any(|keyword| lower.contains(keyword))
                {
                    0
                } else if lower.contains("deepseek-v4-pro") {
                    115
                } else if lower.contains("deepseek") {
                    110
                } else if lower == "k3" || lower.contains("gpt") {
                    105
                } else if ["qwen", "glm", "hunyuan", "grok", "gemini"]
                    .iter()
                    .any(|keyword| lower.contains(keyword))
                {
                    90
                } else {
                    1
                }
            }
            AppType::Gemini => {
                if lower.contains("gemini") {
                    100
                } else {
                    1
                }
            }
            AppType::GrokBuild => {
                if lower.contains("grok") {
                    100
                } else {
                    1
                }
            }
            AppType::Codex => {
                if lower.contains("gpt-5.6") {
                    110
                } else if lower.contains("gpt-5.5") {
                    105
                } else if lower.contains("gpt-5") {
                    100
                } else if lower.contains("codex") {
                    90
                } else {
                    1
                }
            }
            AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => {
                if lower.contains("gpt-5.6") {
                    110
                } else if lower.contains("gpt-5.5") {
                    105
                } else if lower.contains("gpt") {
                    100
                } else if lower.contains("claude") {
                    90
                } else if lower.contains("gemini") {
                    80
                } else {
                    1
                }
            }
        }
    };

    models
        .iter()
        .enumerate()
        .filter(|(_, model)| !is_image_generation_only_model(model))
        .filter_map(|(index, model)| {
            let score = score(model);
            (score > 0).then_some((score, index, model))
        })
        .max_by_key(|(score, index, _)| (*score, std::cmp::Reverse(*index)))
        .map(|(_, _, model)| model.clone())
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn terminal_catalog_models(selected: &str, available_models: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    std::iter::once(selected)
        .chain(available_models.iter().map(String::as_str))
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .filter(|model| !is_image_generation_only_model(model))
        .filter(|model| seen.insert((*model).to_string()))
        .map(str::to_string)
        .collect()
}

fn grokbuild_models_config(token: &str, selected: &str, available_models: &[String]) -> String {
    let mut config = format!("[models]\ndefault = {}\n", toml_string(selected));
    for model in terminal_catalog_models(selected, available_models) {
        config.push_str(&format!(
            "\n[model.{}]\nmodel = {}\nbase_url = {}\nname = {}\napi_key = {}\napi_backend = \"responses\"\ncontext_window = 400000\n",
            toml_string(&model),
            toml_string(&model),
            toml_string(OPENAI_BASE_URL),
            toml_string(MANAGED_PROVIDER_DISPLAY_NAME),
            toml_string(token)
        ));
    }
    config
}

fn provider_meta(app: &AppType, model: &str, reasoning: &str) -> ProviderMeta {
    let claude_api_format = yuanheng_model_api_format(model);
    let mut meta = ProviderMeta {
        common_config_enabled: Some(true),
        api_format: Some(
            match app {
                AppType::Claude | AppType::ClaudeDesktop => claude_api_format,
                AppType::Codex => claude_api_format,
                AppType::GrokBuild => "openai_responses",
                AppType::Gemini => "gemini_native",
                AppType::OpenCode | AppType::OpenClaw | AppType::Hermes => "openai_chat",
            }
            .to_string(),
        ),
        ..ProviderMeta::default()
    };
    if matches!(app, AppType::Claude | AppType::ClaudeDesktop) {
        meta.api_key_field = Some("ANTHROPIC_AUTH_TOKEN".to_string());
    }
    if matches!(app, AppType::ClaudeDesktop) {
        meta.claude_desktop_mode = Some(ClaudeDesktopMode::Proxy);
        meta.claude_desktop_model_routes.insert(
            "claude-sonnet-5".to_string(),
            ClaudeDesktopModelRoute {
                model: model.to_string(),
                label_override: Some(MANAGED_PROVIDER_AI_LABEL.to_string()),
                supports_1m: Some(true),
            },
        );
        meta.local_proxy_request_overrides = match reasoning {
            "auto" => None,
            _ if claude_api_format == "anthropic" => Some(LocalProxyRequestOverrides {
                body: Some(json!({ "output_config": { "effort": reasoning } })),
                ..Default::default()
            }),
            _ if claude_api_format == "openai_responses" => Some(LocalProxyRequestOverrides {
                body: Some(json!({ "reasoning": { "effort": reasoning } })),
                ..Default::default()
            }),
            _ => Some(LocalProxyRequestOverrides {
                body: Some(json!({ "reasoning_effort": reasoning })),
                ..Default::default()
            }),
        };
    }
    meta
}

fn managed_provider_with_models(
    app: &AppType,
    token: &str,
    model: &str,
    available_models: &[String],
    group: &str,
    reasoning: &str,
) -> Result<Provider, String> {
    let catalog_models = terminal_catalog_models(model, available_models);
    let settings = match app {
        AppType::Claude | AppType::ClaudeDesktop => json!({
            "env": {
                "ANTHROPIC_BASE_URL": BASE_URL,
                "ANTHROPIC_AUTH_TOKEN": token,
                "ANTHROPIC_API_KEY": "",
                "ANTHROPIC_MODEL": model,
                "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
                "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
                "ANTHROPIC_DEFAULT_OPUS_MODEL": model
            }
        }),
        AppType::Codex => json!({
            "auth": { "OPENAI_API_KEY": token },
            "config": format!(
                "model_provider = \"custom\"\nmodel = {}\n{}disable_response_storage = true\n\n[model_providers.custom]\nname = {}\nbase_url = {}\nwire_api = \"responses\"\nrequires_openai_auth = true\n",
                toml_string(model),
                if reasoning == "auto" {
                    String::new()
                } else {
                    format!("model_reasoning_effort = {}\n", toml_string(reasoning))
                },
                toml_string(MANAGED_PROVIDER_DISPLAY_NAME),
                toml_string(OPENAI_BASE_URL)
            ),
            "modelCatalog": {
                "models": catalog_models.iter().map(|catalog_model| json!({
                    "model": catalog_model,
                    "displayName": catalog_model,
                    "contextWindow": 200_000,
                    "apiFormat": yuanheng_model_api_format(catalog_model)
                })).collect::<Vec<_>>()
            }
        }),
        AppType::Gemini => json!({
            "env": {
                "GEMINI_API_KEY": token,
                "GOOGLE_GEMINI_BASE_URL": BASE_URL,
                "GEMINI_MODEL": model
            }
        }),
        AppType::GrokBuild => json!({
            "config": grokbuild_models_config(token, model, &catalog_models)
        }),
        AppType::OpenCode => {
            let mut models = Map::new();
            for catalog_model in &catalog_models {
                models.insert(catalog_model.clone(), json!({ "name": catalog_model }));
            }
            json!({
                "npm": "@ai-sdk/openai-compatible",
                "name": MANAGED_PROVIDER_DISPLAY_NAME,
                "options": {
                    "baseURL": OPENAI_BASE_URL,
                    "apiKey": token,
                    "setCacheKey": true
                },
                "models": models
            })
        }
        AppType::OpenClaw => json!({
            "baseUrl": OPENAI_BASE_URL,
            "apiKey": token,
            "api": "openai-completions",
            "models": catalog_models.iter().map(|catalog_model| json!({
                "id": catalog_model,
                "name": catalog_model,
                "contextWindow": 200000
            })).collect::<Vec<_>>()
        }),
        AppType::Hermes => json!({
            "name": MANAGED_PROVIDER_DISPLAY_NAME,
            "base_url": OPENAI_BASE_URL,
            "api_key": token,
            "api_mode": "chat_completions",
            "models": catalog_models.iter().map(|catalog_model| json!({
                "id": catalog_model,
                "name": catalog_model
            })).collect::<Vec<_>>()
        }),
    };

    let mut provider = Provider::with_id(
        MANAGED_PROVIDER_ID.to_string(),
        MANAGED_PROVIDER_DISPLAY_NAME.to_string(),
        settings,
        Some(BASE_URL.to_string()),
    );
    provider.category = Some("managed".to_string());
    provider.notes = Some(format!(
        "由元衡桌面端自动维护 | group={group} | reasoning={reasoning}"
    ));
    provider.icon = Some("yuanheng".to_string());
    provider.meta = Some(provider_meta(app, model, reasoning));
    Ok(provider)
}

#[cfg(test)]
fn managed_provider(
    app: &AppType,
    token: &str,
    model: &str,
    group: &str,
    reasoning: &str,
) -> Result<Provider, String> {
    managed_provider_with_models(app, token, model, &[], group, reasoning)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CodexSurface {
    Terminal,
    Desktop,
}

impl CodexSurface {
    fn marker(self) -> &'static str {
        match self {
            Self::Terminal => "terminal",
            Self::Desktop => "desktop",
        }
    }

    fn namespace(self) -> &'static str {
        match self {
            Self::Terminal => AppType::Codex.as_str(),
            Self::Desktop => CHATGPT_DESKTOP_NAMESPACE,
        }
    }

    fn route_prefix(self) -> &'static str {
        match self {
            Self::Terminal => "codex",
            Self::Desktop => CHATGPT_DESKTOP_NAMESPACE,
        }
    }

    fn catalog_filename(self) -> &'static str {
        match self {
            Self::Terminal => crate::codex_config::YUANHENG_TERMINAL_MODEL_CATALOG_FILENAME,
            Self::Desktop => crate::codex_config::YUANHENG_DESKTOP_MODEL_CATALOG_FILENAME,
        }
    }
}

fn codex_terminal_profile_path() -> std::path::PathBuf {
    crate::services::codex_session_bridge::codex_session_profile_path()
}

fn managed_codex_surface_route_active(
    db: &crate::database::Database,
    surface: CodexSurface,
) -> bool {
    let provider = db
        .get_provider_by_id(MANAGED_PROVIDER_ID, surface.namespace())
        .ok()
        .flatten();
    if !provider
        .as_ref()
        .is_some_and(|provider| codex_surface_matches(provider, surface))
    {
        return false;
    }

    let route = match surface {
        CodexSurface::Terminal => std::fs::read_to_string(codex_terminal_profile_path()).ok(),
        CodexSurface::Desktop => crate::codex_config::read_codex_config_text().ok(),
    };
    route
        .and_then(|config| crate::codex_config::extract_codex_base_url(&config))
        .is_some_and(|url| url.contains(&format!("/{}/v1", surface.route_prefix())))
}

pub(crate) fn managed_chatgpt_desktop_route_active(db: &crate::database::Database) -> bool {
    if managed_codex_surface_route_active(db, CodexSurface::Desktop) {
        return true;
    }
    let official_current = db
        .get_current_provider(AppType::Codex.as_str())
        .ok()
        .flatten()
        .as_deref()
        == Some(CODEX_OFFICIAL_PROVIDER_ID);
    official_current
        && crate::codex_config::read_codex_config_text()
            .ok()
            .is_some_and(|config| {
                crate::codex_config::codex_config_has_official_proxy_route(&config)
            })
}

pub(crate) fn managed_codex_routes_require_core(db: &crate::database::Database) -> bool {
    managed_codex_surface_route_active(db, CodexSurface::Terminal)
        || managed_chatgpt_desktop_route_active(db)
}

fn codex_official_login_available() -> Result<bool, String> {
    let path = crate::codex_config::get_codex_auth_path();
    if !path.exists() {
        return Ok(false);
    }
    let auth: Value = crate::config::read_json_file(&path)
        .map_err(|error| format!("读取 Codex 官方登录状态失败: {error}"))?;
    Ok(crate::codex_config::codex_auth_has_oauth_login_material(
        &auth,
    ))
}

fn yuanheng_codex_mode_available(state: &AppState) -> bool {
    [CodexSurface::Terminal, CodexSurface::Desktop]
        .into_iter()
        .all(|surface| {
            prepared_managed_codex_provider(state, surface)
                .ok()
                .flatten()
                .is_some_and(|provider| {
                    provider_has_credentials_for_route(&provider, &AppType::Codex, true)
                        && codex_surface_matches(&provider, surface)
                })
        })
}

fn codex_account_mode_status_inner(state: &AppState) -> Result<CodexAccountModeStatus, String> {
    let current = ProviderService::current(state, AppType::Codex).map_err(|e| e.to_string())?;
    let terminal_managed =
        managed_codex_surface_route_active(state.db.as_ref(), CodexSurface::Terminal);
    let desktop_managed =
        managed_codex_surface_route_active(state.db.as_ref(), CodexSurface::Desktop);
    let mode = if current == CODEX_OFFICIAL_PROVIDER_ID && !terminal_managed && !desktop_managed {
        "official"
    } else if current == MANAGED_PROVIDER_ID && terminal_managed && desktop_managed {
        "yuanheng"
    } else {
        "unknown"
    };
    let message = match mode {
        "official" => Some("Codex CLI 与 Codex App 当前使用 OpenAI 官方账号".to_string()),
        "yuanheng" => Some("Codex CLI 与 Codex App 当前使用元衡中转".to_string()),
        _ => Some("Codex CLI 与 Codex App 的配置状态不一致，请重新选择使用方式".to_string()),
    };
    let history = crate::codex_history_routes::health(
        &crate::codex_config::read_codex_config_text().map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(CodexAccountModeStatus {
        mode: mode.to_string(),
        official_login_available: codex_official_login_available().unwrap_or(false),
        yuanheng_available: yuanheng_codex_mode_available(state),
        restart_required: false,
        history_repair_needed: history.needs_repair,
        history_conflicts: history.conflicts,
        message,
    })
}

fn read_owned_codex_terminal_profile() -> Result<Option<String>, String> {
    let path = codex_terminal_profile_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let owned = crate::codex_config::extract_codex_base_url(&content)
                .is_some_and(|url| url.contains("/codex/v1"));
            if owned {
                Ok(Some(content))
            } else {
                Err("Codex 终端独立配置已被外部修改，元衡未覆盖该文件".to_string())
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取 Codex 终端独立配置失败: {error}")),
    }
}

#[derive(Clone)]
struct CodexModeSwitchSnapshot {
    live_config: Option<String>,
    terminal_profile: Option<String>,
    local_current: Option<String>,
    database_current: Option<String>,
    previous_provider_setting: Option<String>,
    managed_terminal: Option<Provider>,
    managed_desktop: Option<Provider>,
}

fn capture_codex_mode_switch_snapshot(state: &AppState) -> Result<CodexModeSwitchSnapshot, String> {
    let config_path = crate::codex_config::get_codex_config_path();
    let live_config = match std::fs::read_to_string(&config_path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取 Codex 配置快照失败: {error}")),
    };
    let profile_path = codex_terminal_profile_path();
    let terminal_profile = match std::fs::read_to_string(&profile_path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取 Codex 终端快照失败: {error}")),
    };
    Ok(CodexModeSwitchSnapshot {
        managed_terminal: managed_codex_provider_for_namespace(state, AppType::Codex.as_str())?,
        managed_desktop: managed_codex_provider_for_namespace(state, CHATGPT_DESKTOP_NAMESPACE)?,
        live_config,
        terminal_profile,
        local_current: crate::settings::get_current_provider(&AppType::Codex),
        database_current: state
            .db
            .get_current_provider(AppType::Codex.as_str())
            .map_err(|error| error.to_string())?,
        previous_provider_setting: state
            .db
            .get_setting(&previous_provider_key(&AppType::Codex))
            .map_err(|error| error.to_string())?,
    })
}

fn restore_optional_text_file(path: &std::path::Path, content: Option<&str>) -> Result<(), String> {
    match content {
        Some(content) => crate::config::write_text_file(path, content).map_err(|e| e.to_string()),
        None => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    }
}

fn restore_codex_mode_switch_snapshot(
    state: &AppState,
    snapshot: &CodexModeSwitchSnapshot,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for (namespace, previous) in [
        (AppType::Codex.as_str(), snapshot.managed_terminal.as_ref()),
        (CHATGPT_DESKTOP_NAMESPACE, snapshot.managed_desktop.as_ref()),
    ] {
        let result = match previous {
            Some(provider) => state.db.save_provider(namespace, provider),
            None => state.db.delete_provider(namespace, MANAGED_PROVIDER_ID),
        };
        if let Err(error) = result {
            errors.push(format!("恢复元衡线路记录失败: {error}"));
        }
    }
    let restore_previous = match snapshot.previous_provider_setting.as_deref() {
        Some(value) => state
            .db
            .set_setting(&previous_provider_key(&AppType::Codex), value),
        None => state
            .db
            .delete_setting(&previous_provider_key(&AppType::Codex)),
    };
    if let Err(error) = restore_previous {
        errors.push(format!("恢复接管前供应商记录失败: {error}"));
    }
    if let Err(error) = restore_optional_text_file(
        &crate::codex_config::get_codex_config_path(),
        snapshot.live_config.as_deref(),
    ) {
        errors.push(format!("恢复 Codex App 配置失败: {error}"));
    }
    if let Err(error) = restore_optional_text_file(
        &codex_terminal_profile_path(),
        snapshot.terminal_profile.as_deref(),
    ) {
        errors.push(format!("恢复 Codex CLI 配置失败: {error}"));
    }
    if let Err(error) =
        crate::settings::set_current_provider(&AppType::Codex, snapshot.local_current.as_deref())
    {
        errors.push(format!("恢复本机当前供应商失败: {error}"));
    }
    let database_restore = match snapshot.database_current.as_deref() {
        Some(id) => state.db.set_current_provider(AppType::Codex.as_str(), id),
        None => state.db.clear_current_provider(AppType::Codex.as_str()),
    };
    if let Err(error) = database_restore {
        errors.push(format!("恢复数据库当前供应商失败: {error}"));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

fn set_codex_current_provider(state: &AppState, provider_id: &str) -> Result<(), String> {
    state
        .db
        .set_current_provider(AppType::Codex.as_str(), provider_id)
        .map_err(|error| error.to_string())?;
    crate::settings::set_current_provider(&AppType::Codex, Some(provider_id))
        .map_err(|error| error.to_string())
}

/// Called after Core starts/restarts and by diagnostics. A concurrent account
/// switch owns the same lock and will write its own complete projection.
pub(crate) fn refresh_codex_history_routes_at_port(port: u16) -> Result<bool, String> {
    if port == 0 {
        return Ok(false);
    }
    let Ok(_guard) = codex_account_mode_switch_lock().try_lock() else {
        return Ok(false);
    };
    let current = crate::codex_config::read_codex_config_text().map_err(|e| e.to_string())?;
    let refreshed =
        crate::codex_history_routes::refresh(&current, Some(port)).map_err(|e| e.to_string())?;
    if refreshed == current {
        return Ok(false);
    }
    if crate::codex_config::read_codex_config_text().map_err(|e| e.to_string())? != current {
        return Err("Codex 配置刚刚被其他程序修改，请重试".into());
    }
    crate::codex_config::write_codex_live_config_atomic(Some(&refreshed))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

fn build_codex_official_mode_config(
    current_live: &str,
    proxy_origin: &str,
) -> Result<String, String> {
    let common = ProviderService::extract_common_config_snippet_from_settings(
        AppType::Codex,
        &json!({ "config": current_live }),
    )
    .map_err(|error| error.to_string())?;
    let config = crate::codex_config::apply_codex_official_proxy_route(
        &common,
        &format!("{}/v1", proxy_origin.trim_end_matches('/')),
    )
    .map_err(|error| error.to_string())?;
    crate::codex_history_routes::prepare(current_live, &config).map_err(|error| error.to_string())
}

fn switch_codex_account_mode_at_origin(
    state: &AppState,
    target_mode: &str,
    expected_mode: Option<&str>,
    proxy_origin: &str,
) -> Result<CodexAccountModeStatus, String> {
    if !matches!(target_mode, "yuanheng" | "official") {
        return Err("不支持的 Codex 使用方式".to_string());
    }
    let before = codex_account_mode_status_inner(state)?;
    if let Some(expected) = expected_mode {
        if expected != before.mode {
            return Err("Codex 配置刚刚被其他程序修改，请重新检测后再切换".to_string());
        }
    }

    let snapshot = capture_codex_mode_switch_snapshot(state)?;
    let legacy_routes = [&snapshot.managed_terminal, &snapshot.managed_desktop]
        .into_iter()
        .flatten()
        .any(|provider| {
            let (endpoint, _) = provider.resolve_usage_credentials(&AppType::Codex);
            is_managed_endpoint(&endpoint, &["", "/v1"], true)
                && !is_managed_endpoint(&endpoint, &["", "/v1"], false)
        });
    if before.mode == target_mode && !(target_mode == "yuanheng" && legacy_routes) {
        let current = snapshot.live_config.as_deref().unwrap_or_default();
        let port = url::Url::parse(proxy_origin)
            .ok()
            .and_then(|url| url.port_or_known_default());
        let mut repaired = crate::codex_history_routes::refresh(current, port)
            .map_err(|error| error.to_string())?;
        if before.history_repair_needed && repaired == current && target_mode == "official" {
            repaired = crate::codex_config::apply_codex_official_proxy_route(
                current,
                &format!("{}/v1", proxy_origin.trim_end_matches('/')),
            )
            .map_err(|error| error.to_string())?;
        }
        if repaired != current {
            crate::codex_config::write_codex_live_config_atomic(Some(&repaired))
                .map_err(|error| error.to_string())?;
        }
        let mut status = codex_account_mode_status_inner(state)?;
        status.restart_required = repaired != current;
        status.message = Some(if status.restart_required {
            "历史会话配置已修复，请重新打开对话；若仍未生效，请重启 Codex".into()
        } else {
            "当前使用方式与历史会话配置已检查".into()
        });
        return Ok(status);
    }
    let official_seed_existed = state
        .db
        .get_provider_by_id(CODEX_OFFICIAL_PROVIDER_ID, AppType::Codex.as_str())
        .map_err(|error| error.to_string())?
        .is_some();

    let operation = (|| -> Result<(), String> {
        if target_mode == "official" {
            if !codex_official_login_available()? {
                return Err(CODEX_OFFICIAL_LOGIN_REQUIRED.to_string());
            }
            read_owned_codex_terminal_profile()?;
            state
                .db
                .ensure_official_seed_by_id(CODEX_OFFICIAL_PROVIDER_ID, AppType::Codex)
                .map_err(|error| error.to_string())?;
            let current_live = snapshot.live_config.as_deref().unwrap_or_default();
            let official_config = build_codex_official_mode_config(current_live, proxy_origin)?;
            crate::codex_config::write_codex_live_config_atomic(Some(&official_config))
                .map_err(|error| format!("写入 OpenAI 官方配置失败: {error}"))?;
            restore_optional_text_file(&codex_terminal_profile_path(), None)?;
            set_codex_current_provider(state, CODEX_OFFICIAL_PROVIDER_ID)?;
            crate::services::codex_session_bridge::clear_codex_session_model();
        } else {
            if !yuanheng_codex_mode_available(state) {
                return Err("元衡 Codex 配置尚未准备好，请先连接账号并完成一次配置".to_string());
            }
            // 该文件只允许不存在，或仍为元衡自己生成的路由；未知内容不覆盖。
            read_owned_codex_terminal_profile()?;
            for surface in [CodexSurface::Terminal, CodexSurface::Desktop] {
                let mut provider =
                    prepared_managed_codex_provider(state, surface)?.ok_or("元衡配置不存在")?;
                migrate_codex_provider_endpoint(&mut provider)?;
                state
                    .db
                    .save_provider(surface.namespace(), &provider)
                    .map_err(|e| e.to_string())?;
            }
            write_codex_surface_config_at_origin(state, CodexSurface::Terminal, proxy_origin)?;
            write_codex_surface_config_at_origin(state, CodexSurface::Desktop, proxy_origin)?;
            set_codex_current_provider(state, MANAGED_PROVIDER_ID)?;
            let terminal = managed_codex_provider_for_namespace(state, AppType::Codex.as_str())?
                .ok_or_else(|| "Codex 终端元衡配置不存在".to_string())?;
            let model = provider_model(&terminal, &AppType::Codex)
                .ok_or_else(|| "Codex 终端元衡模型不存在".to_string())?;
            let reasoning = provider_reasoning(&terminal).unwrap_or_else(|| "auto".to_string());
            crate::services::codex_session_bridge::update_codex_session_model(&model, &reasoning);
        }
        if let Err(error) =
            crate::services::McpService::sync_enabled_for_app(state, &AppType::Codex)
        {
            log::warn!("切换 Codex 使用方式后重投影 MCP 失败（将在下次同步时自愈）: {error}");
        }
        Ok(())
    })();

    if let Err(error) = operation {
        let rollback = restore_codex_mode_switch_snapshot(state, &snapshot);
        if !official_seed_existed {
            let _ = state
                .db
                .delete_provider(AppType::Codex.as_str(), CODEX_OFFICIAL_PROVIDER_ID);
        }
        return match rollback {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(format!("{error}；自动回滚失败: {rollback_error}")),
        };
    }

    let mut status = codex_account_mode_status_inner(state)?;
    remember_tool_configured_at(state, AppType::Codex.as_str());
    remember_tool_configured_at(state, CHATGPT_DESKTOP_NAMESPACE);
    status.restart_required = true;
    status.message = Some(if target_mode == "official" {
        "已切换到 OpenAI 官方账号，请重启 Codex CLI 与 Codex App".to_string()
    } else {
        "已切换到元衡中转，请重启 Codex CLI 与 Codex App".to_string()
    });
    Ok(status)
}

fn managed_codex_provider_for_namespace(
    state: &AppState,
    namespace: &str,
) -> Result<Option<Provider>, String> {
    state
        .db
        .get_provider_by_id(MANAGED_PROVIDER_ID, namespace)
        .map_err(|error| error.to_string())
}

/// Old first-tool setup cloned its surface marker into the other namespace.
/// Repair only our known markers; an unknown record still requires configuration.
fn normalize_managed_codex_surface(provider: &mut Provider, surface: CodexSurface) {
    if provider.id == MANAGED_PROVIDER_ID
        && provider.category.as_deref() == Some("managed")
        && matches!(
            provider
                .settings_config
                .get("yuanhengSurface")
                .and_then(Value::as_str),
            Some("terminal" | "desktop")
        )
    {
        provider.settings_config["yuanhengSurface"] = json!(surface.marker());
    }
}

/// Prepare in memory for both preflight and switching. Read-only status must not
/// migrate the DB or claim the live route is already applied; writes stay inside
/// the explicit mode switch's existing snapshot/rollback boundary.
fn prepared_managed_codex_provider(
    state: &AppState,
    surface: CodexSurface,
) -> Result<Option<Provider>, String> {
    let mut provider = managed_codex_provider_for_namespace(state, surface.namespace())?;
    if let Some(provider) = provider.as_mut() {
        normalize_managed_codex_surface(provider, surface);
    }
    Ok(provider)
}

fn save_managed_codex_provider(
    state: &AppState,
    namespace: &str,
    provider: &Provider,
) -> Result<(), String> {
    state
        .db
        .save_provider(namespace, provider)
        .map_err(|error| error.to_string())?;
    state
        .db
        .set_current_provider(namespace, MANAGED_PROVIDER_ID)
        .map_err(|error| error.to_string())
}

fn codex_provider_catalog_settings(provider: &Provider) -> Value {
    json!({
        "modelCatalog": provider
            .settings_config
            .get("modelCatalog")
            .cloned()
            .unwrap_or_else(|| json!({ "models": [] }))
    })
}

/// Change only the selected managed provider's legacy endpoint, never tokens,
/// model catalog, unrelated TOML tables or third-party/official providers.
fn migrate_codex_provider_endpoint(provider: &mut Provider) -> Result<(), String> {
    if provider.id != MANAGED_PROVIDER_ID || provider.category.as_deref() != Some("managed") {
        return Ok(());
    }
    let (endpoint, _) = provider.resolve_usage_credentials(&AppType::Codex);
    if !is_managed_endpoint(&endpoint, &["", "/v1"], true)
        || is_managed_endpoint(&endpoint, &["", "/v1"], false)
    {
        return Ok(());
    }
    let config = provider
        .settings_config
        .get("config")
        .and_then(Value::as_str)
        .ok_or("元衡 Codex 配置缺失")?;
    let mut doc = config
        .parse::<DocumentMut>()
        .map_err(|_| "元衡 Codex 配置格式错误")?;
    let id = doc
        .get("model_provider")
        .and_then(toml_edit::Item::as_str)
        .ok_or("元衡 Codex 供应商标识缺失")?
        .to_string();
    let table = doc
        .get_mut("model_providers")
        .and_then(|providers| providers.get_mut(&id))
        .and_then(toml_edit::Item::as_table_like_mut)
        .ok_or("元衡 Codex 供应商定义缺失")?;
    table.insert("base_url", toml_edit::value(OPENAI_BASE_URL));
    provider.settings_config["config"] = json!(doc.to_string());
    Ok(())
}

fn set_codex_reasoning_field(config_text: &str, reasoning: Option<&str>) -> Result<String, String> {
    let mut document = config_text
        .parse::<DocumentMut>()
        .map_err(|error| format!("解析 Codex 配置失败: {error}"))?;
    if let Some(reasoning) = reasoning {
        document["model_reasoning_effort"] = toml_edit::value(reasoning);
    } else {
        document.as_table_mut().remove("model_reasoning_effort");
    }
    Ok(document.to_string())
}

fn codex_surface_route_config(
    provider: &Provider,
    proxy_base_url: &str,
    catalog_settings: &Value,
    surface: CodexSurface,
) -> Result<String, String> {
    let config_text = provider
        .settings_config
        .get("config")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex 配置缺少 config 字段".to_string())?;
    let config_text =
        crate::codex_config::update_codex_toml_field(config_text, "base_url", proxy_base_url)?;
    let config_text =
        crate::codex_config::update_codex_toml_field(&config_text, "wire_api", "responses")?;
    let placeholder_auth = json!({ "OPENAI_API_KEY": LOCAL_PROXY_TOKEN });
    let config_text =
        crate::codex_config::prepare_codex_provider_live_config(&placeholder_auth, &config_text)
            .map_err(|error| error.to_string())?;
    let configured_reasoning = provider_reasoning(provider).unwrap_or_else(|| "auto".to_string());
    let has_multiple_models = catalog_settings
        .pointer("/modelCatalog/models")
        .and_then(Value::as_array)
        .is_some_and(|models| models.len() > 1);
    let reasoning_override = if has_multiple_models {
        // A provider-level effort selected for the initial model is not valid
        // for every row in a mixed catalog. Let Codex use each row's declared
        // default and picker options after the user changes models in-agent.
        None
    } else {
        match configured_reasoning.as_str() {
            "auto" => None,
            level => Some(level),
        }
    };
    let config_text = set_codex_reasoning_field(&config_text, reasoning_override)?;
    crate::codex_config::prepare_codex_config_text_with_named_model_catalog(
        catalog_settings,
        &config_text,
        crate::codex_config::CodexCatalogToolProfile::ProxyChat,
        surface.catalog_filename(),
    )
    .map_err(|error| error.to_string())
}

fn write_codex_surface_config_at_origin(
    state: &AppState,
    surface: CodexSurface,
    proxy_origin: &str,
) -> Result<(), String> {
    let provider =
        managed_codex_provider_for_namespace(state, surface.namespace())?.ok_or_else(|| {
            match surface {
                CodexSurface::Terminal => "Codex 终端配置不存在".to_string(),
                CodexSurface::Desktop => "ChatGPT Desktop 配置不存在".to_string(),
            }
        })?;
    let catalog_settings = codex_provider_catalog_settings(&provider);
    let route = codex_surface_route_config(
        &provider,
        &format!("{proxy_origin}/{}/v1", surface.route_prefix()),
        &catalog_settings,
        surface,
    )?;

    match surface {
        CodexSurface::Terminal => {
            // 终端桥接只读取独立 profile，不能改写 Codex App 正在使用的 Live 配置。
            crate::config::write_text_file(&codex_terminal_profile_path(), &route)
                .map_err(|error| format!("写入 Codex 终端独立配置失败: {error}"))?;
            log::info!("Codex 终端独立路由已更新，未改写 Codex App Live 配置");
            Ok(())
        }
        CodexSurface::Desktop => {
            let current_live = crate::codex_config::read_codex_config_text().unwrap_or_default();
            let merged = crate::services::provider::update_toml_common_config_snippet(
                &current_live,
                &route,
                true,
            )
            .map_err(|error| error.to_string())?;
            let reasoning = provider_reasoning(&provider).unwrap_or_else(|| "auto".to_string());
            let merged = if reasoning == "auto" {
                set_codex_reasoning_field(&merged, None)?
            } else {
                merged
            };

            crate::codex_config::write_codex_live_config_atomic(Some(&merged))
                .map_err(|error| format!("写入 ChatGPT Desktop 独立配置失败: {error}"))?;
            log::info!("ChatGPT Desktop Live 路由已更新");
            Ok(())
        }
    }
}

async fn write_codex_surface_config(state: &AppState, surface: CodexSurface) -> Result<(), String> {
    let proxy_status = state.proxy_service.get_status().await?;
    if !proxy_status.running || proxy_status.port == 0 {
        return Err("本地模型路由尚未启动".to_string());
    }
    let proxy_origin = format!("http://127.0.0.1:{}", proxy_status.port);
    write_codex_surface_config_at_origin(state, surface, &proxy_origin)
}

fn set_codex_available_models(provider: &mut Provider, selected: &str, models: &[String]) {
    let entries = terminal_catalog_models(selected, models)
        .iter()
        .map(|model| {
            json!({
                "model": model,
                "displayName": model,
                "contextWindow": 200_000,
                "apiFormat": yuanheng_model_api_format(model)
            })
        })
        .collect::<Vec<_>>();
    provider.settings_config["modelCatalog"] = json!({ "models": entries });
}

async fn configure_codex_surface(
    state: &AppState,
    surface: CodexSurface,
    token: &str,
    model: &str,
    available_models: &[String],
    group: &str,
    reasoning: &str,
) -> Result<YuanhengToolConfigureResult, String> {
    // 与“元衡 / 官方账号”切换共享同一把锁，防止快速点击或并发命令
    // 把 CLI profile、Desktop live 配置和 current provider 写成交叉状态。
    let _guard = codex_account_mode_switch_lock().lock().await;
    let snapshot = capture_codex_mode_switch_snapshot(state)?;
    let desktop_current = state
        .db
        .get_current_provider(CHATGPT_DESKTOP_NAMESPACE)
        .map_err(|error| error.to_string())?;
    // Desktop 会改写 Codex Live 配置；终端虽然只写独立 profile，仍需保留
    // 原始 Codex 状态，便于统一关闭元衡接管时恢复。
    remember_tool_state(state, &AppType::Codex)?;

    let mut selected = managed_provider_with_models(
        &AppType::Codex,
        token,
        model,
        available_models,
        group,
        reasoning,
    )?;
    set_codex_available_models(&mut selected, model, available_models);
    selected.settings_config["yuanhengSurface"] = json!(surface.marker());
    let terminal_before = managed_codex_provider_for_namespace(state, AppType::Codex.as_str())?;
    let desktop_before = managed_codex_provider_for_namespace(state, CHATGPT_DESKTOP_NAMESPACE)?;

    let mut terminal = if surface == CodexSurface::Terminal {
        selected.clone()
    } else {
        terminal_before
            .clone()
            .or_else(|| desktop_before.clone())
            .unwrap_or_else(|| selected.clone())
    };
    let mut desktop = if surface == CodexSurface::Desktop {
        selected
    } else {
        desktop_before
            .clone()
            .or_else(|| terminal_before.clone())
            .unwrap_or_else(|| terminal.clone())
    };
    normalize_managed_codex_surface(&mut terminal, CodexSurface::Terminal);
    normalize_managed_codex_surface(&mut desktop, CodexSurface::Desktop);
    migrate_codex_provider_endpoint(&mut terminal)?;
    migrate_codex_provider_endpoint(&mut desktop)?;

    let update = async {
        save_managed_codex_provider(state, AppType::Codex.as_str(), &terminal)?;
        save_managed_codex_provider(state, CHATGPT_DESKTOP_NAMESPACE, &desktop)?;
        crate::settings::set_current_provider(&AppType::Codex, Some(MANAGED_PROVIDER_ID))
            .map_err(|error| error.to_string())?;
        write_codex_surface_config(state, surface).await
    }
    .await;
    if let Err(error) = update {
        let mut rollback_errors = Vec::new();
        for (namespace, old) in [
            (AppType::Codex.as_str(), terminal_before.as_ref()),
            (CHATGPT_DESKTOP_NAMESPACE, desktop_before.as_ref()),
        ] {
            let restored = match old {
                Some(provider) => state.db.save_provider(namespace, provider),
                None => state.db.delete_provider(namespace, MANAGED_PROVIDER_ID),
            };
            if let Err(e) = restored {
                rollback_errors.push(e.to_string());
            }
        }
        if let Err(e) = restore_codex_mode_switch_snapshot(state, &snapshot) {
            rollback_errors.push(e);
        }
        let restored = match desktop_current.as_deref() {
            Some(id) => state.db.set_current_provider(CHATGPT_DESKTOP_NAMESPACE, id),
            None => state.db.clear_current_provider(CHATGPT_DESKTOP_NAMESPACE),
        };
        if let Err(e) = restored {
            rollback_errors.push(e.to_string());
        }
        return if rollback_errors.is_empty() {
            Err(error)
        } else {
            Err(format!(
                "{error}；配置恢复未完成：{}",
                rollback_errors.join("；")
            ))
        };
    }

    Ok(YuanhengToolConfigureResult {
        app: surface.namespace().to_string(),
        configured: true,
        model: Some(model.to_string()),
        warnings: Vec::new(),
        error: None,
    })
}

fn provider_note_value(provider: &Provider, key: &str) -> Option<String> {
    provider
        .notes
        .as_deref()
        .and_then(|notes| {
            notes.split('|').find_map(|part| {
                let (name, value) = part.trim().split_once('=')?;
                (name.trim() == key).then_some(value)
            })
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn provider_group(provider: &Provider) -> Option<String> {
    provider_note_value(provider, "group")
}

fn provider_reasoning(provider: &Provider) -> Option<String> {
    provider_note_value(provider, "reasoning").or_else(|| Some("auto".to_string()))
}

fn provider_schema_current(provider: &Provider, app: &AppType) -> bool {
    if provider.name != MANAGED_PROVIDER_DISPLAY_NAME {
        return false;
    }
    if provider_model(provider, app)
        .as_deref()
        .is_some_and(is_image_generation_only_model)
    {
        return false;
    }
    match app {
        AppType::ClaudeDesktop => {
            let Some(model) = provider_model(provider, app) else {
                return false;
            };
            let Some(meta) = provider.meta.as_ref() else {
                return false;
            };
            meta.api_format.as_deref() == Some(yuanheng_model_api_format(&model))
                && meta
                    .claude_desktop_model_routes
                    .get("claude-sonnet-5")
                    .and_then(|route| route.label_override.as_deref())
                    == Some(MANAGED_PROVIDER_AI_LABEL)
        }
        AppType::Codex => {
            let Some(model) = provider_model(provider, app) else {
                return false;
            };
            let api_format_current = provider
                .meta
                .as_ref()
                .and_then(|meta| meta.api_format.as_deref())
                == Some(yuanheng_model_api_format(&model));
            let display_name_current = provider
                .settings_config
                .get("config")
                .and_then(Value::as_str)
                .and_then(|config| config.parse::<toml::Value>().ok())
                .and_then(|config| {
                    config
                        .get("model_providers")
                        .and_then(|providers| providers.get("custom"))
                        .and_then(|custom| custom.get("name"))
                        .and_then(toml::Value::as_str)
                        .map(str::to_string)
                })
                .as_deref()
                == Some(MANAGED_PROVIDER_DISPLAY_NAME);
            let catalog_is_current = provider
                .settings_config
                .pointer("/modelCatalog/models")
                .and_then(Value::as_array)
                .is_some_and(|models| {
                    !models.is_empty()
                        && models.iter().any(|item| {
                            item.get("model").and_then(Value::as_str) == Some(model.as_str())
                        })
                        && models.iter().all(|item| {
                            let Some(catalog_model) = item.get("model").and_then(Value::as_str)
                            else {
                                return false;
                            };
                            item.get("apiFormat").and_then(Value::as_str)
                                == Some(yuanheng_model_api_format(catalog_model))
                        })
                });
            api_format_current && display_name_current && catalog_is_current
        }
        AppType::GrokBuild => provider
            .settings_config
            .get("config")
            .and_then(Value::as_str)
            .and_then(|config| config.parse::<toml::Value>().ok())
            .and_then(|config| config.get("model").and_then(toml::Value::as_table).cloned())
            .is_some_and(|models| {
                !models.is_empty()
                    && models.values().all(|model| {
                        model.get("name").and_then(toml::Value::as_str)
                            == Some(MANAGED_PROVIDER_DISPLAY_NAME)
                    })
            }),
        AppType::OpenCode | AppType::Hermes => {
            provider.settings_config.get("name").and_then(Value::as_str)
                == Some(MANAGED_PROVIDER_DISPLAY_NAME)
        }
        AppType::Claude | AppType::Gemini | AppType::OpenClaw => true,
    }
}

fn codex_catalog_covers_available_models(provider: &Provider, models: &[String]) -> bool {
    let configured = provider
        .settings_config
        .pointer("/modelCatalog/models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("model").and_then(Value::as_str))
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let terminal_models = models
        .iter()
        .filter(|model| !is_image_generation_only_model(model))
        .collect::<Vec<_>>();
    !terminal_models.is_empty()
        && terminal_models
            .iter()
            .all(|model| configured.contains(model.as_str()))
}

fn provider_catalog_covers_available_models(
    provider: &Provider,
    app: &AppType,
    models: &[String],
) -> bool {
    if matches!(app, AppType::Codex) {
        return codex_catalog_covers_available_models(provider, models);
    }
    let configured = match app {
        AppType::OpenCode => provider
            .settings_config
            .get("models")
            .and_then(Value::as_object)
            .map(|items| items.keys().cloned().collect::<BTreeSet<_>>()),
        AppType::OpenClaw | AppType::Hermes => provider
            .settings_config
            .get("models")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect::<BTreeSet<_>>()
            }),
        AppType::GrokBuild => provider
            .settings_config
            .get("config")
            .and_then(Value::as_str)
            .and_then(|config| config.parse::<toml::Value>().ok())
            .and_then(|config| {
                config
                    .get("model")
                    .and_then(toml::Value::as_table)
                    .map(|items| items.keys().cloned().collect::<BTreeSet<_>>())
            }),
        AppType::Claude | AppType::ClaudeDesktop | AppType::Gemini => return true,
        AppType::Codex => unreachable!(),
    }
    .unwrap_or_default();
    !models.is_empty()
        && models
            .iter()
            .all(|model| configured.contains(model.as_str()))
}

fn cached_models_for_group(
    connection: &YuanhengConnectionStatus,
    group: Option<&str>,
    selected: Option<String>,
) -> Vec<String> {
    let Some(group) = group else {
        return selected.into_iter().collect();
    };
    let models = connection
        .terminal_models
        .iter()
        .filter(|model| {
            connection
                .model_groups
                .get(*model)
                .is_some_and(|groups| groups.iter().any(|candidate| candidate == group))
        })
        .cloned()
        .collect::<Vec<_>>();
    if models.is_empty() {
        selected.into_iter().collect()
    } else {
        models
    }
}

fn cached_models_for_provider_group(
    connection: &YuanhengConnectionStatus,
    provider: &Provider,
    app: &AppType,
) -> Vec<String> {
    let group = provider_group(provider);
    cached_models_for_group(connection, group.as_deref(), provider_model(provider, app))
}

fn codex_surface_matches(provider: &Provider, surface: CodexSurface) -> bool {
    provider
        .settings_config
        .get("yuanhengSurface")
        .and_then(Value::as_str)
        == Some(surface.marker())
}

fn provider_has_credentials(provider: &Provider, app: &AppType) -> bool {
    provider_has_credentials_for_route(provider, app, false)
}

fn provider_has_credentials_for_route(
    provider: &Provider,
    app: &AppType,
    allow_legacy: bool,
) -> bool {
    let settings = &provider.settings_config;
    let non_empty = |pointer: &str| {
        settings
            .pointer(pointer)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    };
    // Inspect the effective endpoint, not arbitrary text in notes or keys.
    // Old CN records remain readable by stored_tool_credential, but must be
    // reapplied through the normal verified configuration flow before current.
    let (base_url, _) = provider.resolve_usage_credentials(app);
    let has_base_url = is_managed_endpoint(&base_url, &["", "/v1"], allow_legacy);
    let has_token = match app {
        AppType::Claude | AppType::ClaudeDesktop => non_empty("/env/ANTHROPIC_AUTH_TOKEN"),
        AppType::Codex => non_empty("/auth/OPENAI_API_KEY"),
        AppType::Gemini => non_empty("/env/GEMINI_API_KEY"),
        AppType::GrokBuild => {
            settings
                .get("config")
                .and_then(Value::as_str)
                .is_some_and(|config| {
                    config.contains("api_key = \"") && !config.contains("api_key = \"\"")
                })
        }
        AppType::OpenCode => non_empty("/options/apiKey"),
        AppType::OpenClaw => non_empty("/apiKey"),
        AppType::Hermes => non_empty("/api_key"),
    };
    has_base_url && has_token
}

fn provider_model(provider: &Provider, app: &AppType) -> Option<String> {
    let settings = &provider.settings_config;
    match app {
        AppType::Claude | AppType::ClaudeDesktop => settings
            .pointer("/env/ANTHROPIC_MODEL")
            .and_then(Value::as_str)
            .map(str::to_string),
        AppType::Codex => settings
            .get("config")
            .and_then(Value::as_str)
            .and_then(|config| config.parse::<toml::Value>().ok())
            .and_then(|config| {
                config
                    .get("model")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string)
            }),
        AppType::Gemini => settings
            .pointer("/env/GEMINI_MODEL")
            .and_then(Value::as_str)
            .map(str::to_string),
        AppType::GrokBuild => settings
            .get("config")
            .and_then(Value::as_str)
            .and_then(crate::grok_config::extract_model_config)
            .map(|config| config.model),
        AppType::OpenCode => settings
            .get("models")
            .and_then(Value::as_object)
            .and_then(|models| models.keys().next().cloned()),
        AppType::OpenClaw | AppType::Hermes => settings
            .get("models")
            .and_then(Value::as_array)
            .and_then(|models| models.first())
            .and_then(|model| model.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

#[cfg(target_os = "macos")]
fn format_download_size(bytes: u64) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    if bytes < 1024 * 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / MIB)
    }
}

#[cfg(target_os = "macos")]
fn claude_desktop_runtime_status_from(
    application_support: &std::path::Path,
    now: SystemTime,
) -> Option<YuanhengRuntimeStatus> {
    let mut newest_partial: Option<(u64, SystemTime)> = None;

    for data_dir in ["Claude-3p", "Claude"] {
        let versions_dir = application_support.join(data_dir).join("claude-code");
        let Ok(versions) = std::fs::read_dir(versions_dir) else {
            continue;
        };
        for version in versions.flatten() {
            let version_path = version.path();
            if version_path.join(".verified").is_file() {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&version_path) else {
                continue;
            };
            for entry in entries.flatten() {
                if !entry.file_name().to_string_lossy().ends_with(".partial") {
                    continue;
                }
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
                if newest_partial
                    .as_ref()
                    .is_none_or(|(_, current)| modified > *current)
                {
                    newest_partial = Some((metadata.len(), modified));
                }
            }
        }
    }

    let (downloaded_bytes, modified) = newest_partial?;
    let is_active = now.duration_since(modified).unwrap_or_default() <= Duration::from_secs(120);
    let size = format_download_size(downloaded_bytes);
    let (state, title, message) = if is_active {
        (
            "downloading",
            "Claude 组件正在下载",
            format!("已下载 {size}。请保持 Claude Desktop 打开，元衡每 30 秒自动检测一次。"),
        )
    } else {
        (
            "stalled",
            "Claude 组件下载已停滞",
            format!("当前已下载 {size}。若 Claude Desktop 已打开，请完全退出后重新打开；如仍无变化，请检查网络能否访问 downloads.claude.ai。"),
        )
    };

    Some(YuanhengRuntimeStatus {
        state: state.to_string(),
        title: title.to_string(),
        message,
        downloaded_bytes,
        updated_at: modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    })
}

#[cfg(target_os = "macos")]
fn claude_desktop_runtime_status() -> Option<YuanhengRuntimeStatus> {
    let application_support = dirs::home_dir()?
        .join("Library")
        .join("Application Support");
    claude_desktop_runtime_status_from(&application_support, SystemTime::now())
}

#[cfg(not(target_os = "macos"))]
fn claude_desktop_runtime_status() -> Option<YuanhengRuntimeStatus> {
    None
}

fn tool_status(
    state: &AppState,
    app: AppType,
    connection: &YuanhengConnectionStatus,
) -> YuanhengToolStatus {
    let models = &connection.models;
    let recommended = recommended_model(&app, models);
    let provider = ProviderService::list(state, app.clone())
        .ok()
        .and_then(|providers| providers.get(MANAGED_PROVIDER_ID).cloned());
    let live_selected = app.is_additive_mode()
        || ProviderService::current(state, app.clone())
            .map(|current| current == MANAGED_PROVIDER_ID)
            .unwrap_or(false);
    let credentials_current = provider
        .as_ref()
        .is_some_and(|item| provider_has_credentials(item, &app));
    let provider_schema_current = provider.as_ref().is_some_and(|item| {
        let expected_models = cached_models_for_provider_group(connection, item, &app);
        provider_schema_current(item, &app)
            && provider_catalog_covers_available_models(item, &app, &expected_models)
            && (!matches!(app, AppType::Codex)
                || codex_surface_matches(item, CodexSurface::Terminal))
    });
    let surface_config_current = !matches!(app, AppType::Codex)
        || std::fs::read_to_string(codex_terminal_profile_path())
            .ok()
            .is_some_and(|config| config.contains("/codex/v1"));
    let schema_current = provider_schema_current && surface_config_current;
    let needs_update =
        provider.is_some() && (!live_selected || !credentials_current || !schema_current);
    let configured = provider.is_some() && !needs_update;
    let model = provider
        .as_ref()
        .and_then(|item| provider_model(item, &app));
    let group = provider.as_ref().and_then(provider_group);
    let reasoning = provider.as_ref().and_then(provider_reasoning);
    let supported = recommended.is_some();
    let message = if !supported {
        Some(
            match app {
                AppType::ClaudeDesktop => "账号中暂时没有适合 Claude Desktop 的文本模型",
                _ => "账号中暂时没有可用模型",
            }
            .to_string(),
        )
    } else if configured {
        Some("元衡配置已写入".to_string())
    } else if needs_update {
        Some("账号或模型已变化，需要重新配置".to_string())
    } else {
        None
    };
    let runtime_status = matches!(app, AppType::ClaudeDesktop)
        .then(claude_desktop_runtime_status)
        .flatten();
    YuanhengToolStatus {
        app: app.as_str().to_string(),
        supported,
        configured,
        needs_update,
        model,
        group,
        reasoning,
        recommended_model: recommended,
        message,
        runtime_warning: runtime_status.as_ref().map(|status| status.message.clone()),
        runtime_status,
    }
}

fn workbuddy_config_path() -> std::path::PathBuf {
    crate::config::get_home_dir()
        .join(".workbuddy")
        .join("models.json")
}

fn read_workbuddy_config() -> Option<Value> {
    let content = std::fs::read_to_string(workbuddy_config_path()).ok()?;
    serde_json::from_str(&content).ok()
}

fn workbuddy_config_matches(value: &Value, model: &str) -> bool {
    workbuddy_config_matches_endpoint(value, model, false)
}

fn workbuddy_config_matches_endpoint(value: &Value, model: &str, allow_legacy: bool) -> bool {
    // The file is replaced/restored as a whole; a valid selected model must
    // not hide another row that still uses CN or belongs to a third party.
    let Some(models) = value.get("models").and_then(Value::as_array) else {
        return false;
    };
    if models.is_empty()
        || !models.iter().all(|item| {
            item.get("vendor").and_then(Value::as_str) == Some(MANAGED_PROVIDER_DISPLAY_NAME)
                && item.get("url").and_then(Value::as_str).is_some_and(|url| {
                    is_managed_endpoint(url, &["/v1/chat/completions"], allow_legacy)
                })
        })
    {
        return false;
    }
    let Some(item) = value
        .get("models")
        .and_then(Value::as_array)
        .and_then(|models| {
            models
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(model))
        })
    else {
        return false;
    };
    item.get("id").and_then(Value::as_str) == Some(model)
        && item.get("vendor").and_then(Value::as_str) == Some(MANAGED_PROVIDER_DISPLAY_NAME)
        && item
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|url| is_managed_endpoint(url, &["/v1/chat/completions"], allow_legacy))
        && item
            .get("apiKey")
            .and_then(Value::as_str)
            .is_some_and(|token| !token.trim().is_empty())
        && value
            .get("availableModels")
            .and_then(Value::as_array)
            .is_some_and(|models| models.iter().any(|item| item.as_str() == Some(model)))
}

fn workbuddy_config_covers_models(value: &Value, models: &[String]) -> bool {
    let configured = value
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    !models.is_empty()
        && models.iter().all(|model| {
            configured.contains(model.as_str()) && workbuddy_config_matches(value, model)
        })
}

fn workbuddy_status(state: &AppState, connection: &YuanhengConnectionStatus) -> YuanhengToolStatus {
    let models = &connection.models;
    let recommended = recommended_model(&AppType::OpenCode, models);
    let stored_model = state
        .db
        .get_setting(WORKBUDDY_MODEL_KEY)
        .ok()
        .flatten()
        .filter(|model| !model.is_empty());
    let stored_group = state
        .db
        .get_setting(WORKBUDDY_GROUP_KEY)
        .ok()
        .flatten()
        .filter(|group| !group.is_empty());
    let was_managed = state
        .db
        .get_setting(PREVIOUS_WORKBUDDY_CONFIG_KEY)
        .ok()
        .flatten()
        .is_some_and(|value| !value.is_empty());
    let configured = was_managed
        && stored_model.as_deref().is_some_and(|model| {
            let expected_models = cached_models_for_group(
                connection,
                stored_group.as_deref(),
                Some(model.to_string()),
            );
            !is_image_generation_only_model(model)
                && models.iter().any(|item| item == model)
                && read_workbuddy_config().as_ref().is_some_and(|value| {
                    workbuddy_config_matches(value, model)
                        && workbuddy_config_covers_models(value, &expected_models)
                })
        });
    let supported = recommended.is_some();
    YuanhengToolStatus {
        app: "workbuddy".to_string(),
        supported,
        configured,
        needs_update: was_managed && !configured,
        model: stored_model,
        group: stored_group,
        reasoning: Some("auto".to_string()),
        recommended_model: recommended,
        message: if !supported {
            Some("账号中暂时没有可用于 WorkBuddy 的文本模型".to_string())
        } else if configured {
            Some("WorkBuddy 自定义模型已写入".to_string())
        } else if was_managed {
            Some("WorkBuddy 配置已变化，需要重新配置".to_string())
        } else {
            None
        },
        runtime_warning: None,
        runtime_status: None,
    }
}

fn chatgpt_desktop_status(
    state: &AppState,
    connection: &YuanhengConnectionStatus,
) -> YuanhengToolStatus {
    let models = &connection.models;
    let stored = managed_codex_provider_for_namespace(state, CHATGPT_DESKTOP_NAMESPACE)
        .ok()
        .flatten();
    let legacy = managed_codex_provider_for_namespace(state, AppType::Codex.as_str())
        .ok()
        .flatten();
    let display_provider = stored.as_ref().or(legacy.as_ref());
    let route_current = crate::codex_config::read_codex_config_text()
        .ok()
        .and_then(|config| crate::codex_config::extract_codex_base_url(&config))
        .is_some_and(|url| url.contains("/chatgpt-desktop/v1"));
    let schema_current = stored.as_ref().is_some_and(|provider| {
        let expected_models =
            cached_models_for_provider_group(connection, provider, &AppType::Codex);
        provider_has_credentials(provider, &AppType::Codex)
            && provider_schema_current(provider, &AppType::Codex)
            && codex_catalog_covers_available_models(provider, &expected_models)
            && codex_surface_matches(provider, CodexSurface::Desktop)
    });
    let configured = stored.is_some() && schema_current && route_current;
    let needs_update = display_provider.is_some() && !configured;
    let recommended = recommended_model(&AppType::Codex, models);
    YuanhengToolStatus {
        app: CHATGPT_DESKTOP_NAMESPACE.to_string(),
        supported: recommended.is_some(),
        configured,
        needs_update,
        model: display_provider.and_then(|provider| provider_model(provider, &AppType::Codex)),
        group: display_provider.and_then(provider_group),
        reasoning: display_provider.and_then(provider_reasoning),
        recommended_model: recommended,
        message: if configured {
            Some("ChatGPT Desktop 独立模型配置已写入".to_string())
        } else if needs_update {
            Some("需要迁移为独立桌面配置".to_string())
        } else {
            None
        },
        runtime_warning: None,
        runtime_status: None,
    }
}

fn all_tool_statuses(
    state: &AppState,
    connection: &YuanhengConnectionStatus,
) -> Vec<YuanhengToolStatus> {
    let mut statuses = AppType::all()
        .map(|app| tool_status(state, app, connection))
        .collect::<Vec<_>>();
    statuses.push(chatgpt_desktop_status(state, connection));
    statuses.push(workbuddy_status(state, connection));
    statuses.push(dsh::status(state, connection));
    statuses
}

fn tool_configured_at_key(app: &str) -> String {
    format!("{TOOL_CONFIGURED_AT_KEY_PREFIX}{app}")
}

fn remember_tool_configured_at(state: &AppState, app: &str) {
    if let Err(error) = state.db.set_setting(
        &tool_configured_at_key(app),
        &chrono::Utc::now().timestamp().to_string(),
    ) {
        log::warn!("记录 {app} 配置生效时间失败: {error}");
    }
}

fn read_tool_configured_at(state: &AppState, app: &str) -> Option<i64> {
    state
        .db
        .get_setting(&tool_configured_at_key(app))
        .ok()
        .flatten()
        .and_then(|value| value.parse::<i64>().ok())
}

async fn yuanheng_tool_activation_statuses_inner(
    state: &AppState,
) -> Result<Vec<YuanhengToolActivationStatus>, String> {
    let connection = read_cached_status(state)?;
    let statuses = all_tool_statuses(state, &connection);
    let status_map = statuses
        .iter()
        .map(|status| (status.app.as_str(), status))
        .collect::<HashMap<_, _>>();
    let codex_mode = codex_account_mode_status_inner(state)
        .ok()
        .map(|status| status.mode)
        .unwrap_or_else(|| "unknown".to_string());
    let proxy_running = state.proxy_service.is_running().await;
    let apps = [
        "claude",
        "claude-desktop",
        "codex",
        CHATGPT_DESKTOP_NAMESPACE,
        "gemini",
        "grokbuild",
        "opencode",
        "openclaw",
        "hermes",
        "workbuddy",
        "dsh",
    ];
    let mut results = Vec::with_capacity(apps.len());

    for app in apps {
        let configured_at = read_tool_configured_at(state, app);
        let official_codex =
            matches!(app, "codex" | CHATGPT_DESKTOP_NAMESPACE) && codex_mode == "official";
        let config_written =
            official_codex || status_map.get(app).is_some_and(|status| status.configured);
        let route_required = matches!(app, "claude-desktop" | "codex" | CHATGPT_DESKTOP_NAMESPACE);
        let owned_route = match app {
            "codex" if official_codex => managed_codex_routes_require_core(state.db.as_ref()),
            "codex" => {
                managed_codex_surface_route_active(state.db.as_ref(), CodexSurface::Terminal)
            }
            CHATGPT_DESKTOP_NAMESPACE => managed_chatgpt_desktop_route_active(state.db.as_ref()),
            "claude-desktop" => config_written,
            _ => true,
        };
        let route_ready = config_written && (!route_required || (proxy_running && owned_route));

        let latest_log = if route_required {
            // 旧安装没有配置时间时也展示近期失败，但不能用旧成功证明本次生效。
            state
                .db
                .get_latest_proxy_request_for_app(
                    app,
                    configured_at.unwrap_or_else(|| chrono::Utc::now().timestamp() - 3600),
                )
                .map_err(|error| error.to_string())?
                .filter(|log| {
                    log.provider_id
                        == if official_codex {
                            CODEX_OFFICIAL_PROVIDER_ID
                        } else {
                            MANAGED_PROVIDER_ID
                        }
                })
        } else {
            None
        };
        let request_received = latest_log.is_some();
        let request_succeeded = latest_log.as_ref().is_some_and(|log| {
            configured_at.is_some()
                && (200..300).contains(&log.status_code)
                && log.error_message.is_none()
        });
        let message = if !config_written {
            "尚未写入有效配置".to_string()
        } else if latest_log
            .as_ref()
            .is_some_and(|log| log.status_code == 401 || log.status_code == 403)
        {
            "已收到请求，但工具分组凭据被拒绝；请在元衡中重新配置该工具，无需登录 OpenAI 官方账号"
                .to_string()
        } else if configured_at.is_none() {
            "配置已存在；重新应用一次后可追踪完整生效过程".to_string()
        } else if !route_ready && request_succeeded {
            "此前已确认模型调用成功，但当前本地路由未运行".to_string()
        } else if !route_ready {
            "配置已写入，正在等待本地路由就绪".to_string()
        } else if !route_required {
            "配置已写入；该工具不经过本地路由，无法确认首次模型调用".to_string()
        } else if !request_received {
            "配置与路由已就绪，等待工具发出第一条请求".to_string()
        } else if request_succeeded {
            "已收到请求并确认模型调用成功".to_string()
        } else {
            let status = latest_log
                .as_ref()
                .map(|log| log.status_code.to_string())
                .unwrap_or_else(|| "未知".to_string());
            format!("已收到请求，但最近一次调用失败（HTTP {status}）")
        };
        results.push(YuanhengToolActivationStatus {
            app: app.to_string(),
            configured_at,
            config_written,
            route_required,
            route_ready,
            request_received,
            request_succeeded,
            last_request_at: latest_log.as_ref().map(|log| log.created_at),
            last_status_code: latest_log.as_ref().map(|log| log.status_code),
            last_model: latest_log.map(|log| log.model),
            message,
        });
    }
    Ok(results)
}

fn previous_provider_key(app: &AppType) -> String {
    format!("{PREVIOUS_PROVIDER_KEY_PREFIX}{}", app.as_str())
}

fn remember_tool_state(state: &AppState, app: &AppType) -> Result<(), String> {
    if matches!(app, AppType::Hermes) {
        let existing = state
            .db
            .get_setting(PREVIOUS_HERMES_MODEL_KEY)
            .map_err(|e| e.to_string())?;
        if existing.as_deref().unwrap_or_default().is_empty() {
            let model = crate::hermes_config::get_model_config().map_err(|e| e.to_string())?;
            let serialized = model
                .map(|value| serde_json::to_string(&value).map_err(|e| e.to_string()))
                .transpose()?
                .unwrap_or_else(|| NO_PREVIOUS_VALUE.to_string());
            state
                .db
                .set_setting(PREVIOUS_HERMES_MODEL_KEY, &serialized)
                .map_err(|e| e.to_string())?;
        }
    }

    if app.is_additive_mode() {
        return Ok(());
    }

    let key = previous_provider_key(app);
    let existing = state.db.get_setting(&key).map_err(|e| e.to_string())?;
    if !existing.as_deref().unwrap_or_default().is_empty() {
        return Ok(());
    }
    let current = ProviderService::current(state, app.clone()).map_err(|e| e.to_string())?;
    let previous = if current.is_empty() || current == MANAGED_PROVIDER_ID {
        NO_PREVIOUS_VALUE
    } else {
        current.as_str()
    };
    state
        .db
        .set_setting(&key, previous)
        .map_err(|e| e.to_string())
}

fn remember_workbuddy_state(state: &AppState) -> Result<(), String> {
    let existing = state
        .db
        .get_setting(PREVIOUS_WORKBUDDY_CONFIG_KEY)
        .map_err(|e| e.to_string())?;
    if existing.as_deref().is_some_and(|value| !value.is_empty()) {
        return Ok(());
    }
    let previous = match std::fs::read_to_string(workbuddy_config_path()) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => NO_PREVIOUS_VALUE.to_string(),
        Err(error) => return Err(format!("备份 WorkBuddy 配置失败: {error}")),
    };
    state
        .db
        .set_setting(PREVIOUS_WORKBUDDY_CONFIG_KEY, &previous)
        .map_err(|e| e.to_string())
}

#[cfg(unix)]
fn protect_workbuddy_config() -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        workbuddy_config_path(),
        std::fs::Permissions::from_mode(0o600),
    )
    .map_err(|error| format!("设置 WorkBuddy 配置权限失败: {error}"))
}

#[cfg(not(unix))]
fn protect_workbuddy_config() -> Result<(), String> {
    Ok(())
}

fn configure_workbuddy(
    state: &AppState,
    token: &str,
    model: &str,
    available_models: &[String],
    group: &str,
) -> Result<YuanhengToolConfigureResult, String> {
    remember_workbuddy_state(state)?;
    let catalog_models = terminal_catalog_models(model, available_models);
    let config = json!({
        "models": catalog_models.iter().map(|catalog_model| json!({
            "id": catalog_model,
            "name": catalog_model,
            "vendor": MANAGED_PROVIDER_DISPLAY_NAME,
            "url": format!("{OPENAI_BASE_URL}/chat/completions"),
            "apiKey": token,
            "maxInputTokens": 200000,
            "maxOutputTokens": 8192,
            "supportsToolCall": true,
            "supportsImages": true
        })).collect::<Vec<_>>(),
        "availableModels": catalog_models
    });
    crate::config::write_json_file(&workbuddy_config_path(), &config)
        .map_err(|error| format!("写入 WorkBuddy 配置失败: {error}"))?;
    protect_workbuddy_config()?;
    state
        .db
        .set_setting(WORKBUDDY_MODEL_KEY, model)
        .map_err(|e| e.to_string())?;
    state
        .db
        .set_setting(WORKBUDDY_GROUP_KEY, group)
        .map_err(|e| e.to_string())?;
    Ok(YuanhengToolConfigureResult {
        app: "workbuddy".to_string(),
        configured: true,
        model: Some(model.to_string()),
        warnings: Vec::new(),
        error: None,
    })
}

fn restore_workbuddy_config(state: &AppState) -> Result<Option<bool>, String> {
    let previous = state
        .db
        .get_setting(PREVIOUS_WORKBUDDY_CONFIG_KEY)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if previous.is_empty() {
        return Ok(None);
    }
    let stored_model = state
        .db
        .get_setting(WORKBUDDY_MODEL_KEY)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let current_is_managed = !stored_model.is_empty()
        && read_workbuddy_config()
            .as_ref()
            .is_some_and(|value| workbuddy_config_matches_endpoint(value, &stored_model, true));
    if !current_is_managed {
        return Err("WorkBuddy 配置已被外部修改，元衡未覆盖当前文件".to_string());
    }

    let restored = if previous == NO_PREVIOUS_VALUE {
        match std::fs::remove_file(workbuddy_config_path()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("移除 WorkBuddy 元衡配置失败: {error}")),
        }
        false
    } else {
        crate::config::write_text_file(&workbuddy_config_path(), &previous)
            .map_err(|error| format!("恢复 WorkBuddy 配置失败: {error}"))?;
        protect_workbuddy_config()?;
        true
    };
    for key in [
        PREVIOUS_WORKBUDDY_CONFIG_KEY,
        WORKBUDDY_MODEL_KEY,
        WORKBUDDY_GROUP_KEY,
    ] {
        state.db.set_setting(key, "").map_err(|e| e.to_string())?;
    }
    Ok(Some(restored))
}

fn restore_hermes_model(state: &AppState) -> Result<(), String> {
    let stored = state
        .db
        .get_setting(PREVIOUS_HERMES_MODEL_KEY)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if stored.is_empty() {
        let mut current = crate::hermes_config::get_model_config()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        if current.provider.as_deref() == Some(MANAGED_PROVIDER_ID) {
            current.provider = None;
            current.default = None;
            crate::hermes_config::set_model_config(&current).map_err(|e| e.to_string())?;
        }
    } else if stored == NO_PREVIOUS_VALUE {
        crate::hermes_config::set_model_config(&Default::default()).map_err(|e| e.to_string())?;
    } else {
        let previous = serde_json::from_str(&stored).map_err(|e| e.to_string())?;
        crate::hermes_config::set_model_config(&previous).map_err(|e| e.to_string())?;
    }
    state
        .db
        .set_setting(PREVIOUS_HERMES_MODEL_KEY, "")
        .map_err(|e| e.to_string())
}

fn remove_managed_tool(state: &AppState, app: AppType) -> Result<Option<bool>, String> {
    let providers = ProviderService::list(state, app.clone()).map_err(|e| e.to_string())?;
    if !providers.contains_key(MANAGED_PROVIDER_ID) {
        return Ok(None);
    }

    if app.is_additive_mode() {
        ProviderService::delete(state, app.clone(), MANAGED_PROVIDER_ID)
            .map_err(|e| e.to_string())?;
        if matches!(app, AppType::Hermes) {
            restore_hermes_model(state)?;
        }
        return Ok(Some(false));
    }

    let current = ProviderService::current(state, app.clone()).map_err(|e| e.to_string())?;
    if current != MANAGED_PROVIDER_ID {
        ProviderService::delete(state, app.clone(), MANAGED_PROVIDER_ID)
            .map_err(|e| e.to_string())?;
        state
            .db
            .set_setting(&previous_provider_key(&app), "")
            .map_err(|e| e.to_string())?;
        return Ok(Some(false));
    }

    let previous = state
        .db
        .get_setting(&previous_provider_key(&app))
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if previous.is_empty() || previous == NO_PREVIOUS_VALUE || !providers.contains_key(&previous) {
        return Err("没有可安全恢复的原配置，元衡配置已保留".to_string());
    }

    ProviderService::switch(state, app.clone(), &previous).map_err(|e| e.to_string())?;
    ProviderService::delete(state, app.clone(), MANAGED_PROVIDER_ID).map_err(|e| e.to_string())?;
    state
        .db
        .set_setting(&previous_provider_key(&app), "")
        .map_err(|e| e.to_string())?;
    Ok(Some(true))
}

fn remove_codex_surface_artifacts(state: &AppState) -> Result<bool, String> {
    let desktop_provider = managed_codex_provider_for_namespace(state, CHATGPT_DESKTOP_NAMESPACE)?;
    let profile_path = codex_terminal_profile_path();
    let profile_should_remove = match std::fs::read_to_string(&profile_path) {
        Ok(content)
            if (content.contains("model_provider = \"custom\"")
                || content.contains("model_provider = \"yuanheng\""))
                && content.contains("/codex/v1") =>
        {
            true
        }
        Ok(_) => {
            return Err("Codex 终端独立配置已被外部修改，元衡未删除该文件".to_string());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("读取 Codex 终端独立配置失败: {error}")),
    };

    if desktop_provider.is_some() {
        state
            .db
            .delete_provider(CHATGPT_DESKTOP_NAMESPACE, MANAGED_PROVIDER_ID)
            .map_err(|error| error.to_string())?;
    }
    if profile_should_remove {
        std::fs::remove_file(&profile_path)
            .map_err(|error| format!("移除 Codex 终端独立配置失败: {error}"))?;
    }
    crate::codex_config::remove_yuanheng_model_catalogs()
        .map_err(|error| format!("移除 Codex 模型目录失败: {error}"))?;

    Ok(desktop_provider.is_some() || profile_should_remove)
}

fn restore_managed_tools_inner(state: &AppState) -> Result<YuanhengDisconnectResult, String> {
    let mut result = YuanhengDisconnectResult {
        disconnected: false,
        ..Default::default()
    };
    let mut codex_restored = false;
    for app in AppType::all() {
        match remove_managed_tool(state, app.clone()) {
            Ok(Some(true)) => {
                codex_restored |= matches!(app, AppType::Codex);
                result.restored_tools.push(app.as_str().to_string());
            }
            Ok(Some(false)) => {
                codex_restored |= matches!(app, AppType::Codex);
                result.removed_tools.push(app.as_str().to_string());
            }
            Ok(None) => {}
            Err(error) => {
                result.retained_tools.push(app.as_str().to_string());
                result.warnings.push(format!("{}: {error}", app.as_str()));
            }
        }
    }
    if codex_restored {
        match remove_codex_surface_artifacts(state) {
            Ok(true) => result
                .removed_tools
                .push(CHATGPT_DESKTOP_NAMESPACE.to_string()),
            Ok(false) => {}
            Err(error) => {
                result
                    .retained_tools
                    .push(CHATGPT_DESKTOP_NAMESPACE.to_string());
                result
                    .warnings
                    .push(format!("{CHATGPT_DESKTOP_NAMESPACE}: {error}"));
            }
        }
    }
    match dsh::restore(state) {
        Ok(true) => result.restored_tools.push("dsh".into()),
        Ok(false) => {}
        Err(error) => {
            result.retained_tools.push("dsh".into());
            result.warnings.push(format!("dsh: {error}"));
        }
    }
    match restore_workbuddy_config(state) {
        Ok(Some(true)) => result.restored_tools.push("workbuddy".to_string()),
        Ok(Some(false)) => result.removed_tools.push("workbuddy".to_string()),
        Ok(None) => {}
        Err(error) => {
            result.retained_tools.push("workbuddy".to_string());
            result.warnings.push(format!("workbuddy: {error}"));
        }
    }
    Ok(result)
}

fn disconnect_yuanheng_inner(state: &AppState) -> Result<YuanhengDisconnectResult, String> {
    let mut result = restore_managed_tools_inner(state)?;
    result.disconnected = true;
    #[cfg(any(target_os = "macos", test))]
    if credential_session::has_session(state)? {
        credential_session::clear(state)?;
        return Ok(result);
    }
    for key in YUANHENG_SECURE_KEYS {
        delete_yuanheng_secret(state, key)?;
    }
    for key in [API_TOKEN_ID_KEY, API_TOKEN_GROUP_KEY, CACHE_KEY] {
        state
            .db
            .delete_setting(key)
            .map_err(|error| error.to_string())?;
    }
    Ok(result)
}

fn resolve_tool_model(
    app: AppType,
    models: &[String],
    requested_model: Option<&str>,
) -> Result<String, String> {
    if let Some(model) = requested_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !models.iter().any(|item| item == model) {
            return Err(format!("模型 {model} 不在当前账号目录中"));
        }
        if is_image_generation_only_model(model) {
            return Err(format!(
                "模型 {model} 仅支持图像生成/编辑 API，不能作为终端主模型"
            ));
        }
        Ok(model.to_string())
    } else {
        recommended_model(&app, models).ok_or_else(|| "当前账号没有兼容模型".to_string())
    }
}

fn preferred_group_for_model(
    connection: &YuanhengConnectionStatus,
    model: &str,
    requested_group: Option<&str>,
) -> Result<String, String> {
    let available = connection
        .model_groups
        .get(model)
        .cloned()
        .unwrap_or_default();
    if available.is_empty() {
        if let Some(group) = requested_group
            .map(str::trim)
            .filter(|group| !group.is_empty())
        {
            return Ok(group.to_string());
        }
        return connection
            .account
            .as_ref()
            .map(|account| account.group.clone())
            .filter(|group| !group.is_empty())
            .ok_or_else(|| format!("模型 {model} 当前没有可用令牌分组"));
    }
    if let Some(group) = requested_group
        .map(str::trim)
        .filter(|group| !group.is_empty())
    {
        if available.iter().any(|item| item == group) {
            return Ok(group.to_string());
        }
        return Err(format!("模型 {model} 不支持分组 {group}"));
    }
    if available.iter().any(|group| group == "auto") {
        return Ok("auto".to_string());
    }
    if let Some(account_group) = connection.account.as_ref().map(|account| &account.group) {
        if available.iter().any(|group| group == account_group) {
            return Ok(account_group.clone());
        }
    }
    connection
        .groups
        .iter()
        .filter(|group| available.iter().any(|item| item == &group.id))
        .min_by(|left, right| {
            left.ratio
                .unwrap_or(f64::INFINITY)
                .partial_cmp(&right.ratio.unwrap_or(f64::INFINITY))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.id.cmp(&right.id))
        })
        .map(|group| group.id.clone())
        .ok_or_else(|| format!("模型 {model} 当前没有可用令牌分组"))
}

fn resolve_reasoning_level(
    requested: Option<&str>,
    model: &str,
    supported: &HashMap<String, Vec<String>>,
) -> Result<String, String> {
    let level = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto");
    if level == "auto" {
        return Ok(level.to_string());
    }
    if !REASONING_LEVELS.contains(&level) {
        return Err(format!("不支持的推理等级: {level}"));
    }
    let fallback;
    let levels = if let Some(levels) = supported.get(model) {
        levels
    } else {
        fallback = fallback_reasoning_levels(model);
        &fallback
    };
    if levels.iter().any(|item| item == level) {
        Ok(level.to_string())
    } else if levels.is_empty() {
        Err(format!("模型 {model} 未声明可调推理等级，请使用自动"))
    } else {
        Err(format!(
            "模型 {model} 不支持 {level}，可选：{}",
            levels.join("、")
        ))
    }
}

fn preflight_target_protocol(app_name: &str) -> &'static str {
    match app_name {
        "claude" | "claude-desktop" => "anthropic_messages",
        "codex" | CHATGPT_DESKTOP_NAMESPACE | "grokbuild" => "openai_responses",
        "gemini" => "gemini_native",
        "opencode" | "openclaw" | "hermes" | "workbuddy" | "dsh" => "openai_chat",
        _ => "unknown",
    }
}

fn preflight_image_input(model: &str) -> &'static str {
    if crate::model_capabilities::is_confirmed_text_only_model(model) {
        "unsupported"
    } else {
        "unknown"
    }
}

fn push_preflight_check(
    checks: &mut Vec<YuanhengPreflightCheck>,
    id: &str,
    status: &str,
    title: &str,
    message: impl Into<String>,
) {
    checks.push(YuanhengPreflightCheck {
        id: id.to_string(),
        status: status.to_string(),
        title: title.to_string(),
        message: message.into(),
    });
}

async fn preflight_yuanheng_tool_inner(
    state: &AppState,
    app_name: &str,
    model: &str,
    requested_group: Option<&str>,
    requested_reasoning: Option<&str>,
) -> Result<YuanhengToolPreflight, String> {
    preflight_yuanheng_tool_at(
        state,
        app_name,
        model,
        requested_group,
        requested_reasoning,
        &yuanheng_client()?,
        BASE_URL,
    )
    .await
}

async fn preflight_yuanheng_tool_at(
    state: &AppState,
    app_name: &str,
    model: &str,
    requested_group: Option<&str>,
    requested_reasoning: Option<&str>,
    client: &reqwest::Client,
    origin: &str,
) -> Result<YuanhengToolPreflight, String> {
    let app_name = app_name.trim();
    let is_workbuddy = app_name == "workbuddy";
    let app = match app_name {
        CHATGPT_DESKTOP_NAMESPACE => AppType::Codex,
        "workbuddy" | "dsh" => AppType::OpenCode,
        _ => app_name.parse::<AppType>().map_err(|e| e.to_string())?,
    };
    let connection = read_cached_status(state)?;
    if !connection.connected {
        return Err("请先连接元衡账号".to_string());
    }
    let model = model.trim();
    if model.is_empty() {
        return Err("请选择模型".to_string());
    }

    let mut checks = Vec::new();
    let mut has_error = false;
    let mut has_warning = false;

    if is_image_generation_only_model(model) {
        has_error = true;
        push_preflight_check(
            &mut checks,
            "model",
            "error",
            "模型类型不兼容",
            "该模型只支持图像生成或编辑，不能作为 Agent 对话模型",
        );
    } else if connection.terminal_models.iter().any(|item| item == model) {
        push_preflight_check(
            &mut checks,
            "model",
            "ok",
            "模型目录有效",
            format!("已在当前账号目录中找到 {model}"),
        );
    } else {
        has_error = true;
        push_preflight_check(
            &mut checks,
            "model",
            "error",
            "模型已经失效",
            "当前账号目录中不存在该模型，请刷新模型列表",
        );
    }

    let group = preferred_group_for_model(&connection, model, requested_group)?;
    let session_cookie = get_yuanheng_secret(state, SESSION_COOKIE_KEY)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "元衡登录状态缺失，请重新登录".to_string())?;
    let user_id = get_yuanheng_secret(state, USER_ID_KEY)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "元衡用户 ID 缺失".to_string())?;
    match fetch_user_models_at(client, origin, &session_cookie, &user_id, Some(&group)).await {
        Ok(models) if models.iter().any(|item| item == model) => push_preflight_check(
            &mut checks,
            "account",
            "ok",
            "账号与分组有效",
            format!("登录有效，{group} 分组实时支持该模型"),
        ),
        Ok(_) => {
            has_error = true;
            push_preflight_check(
                &mut checks,
                "account",
                "error",
                "分组模型已变化",
                format!("{model} 已不在 {group} 分组的实时目录中"),
            );
        }
        Err(error) => {
            has_error = true;
            push_preflight_check(&mut checks, "account", "error", "账号或平台连接失败", error);
        }
    }

    let source_protocol = yuanheng_model_api_format(model).to_string();
    let target_protocol = if app_name == "dsh" {
        source_protocol.clone()
    } else {
        preflight_target_protocol(app_name).to_string()
    };
    if target_protocol == "unknown" {
        has_error = true;
        push_preflight_check(
            &mut checks,
            "protocol",
            "error",
            "工具协议未知",
            "当前工具没有受支持的协议适配器",
        );
    } else {
        let adapted = source_protocol != target_protocol;
        push_preflight_check(
            &mut checks,
            "protocol",
            "ok",
            "协议兼容",
            if adapted {
                format!("将由兼容层把 {target_protocol} 转换为 {source_protocol}")
            } else {
                format!("模型与工具均使用 {target_protocol}")
            },
        );
    }

    let reasoning =
        resolve_reasoning_level(requested_reasoning, model, &connection.reasoning_levels);
    match reasoning {
        Ok(_) => push_preflight_check(
            &mut checks,
            "reasoning",
            "ok",
            "推理等级兼容",
            "当前推理设置可用于该模型",
        ),
        Err(error) => {
            has_error = true;
            push_preflight_check(&mut checks, "reasoning", "error", "推理等级不兼容", error);
        }
    }

    let stored_token = stored_tool_credential(state, app_name, &group, Some(model))?;
    let legacy_endpoint = tool_uses_legacy_endpoint(state, app_name, model);
    let mut requires_configuration = stored_token.is_none() || legacy_endpoint;
    if legacy_endpoint {
        has_warning = true;
        push_preflight_check(
            &mut checks,
            "endpoint",
            "warning",
            "元衡线路需要更新",
            "仍在使用旧 CN 线路，重新应用配置后将使用 meta-api.vip；模型与分组保持当前选择",
        );
    }
    {
        match stored_token {
            Some(token) => match fetch_api_models_at(client, origin, &token).await {
                Ok(models) if models.iter().any(|item| item == model) => push_preflight_check(
                    &mut checks,
                    "credential",
                    "ok",
                    "API 凭据有效",
                    "模型接口已通过轻量鉴权检查，未发送生成请求",
                ),
                Ok(_) => {
                    has_error = true;
                    push_preflight_check(
                        &mut checks,
                        "credential",
                        "error",
                        "API 模型不可用",
                        "API 凭据有效，但接口没有返回所选模型",
                    );
                }
                Err(error) if is_token_rejected(&error) => {
                    requires_configuration = true;
                    has_warning = true;
                    push_preflight_check(
                        &mut checks,
                        "credential",
                        "warning",
                        "工具分组凭据需要同步",
                        "当前工具凭据被拒绝；配置时会重新获取该分组凭据并验证，原配置在验证通过前保持不变",
                    );
                }
                Err(error) => {
                    has_error = true;
                    push_preflight_check(
                        &mut checks,
                        "credential",
                        "error",
                        "工具接口验证未完成",
                        error,
                    );
                }
            },
            None => {
                has_warning = true;
                push_preflight_check(
                    &mut checks,
                    "credential",
                    "warning",
                    "分组凭据将在配置时核验",
                    "尚无该工具、该分组的可用凭据；配置时将获取并验证对应凭据",
                );
            }
        }
    }

    let route_required = matches!(app, AppType::ClaudeDesktop | AppType::Codex) && !is_workbuddy;
    if route_required {
        if state.proxy_service.is_running().await {
            push_preflight_check(
                &mut checks,
                "route",
                "ok",
                "本地路由已就绪",
                "协议转换与请求记录服务正在运行",
            );
        } else {
            has_warning = true;
            push_preflight_check(
                &mut checks,
                "route",
                "warning",
                "本地路由将在配置时启动",
                "当前尚未运行，配置过程中会自动启动",
            );
        }
    } else {
        push_preflight_check(
            &mut checks,
            "route",
            "ok",
            "无需本地协议路由",
            "该工具会使用已验证的元衡接口配置",
        );
    }

    let status = if has_error {
        "error"
    } else if has_warning {
        "warning"
    } else {
        "ok"
    };
    Ok(YuanhengToolPreflight {
        app: app_name.to_string(),
        model: model.to_string(),
        group,
        status: status.to_string(),
        source_protocol,
        target_protocol,
        streaming_supported: true,
        tool_call: "unknown".to_string(),
        reasoning_supported: connection
            .reasoning_levels
            .get(model)
            .is_some_and(|levels| !levels.is_empty()),
        image_input: preflight_image_input(model).to_string(),
        checks,
        message: match status {
            "ok" => "兼容性预检通过，可以安全配置".to_string(),
            "warning" => "兼容性预检通过，配置时还需完成一项自动准备".to_string(),
            _ => "兼容性预检未通过，已阻止写入配置".to_string(),
        },
        requires_configuration,
    })
}

fn configure_tool_with_models(
    state: &AppState,
    app: AppType,
    token: &str,
    model: &str,
    available_models: &[String],
    group: &str,
    reasoning: &str,
) -> Result<YuanhengToolConfigureResult, String> {
    remember_tool_state(state, &app)?;
    let provider =
        managed_provider_with_models(&app, token, model, available_models, group, reasoning)?;
    let exists = ProviderService::list(state, app.clone())
        .map_err(|e| e.to_string())?
        .contains_key(MANAGED_PROVIDER_ID);
    if exists {
        ProviderService::update(state, app.clone(), None, provider).map_err(|e| e.to_string())?;
    } else {
        ProviderService::add(state, app.clone(), provider, true).map_err(|e| e.to_string())?;
    }
    let switch_result = ProviderService::switch(state, app.clone(), MANAGED_PROVIDER_ID)
        .map_err(|e| e.to_string())?;
    Ok(YuanhengToolConfigureResult {
        app: app.as_str().to_string(),
        configured: true,
        model: Some(model.to_string()),
        warnings: switch_result.warnings,
        error: None,
    })
}

#[cfg(test)]
fn configure_tool(
    state: &AppState,
    app: AppType,
    token: &str,
    models: &[String],
    requested_model: Option<&str>,
    group: &str,
    reasoning: &str,
) -> Result<YuanhengToolConfigureResult, String> {
    let model = resolve_tool_model(app.clone(), models, requested_model)?;
    configure_tool_with_models(state, app, token, &model, models, group, reasoning)
}

#[tauri::command]
pub async fn get_yuanheng_connection(
    state: State<'_, AppState>,
) -> Result<YuanhengConnectionStatus, String> {
    read_cached_status(&state)
}

/// Explicit user action; never called by startup, refresh or diagnostics.
#[tauri::command]
pub async fn restore_yuanheng_keychain_access(
    state: State<'_, AppState>,
) -> Result<YuanhengConnectionStatus, String> {
    // Keep any system dialog off the main/UI thread. Only our fixed service and
    // keys are accessible, never caller-supplied keychain selectors.
    #[cfg(any(target_os = "macos", test))]
    let keys = credential_session::recovery_keys(&state)?;
    #[cfg(not(any(target_os = "macos", test)))]
    let keys: Vec<String> = YUANHENG_SECURE_KEYS
        .iter()
        .map(|key| (*key).into())
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
        crate::secure_storage::authorize_access(&keys)
    })
    .await
    .map_err(|_| "恢复本机登录任务失败".to_string())??;
    read_cached_status(&state)
}

#[tauri::command]
pub async fn get_yuanheng_announcement() -> Result<Option<String>, String> {
    fetch_legacy_announcement(&yuanheng_client()?).await
}

#[tauri::command]
pub async fn get_yuanheng_announcements() -> Result<YuanhengAnnouncementFeed, String> {
    fetch_announcements(&yuanheng_client()?).await
}

#[tauri::command]
pub fn get_yuanheng_tool_statuses(
    state: State<'_, AppState>,
) -> Result<Vec<YuanhengToolStatus>, String> {
    let connection = read_cached_status(&state)?;
    Ok(all_tool_statuses(&state, &connection))
}

#[tauri::command]
pub async fn get_yuanheng_tool_activation_statuses(
    state: State<'_, AppState>,
) -> Result<Vec<YuanhengToolActivationStatus>, String> {
    yuanheng_tool_activation_statuses_inner(&state).await
}

#[tauri::command]
pub async fn preflight_yuanheng_tool(
    state: State<'_, AppState>,
    app: String,
    model: String,
    group: Option<String>,
    reasoning: Option<String>,
) -> Result<YuanhengToolPreflight, String> {
    preflight_yuanheng_tool_inner(&state, &app, &model, group.as_deref(), reasoning.as_deref())
        .await
}

#[tauri::command]
pub fn get_codex_account_mode(
    state: State<'_, AppState>,
) -> Result<CodexAccountModeStatus, String> {
    codex_account_mode_status_inner(&state)
}

#[allow(non_snake_case)]
#[tauri::command]
pub async fn switch_codex_account_mode(
    state: State<'_, AppState>,
    mode: String,
    expectedMode: Option<String>,
) -> Result<CodexAccountModeStatus, String> {
    let _guard = codex_account_mode_switch_lock().lock().await;
    let mode = mode.trim();
    if !matches!(mode, "yuanheng" | "official") {
        return Err("不支持的 Codex 使用方式".to_string());
    }
    let current = codex_account_mode_status_inner(&state)?;
    if expectedMode
        .as_deref()
        .is_some_and(|expected| expected != current.mode.as_str())
    {
        return Err("Codex 配置刚刚被其他程序修改，请重新检测后再切换".to_string());
    }

    // 先完成所有只读前置校验，再启动 Core。这样登录缺失、配置冲突或
    // 非法参数不会留下一个本次操作并不需要的后台服务。
    read_owned_codex_terminal_profile()?;
    if mode == "official" {
        if !codex_official_login_available()? {
            return Err(CODEX_OFFICIAL_LOGIN_REQUIRED.to_string());
        }
        let snapshot = capture_codex_mode_switch_snapshot(&state)?;
        build_codex_official_mode_config(
            snapshot.live_config.as_deref().unwrap_or_default(),
            "http://127.0.0.1:1",
        )?;
    } else if !yuanheng_codex_mode_available(&state) {
        return Err("元衡 Codex 配置尚未准备好，请先连接账号并完成一次配置".to_string());
    }
    if !state.proxy_service.is_running().await {
        state
            .proxy_service
            .start()
            .await
            .map_err(|error| format!("启动本地安全路由失败: {error}"))?;
    }
    let proxy_status = state.proxy_service.get_status().await?;
    if !proxy_status.running || proxy_status.port == 0 {
        return Err("本地安全路由尚未就绪".to_string());
    }
    let proxy_origin = format!("http://127.0.0.1:{}", proxy_status.port);
    switch_codex_account_mode_at_origin(&state, mode, expectedMode.as_deref(), &proxy_origin)
}

async fn diagnose_yuanheng_inner(state: &AppState) -> Result<YuanhengDiagnosticReport, String> {
    let connection = read_cached_status(state)?;
    let mut checks = Vec::new();

    if !connection.connected {
        checks.push(YuanhengDiagnosticCheck {
            id: "connection".to_string(),
            status: "error".to_string(),
            title: "尚未连接元衡".to_string(),
            message: "登录后会自动创建本机凭据并检查工具配置。".to_string(),
            action: Some("login".to_string()),
        });
        return Ok(YuanhengDiagnosticReport {
            status: "error".to_string(),
            checked_at: chrono::Utc::now().timestamp(),
            ready_tools: 0,
            attention_tools: Vec::new(),
            checks,
            support_json: None,
            snapshot_id: None,
        });
    }

    let session_cookie = get_yuanheng_secret(state, SESSION_COOKIE_KEY)?.unwrap_or_default();
    let user_id = get_yuanheng_secret(state, USER_ID_KEY)?.unwrap_or_default();
    let api_token = get_yuanheng_secret(state, API_TOKEN_KEY)?.unwrap_or_default();
    let client = yuanheng_client()?;

    if session_cookie.is_empty() || user_id.is_empty() {
        checks.push(YuanhengDiagnosticCheck {
            id: "session".to_string(),
            status: "error".to_string(),
            title: "登录状态不完整".to_string(),
            message: "请重新登录元衡账号。".to_string(),
            action: Some("login".to_string()),
        });
    } else {
        let account_url = format!("{BASE_URL}/api/user/self");
        match fetch_json(&client, &account_url, Some(&session_cookie), Some(&user_id)).await {
            Ok(value) if parse_account(&value).is_ok() => checks.push(YuanhengDiagnosticCheck {
                id: "session".to_string(),
                status: "ok".to_string(),
                title: "账号连接正常".to_string(),
                message: "登录状态有效。".to_string(),
                action: None,
            }),
            Err(error) if !is_yuanheng_session_auth_error(&error) => {
                checks.push(YuanhengDiagnosticCheck {
                    id: "session".to_string(),
                    status: "warning".to_string(),
                    title: "暂时无法验证登录".to_string(),
                    message: "网络或平台响应异常，未清除登录状态，请稍后重新检查。".to_string(),
                    action: None,
                })
            }
            _ => checks.push(YuanhengDiagnosticCheck {
                id: "session".to_string(),
                status: "error".to_string(),
                title: "登录状态已失效".to_string(),
                message: "请退出后重新登录元衡账号。".to_string(),
                action: Some("login".to_string()),
            }),
        }
    }

    if api_token.is_empty() {
        checks.push(YuanhengDiagnosticCheck {
            id: "credential".to_string(),
            status: "error".to_string(),
            title: "本机凭据缺失".to_string(),
            message: "可以自动重新创建本机工具凭据。".to_string(),
            action: Some("repair_credentials".to_string()),
        });
    } else {
        match verify_api_token(&client, &api_token).await {
            Ok(()) => checks.push(YuanhengDiagnosticCheck {
                id: "credential".to_string(),
                status: "ok".to_string(),
                title: "API 连接正常".to_string(),
                message: "本机凭据可访问模型接口。".to_string(),
                action: None,
            }),
            Err(error) if !is_token_rejected(&error) => checks.push(YuanhengDiagnosticCheck {
                id: "credential".to_string(),
                status: "warning".to_string(),
                title: "凭据检查暂未完成".to_string(),
                message: "网络或模型目录响应异常，不能据此认定令牌失效。".to_string(),
                action: None,
            }),
            Err(_) => checks.push(YuanhengDiagnosticCheck {
                id: "credential".to_string(),
                status: "error".to_string(),
                title: "本机凭据已失效".to_string(),
                message: "可以自动重新同步本机工具凭据。".to_string(),
                action: Some("repair_credentials".to_string()),
            }),
        }
    }

    let tool_statuses = all_tool_statuses(state, &connection);
    // 体检验证每个托管工具的真实分组 key。按 key 复用响应，防止同一分组重复请求。
    let mut credential_results: HashMap<String, Result<Vec<String>, String>> = HashMap::new();
    let mut credential_attention = BTreeSet::new();
    for tool in tool_statuses.iter().filter(|tool| tool.configured) {
        let Some(group) = tool.group.as_deref() else {
            continue;
        };
        let token = stored_tool_credential(state, &tool.app, group, tool.model.as_deref())?;
        let result = if let Some(token) = token {
            if let Some(result) = credential_results.get(&token) {
                result.clone()
            } else {
                let result = fetch_api_models(&client, &token).await;
                credential_results.insert(token, result.clone());
                result
            }
        } else {
            Err("工具凭据缺失（HTTP 401）".to_string())
        };
        let (status, message, action) = match result {
            Ok(models)
                if tool
                    .model
                    .as_ref()
                    .is_none_or(|model| models.contains(model)) =>
            {
                ("ok", "该工具的分组凭据已通过模型目录验证。", None)
            }
            Ok(_) => (
                "error",
                "该工具凭据无法访问所选模型，请重新配置该工具。",
                Some("repair_tools"),
            ),
            Err(error) if is_token_rejected(&error) => (
                "error",
                "该工具实际使用的分组令牌被拒绝；账号登录正常并不代表工具令牌有效。",
                Some("repair_tools"),
            ),
            Err(_) => ("warning", "网络检查未完成，未将其判定为令牌失效。", None),
        };
        if status != "ok" {
            credential_attention.insert(tool.app.clone());
        }
        checks.push(YuanhengDiagnosticCheck {
            id: format!("tool_credential:{}", tool.app),
            status: status.to_string(),
            title: format!("{} · {} 分组凭据", tool.app, group),
            message: message.to_string(),
            action: action.map(str::to_string),
        });
    }
    let invalid_model_tools: Vec<String> = tool_statuses
        .iter()
        .filter(|item| item.configured)
        .filter_map(|item| {
            let model = item.model.as_deref()?;
            let model_missing = !connection.models.iter().any(|candidate| candidate == model);
            let group_missing = item.group.as_deref().is_some_and(|group| {
                !connection
                    .model_groups
                    .get(model)
                    .is_some_and(|groups| groups.iter().any(|candidate| candidate == group))
            });
            (model_missing || group_missing).then(|| item.app.clone())
        })
        .collect();
    if invalid_model_tools.is_empty() {
        checks.push(YuanhengDiagnosticCheck {
            id: "model_catalog".to_string(),
            status: "ok".to_string(),
            title: "模型与分组匹配".to_string(),
            message: "已配置工具使用的模型仍在当前账号目录中。".to_string(),
            action: None,
        });
    } else {
        checks.push(YuanhengDiagnosticCheck {
            id: "model_catalog".to_string(),
            status: "error".to_string(),
            title: "模型或分组已经失效".to_string(),
            message: format!(
                "{} 个工具使用了当前账号目录中不存在的模型或分组。",
                invalid_model_tools.len()
            ),
            action: Some("repair_tools".to_string()),
        });
    }

    let local_route_required = tool_statuses.iter().any(|item| {
        item.configured
            && matches!(
                item.app.as_str(),
                "claude-desktop" | "codex" | CHATGPT_DESKTOP_NAMESPACE
            )
    });
    if local_route_required {
        if state.proxy_service.is_running().await {
            checks.push(YuanhengDiagnosticCheck {
                id: "local_route".to_string(),
                status: "ok".to_string(),
                title: "本地 Core 正在运行".to_string(),
                message: "仅确认 Core 运行状态；不代表桌面工具连接、工作区启动或模型请求成功。"
                    .to_string(),
                action: None,
            });
        } else {
            checks.push(YuanhengDiagnosticCheck {
                id: "local_route".to_string(),
                status: "error".to_string(),
                title: "本地模型路由未运行".to_string(),
                message: "Codex 或 Claude Desktop 的配置存在，但本地协议路由未启动。".to_string(),
                action: Some("repair_tools".to_string()),
            });
        }
    }
    let ready_tools = tool_statuses
        .iter()
        .filter(|item| item.configured && !credential_attention.contains(&item.app))
        .count();
    let attention_tools: Vec<String> = tool_statuses
        .iter()
        .filter(|item| item.needs_update || credential_attention.contains(&item.app))
        .map(|item| item.app.clone())
        .collect();
    if !attention_tools.is_empty() {
        checks.push(YuanhengDiagnosticCheck {
            id: "tools".to_string(),
            status: "warning".to_string(),
            title: "部分工具配置需要恢复".to_string(),
            message: format!("检测到 {} 个工具配置发生变化。", attention_tools.len()),
            action: Some("repair_tools".to_string()),
        });
    } else if ready_tools > 0 {
        checks.push(YuanhengDiagnosticCheck {
            id: "tools".to_string(),
            status: "ok".to_string(),
            title: "工具配置正常".to_string(),
            message: format!(
                "{ready_tools} 个工具通过配置检查；实际请求与桌面运行环境需单独验证。"
            ),
            action: None,
        });
    } else {
        checks.push(YuanhengDiagnosticCheck {
            id: "tools".to_string(),
            status: "warning".to_string(),
            title: "尚未配置 AI 工具".to_string(),
            message: "选择本机已安装的工具后即可一键配置。".to_string(),
            action: Some("configure_tools".to_string()),
        });
    }

    let status = if checks.iter().any(|item| item.status == "error") {
        "error"
    } else if checks.iter().any(|item| item.status == "warning") {
        "warning"
    } else {
        "ok"
    };
    Ok(YuanhengDiagnosticReport {
        status: status.to_string(),
        checked_at: chrono::Utc::now().timestamp(),
        ready_tools,
        attention_tools,
        checks,
        support_json: None,
        snapshot_id: None,
    })
}

#[tauri::command]
pub async fn get_yuanheng_diagnostics(
    state: State<'_, AppState>,
) -> Result<YuanhengDiagnosticReport, String> {
    use super::support_diagnostics as support;
    let requested_at = std::time::Instant::now();
    let owner = diagnostic_owner(&state)?;
    let _run = state.diagnostic_run.lock().await;
    {
        let snapshot = state
            .diagnostic_snapshot
            .lock()
            .map_err(|_| "诊断快照不可用")?;
        if let Some(snapshot) = snapshot.as_ref() {
            if snapshot.owner == owner && snapshot.captured >= requested_at {
                return Ok(snapshot.report.clone());
            }
        }
    }
    let connection = read_cached_status(&state)?;
    if connection.connected && connection.user_id != get_yuanheng_secret(&state, USER_ID_KEY)? {
        return Err("缓存账号与登录状态不一致，请刷新账号后检查".into());
    }
    let mut report = match tokio::time::timeout(
        std::time::Duration::from_secs(25),
        diagnose_yuanheng_inner(&state),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => YuanhengDiagnosticReport {
            status: "warning".into(),
            checked_at: chrono::Utc::now().timestamp(),
            ready_tools: 0,
            attention_tools: vec![],
            checks: vec![YuanhengDiagnosticCheck {
                id: "timeout".into(),
                status: "warning".into(),
                title: "网络体检超时".into(),
                message: "已停止等待网络检查，仍可导出本机状态；未将账号判定为失效。".into(),
                action: None,
            }],
            support_json: None,
            snapshot_id: None,
        },
    };
    let history_repaired = if let Ok(proxy) = state.proxy_service.get_status().await {
        if proxy.running {
            refresh_codex_history_routes_at_port(proxy.port)
        } else {
            Ok(false)
        }
    } else {
        Ok(false)
    };
    let history_check = (|| -> Result<YuanhengDiagnosticCheck, String> {
        let repaired = history_repaired?;
        let config = crate::codex_config::read_codex_config_text().map_err(|e| e.to_string())?;
        let health = crate::codex_history_routes::health(&config).map_err(|e| e.to_string())?;
        Ok(YuanhengDiagnosticCheck {
            id: "codex_history".into(),
            status: if health.needs_repair || !health.conflicts.is_empty() {
                "warning"
            } else {
                "ok"
            }
            .into(),
            title: "Codex 历史会话兼容性".into(),
            message: if !health.conflicts.is_empty() {
                format!(
                    "{} 使用了自定义供应商配置，已保留；请检查旧对话所需的供应商。",
                    health.conflicts.join("、")
                )
            } else if repaired {
                "历史会话配置已修复，请重新打开对话；旧模型不可用时，请在 Codex 中重新选择模型。"
                    .into()
            } else if health.needs_repair {
                "历史会话配置需要修复，请在工作台重新选择当前使用方式。".into()
            } else {
                "未发现元衡历史供应商配置缺失。旧模型是否可用，以当前账号为准。".into()
            },
            action: None,
        })
    })();
    match history_check {
        Ok(check) => {
            if check.status == "warning" && report.status == "ok" {
                report.status = "warning".into();
            }
            report.checks.push(check);
        }
        Err(_) => {
            if report.status == "ok" {
                report.status = "warning".into();
            }
            report.checks.push(YuanhengDiagnosticCheck {
                id: "codex_history".into(),
                status: "warning".into(),
                title: "Codex 历史会话兼容性".into(),
                message: "配置检查未完成，原配置已保留；请检查 Codex 配置后重新检测。".into(),
                action: None,
            });
        }
    }
    let now = chrono::Utc::now().timestamp();
    // Do not export historical traffic from before the current account's sync.
    let since = connection
        .last_synced_at
        .unwrap_or(now)
        .max(now - 3600)
        .min(now);
    let mut warnings = Vec::new();
    let mut requests = if connection.connected {
        match support::recent_requests(&state.db, since, now) {
            Ok(requests) => requests,
            Err(_) => {
                warnings.push("request_metadata_unavailable");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let private_labels = connection
        .account
        .as_ref()
        .map(|account| vec![account.username.as_str(), account.display_name.as_str()])
        .unwrap_or_default();
    for request in &mut requests {
        request.model = support::hide_account_label(&request.model, &private_labels);
    }
    let proxy = match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        state.proxy_service.get_status(),
    )
    .await
    {
        Ok(Ok(status)) => json!({
            "running": status.running, "port": status.port,
            "listener": if status.address == "127.0.0.1" || status.address == "::1" { "loopback" } else { "other-address-hidden" },
            "activeConnections": status.active_connections,
            "uptimeSeconds": status.uptime_seconds,
        }),
        _ => {
            warnings.push("proxy_status_unavailable");
            serde_json::Value::Null
        }
    };
    let mut group_labels: HashMap<String, String> = HashMap::new();
    let tool_statuses = all_tool_statuses(&state, &connection);
    let core_support = match tokio::time::timeout(
        std::time::Duration::from_secs(4),
        state.proxy_service.core_support_info(),
    )
    .await
    {
        Ok(Ok(info)) => {
            let events = info
                .request_diagnostics
                .as_ref()
                .map(|snapshot| {
                    crate::core_diagnostics::support_events(&snapshot.events, since, now)
                })
                .unwrap_or_default();
            let available = info
                .request_diagnostics
                .as_ref()
                .is_some_and(|s| s.schema_version == 1);
            let persistence_ok = info
                .request_diagnostics
                .as_ref()
                .is_some_and(|s| s.persistence_ok);
            report.checks.push(YuanhengDiagnosticCheck {
                id: "core_version".into(),
                status: "ok".into(),
                title: "实际运行的 Core".into(),
                message: format!(
                    "Core {}；版本来自正在运行的进程，不是客户端安装版本。",
                    support::safe_version(&info.version).unwrap_or_else(|| "未知".into())
                ),
                action: None,
            });
            if !available || !persistence_ok {
                report.checks.push(YuanhengDiagnosticCheck {
                    id: "core_diagnostics".into(), status: "warning".into(),
                    title: "Core 故障记录能力".into(),
                    message: if !available {
                        "当前 Core 尚不支持阶段诊断；客户端版本不代表后台 Core 已更新。请在空闲时通过客户端更新，勿强制结束活跃请求。"
                    } else {
                        "Core 日志存在队列丢弃、写入失败或写入线程不可用；内存记录仍可导出，请查看计数，磁盘记录可能不完整。"
                    }.into(), action: None,
                });
            }
            json!({
                "version": support::safe_version(&info.version),
                "protocolVersion": info.protocol_version,
                "stageDiagnosticsAvailable": available, "persistenceOk": persistence_ok,
                "pendingWrites": info.request_diagnostics.as_ref().map(|s| s.pending_writes),
                "droppedEvents": info.request_diagnostics.as_ref().map(|s| s.dropped_events),
                "writeFailures": info.request_diagnostics.as_ref().map(|s| s.write_failures),
                "writerRunning": info.request_diagnostics.as_ref().map(|s| s.writer_running),
                "writerCounterScope": "Device-local Core lifetime; includes pending writes, not account request or billing counts.",
                "events": if connection.connected { events } else { vec![] },
                "scope": "Claude Desktop messages only; progress is not inference success. Request bodies, raw errors and identifiers are excluded.",
            })
        }
        _ => {
            warnings.push("core_info_unavailable");
            // Recover only closed-schema records; never export arbitrary log text.
            let events =
                crate::core_diagnostics::persisted_events(&crate::config::get_app_config_dir());
            json!({
                "version": null, "stageDiagnosticsAvailable": false,
                "source": "persisted_previous_core",
                "events": if connection.connected {
                    crate::core_diagnostics::support_events(&events, since, now)
                } else { vec![] },
            })
        }
    };
    if core_support
        .get("events")
        .and_then(Value::as_array)
        .is_some_and(|events| {
            events.iter().any(|event| {
                matches!(
                    event.get("outcome").and_then(Value::as_str),
                    Some("panic" | "body_error")
                ) || event
                    .get("status")
                    .and_then(Value::as_u64)
                    .is_some_and(|s| s >= 400)
            })
        })
    {
        report.checks.push(YuanhengDiagnosticCheck {
            id: "core_request_flow".into(), status: "warning".into(),
            title: "Claude Desktop 请求阶段记录".into(),
            message: "观察窗口内存在失败或响应中断，记录已随脱敏报告导出；历史失败不代表当前仍失败，阶段记录也不等于上游计费结果。".into(),
            action: None,
        });
    }
    if tool_statuses
        .iter()
        .any(|t| t.app == "claude-desktop" && t.configured)
    {
        let (gateway, environment) = tokio::join!(
            super::claude_desktop_diagnostics::gateway(&state.db),
            super::claude_desktop_diagnostics::windows_environment(),
        );
        report.checks.push(gateway);
        if let Some(environment) = environment {
            report.checks.push(environment);
        }
    }
    if report.status == "ok" && report.checks.iter().any(|c| c.status != "ok") {
        report.status = "warning".into();
    }
    let configured_at = tool_statuses
        .iter()
        .filter(|tool| tool.configured)
        .map(|tool| {
            (
                tool.app.clone(),
                read_tool_configured_at(&state, &tool.app).unwrap_or(since),
            )
        })
        .collect::<HashMap<_, _>>();
    if support::latest_request_failures(&requests, &configured_at) > 0 {
        if report.status == "ok" {
            report.status = "warning".into();
        }
        report.checks.push(YuanhengDiagnosticCheck {
            id: "recent_requests".into(),
            status: "warning".into(),
            title: "最近请求需要关注".into(),
            message: "配置检查通过不等于模型调用成功，请查看报告中的最近 HTTP 状态和耗时。".into(),
            action: None,
        });
    }
    let tools: Vec<_> = tool_statuses
        .iter()
        .map(|tool| {
            let group = tool.group.as_ref().map(|group| {
                let next = format!("group-{}", group_labels.len() + 1);
                group_labels.entry(group.clone()).or_insert(next).clone()
            });
            json!({
                "tool": support::safe_tool(&tool.app), "configured": tool.configured,
                "needsUpdate": tool.needs_update,
            "model": tool.model.as_deref().map(|model| support::hide_account_label(model, &private_labels)), "group": group,
            })
        })
        .collect();
    if owner != diagnostic_owner(&state)? {
        return Err("检查期间账号发生变化，请重新检查".into());
    }
    let installations = super::misc::support_probe_observations();
    if installations.is_empty() {
        warnings.push("no_recent_local_installation_probe; use Redetect for installation details");
    }
    let snapshot_id = uuid::Uuid::new_v4().to_string();
    let document = json!({
        "schemaVersion": 3, "snapshotId": snapshot_id,
        "product": "YuanHeng Desktop", "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH,
        "capturedAt": chrono::Utc::now().to_rfc3339(),
        "checkedAt": report.checked_at,
        "checkDurationMs": requested_at.elapsed().as_millis() as u64,
        "status": report.status, "checks": support::safe_checks(&report),
        "tools": tools, "configLocations": support::config_locations(),
        "detectedInstallations": installations,
        "proxy": proxy, "core": core_support,
        "recentRequests": requests, "requestWindowStart": since,
        "warnings": warnings,
        "privacy": "No account names, tokens, raw paths, headers, conversation content, raw errors or request IDs. Groups are aliases; custom models are hidden.",
        "scope": "Latest 20 completed local proxy records since the current account sync, within one hour. Direct/official traffic outside the local proxy is not observable. HTTP status alone does not identify fault ownership.",
    });
    report.snapshot_id = Some(snapshot_id);
    report.support_json =
        Some(serde_json::to_string_pretty(&document).map_err(|_| "生成诊断快照失败")?);
    *state
        .diagnostic_snapshot
        .lock()
        .map_err(|_| "诊断快照不可用")? = Some(support::DiagnosticSnapshot {
        owner,
        captured: std::time::Instant::now(),
        report: report.clone(),
    });
    Ok(report)
}

fn diagnostic_owner(state: &AppState) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for key in [SESSION_COOKIE_KEY, USER_ID_KEY, API_TOKEN_KEY] {
        let value = get_yuanheng_secret(state, key)?.unwrap_or_default();
        hash.update((value.len() as u64).to_le_bytes());
        hash.update(value.as_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[allow(non_snake_case)]
#[tauri::command]
pub fn get_yuanheng_diagnostic_snapshot(
    state: State<'_, AppState>,
    snapshotId: String,
) -> Result<String, String> {
    read_diagnostic_snapshot(&state, &snapshotId)
}

fn read_diagnostic_snapshot(state: &AppState, snapshot_id: &str) -> Result<String, String> {
    let owner = diagnostic_owner(state)?;
    let snapshot = state
        .diagnostic_snapshot
        .lock()
        .map_err(|_| "诊断快照不可用")?;
    let snapshot = snapshot
        .as_ref()
        .filter(|snapshot| snapshot.matches(&owner, snapshot_id))
        .ok_or("诊断快照已过期或账号已切换，请重新检查")?;
    snapshot
        .report
        .support_json
        .clone()
        .ok_or_else(|| "请先生成诊断快照".into())
}

#[allow(non_snake_case)]
#[tauri::command]
pub async fn export_yuanheng_diagnostics(
    state: State<'_, AppState>,
    filePath: String,
    snapshotId: String,
) -> Result<String, String> {
    if filePath.trim().is_empty() {
        return Err("请选择诊断文件保存位置".to_string());
    }
    let content = read_diagnostic_snapshot(&state, &snapshotId)?;
    // Export precisely what was previewed/copied. Never re-run network diagnostics here.
    std::fs::write(&filePath, content).map_err(|e| format!("写入诊断文件失败: {e}"))?;
    Ok(filePath)
}

#[allow(non_snake_case)]
#[tauri::command]
pub async fn configure_yuanheng_tools(
    state: State<'_, AppState>,
    apps: Vec<String>,
    models: Option<HashMap<String, String>>,
    groups: Option<HashMap<String, String>>,
    reasoning: Option<HashMap<String, String>>,
) -> Result<Vec<YuanhengToolConfigureResult>, String> {
    if apps.is_empty() || apps.len() > 11 {
        return Err("请选择 1 到 11 个 AI 工具".to_string());
    }
    let _control_token = get_yuanheng_secret(&state, API_TOKEN_KEY)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "请先连接元衡账号".to_string())?;
    let session_cookie = get_yuanheng_secret(&state, SESSION_COOKIE_KEY)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "元衡登录状态缺失，请重新登录".to_string())?;
    let user_id = get_yuanheng_secret(&state, USER_ID_KEY)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "元衡用户 ID 缺失".to_string())?;
    let client = yuanheng_client()?;
    let connection = read_cached_status(&state)?;
    let requested_models = models.unwrap_or_default();
    let requested_groups = groups.unwrap_or_default();
    let requested_reasoning = reasoning.unwrap_or_default();
    // 旧版本没有记录令牌所属分组，不能用当前账号分组反推，否则会把 default
    // 令牌误用于新选择的分组。缺少记录时按目标分组重新读取令牌。
    // 每次显式配置都向已登录账号重新取该分组的 key，禁止沿用可能已撤销的主 key。
    // 同一批次内仅按分组复用，绝不跨分组复用。
    let mut token_cache: HashMap<String, String> = HashMap::new();
    let mut verified_token_models: HashMap<String, Vec<String>> = HashMap::new();
    let mut group_models_cache: HashMap<String, Result<Vec<String>, String>> = HashMap::new();
    let mut results = Vec::new();
    let mut seen = BTreeSet::new();
    let previous_statuses = all_tool_statuses(&state, &connection);
    for app_name in apps {
        if !seen.insert(app_name.clone()) {
            continue;
        }
        let is_workbuddy = app_name == "workbuddy";
        let is_chatgpt_desktop = app_name == CHATGPT_DESKTOP_NAMESPACE;
        let app = match app_name.as_str() {
            CHATGPT_DESKTOP_NAMESPACE => AppType::Codex,
            "workbuddy" | "dsh" => AppType::OpenCode,
            _ => match app_name.parse::<AppType>() {
                Ok(app) => app,
                Err(error) => {
                    results.push(YuanhengToolConfigureResult {
                        app: app_name,
                        configured: false,
                        model: None,
                        warnings: Vec::new(),
                        error: Some(error.to_string()),
                    });
                    continue;
                }
            },
        };
        let previous = previous_statuses.iter().find(|item| item.app == app_name);
        let model = match resolve_tool_model(
            app.clone(),
            &connection.models,
            requested_models
                .get(&app_name)
                .map(String::as_str)
                .or_else(|| previous.and_then(|item| item.model.as_deref())),
        ) {
            Ok(model) => model,
            Err(error) => {
                results.push(YuanhengToolConfigureResult {
                    app: app_name.clone(),
                    configured: false,
                    model: None,
                    warnings: Vec::new(),
                    error: Some(error),
                });
                continue;
            }
        };
        let group = match preferred_group_for_model(
            &connection,
            &model,
            requested_groups
                .get(&app_name)
                .map(String::as_str)
                .or_else(|| previous.and_then(|item| item.group.as_deref())),
        ) {
            Ok(group) => group,
            Err(error) => {
                results.push(YuanhengToolConfigureResult {
                    app: app_name.clone(),
                    configured: false,
                    model: Some(model),
                    warnings: Vec::new(),
                    error: Some(error),
                });
                continue;
            }
        };
        let reasoning = match resolve_reasoning_level(
            requested_reasoning
                .get(&app_name)
                .map(String::as_str)
                .or_else(|| previous.and_then(|item| item.reasoning.as_deref())),
            &model,
            &connection.reasoning_levels,
        ) {
            Ok(reasoning) => reasoning,
            Err(error) => {
                results.push(YuanhengToolConfigureResult {
                    app: app_name.clone(),
                    configured: false,
                    model: Some(model),
                    warnings: Vec::new(),
                    error: Some(error),
                });
                continue;
            }
        };
        let group_models_result = if let Some(cached) = group_models_cache.get(&group) {
            cached.clone()
        } else {
            let fetched = fetch_user_models(&client, &session_cookie, &user_id, Some(&group)).await;
            group_models_cache.insert(group.clone(), fetched.clone());
            fetched
        };
        let (group_models, group_models_warning) = match group_models_result {
            Ok(models) if models.iter().any(|item| item == &model) => {
                (terminal_catalog_models(&model, &models), None)
            }
            Ok(_) => {
                results.push(YuanhengToolConfigureResult {
                    app: app_name.clone(),
                    configured: false,
                    model: Some(model.clone()),
                    warnings: Vec::new(),
                    error: Some(format!(
                        "模型 {model} 已不在 {group} 分组的实时目录中，请刷新后重新选择"
                    )),
                });
                continue;
            }
            Err(error) => (
                vec![model.clone()],
                Some(format!(
                    "读取 {group} 分组模型失败，仅配置当前模型：{error}"
                )),
            ),
        };
        let token = if let Some(token) = token_cache.get(&group) {
            token.clone()
        } else {
            match ensure_device_api_token(&client, &session_cookie, &user_id, &group).await {
                Ok((token, _)) => {
                    token_cache.insert(group.clone(), token.clone());
                    token
                }
                Err(error) => {
                    results.push(YuanhengToolConfigureResult {
                        app: app_name.clone(),
                        configured: false,
                        model: Some(model),
                        warnings: Vec::new(),
                        error: Some(format!("创建 {group} 分组凭据失败: {error}")),
                    });
                    continue;
                }
            }
        };
        let verified_models = if let Some(models) = verified_token_models.get(&group) {
            Ok(models.clone())
        } else {
            fetch_api_models(&client, &token).await
        };
        match verified_models {
            Ok(models) if models.iter().any(|item| item == &model) => {
                verified_token_models.insert(group.clone(), models);
            }
            result => {
                let detail = result
                    .err()
                    .unwrap_or_else(|| "该凭据没有所选模型的访问权限".to_string());
                results.push(YuanhengToolConfigureResult {
                    app: app_name,
                    configured: false,
                    model: Some(model),
                    warnings: Vec::new(),
                    error: Some(format!(
                        "{group} 分组凭据验证未通过，原配置未更改：{detail}"
                    )),
                });
                continue;
            }
        }
        if !is_workbuddy
            && matches!(&app, AppType::ClaudeDesktop | AppType::Codex)
            && !state.proxy_service.is_running().await
        {
            if let Err(error) = state.proxy_service.start().await {
                results.push(YuanhengToolConfigureResult {
                    app: app_name.clone(),
                    configured: false,
                    model: None,
                    warnings: Vec::new(),
                    error: Some(format!("本地模型路由启动失败: {error}")),
                });
                continue;
            }
        }
        if get_yuanheng_secret(&state, USER_ID_KEY)?.as_deref() != Some(user_id.as_str())
            || get_yuanheng_secret(&state, SESSION_COOKIE_KEY)?.as_deref()
                != Some(session_cookie.as_str())
        {
            results.push(YuanhengToolConfigureResult {
                app: app_name,
                configured: false,
                model: Some(model),
                warnings: Vec::new(),
                error: Some("配置期间登录账号发生变化，已停止写入，请重新选择分组".to_string()),
            });
            break;
        }
        let configured = if app_name == "dsh" {
            dsh::configure(&state, &token, &model, &group_models, &group)
        } else if is_workbuddy {
            configure_workbuddy(&state, &token, &model, &group_models, &group)
        } else if matches!(&app, AppType::Codex) {
            configure_codex_surface(
                &state,
                if is_chatgpt_desktop {
                    CodexSurface::Desktop
                } else {
                    CodexSurface::Terminal
                },
                &token,
                &model,
                &group_models,
                &group,
                &reasoning,
            )
            .await
        } else {
            configure_tool_with_models(
                &state,
                app.clone(),
                &token,
                &model,
                &group_models,
                &group,
                &reasoning,
            )
        };
        match configured {
            Ok(mut result) => {
                result.app = app_name.clone();
                remember_tool_configured_at(&state, &app_name);
                if let Some(warning) = group_models_warning {
                    result.warnings.push(warning);
                }
                result.warnings.push(format!("使用令牌分组：{group}"));
                if app_name == AppType::Codex.as_str() {
                    crate::services::codex_session_bridge::update_codex_session_model(
                        &model, &reasoning,
                    );
                }
                results.push(result);
            }
            Err(error) => results.push(YuanhengToolConfigureResult {
                app: app_name,
                configured: false,
                model: None,
                warnings: Vec::new(),
                error: Some(error),
            }),
        }
    }
    Ok(results)
}

#[tauri::command]
pub async fn login_yuanheng(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<YuanhengAuthResult, String> {
    login_with_credentials(&state, username.trim(), &password).await
}

#[tauri::command]
pub async fn register_yuanheng(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<YuanhengAuthResult, String> {
    let username = username.trim();
    validate_registration_credentials(username, &password)?;
    let client = yuanheng_client()?;
    let (value, _) = post_json(
        &client,
        &format!("{BASE_URL}/api/user/register"),
        &json!({ "username": username, "password": password.as_str() }),
        None,
        None,
    )
    .await?;
    ensure_api_success(&value, "元衡注册失败")?;
    login_with_credentials(&state, username, &password).await
}

#[allow(non_snake_case)]
#[tauri::command]
pub async fn verify_yuanheng_two_factor(
    state: State<'_, AppState>,
    code: String,
) -> Result<YuanhengAuthResult, String> {
    let code = code.trim();
    if code.is_empty() || code.len() > 64 || code.contains(['\n', '\r']) {
        return Err("请输入有效的两步验证码或备用码".to_string());
    }
    let pending_cookie = get_yuanheng_secret(&state, PENDING_SESSION_COOKIE_KEY)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "两步验证会话已过期，请重新登录".to_string())?;
    let client = yuanheng_client()?;
    let (value, headers) = post_json(
        &client,
        &format!("{BASE_URL}/api/user/login/2fa"),
        &json!({ "code": code }),
        Some(&pending_cookie),
        None,
    )
    .await?;
    let (requires_two_factor, user_id) = parse_auth_response(&value)?;
    if requires_two_factor {
        return Err("元衡仍要求两步验证，请重新输入验证码".to_string());
    }
    let session_cookie = extract_cookie(&headers, "session")
        .ok_or_else(|| "两步验证成功，但未返回有效会话".to_string())?;
    let user_id = user_id.ok_or_else(|| "元衡登录响应缺少用户 ID".to_string())?;
    let status = finish_authenticated_session(&state, &client, &session_cookie, &user_id).await?;
    Ok(YuanhengAuthResult {
        requires_two_factor: false,
        connection: Some(status),
    })
}

#[tauri::command]
pub async fn refresh_yuanheng_connection(
    state: State<'_, AppState>,
) -> Result<YuanhengConnectionStatus, String> {
    let session_cookie = get_yuanheng_secret(&state, SESSION_COOKIE_KEY)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "元衡尚未连接".to_string())?;
    let user_id = get_yuanheng_secret(&state, USER_ID_KEY)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "元衡用户 ID 缺失".to_string())?;
    let client = yuanheng_client()?;
    match finish_authenticated_session(&state, &client, &session_cookie, &user_id).await {
        Ok(status) => Ok(status),
        Err(error) if is_yuanheng_session_auth_error(&error) => {
            log::warn!("元衡登录会话已失效，清理本机会话缓存: {error}");
            invalidate_yuanheng_session(&state)?;
            Err("元衡登录会话已过期，请重新登录后再同步".to_string())
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn rotate_yuanheng_device_token(
    state: State<'_, AppState>,
) -> Result<YuanhengConnectionStatus, String> {
    let session_cookie = get_yuanheng_secret(&state, SESSION_COOKIE_KEY)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "元衡尚未连接".to_string())?;
    let user_id = get_yuanheng_secret(&state, USER_ID_KEY)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "元衡用户 ID 缺失".to_string())?;
    let previous_token_id = state
        .db
        .get_setting(API_TOKEN_ID_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|value| value.parse::<i64>().ok());
    let client = yuanheng_client()?;
    let status = sync_connection(&client, &session_cookie, &user_id).await?;
    let group = status
        .account
        .as_ref()
        .map(|account| account.group.trim())
        .filter(|group| !group.is_empty())
        .unwrap_or("default");
    let detected_name = crate::services::sync_protocol::detect_system_device_name();
    let token_name = device_token_name(detected_name.as_deref());
    let (created, _) = post_json(
        &client,
        &format!("{BASE_URL}/api/token/"),
        &json!({
            "name": token_name.as_str(),
            "expired_time": -1,
            "remain_quota": 0,
            "unlimited_quota": true,
            "model_limits_enabled": false,
            "group": group
        }),
        Some(&session_cookie),
        Some(&user_id),
    )
    .await?;
    ensure_api_success(&created, "重新创建本机凭据失败")?;

    let list = fetch_json(
        &client,
        &format!("{BASE_URL}/api/token/?p=1&size=100"),
        Some(&session_cookie),
        Some(&user_id),
    )
    .await?;
    ensure_api_success(&list, "读取新建凭据失败")?;
    let now = chrono::Utc::now().timestamp();
    let token_id = find_device_token_id(&list, &token_name, group, now)
        .filter(|id| Some(*id) != previous_token_id)
        .ok_or_else(|| "本机凭据已创建，但未能读取新凭据编号".to_string())?;
    let key_value = fetch_json(
        &client,
        &format!("{BASE_URL}/api/token/{token_id}/key"),
        Some(&session_cookie),
        Some(&user_id),
    )
    .await?;
    ensure_api_success(&key_value, "读取新建凭据失败")?;
    let key = key_value
        .pointer("/data/key")
        .and_then(Value::as_str)
        .ok_or_else(|| "元衡工具凭据响应缺少 key".to_string())?;
    let api_token = normalize_api_token(key)?;
    verify_api_token(&client, &api_token).await?;
    persist_connection(
        &state,
        &session_cookie,
        &user_id,
        &api_token,
        token_id,
        &status,
    )?;

    // 旧 key 可能仍被 CLI、其他分组配置或离线设备引用。在所有消费者确认
    // 切换之前禁止撤销；不能依赖前端随后发起的重配命令充当跨端事务。
    // 用户需要撤销时可在平台令牌管理中显式处理。

    #[cfg(any(target_os = "macos", test))]
    {
        read_cached_status(&state)
    }
    #[cfg(not(any(target_os = "macos", test)))]
    {
        Ok(status)
    }
}

async fn open_yuanheng_authenticated_webview(
    app: &AppHandle,
    state: &AppState,
    page_url: &str,
    window_label: &str,
    window_title: &str,
    operation_name: &str,
) -> Result<bool, String> {
    let connection = read_cached_status(state)?;
    if !connection.connected {
        return Err("请先登录元衡账号".to_string());
    }

    let session_cookie = get_yuanheng_secret(state, SESSION_COOKIE_KEY)?.unwrap_or_default();
    let user_id = get_yuanheng_secret(state, USER_ID_KEY)?.unwrap_or_default();
    if session_cookie.is_empty() || user_id.is_empty() {
        return Err("元衡登录状态不完整，请重新登录".to_string());
    }

    // All embedded pages stay on new-api. The session cookie is injected only
    // into this isolated WebView; Pulse never receives it or a client secret.
    let client = yuanheng_client()?;
    let user_value = fetch_json(
        &client,
        &format!("{BASE_URL}/api/user/self"),
        Some(&session_cookie),
        Some(&user_id),
    )
    .await?;
    ensure_api_success(&user_value, "元衡登录状态已失效")?;
    let user_data = user_value
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| "元衡账号信息不完整".to_string())?;
    let user_seed = json!({
        "id": user_data.get("id").cloned().unwrap_or_else(|| json!(user_id)),
        "username": user_data
            .get("username")
            .cloned()
            .unwrap_or_else(|| json!(connection.account.as_ref().map(|item| item.username.clone()).unwrap_or_default())),
        "role": user_data.get("role").cloned().unwrap_or_else(|| json!(1)),
    });
    let user_seed_json = serde_json::to_string(&user_seed).map_err(|e| e.to_string())?;
    let user_seed_literal = serde_json::to_string(&user_seed_json).map_err(|e| e.to_string())?;
    let origin_literal = serde_json::to_string(BASE_URL).map_err(|e| e.to_string())?;
    let init_script = format!(
        r#"if (window.location.origin === {origin}) {{
          window.localStorage.setItem("user", {user_seed});
        }}"#,
        origin = origin_literal,
        user_seed = user_seed_literal,
    );
    let cookie = session_cookie_for_webview(&session_cookie)?;
    let target_url = page_url
        .parse()
        .map_err(|e| format!("{operation_name}地址无效: {e}"))?;

    if let Some(window) = app.get_webview_window(window_label) {
        window.set_cookie(cookie).map_err(|e| e.to_string())?;
        window
            .navigate(target_url)
            .map_err(|e| format!("打开{operation_name}失败: {e}"))?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(true);
    }

    let opener_app = app.clone();
    let window = WebviewWindowBuilder::new(
        app,
        window_label,
        WebviewUrl::External(
            "about:blank"
                .parse()
                .map_err(|e| format!("初始化{operation_name}窗口失败: {e}"))?,
        ),
    )
    .title(window_title)
    .inner_size(1080.0, 760.0)
    .min_inner_size(860.0, 620.0)
    .center()
    .resizable(true)
    .visible(false)
    .incognito(true)
    .initialization_script(init_script)
    .on_new_window(move |url, _| {
        if matches!(url.scheme(), "http" | "https") {
            if let Err(error) = opener_app.opener().open_url(url.as_str(), None::<String>) {
                log::error!("打开外部页面失败: {error}");
            }
        }
        NewWindowResponse::Deny
    })
    .build()
    .map_err(|e| format!("创建{operation_name}窗口失败: {e}"))?;

    window.set_cookie(cookie).map_err(|e| e.to_string())?;
    window
        .navigate(target_url)
        .map_err(|e| format!("打开{operation_name}失败: {e}"))?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn open_yuanheng_topup(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let already_open = app.get_webview_window(TOPUP_WINDOW_LABEL).is_some();
    let opened = open_yuanheng_authenticated_webview(
        &app,
        &state,
        TOPUP_URL,
        TOPUP_WINDOW_LABEL,
        "元衡充值",
        "充值",
    )
    .await?;

    if !already_open {
        if let Some(window) = app.get_webview_window(TOPUP_WINDOW_LABEL) {
            let event_app = app.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    let _ = event_app.emit(TOPUP_CLOSED_EVENT, ());
                }
            });
        }
    }
    Ok(opened)
}

#[tauri::command]
pub async fn open_yuanheng_pulse(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    open_yuanheng_authenticated_webview(
        &app,
        &state,
        PULSE_URL,
        PULSE_WINDOW_LABEL,
        "元衡脉冲",
        "脉冲控制台",
    )
    .await
}

#[tauri::command]
pub fn sign_out_yuanheng(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    for label in [TOPUP_WINDOW_LABEL, PULSE_WINDOW_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }
    invalidate_yuanheng_session(&state)?;
    Ok(true)
}

#[tauri::command]
pub fn disconnect_yuanheng(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<YuanhengDisconnectResult, String> {
    for label in [TOPUP_WINDOW_LABEL, PULSE_WINDOW_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }
    disconnect_yuanheng_inner(&state)
}

/// 恢复元衡接管前的工具配置，但保留账号连接和本机凭据。
/// 仅在存在可验证的历史配置时恢复；外部修改过的文件会保留并返回警告。
#[tauri::command]
pub fn rollback_yuanheng_tools(
    state: State<'_, AppState>,
) -> Result<YuanhengDisconnectResult, String> {
    restore_managed_tools_inner(&state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use serial_test::serial;
    use std::sync::Arc;

    #[tokio::test]
    #[serial]
    async fn preflight_uses_secure_login_and_each_tools_group_credential() {
        use axum::{routing::get, Json, Router};
        crate::secure_storage::clear_for_tests();
        let (_home, state) = isolated_state();
        let groups = ["default", "auto", "premium", "中文分组", "custom/group"];
        let connection = YuanhengConnectionStatus {
            connected: true,
            models: vec!["test-model".to_string()],
            terminal_models: vec!["test-model".to_string()],
            groups: groups
                .iter()
                .map(|group| YuanhengGroupOption {
                    id: group.to_string(),
                    description: String::new(),
                    ratio: None,
                })
                .collect(),
            model_groups: HashMap::from([(
                "test-model".to_string(),
                groups.iter().map(|s| s.to_string()).collect(),
            )]),
            ..Default::default()
        };
        persist_connection(
            &state,
            "session=fake-test",
            "test-user",
            "sk-main-valid",
            1,
            &connection,
        )
        .unwrap();
        assert!(state.db.get_setting(SESSION_COOKIE_KEY).unwrap().is_none());
        assert!(state.db.get_setting(USER_ID_KEY).unwrap().is_none());
        assert!(state.db.get_setting(API_TOKEN_KEY).unwrap().is_none());
        let router = Router::new()
            .route(
                "/api/user/models",
                get(|headers: axum::http::HeaderMap| async move {
                    assert_eq!(headers.get("cookie").unwrap(), "session=fake-test");
                    Json(json!({"success": true, "data": ["test-model"]}))
                }),
            )
            .route(
                "/v1/models",
                get(|headers: axum::http::HeaderMap| async move {
                    let token = headers.get("authorization").unwrap().to_str().unwrap();
                    if token == "Bearer sk-rejected" {
                        (
                            axum::http::StatusCode::UNAUTHORIZED,
                            Json(json!({"message": "must-not-leak-token"})),
                        )
                    } else {
                        assert!(token.starts_with("Bearer sk-group-"));
                        (
                            axum::http::StatusCode::OK,
                            Json(json!({"data": [{"id": "test-model"}]})),
                        )
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = yuanheng_client().unwrap();
        for (index, group) in groups.iter().enumerate() {
            for app in [
                "codex",
                CHATGPT_DESKTOP_NAMESPACE,
                "claude",
                "claude-desktop",
                "gemini",
                "opencode",
                "openclaw",
                "hermes",
                "grokbuild",
            ] {
                let kind = if app == CHATGPT_DESKTOP_NAMESPACE {
                    AppType::Codex
                } else {
                    app.parse().unwrap()
                };
                let provider = managed_provider(
                    &kind,
                    &format!("sk-group-{index}"),
                    "test-model",
                    group,
                    "auto",
                )
                .unwrap();
                state.db.save_provider(app, &provider).unwrap();
                let result = preflight_yuanheng_tool_at(
                    &state,
                    app,
                    "test-model",
                    Some(group),
                    Some("auto"),
                    &client,
                    &origin,
                )
                .await
                .unwrap();
                assert_ne!(result.status, "error", "{app}/{group}: {:?}", result.checks);
                assert!(!result.requires_configuration, "{app}/{group}");
                assert!(result
                    .checks
                    .iter()
                    .any(|check| check.id == "credential" && check.status == "ok"));
            }
            configure_workbuddy(
                &state,
                &format!("sk-group-{index}"),
                "test-model",
                &["test-model".to_string()],
                group,
            )
            .unwrap();
            let result = preflight_yuanheng_tool_at(
                &state,
                "workbuddy",
                "test-model",
                Some(group),
                Some("auto"),
                &client,
                &origin,
            )
            .await
            .unwrap();
            assert_ne!(result.status, "error");
            assert!(!result.requires_configuration);
            dsh::configure(
                &state,
                &format!("sk-group-{index}"),
                "test-model",
                &["test-model".into()],
                group,
            )
            .unwrap();
            let result = preflight_yuanheng_tool_at(
                &state,
                "dsh",
                "test-model",
                Some(group),
                Some("auto"),
                &client,
                &origin,
            )
            .await
            .unwrap();
            assert_ne!(result.status, "error", "{:?}", result.checks);
            assert!(!result.requires_configuration);
        }
        // 主 key 有效不应掩盖 Desktop key 被拒绝；CLI 的 key 也不能代替它。
        let provider = managed_provider(
            &AppType::Codex,
            "sk-rejected",
            "test-model",
            "premium",
            "auto",
        )
        .unwrap();
        state
            .db
            .save_provider(CHATGPT_DESKTOP_NAMESPACE, &provider)
            .unwrap();
        let result = preflight_yuanheng_tool_at(
            &state,
            CHATGPT_DESKTOP_NAMESPACE,
            "test-model",
            Some("premium"),
            Some("auto"),
            &client,
            &origin,
        )
        .await
        .unwrap();
        assert!(result.requires_configuration);
        assert!(result
            .checks
            .iter()
            .any(|check| check.id == "credential" && check.status == "warning"));
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("must-not-leak"));
        // 没配置过的分组进入准备流程，不误报用户未登录。
        let result = preflight_yuanheng_tool_at(
            &state,
            CHATGPT_DESKTOP_NAMESPACE,
            "test-model",
            Some("中文分组"),
            None,
            &client,
            &origin,
        )
        .await
        .unwrap();
        assert!(result.requires_configuration);
        task.abort();
        let _ = task.await;
        crate::secure_storage::clear_for_tests();
    }

    #[tokio::test]
    #[serial]
    async fn codex_config_failure_restores_both_providers_and_files() {
        let (_home, state) = isolated_state();
        prepare_managed_codex_mode(&state, true);
        let before_cli = managed_codex_provider_for_namespace(&state, "codex")
            .unwrap()
            .unwrap();
        let before_app = managed_codex_provider_for_namespace(&state, CHATGPT_DESKTOP_NAMESPACE)
            .unwrap()
            .unwrap();
        let before = capture_codex_mode_switch_snapshot(&state).unwrap();
        // 路由未启动，注入写入链路中途失败，不能把新分组/新 key 留在 DB。
        let result = configure_codex_surface(
            &state,
            CodexSurface::Desktop,
            "sk-new",
            "test-model",
            &["test-model".to_string()],
            "other-group",
            "auto",
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            managed_codex_provider_for_namespace(&state, "codex")
                .unwrap()
                .unwrap()
                .settings_config,
            before_cli.settings_config
        );
        assert_eq!(
            managed_codex_provider_for_namespace(&state, CHATGPT_DESKTOP_NAMESPACE)
                .unwrap()
                .unwrap()
                .settings_config,
            before_app.settings_config
        );
        assert_eq!(
            crate::codex_config::read_codex_config_text().unwrap(),
            before.live_config.unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(codex_terminal_profile_path()).unwrap(),
            before.terminal_profile.unwrap()
        );
    }

    #[test]
    fn network_failures_do_not_mean_token_rejection() {
        assert!(is_token_rejected("模型目录鉴权检查失败（HTTP 401）"));
        assert!(is_token_rejected("模型目录鉴权检查失败（HTTP 403）"));
        for error in ["连接超时", "HTTP 502", "HTTP 429", "非 JSON 响应"] {
            assert!(!is_token_rejected(error));
        }
    }

    #[test]
    fn login_accepts_existing_usernames_longer_than_registration_limit() {
        let username = "account-name-longer-than-twenty-characters";

        assert!(validate_login_credentials(username, "password123").is_ok());
        assert!(validate_registration_credentials(username, "password123").is_err());
    }

    #[test]
    fn creates_session_cookie_for_isolated_webview() {
        let cookie = session_cookie_for_webview("session=abc123").unwrap();

        assert_eq!(cookie.name(), "session");
        assert_eq!(cookie.value(), "abc123");
        assert_eq!(cookie.domain(), Some("meta-api.vip"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.http_only(), Some(true));
    }

    #[test]
    fn rejects_invalid_session_cookie_for_webview() {
        assert!(session_cookie_for_webview("").is_err());
        assert!(session_cookie_for_webview("token=abc123").is_err());
        assert!(session_cookie_for_webview("session=").is_err());
    }

    #[test]
    fn recognizes_expired_yuanheng_session_errors_without_matching_network_failures() {
        assert!(is_yuanheng_session_auth_error(
            "无权进行此操作，未登录且未提供 access token"
        ));
        assert!(is_yuanheng_session_auth_error("登录状态已失效"));
        assert!(!is_yuanheng_session_auth_error(
            "连接元衡失败: request timed out"
        ));
        assert!(!is_yuanheng_session_auth_error("读取账号模型失败"));
    }

    #[test]
    #[serial]
    fn migrates_yuanheng_credentials_out_of_sqlite() {
        crate::secure_storage::clear_for_tests();
        let (_home, state) = isolated_state();
        for (key, value) in [
            (TOKEN_KEY, "legacy-token"),
            (USER_ID_KEY, "42"),
            (SESSION_COOKIE_KEY, "session=legacy"),
            (PENDING_SESSION_COOKIE_KEY, "session=pending"),
            (API_TOKEN_KEY, "sk-device"),
        ] {
            state.db.set_setting(key, value).unwrap();
        }

        migrate_legacy_yuanheng_secrets(&state).unwrap();

        for (key, value) in [
            (TOKEN_KEY, "legacy-token"),
            (USER_ID_KEY, "42"),
            (SESSION_COOKIE_KEY, "session=legacy"),
            (PENDING_SESSION_COOKIE_KEY, "session=pending"),
            (API_TOKEN_KEY, "sk-device"),
        ] {
            assert_eq!(
                crate::secure_storage::get_secret(key).unwrap().as_deref(),
                Some(value)
            );
            assert!(state.db.get_setting(key).unwrap().is_none());
        }
        crate::secure_storage::clear_for_tests();
    }

    #[test]
    #[serial]
    fn migration_retry_keeps_legacy_copy_until_store_verification_succeeds() {
        crate::secure_storage::clear_for_tests();
        let (_home, state) = isolated_state();
        state
            .db
            .set_setting(SESSION_COOKIE_KEY, "session=legacy")
            .unwrap();
        // Simulate a previous attempt that wrote the same value and populated
        // the cache, but could not complete native read-back verification.
        crate::secure_storage::set_secret(SESSION_COOKIE_KEY, "session=legacy").unwrap();
        crate::secure_storage::block_verification_for_tests(true);
        let result = migrate_legacy_yuanheng_secret(&state, SESSION_COOKIE_KEY);
        crate::secure_storage::block_verification_for_tests(false);
        assert!(result.is_err());
        assert_eq!(
            state.db.get_setting(SESSION_COOKIE_KEY).unwrap().as_deref(),
            Some("session=legacy")
        );

        migrate_legacy_yuanheng_secret(&state, SESSION_COOKIE_KEY).unwrap();
        assert!(state.db.get_setting(SESSION_COOKIE_KEY).unwrap().is_none());
        assert_eq!(
            crate::secure_storage::get_secret(SESSION_COOKIE_KEY)
                .unwrap()
                .as_deref(),
            Some("session=legacy")
        );
        crate::secure_storage::clear_for_tests();
    }

    #[test]
    #[serial]
    fn invalidating_yuanheng_session_preserves_device_api_token() {
        crate::secure_storage::clear_for_tests();
        let (_home, state) = isolated_state();
        for (key, value) in [
            (TOKEN_KEY, "legacy-token"),
            (USER_ID_KEY, "42"),
            (SESSION_COOKIE_KEY, "session=expired"),
            (PENDING_SESSION_COOKIE_KEY, "session=pending"),
            (API_TOKEN_KEY, "sk-device"),
        ] {
            crate::secure_storage::set_secret(key, value).unwrap();
            // 模拟旧版本还残留的 SQLite 值，退出时必须一并删除。
            state.db.set_setting(key, value).unwrap();
        }
        state.db.set_setting(API_TOKEN_ID_KEY, "123").unwrap();
        state.db.set_setting(API_TOKEN_GROUP_KEY, "vip").unwrap();
        state.db.set_setting(CACHE_KEY, "cached-status").unwrap();

        invalidate_yuanheng_session(&state).unwrap();

        for key in [
            TOKEN_KEY,
            USER_ID_KEY,
            SESSION_COOKIE_KEY,
            PENDING_SESSION_COOKIE_KEY,
        ] {
            assert!(crate::secure_storage::get_secret(key).unwrap().is_none());
            assert!(state.db.get_setting(key).unwrap().is_none());
        }
        assert_eq!(
            crate::secure_storage::get_secret(API_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("sk-device")
        );
        assert!(state.db.get_setting(API_TOKEN_KEY).unwrap().is_none());
        assert_eq!(
            state.db.get_setting(API_TOKEN_ID_KEY).unwrap().as_deref(),
            Some("123")
        );
        assert_eq!(
            state
                .db
                .get_setting(API_TOKEN_GROUP_KEY)
                .unwrap()
                .as_deref(),
            Some("vip")
        );
        assert!(state.db.get_setting(CACHE_KEY).unwrap().is_none());
        crate::secure_storage::clear_for_tests();
    }

    #[test]
    fn parses_public_announcement_response() {
        assert_eq!(
            parse_announcement_response(&json!({ "data": "  新公告  " })).as_deref(),
            Some("新公告")
        );
        assert_eq!(parse_announcement_response(&json!({ "data": " " })), None);
        assert_eq!(parse_announcement_response(&json!({ "data": null })), None);
    }

    #[test]
    fn parses_structured_platform_announcements() {
        let feed = parse_platform_announcements(&json!({
            "data": {
                "announcements_enabled": true,
                "announcements": [
                    {
                        "id": 34,
                        "content": "  分组名称调整  ",
                        "extra": "  以平台实时显示为准  ",
                        "publishDate": "2026-07-28T02:41:25.745Z",
                        "type": "warning"
                    },
                    {
                        "id": "35",
                        "content": "新模型上线",
                        "extra": "",
                        "publishDate": "2026-07-29T02:41:25.745Z",
                        "type": "unknown"
                    }
                ]
            }
        }))
        .expect("structured feed");

        assert!(feed.enabled);
        assert_eq!(feed.source, "platform");
        assert_eq!(feed.announcements.len(), 2);
        assert_eq!(feed.announcements[0].id, "35");
        assert_eq!(feed.announcements[0].content, "新模型上线");
        assert_eq!(feed.announcements[0].announcement_type, "default");
        assert_eq!(feed.announcements[1].id, "34");
        assert_eq!(
            feed.announcements[1].extra.as_deref(),
            Some("以平台实时显示为准")
        );
        assert_eq!(feed.announcements[1].announcement_type, "warning");
    }

    #[test]
    fn respects_disabled_platform_announcements() {
        let feed = parse_platform_announcements(&json!({
            "data": {
                "announcements_enabled": false
            }
        }))
        .expect("disabled feed");

        assert!(!feed.enabled);
        assert!(feed.announcements.is_empty());
    }

    struct TestHome {
        _dir: tempfile::TempDir,
        previous_test_home: Option<std::ffi::OsString>,
    }

    impl TestHome {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let previous_test_home = std::env::var_os("YUANHENG_SWITCH_TEST_HOME");
            std::env::set_var("YUANHENG_SWITCH_TEST_HOME", dir.path());
            crate::settings::reload_settings().expect("reload isolated settings");
            Self {
                _dir: dir,
                previous_test_home,
            }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            match self.previous_test_home.take() {
                Some(value) => std::env::set_var("YUANHENG_SWITCH_TEST_HOME", value),
                None => std::env::remove_var("YUANHENG_SWITCH_TEST_HOME"),
            }
            let _ = crate::settings::reload_settings();
        }
    }

    fn isolated_state() -> (TestHome, AppState) {
        let home = TestHome::new();
        let db = Arc::new(Database::memory().expect("in-memory database"));
        (home, AppState::new(db))
    }

    #[test]
    #[serial]
    fn dsh_configures_profiles_rotates_key_and_restores_without_touching_other_providers() {
        let (_home, state) = isolated_state();
        let root = crate::config::get_home_dir().join(".dsh");
        let desktop = root.join("profiles/desktop/cordis.patch.yml");
        let web = root.join("profiles/web/cordis.patch.yml");
        std::fs::create_dir_all(desktop.parent().unwrap()).unwrap();
        std::fs::create_dir_all(web.parent().unwrap()).unwrap();
        std::fs::write(&desktop, "# desktop comment\n[]\n").unwrap();
        let old_web = "# web comment\n- id: llm-pi-ai\n  config:\n    providers:\n      mine: {api: openai-completions, baseURL: 'https://example.invalid/v1', models: [{id: old}]}\n";
        std::fs::write(&web, old_web).unwrap();
        std::fs::write(
            root.join(".credentials.yaml"),
            "# other key\nOTHER_KEY: preserved\n",
        )
        .unwrap();
        let models = vec![
            "gpt-5.6".into(),
            "claude-sonnet-4-6".into(),
            "test-model".into(),
        ];
        dsh::configure(&state, "synthetic-key-one", "gpt-5.6", &models, "default").unwrap();
        assert_eq!(
            dsh::credential(&state, "default").unwrap().as_deref(),
            Some("synthetic-key-one")
        );
        assert!(dsh::credential(&state, "other").unwrap().is_none());
        let connection = YuanhengConnectionStatus {
            models: models.clone(),
            terminal_models: models.clone(),
            ..Default::default()
        };
        assert!(dsh::status(&state, &connection).configured);
        dsh::configure(
            &state,
            "synthetic-key-two",
            "claude-sonnet-4-6",
            &models,
            "default",
        )
        .unwrap();
        assert_eq!(
            dsh::credential(&state, "default").unwrap().as_deref(),
            Some("synthetic-key-two")
        );
        let contents = std::fs::read_to_string(&web).unwrap();
        assert!(contents.starts_with(old_web));
        for protocol in [
            "openai-responses",
            "anthropic-messages",
            "openai-completions",
        ] {
            assert!(contents.contains(protocol));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.join(".credentials.yaml"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        // Optional export contains synthetic credentials only, for DSH runtime contract checks.
        if let Ok(target) = std::env::var("YUANHENG_DSH_TEST_EXPORT") {
            for relative in [
                "profiles/desktop/cordis.patch.yml",
                "profiles/web/cordis.patch.yml",
                ".credentials.yaml",
            ] {
                let output = std::path::Path::new(&target).join(relative);
                std::fs::create_dir_all(output.parent().unwrap()).unwrap();
                std::fs::copy(root.join(relative), output).unwrap();
            }
        }
        std::fs::write(&web, format!("{contents}# unrelated later note\n")).unwrap();
        assert!(dsh::restore(&state).unwrap());
        assert_eq!(
            std::fs::read_to_string(&web).unwrap(),
            format!("{old_web}# unrelated later note\n")
        );
        assert_eq!(
            std::fs::read_to_string(root.join(".credentials.yaml")).unwrap(),
            "# other key\nOTHER_KEY: preserved\n"
        );
        assert!(!dsh::restore(&state).unwrap());
    }

    #[test]
    #[serial]
    fn dsh_recovers_an_interrupted_multi_file_write() {
        let (_home, state) = isolated_state();
        dsh::configure(
            &state,
            "synthetic-key",
            "test-model",
            &["test-model".into()],
            "default",
        )
        .unwrap();
        let raw = state
            .db
            .get_setting("yuanheng_dsh_configuration")
            .unwrap()
            .unwrap();
        let mut record: Value = serde_json::from_str(&raw).unwrap();
        record["pending"] = json!(true);
        record["previous_hashes"] = json!([null, null, null]);
        state
            .db
            .set_setting("yuanheng_dsh_configuration", &record.to_string())
            .unwrap();
        let root = crate::config::get_home_dir().join(".dsh");
        std::fs::write(root.join("profiles/web/cordis.patch.yml"), "[]\n").unwrap();
        assert!(dsh::credential(&state, "default").is_err());
        assert!(dsh::restore(&state).unwrap());
        assert!(!std::fs::read_to_string(root.join(".credentials.yaml"))
            .unwrap()
            .contains("synthetic-key"));
    }

    #[test]
    #[serial]
    fn dsh_legacy_claude_policy_remains_trusted_for_reconfiguration_and_restore() {
        use sha2::{Digest, Sha256};

        for restore_only in [false, true] {
            let (_home, state) = isolated_state();
            let models = vec!["claude-opus-5-5".into(), "gpt-6.1-sol".into()];
            let connection = YuanhengConnectionStatus {
                models: models.clone(),
                terminal_models: models.clone(),
                ..Default::default()
            };
            dsh::configure(&state, "synthetic-key", &models[0], &models, "default").unwrap();
            let root = crate::config::get_home_dir().join(".dsh");
            let raw = state
                .db
                .get_setting("yuanheng_dsh_configuration")
                .unwrap()
                .unwrap();
            let mut record: Value = serde_json::from_str(&raw).unwrap();
            // Reconstruct an authentic pre-policy configuration and its ownership hashes.
            for (index, profile) in ["desktop", "web"].into_iter().enumerate() {
                let path = root.join(format!("profiles/{profile}/cordis.patch.yml"));
                let text = std::fs::read_to_string(&path).unwrap();
                let mut document: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
                let provider = document[0]["config"]["providers"]["yuanheng-messages"]
                    .as_mapping_mut()
                    .unwrap();
                provider.remove(serde_yaml::Value::from("streamIdleTimeoutMs"));
                provider.remove(serde_yaml::Value::from("retryPolicy"));
                let managed = format!(
                    "# BEGIN YUANHENG DSH\n{}# END YUANHENG DSH\n",
                    serde_yaml::to_string(&document).unwrap()
                );
                std::fs::write(&path, &managed).unwrap();
                record["hashes"][index + 1] =
                    json!(format!("{:x}", Sha256::digest(managed.as_bytes())));
            }
            state
                .db
                .set_setting("yuanheng_dsh_configuration", &record.to_string())
                .unwrap();
            let legacy_status = dsh::status(&state, &connection);
            assert!(!legacy_status.configured);
            assert!(legacy_status.needs_update);
            assert_eq!(
                dsh::credential(&state, "default").unwrap().as_deref(),
                Some("synthetic-key")
            );

            if !restore_only {
                let token = dsh::credential(&state, "default").unwrap().unwrap();
                dsh::configure(&state, &token, &models[0], &models, "default").unwrap();
                let updated_status = dsh::status(&state, &connection);
                assert!(updated_status.configured);
                assert!(!updated_status.needs_update);
                assert_eq!(
                    dsh::credential(&state, "default").unwrap().as_deref(),
                    Some("synthetic-key")
                );
            }
            assert!(dsh::restore(&state).unwrap());
            assert!(dsh::credential(&state, "default").unwrap().is_none());
        }
    }

    #[test]
    #[serial]
    fn dsh_refuses_external_edits_overrides_and_busy_writers() {
        let (_home, state) = isolated_state();
        let root = crate::config::get_home_dir().join(".dsh");
        let models = vec!["test-model".into()];
        dsh::configure(&state, "synthetic-key", "test-model", &models, "default").unwrap();
        let web = root.join("profiles/web/cordis.patch.yml");
        let before = std::fs::read_to_string(&web).unwrap();
        std::fs::write(
            &web,
            format!(
                "{before}- id: agent-default-model\n  config: {{provider: other, model: other}}\n"
            ),
        )
        .unwrap();
        assert!(dsh::credential(&state, "default").is_err());
        std::fs::write(&web, before.replace("test-model", "user-model")).unwrap();
        assert!(dsh::configure(&state, "new-key", "test-model", &models, "default").is_err());
        assert!(dsh::restore(&state).is_err());
        std::fs::write(&web, &before).unwrap();
        let lock = root.join(".credentials.yaml.lock");
        std::fs::write(&lock, "123\n").unwrap();
        assert!(dsh::configure(&state, "new-key", "test-model", &models, "default").is_err());
        std::fs::remove_file(lock).unwrap();
        std::fs::write(
            root.join("cordis.patch.yml"),
            "- id: llm-pi-ai\n  config: {}\n",
        )
        .unwrap();
        assert!(dsh::configure(&state, "new-key", "test-model", &models, "default").is_err());
        assert_eq!(std::fs::read_to_string(&web).unwrap(), before);
    }

    #[test]
    fn extracts_latest_session_cookie() {
        let mut headers = HeaderMap::new();
        headers.append(
            SET_COOKIE,
            "session=pending; Path=/; HttpOnly".parse().unwrap(),
        );
        headers.append(
            SET_COOKIE,
            "session=authenticated; Path=/; HttpOnly".parse().unwrap(),
        );
        assert_eq!(
            extract_cookie(&headers, "session").as_deref(),
            Some("session=authenticated")
        );
    }

    #[test]
    fn parses_two_factor_login_response() {
        let parsed = parse_auth_response(&json!({
            "success": true,
            "data": { "require_2fa": true }
        }))
        .unwrap();
        assert_eq!(parsed, (true, None));

        let parsed = parse_auth_response(&json!({
            "success": true,
            "data": { "id": 1024, "username": "nanashi" }
        }))
        .unwrap();
        assert_eq!(parsed, (false, Some("1024".to_string())));
    }

    #[test]
    fn builds_safe_device_token_name_and_normalizes_key() {
        let name = device_token_name(Some("测试设备名称非常非常长-MacBook-Pro"));
        assert!(name.starts_with("元衡桌面端 - "));
        assert!(name.len() <= 50);
        assert_eq!(normalize_api_token("raw-key").unwrap(), "sk-raw-key");
        assert_eq!(normalize_api_token("sk-ready").unwrap(), "sk-ready");
    }

    #[test]
    fn only_reuses_control_token_for_its_persisted_group() {
        assert!(token_cache_for_stored_group(None, "default-token".to_string()).is_empty());
        let cache = token_cache_for_stored_group(Some(" EMOXIA "), "emoxia-token".to_string());
        assert_eq!(
            cache.get("EMOXIA").map(String::as_str),
            Some("emoxia-token")
        );
        assert!(!cache.contains_key("default"));
    }

    #[test]
    fn finds_latest_usable_device_token() {
        let value = json!({
            "success": true,
            "data": {
                "items": [
                    { "id": 1, "name": "device", "group": "default", "status": 1, "expired_time": -1, "unlimited_quota": true },
                    { "id": 2, "name": "device", "group": "default", "status": 2, "expired_time": -1, "unlimited_quota": true },
                    { "id": 3, "name": "device", "group": "default", "status": 1, "expired_time": -1, "unlimited_quota": true },
                    { "id": 4, "name": "device", "group": "vip", "status": 1, "expired_time": -1, "unlimited_quota": true }
                ]
            }
        });
        assert_eq!(
            find_device_token_id(&value, "device", "default", 100),
            Some(3)
        );
    }

    #[test]
    #[serial]
    fn legacy_access_token_does_not_count_as_logged_in() {
        let (_home, state) = isolated_state();
        state.db.set_setting(TOKEN_KEY, "legacy-token").unwrap();
        state
            .db
            .set_setting(
                CACHE_KEY,
                &serde_json::to_string(&YuanhengConnectionStatus {
                    connected: true,
                    ..Default::default()
                })
                .unwrap(),
            )
            .unwrap();

        assert!(!read_cached_status(&state).unwrap().connected);
    }

    #[test]
    fn parses_newapi_account_quota() {
        let account = parse_account(&serde_json::json!({
            "success": true,
            "data": {
                "username": "nanashi",
                "display_name": "Nana",
                "group": "vip",
                "quota": 1_000_000,
                "used_quota": 250_000
            }
        }))
        .unwrap();
        assert_eq!(account.group, "vip");
        assert_eq!(account.remaining_usd, 2.0);
        assert_eq!(account.used_usd, 0.5);
    }

    #[test]
    fn extracts_models_without_unrelated_names() {
        let mut models = BTreeSet::new();
        collect_model_names(
            &serde_json::json!({
                "data": [
                    { "model_name": "gpt-5.6" },
                    { "model": "claude-opus-4-6", "name": "not-a-model" }
                ]
            }),
            &mut models,
        );
        assert_eq!(models.len(), 2);
        assert!(models.contains("gpt-5.6"));
        assert!(!models.contains("not-a-model"));
    }

    #[test]
    fn parses_live_api_model_catalog() {
        let models = parse_api_models(&serde_json::json!({
            "data": [
                { "id": "deepseek-v3.2", "object": "model" },
                { "id": "gpt-5.6", "object": "model" },
                { "id": "deepseek-v3.2", "object": "model" },
                { "name": "ignored" }
            ]
        }))
        .unwrap();
        assert_eq!(models, vec!["deepseek-v3.2", "gpt-5.6"]);
    }

    #[test]
    fn separates_terminal_and_image_generation_models() {
        let models = vec![
            "gpt-5.6-sol".to_string(),
            "gpt-image-1.5".to_string(),
            "gpt-image-2".to_string(),
            "deepseek-v4-pro".to_string(),
        ];
        let (terminal, image) = partition_model_catalog(&models);
        assert_eq!(terminal, vec!["gpt-5.6-sol", "deepseek-v4-pro"]);
        assert_eq!(image, vec!["gpt-image-1.5", "gpt-image-2"]);
    }

    #[test]
    fn parses_account_models_and_groups() {
        let models = parse_user_models(&json!({
            "success": true,
            "data": ["gpt-5.6-sol", "deepseek-v4-pro", "gpt-5.6-sol"]
        }))
        .unwrap();
        assert_eq!(models, vec!["deepseek-v4-pro", "gpt-5.6-sol"]);

        let groups = parse_user_groups(&json!({
            "success": true,
            "data": {
                "vip": { "desc": "VIP", "ratio": 0.5 },
                "default": { "desc": "默认分组", "ratio": 1.0 }
            }
        }))
        .unwrap();
        assert_eq!(groups[0].id, "default");
        assert_eq!(groups[1].ratio, Some(0.5));
    }

    #[test]
    fn chooses_a_usable_group_for_each_model() {
        let mut connection = YuanhengConnectionStatus {
            account: Some(YuanhengAccount {
                group: "default".to_string(),
                ..Default::default()
            }),
            groups: vec![
                YuanhengGroupOption {
                    id: "default".to_string(),
                    description: "默认分组".to_string(),
                    ratio: Some(1.0),
                },
                YuanhengGroupOption {
                    id: "svip".to_string(),
                    description: "SVIP".to_string(),
                    ratio: Some(0.5),
                },
                YuanhengGroupOption {
                    id: "vip".to_string(),
                    description: "VIP".to_string(),
                    ratio: Some(0.8),
                },
            ],
            model_groups: HashMap::from([(
                "gpt-5.6-sol".to_string(),
                vec!["svip".to_string(), "vip".to_string()],
            )]),
            ..Default::default()
        };

        assert_eq!(
            preferred_group_for_model(&connection, "gpt-5.6-sol", None).unwrap(),
            "svip"
        );
        assert_eq!(
            preferred_group_for_model(&connection, "gpt-5.6-sol", Some("vip")).unwrap(),
            "vip"
        );
        assert!(
            preferred_group_for_model(&connection, "gpt-5.6-sol", Some("default"))
                .unwrap_err()
                .contains("不支持分组")
        );

        connection
            .model_groups
            .get_mut("gpt-5.6-sol")
            .unwrap()
            .push("auto".to_string());
        assert_eq!(
            preferred_group_for_model(&connection, "gpt-5.6-sol", None).unwrap(),
            "auto"
        );
    }

    #[test]
    fn recommends_models_by_tool_protocol() {
        let models = vec![
            "gpt-image-2".to_string(),
            "deepseek-chat".to_string(),
            "claude-sonnet-4-6".to_string(),
            "gemini-3-pro".to_string(),
            "gpt-5.6".to_string(),
        ];
        assert_eq!(
            recommended_model(&AppType::Claude, &models).as_deref(),
            Some("claude-sonnet-4-6")
        );
        assert_eq!(
            recommended_model(&AppType::ClaudeDesktop, &models).as_deref(),
            Some("claude-sonnet-4-6")
        );
        assert_eq!(
            recommended_model(&AppType::Gemini, &models).as_deref(),
            Some("gemini-3-pro")
        );
        assert_eq!(
            recommended_model(&AppType::Codex, &models).as_deref(),
            Some("gpt-5.6")
        );
        assert!(recommended_model(&AppType::Codex, &["gpt-image-2".to_string()]).is_none());
        assert!(
            resolve_tool_model(AppType::Claude, &models, Some("gpt-image-2"))
                .unwrap_err()
                .contains("仅支持图像生成/编辑 API")
        );
    }

    #[test]
    fn recommends_text_model_for_claude_terminal_without_claude_models() {
        let models = vec![
            "FunAudioLLM/SenseVoiceSmall".to_string(),
            "deepseek-ai/DeepSeek-OCR".to_string(),
            "k3".to_string(),
            "gpt-5.4".to_string(),
            "deepseek-v4-flash".to_string(),
            "deepseek-v4-pro".to_string(),
        ];
        assert_eq!(
            recommended_model(&AppType::Claude, &models).as_deref(),
            Some("deepseek-v4-pro")
        );
        assert_eq!(
            recommended_model(&AppType::ClaudeDesktop, &models).as_deref(),
            Some("deepseek-v4-pro")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reports_claude_desktop_download_progress_and_stall() {
        let support = tempfile::tempdir().expect("tempdir");
        let version_dir = support.path().join("Claude-3p/claude-code/2.1.217");
        std::fs::create_dir_all(&version_dir).expect("create version dir");
        let partial = version_dir.join("download.zst.partial");
        std::fs::File::create(&partial)
            .expect("create partial")
            .set_len(13 * 1024 * 1024)
            .expect("size partial");

        let now = SystemTime::now();
        let downloading = claude_desktop_runtime_status_from(support.path(), now)
            .expect("partial download should be reported");
        assert_eq!(downloading.state, "downloading");
        assert_eq!(downloading.downloaded_bytes, 13 * 1024 * 1024);
        assert!(downloading.message.contains("13.0 MB"));

        let stalled =
            claude_desktop_runtime_status_from(support.path(), now + Duration::from_secs(121))
                .expect("stalled download should be reported");
        assert_eq!(stalled.state, "stalled");

        std::fs::write(version_dir.join(".verified"), "ready").expect("mark verified");
        assert!(claude_desktop_runtime_status_from(support.path(), now).is_none());
    }

    #[test]
    fn builds_hidden_managed_configs_for_each_tool() {
        let cases = [
            (AppType::Claude, "claude-sonnet-4-6"),
            (AppType::ClaudeDesktop, "deepseek-v4-pro"),
            (AppType::Codex, "gpt-5.6"),
            (AppType::Gemini, "gemini-3-pro"),
            (AppType::GrokBuild, "grok-4"),
            (AppType::OpenCode, "gpt-5.6"),
            (AppType::OpenClaw, "gpt-5.6"),
            (AppType::Hermes, "gpt-5.6"),
        ];
        for (app, model) in cases {
            let provider = managed_provider(&app, "sk-test", model, "default", "auto").unwrap();
            assert_eq!(provider.id, MANAGED_PROVIDER_ID);
            assert_eq!(provider.name, MANAGED_PROVIDER_DISPLAY_NAME);
            assert_eq!(provider_model(&provider, &app).as_deref(), Some(model));
            assert!(provider.settings_config.to_string().contains("sk-test"));
            assert!(provider_schema_current(&provider, &app));
            assert!(provider_has_credentials(&provider, &app));
            assert!(!provider
                .settings_config
                .to_string()
                .contains("cn.meta-api.vip"));

            let mut legacy_name = provider.clone();
            legacy_name.name = "元衡".to_string();
            assert!(!provider_schema_current(&legacy_name, &app));
        }
    }

    #[test]
    #[serial]
    fn international_route_reads_legacy_credentials_without_treating_cn_as_current() {
        let (_home, state) = isolated_state();
        for namespace in [
            "claude",
            "claude-desktop",
            "codex",
            "chatgpt-desktop",
            "gemini",
            "grokbuild",
            "opencode",
            "openclaw",
            "hermes",
        ] {
            let app = if namespace == CHATGPT_DESKTOP_NAMESPACE {
                AppType::Codex
            } else {
                namespace.parse::<AppType>().unwrap()
            };
            let provider =
                managed_provider(&app, "sk-own-group", "test-model", "vip", "auto").unwrap();
            let legacy_json = serde_json::to_string(&provider.settings_config)
                .unwrap()
                .replace(BASE_URL, "https://cn.meta-api.vip");
            let mut legacy = provider.clone();
            legacy.settings_config = serde_json::from_str(&legacy_json).unwrap();
            state.db.save_provider(namespace, &legacy).unwrap();
            assert!(tool_uses_legacy_endpoint(&state, namespace, "test-model"));
            assert!(!provider_has_credentials(&legacy, &app), "{namespace}");
            assert_eq!(
                stored_tool_credential(&state, namespace, "vip", Some("test-model")).unwrap(),
                Some("sk-own-group".into()),
                "{namespace}"
            );
            assert_eq!(
                stored_tool_credential(&state, namespace, "other", Some("test-model")).unwrap(),
                None
            );
            // Reapplying the same selection updates only the managed endpoint;
            // model, group and credentials retain their own identity.
            assert_eq!(
                provider_model(&legacy, &app),
                provider_model(&provider, &app)
            );
            assert_eq!(provider_group(&legacy), provider_group(&provider));
            state.db.save_provider(namespace, &provider).unwrap();
            assert!(!tool_uses_legacy_endpoint(&state, namespace, "test-model"));
            assert!(provider_has_credentials(&provider, &app));
            assert_eq!(
                stored_tool_credential(&state, namespace, "vip", Some("test-model")).unwrap(),
                Some("sk-own-group".into())
            );
            let mut external = legacy.clone();
            external.settings_config = serde_json::from_str(&legacy_json.replace(
                "https://cn.meta-api.vip",
                "https://cn.meta-api.vip.evil.test",
            ))
            .unwrap();
            state.db.save_provider(namespace, &external).unwrap();
            assert!(stored_tool_credential(&state, namespace, "vip", Some("test-model")).is_err());
            assert!(!provider_has_credentials(&external, &app));
        }
    }

    #[test]
    fn workbuddy_legacy_endpoint_is_recognized_for_rollback_but_requires_reapply() {
        let old = json!({
            "models":[{"id":"test-model","vendor":"YuanHeng",
                "url":"https://cn.meta-api.vip/v1/chat/completions","apiKey":"sk-own-group"}],
            "availableModels":["test-model"]
        });
        assert!(!workbuddy_config_matches(&old, "test-model"));
        assert!(workbuddy_config_matches_endpoint(&old, "test-model", true));
        let mut new = old.clone();
        new["models"][0]["url"] = json!(crate::yuanheng_endpoints::CHAT_URL);
        assert!(workbuddy_config_matches(&new, "test-model"));
        let mut mixed = new.clone();
        mixed["models"].as_array_mut().unwrap().push(json!({
            "id":"other-model","vendor":"YuanHeng","apiKey":"sk-own-group",
            "url":"https://cn.meta-api.vip/v1/chat/completions"
        }));
        assert!(!workbuddy_config_matches(&mixed, "test-model"));
        assert!(workbuddy_config_matches_endpoint(
            &mixed,
            "test-model",
            true
        ));
        mixed["models"][1]["url"] = json!("https://example.test/v1/chat/completions");
        assert!(!workbuddy_config_matches_endpoint(
            &mixed,
            "test-model",
            true
        ));
        for url in [
            "https://cn.meta-api.vip.evil.test/v1/chat/completions",
            "https://meta-api.vip/v1/chat/completions?redirect=evil",
        ] {
            new["models"][0]["url"] = json!(url);
            assert!(!workbuddy_config_matches_endpoint(&new, "test-model", true));
        }
    }

    #[test]
    fn managed_external_provider_labels_are_ascii_yuanheng() {
        let codex =
            managed_provider(&AppType::Codex, "sk-test", "gpt-5.6-sol", "default", "auto").unwrap();
        let codex_config = codex.settings_config["config"].as_str().unwrap();
        let codex_toml: toml::Value = codex_config.parse().unwrap();
        assert_eq!(
            codex_toml["model_providers"]["custom"]["name"].as_str(),
            Some(MANAGED_PROVIDER_DISPLAY_NAME)
        );

        let grok =
            managed_provider(&AppType::GrokBuild, "sk-test", "grok-4", "default", "auto").unwrap();
        let grok_model = crate::grok_config::extract_model_config(
            grok.settings_config["config"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(grok_model.name, MANAGED_PROVIDER_DISPLAY_NAME);

        let opencode = managed_provider(
            &AppType::OpenCode,
            "sk-test",
            "gpt-5.6-sol",
            "default",
            "auto",
        )
        .unwrap();
        assert_eq!(
            opencode.settings_config["name"].as_str(),
            Some(MANAGED_PROVIDER_DISPLAY_NAME)
        );

        let hermes = managed_provider(
            &AppType::Hermes,
            "sk-test",
            "gpt-5.6-sol",
            "default",
            "auto",
        )
        .unwrap();
        assert_eq!(
            hermes.settings_config["name"].as_str(),
            Some(MANAGED_PROVIDER_DISPLAY_NAME)
        );

        for provider in [codex, grok, opencode, hermes] {
            assert!(provider.name.is_ascii());
            assert!(!provider.settings_config.to_string().contains("元衡"));
        }
    }

    #[test]
    fn managed_configs_pass_strict_tool_validators() {
        let desktop =
            managed_provider(&AppType::ClaudeDesktop, "sk-test", "k3", "default", "high").unwrap();
        crate::claude_desktop_config::validate_provider(&desktop).unwrap();
        assert_eq!(
            desktop
                .meta
                .as_ref()
                .and_then(|meta| meta.claude_desktop_mode.clone()),
            Some(ClaudeDesktopMode::Proxy)
        );
        assert_eq!(
            crate::claude_desktop_config::proxy_model_routes(&desktop).unwrap()[0].upstream_model,
            "k3"
        );
        let desktop_meta = desktop.meta.as_ref().unwrap();
        assert_eq!(desktop_meta.api_format.as_deref(), Some("openai_chat"));
        assert_eq!(
            desktop_meta.claude_desktop_model_routes["claude-sonnet-5"]
                .label_override
                .as_deref(),
            Some(MANAGED_PROVIDER_AI_LABEL)
        );
        assert_eq!(
            desktop_meta
                .local_proxy_request_overrides
                .as_ref()
                .and_then(|overrides| overrides.body.as_ref())
                .and_then(|body| body.get("reasoning_effort"))
                .and_then(Value::as_str),
            Some("high")
        );

        let desktop_gpt = managed_provider(
            &AppType::ClaudeDesktop,
            "sk-test",
            "gpt-5.6-sol",
            "default",
            "high",
        )
        .unwrap();
        let gpt_meta = desktop_gpt.meta.as_ref().unwrap();
        assert_eq!(gpt_meta.api_format.as_deref(), Some("openai_responses"));
        assert_eq!(
            gpt_meta
                .local_proxy_request_overrides
                .as_ref()
                .and_then(|overrides| overrides.body.as_ref())
                .and_then(|body| body.pointer("/reasoning/effort"))
                .and_then(Value::as_str),
            Some("high")
        );

        let desktop_claude = managed_provider(
            &AppType::ClaudeDesktop,
            "sk-test",
            "claude-sonnet-4-6",
            "default",
            "high",
        )
        .unwrap();
        let claude_meta = desktop_claude.meta.as_ref().unwrap();
        assert_eq!(claude_meta.api_format.as_deref(), Some("anthropic"));
        assert_eq!(
            claude_meta
                .local_proxy_request_overrides
                .as_ref()
                .and_then(|overrides| overrides.body.as_ref())
                .and_then(|body| body.pointer("/output_config/effort"))
                .and_then(Value::as_str),
            Some("high")
        );

        let codex =
            managed_provider(&AppType::Codex, "sk-test", "gpt-5.6", "default", "high").unwrap();
        assert!(codex.settings_config["config"]
            .as_str()
            .unwrap()
            .contains("model_reasoning_effort = \"high\""));
        assert_eq!(provider_group(&codex).as_deref(), Some("default"));
        assert_eq!(provider_reasoning(&codex).as_deref(), Some("high"));
        let codex_chat =
            managed_provider(&AppType::Codex, "sk-test", "k3", "default", "high").unwrap();
        assert_eq!(
            codex_chat.settings_config["modelCatalog"]["models"][0]["model"],
            "k3"
        );
        assert_eq!(
            codex_chat
                .meta
                .as_ref()
                .and_then(|meta| meta.api_format.as_deref()),
            Some("openai_chat")
        );
        assert!(provider_schema_current(&codex_chat, &AppType::Codex));
        let mut full_catalog = codex_chat.clone();
        set_codex_available_models(
            &mut full_catalog,
            "k3",
            &[
                "gpt-5.6-sol".to_string(),
                "gpt-image-2".to_string(),
                "deepseek-v4-pro".to_string(),
                "k3".to_string(),
            ],
        );
        let models = full_catalog.settings_config["modelCatalog"]["models"]
            .as_array()
            .unwrap();
        assert_eq!(models.len(), 3);
        assert!(models
            .iter()
            .all(|item| item["model"].as_str() != Some("gpt-image-2")));
        assert_eq!(models[0]["model"], "k3");
        assert_eq!(models[1]["model"], "gpt-5.6-sol");
        assert_eq!(models[0]["apiFormat"], "openai_chat");
        assert_eq!(models[1]["apiFormat"], "openai_responses");
        let mut legacy_codex_chat = codex_chat.clone();
        legacy_codex_chat.meta.as_mut().unwrap().api_format = Some("openai_responses".to_string());
        assert!(!provider_schema_current(
            &legacy_codex_chat,
            &AppType::Codex
        ));
        let mut legacy_codex_name = codex_chat.clone();
        legacy_codex_name.settings_config["config"] = json!(legacy_codex_name.settings_config
            ["config"]
            .as_str()
            .unwrap()
            .replace("name = \"YuanHeng\"", "name = \"元衡\""));
        assert!(!provider_schema_current(
            &legacy_codex_name,
            &AppType::Codex
        ));
        let mut missing_catalog = codex_chat.clone();
        missing_catalog
            .settings_config
            .as_object_mut()
            .unwrap()
            .remove("modelCatalog");
        assert!(!provider_schema_current(&missing_catalog, &AppType::Codex));
        assert!(provider_schema_current(&desktop, &AppType::ClaudeDesktop));
        let mut legacy_desktop = desktop.clone();
        legacy_desktop
            .meta
            .as_mut()
            .unwrap()
            .claude_desktop_model_routes
            .get_mut("claude-sonnet-5")
            .unwrap()
            .label_override = Some("k3".to_string());
        assert!(!provider_schema_current(
            &legacy_desktop,
            &AppType::ClaudeDesktop
        ));
        crate::codex_config::validate_config_toml(
            codex.settings_config["config"].as_str().unwrap(),
        )
        .unwrap();

        let gemini = managed_provider(
            &AppType::Gemini,
            "sk-test",
            "gemini-3-pro",
            "default",
            "auto",
        )
        .unwrap();
        crate::gemini_config::validate_gemini_settings(&gemini.settings_config).unwrap();

        let grok =
            managed_provider(&AppType::GrokBuild, "sk-test", "grok-4", "default", "auto").unwrap();
        crate::grok_config::validate_config_toml(grok.settings_config["config"].as_str().unwrap())
            .unwrap();
    }

    #[test]
    fn managed_agents_receive_the_selected_groups_full_text_catalog() {
        let models = vec![
            "gpt-5.6-sol".to_string(),
            "deepseek-v4-pro".to_string(),
            "claude-opus-4-7".to_string(),
            "gpt-image-2".to_string(),
        ];

        let codex = managed_provider_with_models(
            &AppType::Codex,
            "sk-test",
            "gpt-5.6-sol",
            &models,
            "vip",
            "auto",
        )
        .unwrap();
        let codex_models = codex.settings_config["modelCatalog"]["models"]
            .as_array()
            .unwrap();
        assert_eq!(codex_models.len(), 3);
        assert_eq!(codex_models[2]["apiFormat"], "anthropic");

        let opencode = managed_provider_with_models(
            &AppType::OpenCode,
            "sk-test",
            "gpt-5.6-sol",
            &models,
            "vip",
            "auto",
        )
        .unwrap();
        assert_eq!(
            opencode.settings_config["models"]
                .as_object()
                .unwrap()
                .len(),
            3
        );

        let openclaw = managed_provider_with_models(
            &AppType::OpenClaw,
            "sk-test",
            "gpt-5.6-sol",
            &models,
            "vip",
            "auto",
        )
        .unwrap();
        assert_eq!(
            openclaw.settings_config["models"].as_array().unwrap().len(),
            3
        );

        let hermes = managed_provider_with_models(
            &AppType::Hermes,
            "sk-test",
            "gpt-5.6-sol",
            &models,
            "vip",
            "auto",
        )
        .unwrap();
        assert_eq!(
            hermes.settings_config["models"].as_array().unwrap().len(),
            3
        );

        let grok = managed_provider_with_models(
            &AppType::GrokBuild,
            "sk-test",
            "gpt-5.6-sol",
            &models,
            "vip",
            "auto",
        )
        .unwrap();
        let grok_config = grok.settings_config["config"].as_str().unwrap();
        assert!(grok_config.contains("[model.\"gpt-5.6-sol\"]"));
        assert!(grok_config.contains("[model.\"deepseek-v4-pro\"]"));
        assert!(grok_config.contains("[model.\"claude-opus-4-7\"]"));
        assert!(!grok_config.contains("gpt-image-2"));
    }

    #[test]
    fn validates_reasoning_levels() {
        let supported = HashMap::from([(
            "k3".to_string(),
            vec!["minimal", "low", "medium", "high", "xhigh"]
                .into_iter()
                .map(str::to_string)
                .collect(),
        )]);
        for level in ["auto", "minimal", "low", "medium", "high", "xhigh"] {
            assert_eq!(
                resolve_reasoning_level(Some(level), "k3", &supported).unwrap(),
                level
            );
        }
        assert_eq!(
            resolve_reasoning_level(None, "k3", &supported).unwrap(),
            "auto"
        );
        assert!(resolve_reasoning_level(Some("max"), "k3", &supported).is_err());
        assert!(resolve_reasoning_level(Some("extreme"), "k3", &supported).is_err());
        assert!(resolve_reasoning_level(Some("high"), "deepseek-v4-pro", &supported).is_err());
    }

    #[test]
    fn provides_model_specific_reasoning_fallbacks() {
        assert_eq!(
            fallback_reasoning_levels("claude-opus-4-7"),
            vec!["low", "medium", "high", "max"]
        );
        assert_eq!(
            fallback_reasoning_levels("gpt-5.5"),
            vec!["low", "medium", "high", "xhigh"]
        );
        assert!(fallback_reasoning_levels("deepseek-v4-pro").is_empty());
    }

    #[test]
    fn selects_claude_protocol_by_model_family() {
        assert_eq!(yuanheng_model_api_format("claude-opus-4-7"), "anthropic");
        assert_eq!(yuanheng_model_api_format("gpt-5.6-sol"), "openai_responses");
        assert_eq!(yuanheng_model_api_format("o3-mini"), "openai_responses");
        assert_eq!(yuanheng_model_api_format("k3"), "openai_chat");
        assert_eq!(yuanheng_model_api_format("deepseek-v4-pro"), "openai_chat");
    }

    #[test]
    fn preflight_describes_tool_protocols_without_guessing_image_support() {
        assert_eq!(preflight_target_protocol("codex"), "openai_responses");
        assert_eq!(
            preflight_target_protocol(CHATGPT_DESKTOP_NAMESPACE),
            "openai_responses"
        );
        assert_eq!(preflight_target_protocol("claude"), "anthropic_messages");
        assert_eq!(preflight_target_protocol("workbuddy"), "openai_chat");
        assert_eq!(preflight_image_input("deepseek-v4-pro"), "unsupported");
        assert_eq!(preflight_image_input("future-vision-model"), "unknown");
    }

    #[test]
    #[serial]
    fn codex_surfaces_keep_independent_models_and_routes() {
        let (_home, state) = isolated_state();
        let terminal = managed_provider(
            &AppType::Codex,
            "terminal-token",
            "gpt-5.6-sol",
            "premium",
            "xhigh",
        )
        .unwrap();
        let desktop =
            managed_provider(&AppType::Codex, "desktop-token", "k3", "default", "high").unwrap();
        save_managed_codex_provider(&state, AppType::Codex.as_str(), &terminal).unwrap();
        save_managed_codex_provider(&state, CHATGPT_DESKTOP_NAMESPACE, &desktop).unwrap();

        let stored_terminal = managed_codex_provider_for_namespace(&state, AppType::Codex.as_str())
            .unwrap()
            .unwrap();
        let stored_desktop =
            managed_codex_provider_for_namespace(&state, CHATGPT_DESKTOP_NAMESPACE)
                .unwrap()
                .unwrap();
        assert_eq!(
            provider_model(&stored_terminal, &AppType::Codex).as_deref(),
            Some("gpt-5.6-sol")
        );
        assert_eq!(
            provider_model(&stored_desktop, &AppType::Codex).as_deref(),
            Some("k3")
        );

        let terminal_catalog = codex_provider_catalog_settings(&stored_terminal);
        let desktop_catalog = codex_provider_catalog_settings(&stored_desktop);
        let terminal_config = codex_surface_route_config(
            &stored_terminal,
            "http://127.0.0.1:15721/codex/v1",
            &terminal_catalog,
            CodexSurface::Terminal,
        )
        .unwrap();
        let desktop_config = codex_surface_route_config(
            &stored_desktop,
            "http://127.0.0.1:15721/chatgpt-desktop/v1",
            &desktop_catalog,
            CodexSurface::Desktop,
        )
        .unwrap();
        assert!(terminal_config.contains("/codex/v1"));
        assert!(terminal_config.contains("model = \"gpt-5.6-sol\""));
        assert!(terminal_config.contains("yuanheng-terminal-model-catalog-"));
        assert!(!terminal_config.contains("yuanheng-desktop-model-catalog-"));
        assert!(desktop_config.contains("/chatgpt-desktop/v1"));
        assert!(desktop_config.contains("model = \"k3\""));
        assert!(desktop_config.contains("yuanheng-desktop-model-catalog-"));
        assert!(!desktop_config.contains("yuanheng-terminal-model-catalog-"));
        assert!(crate::codex_config::get_codex_named_model_catalog_path(
            crate::codex_config::YUANHENG_TERMINAL_MODEL_CATALOG_FILENAME
        )
        .exists());
        assert!(crate::codex_config::get_codex_named_model_catalog_path(
            crate::codex_config::YUANHENG_DESKTOP_MODEL_CATALOG_FILENAME
        )
        .exists());
        let terminal_catalog: Value = serde_json::from_str(
            &std::fs::read_to_string(crate::codex_config::get_codex_named_model_catalog_path(
                crate::codex_config::YUANHENG_TERMINAL_MODEL_CATALOG_FILENAME,
            ))
            .unwrap(),
        )
        .unwrap();
        let desktop_catalog: Value = serde_json::from_str(
            &std::fs::read_to_string(crate::codex_config::get_codex_named_model_catalog_path(
                crate::codex_config::YUANHENG_DESKTOP_MODEL_CATALOG_FILENAME,
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(terminal_catalog["models"].as_array().unwrap().len(), 1);
        assert_eq!(terminal_catalog["models"][0]["slug"], "gpt-5.6-sol");
        assert_eq!(desktop_catalog["models"].as_array().unwrap().len(), 1);
        assert_eq!(desktop_catalog["models"][0]["slug"], "k3");
    }

    #[tokio::test]
    #[serial]
    async fn codex_first_surface_configuration_allows_managed_mode_switch() {
        for surface in [CodexSurface::Desktop, CodexSurface::Terminal] {
            let (_home, state) = isolated_state();
            let mut config = state.db.get_proxy_config().await.unwrap();
            config.listen_port = 0;
            state.db.update_proxy_config(config).await.unwrap();
            let proxy = state.proxy_service.start().await.unwrap();
            let original_live = "model = \"gpt-existing\"\n";
            let auth = json!({ "auth_mode": "apikey", "OPENAI_API_KEY": "relay-login-test" });
            crate::codex_config::write_codex_live_atomic(&auth, Some(original_live)).unwrap();

            let result = configure_codex_surface(
                &state,
                surface,
                "synthetic-key",
                "gpt-5.6-sol",
                &["gpt-5.6-sol".into()],
                "premium",
                "high",
            )
            .await
            .unwrap();
            state.proxy_service.stop().await.unwrap();
            assert!(result.configured);
            let connection = YuanhengConnectionStatus {
                models: vec!["gpt-5.6-sol".into()],
                terminal_models: vec!["gpt-5.6-sol".into()],
                ..Default::default()
            };
            if surface == CodexSurface::Desktop {
                assert!(chatgpt_desktop_status(&state, &connection).configured);
                assert!(!codex_terminal_profile_path().exists());
            } else {
                assert!(tool_status(&state, AppType::Codex, &connection).configured);
                assert_eq!(
                    crate::codex_config::read_codex_config_text().unwrap(),
                    original_live
                );
            }
            let before = codex_account_mode_status_inner(&state).unwrap();
            assert!(
                before.yuanheng_available,
                "one configured tool must allow switching"
            );
            assert!(!before.official_login_available);
            let switched = switch_codex_account_mode_at_origin(
                &state,
                "yuanheng",
                Some(&before.mode),
                &format!("http://127.0.0.1:{}", proxy.port),
            )
            .unwrap();
            assert_eq!(switched.mode, "yuanheng");
            for target in [CodexSurface::Terminal, CodexSurface::Desktop] {
                let provider = managed_codex_provider_for_namespace(&state, target.namespace())
                    .unwrap()
                    .unwrap();
                assert!(codex_surface_matches(&provider, target));
            }
            let final_auth: Value =
                crate::config::read_json_file(&crate::codex_config::get_codex_auth_path()).unwrap();
            assert_eq!(final_auth, auth);
        }
    }

    #[test]
    #[serial]
    fn codex_mode_switch_repairs_legacy_surface_markers_without_changing_selections() {
        for wrong_surface in [CodexSurface::Terminal, CodexSurface::Desktop] {
            let (_home, state) = isolated_state();
            prepare_managed_codex_mode(&state, false);
            let mut original =
                managed_codex_provider_for_namespace(&state, wrong_surface.namespace())
                    .unwrap()
                    .unwrap();
            original.settings_config["yuanhengSurface"] =
                json!(if wrong_surface == CodexSurface::Terminal {
                    "desktop"
                } else {
                    "terminal"
                });
            state
                .db
                .save_provider(wrong_surface.namespace(), &original)
                .unwrap();
            let snapshot = capture_codex_mode_switch_snapshot(&state).unwrap();
            let auth = std::fs::read(crate::codex_config::get_codex_auth_path()).unwrap();
            let status = codex_account_mode_status_inner(&state).unwrap();
            assert_eq!(status.mode, "unknown", "repairable does not mean applied");
            assert!(status.yuanheng_available);
            assert_eq!(
                managed_codex_provider_for_namespace(&state, wrong_surface.namespace())
                    .unwrap()
                    .unwrap()
                    .settings_config,
                original.settings_config,
                "read-only status must not migrate stored records",
            );
            let result = switch_codex_account_mode_at_origin(
                &state,
                "yuanheng",
                Some("unknown"),
                "http://127.0.0.1:15721",
            )
            .unwrap();
            assert_eq!(result.mode, "yuanheng");
            for (surface, previous) in [
                (CodexSurface::Terminal, snapshot.managed_terminal.unwrap()),
                (CodexSurface::Desktop, snapshot.managed_desktop.unwrap()),
            ] {
                let mut expected = previous;
                expected.settings_config["yuanhengSurface"] =
                    json!(if surface == CodexSurface::Terminal {
                        "terminal"
                    } else {
                        "desktop"
                    });
                let actual = managed_codex_provider_for_namespace(&state, surface.namespace())
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    serde_json::to_value(actual).unwrap(),
                    serde_json::to_value(expected).unwrap()
                );
            }
            assert_eq!(
                std::fs::read(crate::codex_config::get_codex_auth_path()).unwrap(),
                auth
            );
        }
    }

    #[test]
    #[serial]
    fn codex_mode_switch_does_not_repair_unknown_or_untrusted_surface_records() {
        for invalid in [
            "unknown-marker",
            "missing-marker",
            "non-managed",
            "missing-key",
            "external-endpoint",
        ] {
            let (_home, state) = isolated_state();
            prepare_managed_codex_mode(&state, false);
            let mut terminal = managed_codex_provider_for_namespace(&state, "codex")
                .unwrap()
                .unwrap();
            terminal.settings_config["yuanhengSurface"] = json!("desktop");
            match invalid {
                "unknown-marker" => terminal.settings_config["yuanhengSurface"] = json!("other"),
                "missing-marker" => {
                    terminal
                        .settings_config
                        .as_object_mut()
                        .unwrap()
                        .remove("yuanhengSurface");
                }
                "non-managed" => terminal.category = Some("custom".into()),
                "missing-key" => terminal.settings_config["auth"]["OPENAI_API_KEY"] = json!(""),
                "external-endpoint" => {
                    terminal.settings_config["config"] = json!(terminal.settings_config["config"]
                        .as_str()
                        .unwrap()
                        .replace(OPENAI_BASE_URL, "https://example.invalid/v1"));
                }
                _ => unreachable!(),
            }
            state.db.save_provider("codex", &terminal).unwrap();
            assert!(!yuanheng_codex_mode_available(&state), "{invalid}");
            assert!(
                switch_codex_account_mode_at_origin(
                    &state,
                    "yuanheng",
                    Some("unknown"),
                    "http://127.0.0.1:15721",
                )
                .is_err(),
                "{invalid}"
            );
            assert_eq!(
                managed_codex_provider_for_namespace(&state, "codex")
                    .unwrap()
                    .unwrap()
                    .settings_config,
                terminal.settings_config
            );
        }
    }

    #[test]
    #[serial]
    fn codex_surface_marker_repair_rolls_back_when_desktop_write_fails() {
        let (_home, state) = isolated_state();
        prepare_managed_codex_mode(&state, false);
        let mut terminal = managed_codex_provider_for_namespace(&state, "codex")
            .unwrap()
            .unwrap();
        terminal.settings_config["yuanhengSurface"] = json!("desktop");
        state.db.save_provider("codex", &terminal).unwrap();
        let before = capture_codex_mode_switch_snapshot(&state).unwrap();
        let catalog_path = crate::codex_config::get_codex_named_model_catalog_path(
            crate::codex_config::YUANHENG_DESKTOP_MODEL_CATALOG_FILENAME,
        );
        std::fs::remove_file(&catalog_path).unwrap();
        std::fs::create_dir(&catalog_path).unwrap();
        assert!(yuanheng_codex_mode_available(&state));
        assert!(switch_codex_account_mode_at_origin(
            &state,
            "yuanheng",
            Some("unknown"),
            "http://127.0.0.1:18888",
        )
        .is_err());
        assert_eq!(
            managed_codex_provider_for_namespace(&state, "codex")
                .unwrap()
                .unwrap()
                .settings_config,
            terminal.settings_config
        );
        assert_eq!(
            crate::codex_config::read_codex_config_text().unwrap(),
            before.live_config.unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(codex_terminal_profile_path()).unwrap(),
            before.terminal_profile.unwrap()
        );
        assert_eq!(
            ProviderService::current(&state, AppType::Codex).unwrap(),
            MANAGED_PROVIDER_ID
        );
    }

    fn prepare_managed_codex_mode(state: &AppState, with_oauth: bool) {
        let mut terminal = managed_provider(
            &AppType::Codex,
            "terminal-token",
            "gpt-5.6-sol",
            "premium",
            "xhigh",
        )
        .unwrap();
        terminal.settings_config["yuanhengSurface"] = json!("terminal");
        let mut desktop =
            managed_provider(&AppType::Codex, "desktop-token", "k3", "default", "high").unwrap();
        desktop.settings_config["yuanhengSurface"] = json!("desktop");
        save_managed_codex_provider(state, AppType::Codex.as_str(), &terminal).unwrap();
        save_managed_codex_provider(state, CHATGPT_DESKTOP_NAMESPACE, &desktop).unwrap();
        crate::settings::set_current_provider(&AppType::Codex, Some(MANAGED_PROVIDER_ID)).unwrap();
        let auth = if with_oauth {
            json!({
                "auth_mode": "chatgpt",
                "tokens": { "access_token": "oauth-test" }
            })
        } else {
            json!({})
        };
        crate::codex_config::write_codex_live_atomic(&auth, Some("")).unwrap();
        write_codex_surface_config_at_origin(
            state,
            CodexSurface::Terminal,
            "http://127.0.0.1:15721",
        )
        .unwrap();
        write_codex_surface_config_at_origin(
            state,
            CodexSurface::Desktop,
            "http://127.0.0.1:15721",
        )
        .unwrap();
    }

    #[test]
    #[serial]
    fn codex_account_mode_round_trip_preserves_both_managed_surfaces_and_oauth() {
        let (_home, state) = isolated_state();
        prepare_managed_codex_mode(&state, true);
        let auth_before: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path()).unwrap();

        let official = switch_codex_account_mode_at_origin(
            &state,
            "official",
            Some("yuanheng"),
            "http://127.0.0.1:15721",
        )
        .unwrap();
        assert_eq!(official.mode, "official");
        assert!(official.restart_required);
        assert!(!codex_terminal_profile_path().exists());
        let official_live = crate::codex_config::read_codex_config_text().unwrap();
        assert!(crate::codex_config::codex_config_has_official_proxy_route(
            &official_live
        ));
        let official_doc: toml::Value = toml::from_str(&official_live).unwrap();
        let routes = &official_doc["model_providers"];
        assert_eq!(
            routes["yuanheng"],
            routes[crate::codex_config::CC_SWITCH_CODEX_OFFICIAL_PROXY_PROVIDER_ID]
        );
        assert_eq!(
            routes["yuanheng"]["requires_openai_auth"].as_bool(),
            Some(true)
        );
        assert!(routes["yuanheng"]
            .get("experimental_bearer_token")
            .is_none());
        assert!(managed_codex_routes_require_core(state.db.as_ref()));
        let auth_after: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path()).unwrap();
        assert_eq!(auth_after, auth_before, "官方 OAuth 凭据必须保持不变");
        assert!(
            managed_codex_provider_for_namespace(&state, AppType::Codex.as_str())
                .unwrap()
                .is_some()
        );
        assert!(
            managed_codex_provider_for_namespace(&state, CHATGPT_DESKTOP_NAMESPACE)
                .unwrap()
                .is_some()
        );

        let managed = switch_codex_account_mode_at_origin(
            &state,
            "yuanheng",
            Some("official"),
            "http://127.0.0.1:15721",
        )
        .unwrap();
        assert_eq!(managed.mode, "yuanheng");
        let terminal_profile = std::fs::read_to_string(codex_terminal_profile_path()).unwrap();
        let desktop_live = crate::codex_config::read_codex_config_text().unwrap();
        assert!(terminal_profile.contains("/codex/v1"));
        assert!(terminal_profile.contains("model = \"gpt-5.6-sol\""));
        let desktop_doc: toml::Value = toml::from_str(&desktop_live).unwrap();
        let active = desktop_doc["model_provider"].as_str().unwrap();
        assert_eq!(
            desktop_doc["model_providers"]["yuanheng"],
            desktop_doc["model_providers"][active]
        );
        assert_eq!(
            desktop_doc["model_providers"]
                [crate::codex_config::CC_SWITCH_CODEX_OFFICIAL_PROXY_PROVIDER_ID],
            desktop_doc["model_providers"][active]
        );
        assert!(desktop_live.contains("/chatgpt-desktop/v1"));
        assert!(desktop_live.contains("model = \"k3\""));
        let auth_final: Value =
            crate::config::read_json_file(&crate::codex_config::get_codex_auth_path()).unwrap();
        assert_eq!(auth_final, auth_before, "切回元衡也不能覆盖官方 OAuth");
    }

    fn make_codex_endpoints_legacy(state: &AppState) -> Vec<(String, Provider)> {
        [AppType::Codex.as_str(), CHATGPT_DESKTOP_NAMESPACE]
            .iter()
            .map(|namespace| {
                let mut provider = managed_codex_provider_for_namespace(state, namespace)
                    .unwrap()
                    .unwrap();
                let config = provider.settings_config["config"]
                    .as_str()
                    .unwrap()
                    .replace(BASE_URL, "https://cn.meta-api.vip");
                provider.settings_config["config"] = json!(config);
                state.db.save_provider(namespace, &provider).unwrap();
                (namespace.to_string(), provider)
            })
            .collect()
    }

    #[tokio::test]
    #[serial]
    async fn legacy_routes_migrate_on_explicit_mode_switch_without_changing_identity() {
        use crate::proxy::providers::get_adapter;
        for official_first in [true, false] {
            let (_home, state) = isolated_state();
            prepare_managed_codex_mode(&state, true);
            if official_first {
                switch_codex_account_mode_at_origin(
                    &state,
                    "official",
                    Some("yuanheng"),
                    "http://127.0.0.1:15721",
                )
                .unwrap();
            }
            let originals = make_codex_endpoints_legacy(&state);
            // Reuse a router instantiated before migration, as a running Core
            // would: new requests must read the updated provider from the DB.
            let router = crate::proxy::ProviderRouter::new(state.db.clone());
            assert!(
                yuanheng_codex_mode_available(&state),
                "valid CN keys must not disable switching"
            );
            let auth = std::fs::read(crate::codex_config::get_codex_auth_path()).unwrap();
            switch_codex_account_mode_at_origin(
                &state,
                "yuanheng",
                Some(if official_first {
                    "official"
                } else {
                    "yuanheng"
                }),
                "http://127.0.0.1:15721",
            )
            .unwrap();
            for (namespace, original) in originals {
                let actual = managed_codex_provider_for_namespace(&state, &namespace)
                    .unwrap()
                    .unwrap();
                let mut expected = original.clone();
                migrate_codex_provider_endpoint(&mut expected).unwrap();
                assert_eq!(
                    serde_json::to_value(&actual).unwrap(),
                    serde_json::to_value(&expected).unwrap()
                );
                let adapter = get_adapter(&AppType::Codex);
                assert_eq!(adapter.extract_base_url(&actual).unwrap(), OPENAI_BASE_URL);
                let selected = router.select_providers(&namespace).await.unwrap();
                assert_eq!(
                    adapter.extract_base_url(&selected[0]).unwrap(),
                    OPENAI_BASE_URL
                );
                assert_eq!(
                    adapter.extract_auth(&actual).unwrap().api_key,
                    adapter.extract_auth(&original).unwrap().api_key
                );
                assert!(provider_has_credentials(&actual, &AppType::Codex));
            }
            assert_eq!(
                std::fs::read(crate::codex_config::get_codex_auth_path()).unwrap(),
                auth
            );
            assert!(crate::codex_config::read_codex_config_text()
                .unwrap()
                .contains("/chatgpt-desktop/v1"));
            assert!(std::fs::read_to_string(codex_terminal_profile_path())
                .unwrap()
                .contains("/codex/v1"));
        }
    }

    #[test]
    #[serial]
    fn failed_switch_restores_legacy_database_records_and_files() {
        let (_home, state) = isolated_state();
        prepare_managed_codex_mode(&state, true);
        switch_codex_account_mode_at_origin(
            &state,
            "official",
            Some("yuanheng"),
            "http://127.0.0.1:15721",
        )
        .unwrap();
        let originals = make_codex_endpoints_legacy(&state);
        let live = crate::codex_config::read_codex_config_text().unwrap();
        // Deterministic IO failure: terminal catalog target is a directory.
        let catalog = crate::codex_config::get_codex_named_model_catalog_path(
            crate::codex_config::YUANHENG_TERMINAL_MODEL_CATALOG_FILENAME,
        );
        if catalog.is_file() {
            std::fs::remove_file(&catalog).unwrap();
        }
        std::fs::create_dir_all(&catalog).unwrap();
        let result = switch_codex_account_mode_at_origin(
            &state,
            "yuanheng",
            Some("official"),
            "http://127.0.0.1:15721",
        );
        assert!(result.is_err());
        for (namespace, original) in originals {
            let actual = managed_codex_provider_for_namespace(&state, &namespace)
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::to_value(original).unwrap()
            );
        }
        assert_eq!(crate::codex_config::read_codex_config_text().unwrap(), live);
        assert_eq!(
            codex_account_mode_status_inner(&state).unwrap().mode,
            "official"
        );
    }

    #[test]
    fn codex_endpoint_migration_is_narrow_and_idempotent() {
        let mut provider =
            managed_provider(&AppType::Codex, "sk-private", "test-model", "vip", "high").unwrap();
        let text = provider.settings_config["config"]
            .as_str()
            .unwrap()
            .replace(BASE_URL, "https://cn.meta-api.vip");
        provider.settings_config["config"] = json!(format!(
            "{text}\n[model_providers.personal]\nbase_url = \"https://example.test/v1\"\n"
        ));
        let original = provider.clone();
        migrate_codex_provider_endpoint(&mut provider).unwrap();
        assert_eq!(provider_group(&original), provider_group(&provider));
        assert_eq!(
            provider_model(&original, &AppType::Codex),
            provider_model(&provider, &AppType::Codex)
        );
        let once = serde_json::to_value(&provider).unwrap();
        migrate_codex_provider_endpoint(&mut provider).unwrap();
        assert_eq!(serde_json::to_value(&provider).unwrap(), once);
        assert!(provider.settings_config["config"]
            .as_str()
            .unwrap()
            .contains("https://example.test/v1"));
        for endpoint in [
            "https://cn.meta-api.vip.evil.test/v1",
            "https://example.test/v1",
        ] {
            let mut external = original.clone();
            external.settings_config["config"] =
                json!(text.replace("https://cn.meta-api.vip/v1", endpoint));
            let before = serde_json::to_value(&external).unwrap();
            migrate_codex_provider_endpoint(&mut external).unwrap();
            assert_eq!(serde_json::to_value(external).unwrap(), before);
        }
    }

    #[test]
    #[serial]
    fn codex_account_mode_repairs_same_mode_without_changing_model_or_history() {
        let (_home, state) = isolated_state();
        prepare_managed_codex_mode(&state, true);
        switch_codex_account_mode_at_origin(
            &state,
            "official",
            Some("yuanheng"),
            "http://127.0.0.1:15721",
        )
        .unwrap();
        let auth = std::fs::read(crate::codex_config::get_codex_auth_path()).unwrap();
        let sessions = crate::codex_config::get_codex_config_dir().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let history_path = sessions.join("legacy.jsonl");
        let history = "{\"type\":\"session_meta\",\"payload\":{\"model_provider\":\"yuanheng\"}}\n";
        std::fs::write(&history_path, history).unwrap();
        let path = crate::codex_config::get_codex_config_path();
        let mut doc = std::fs::read_to_string(&path)
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        doc["model"] = toml_edit::value("gpt-existing-selection");
        doc["model_providers"]
            .as_table_mut()
            .unwrap()
            .remove("custom");
        doc["model_providers"]
            .as_table_mut()
            .unwrap()
            .remove("yuanheng");
        // Simulate a config produced by the old application, bypassing new writers.
        std::fs::write(&path, doc.to_string()).unwrap();
        assert!(
            codex_account_mode_status_inner(&state)
                .unwrap()
                .history_repair_needed
        );
        let repaired = switch_codex_account_mode_at_origin(
            &state,
            "official",
            Some("official"),
            "http://127.0.0.1:18888",
        )
        .unwrap();
        assert!(repaired.restart_required);
        assert!(!repaired.history_repair_needed);
        let live = std::fs::read_to_string(&path).unwrap();
        let parsed: toml::Value = toml::from_str(&live).unwrap();
        assert_eq!(parsed["model"].as_str(), Some("gpt-existing-selection"));
        assert_eq!(
            parsed["model_providers"]["custom"]["base_url"].as_str(),
            Some("http://127.0.0.1:18888/v1")
        );
        assert_eq!(std::fs::read_to_string(&history_path).unwrap(), history);
        assert_eq!(
            std::fs::read(crate::codex_config::get_codex_auth_path()).unwrap(),
            auth
        );
        let backups = crate::config::get_app_config_dir().join("backups/codex-history-routes");
        let backup_count = std::fs::read_dir(&backups).unwrap().count();
        assert!(std::fs::read_dir(&backups)
            .unwrap()
            .any(
                |entry| std::fs::read_to_string(entry.unwrap().path()).unwrap() == doc.to_string()
            ));
        let unchanged = switch_codex_account_mode_at_origin(
            &state,
            "official",
            Some("official"),
            "http://127.0.0.1:18888",
        )
        .unwrap();
        assert!(!unchanged.restart_required);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), live);
        assert_eq!(std::fs::read_dir(backups).unwrap().count(), backup_count);
    }

    #[test]
    #[serial]
    fn codex_account_mode_keeps_files_and_mode_when_history_backup_fails() {
        let (_home, state) = isolated_state();
        prepare_managed_codex_mode(&state, true);
        let before = capture_codex_mode_switch_snapshot(&state).unwrap();
        let auth = std::fs::read(crate::codex_config::get_codex_auth_path()).unwrap();
        let backup = crate::config::get_app_config_dir().join("backups/codex-history-routes");
        std::fs::create_dir_all(backup.parent().unwrap()).unwrap();
        std::fs::write(&backup, "simulate unavailable backup directory").unwrap();
        assert!(switch_codex_account_mode_at_origin(
            &state,
            "official",
            Some("yuanheng"),
            "http://127.0.0.1:15721"
        )
        .is_err());
        let after = capture_codex_mode_switch_snapshot(&state).unwrap();
        assert_eq!(after.live_config, before.live_config);
        assert_eq!(after.terminal_profile, before.terminal_profile);
        assert_eq!(after.database_current, before.database_current);
        assert_eq!(after.local_current, before.local_current);
        assert_eq!(
            std::fs::read(crate::codex_config::get_codex_auth_path()).unwrap(),
            auth
        );
    }

    #[test]
    #[serial]
    fn codex_account_mode_repairs_missing_active_official_definition() {
        let (_home, state) = isolated_state();
        prepare_managed_codex_mode(&state, true);
        switch_codex_account_mode_at_origin(
            &state,
            "official",
            Some("yuanheng"),
            "http://127.0.0.1:15721",
        )
        .unwrap();
        std::fs::write(
            crate::codex_config::get_codex_config_path(),
            "model_provider = \"yuanheng-switch-official\"\nmodel = \"gpt-existing\"\n",
        )
        .unwrap();
        let fixed = switch_codex_account_mode_at_origin(
            &state,
            "official",
            Some("official"),
            "http://127.0.0.1:15721",
        )
        .unwrap();
        assert!(fixed.restart_required);
        assert!(!fixed.history_repair_needed);
    }

    #[test]
    #[serial]
    fn codex_account_mode_rejects_official_without_oauth_and_keeps_managed_state() {
        let (_home, state) = isolated_state();
        prepare_managed_codex_mode(&state, false);
        let live_before = crate::codex_config::read_codex_config_text().unwrap();
        let profile_before = std::fs::read_to_string(codex_terminal_profile_path()).unwrap();

        let error = switch_codex_account_mode_at_origin(
            &state,
            "official",
            Some("yuanheng"),
            "http://127.0.0.1:15721",
        )
        .expect_err("没有 OAuth 时必须拒绝切换");

        assert!(error.contains("未检测到 OpenAI 官方登录"));
        assert_eq!(
            crate::codex_config::read_codex_config_text().unwrap(),
            live_before
        );
        assert_eq!(
            std::fs::read_to_string(codex_terminal_profile_path()).unwrap(),
            profile_before
        );
        assert_eq!(
            ProviderService::current(&state, AppType::Codex).unwrap(),
            MANAGED_PROVIDER_ID
        );
    }

    #[test]
    #[serial]
    fn codex_account_mode_rejects_external_terminal_profile_changes() {
        let (_home, state) = isolated_state();
        prepare_managed_codex_mode(&state, true);
        crate::config::write_text_file(
            &codex_terminal_profile_path(),
            "model_provider = \"user-custom\"\n",
        )
        .unwrap();
        let live_before = crate::codex_config::read_codex_config_text().unwrap();

        let error = switch_codex_account_mode_at_origin(
            &state,
            "official",
            Some("unknown"),
            "http://127.0.0.1:15721",
        )
        .expect_err("外部配置不能被静默覆盖");

        assert!(error.contains("外部修改"));
        assert_eq!(
            crate::codex_config::read_codex_config_text().unwrap(),
            live_before
        );
        assert_eq!(
            std::fs::read_to_string(codex_terminal_profile_path()).unwrap(),
            "model_provider = \"user-custom\"\n"
        );
    }

    #[tokio::test]
    #[serial]
    async fn activation_loop_uses_exact_codex_surface_and_only_new_requests() {
        let (_home, state) = isolated_state();
        prepare_managed_codex_mode(&state, true);
        remember_tool_configured_at(&state, "codex");
        remember_tool_configured_at(&state, CHATGPT_DESKTOP_NAMESPACE);

        let request =
            |request_id: &str, app_type: &str, status_code: u16| crate::proxy::usage::RequestLog {
                request_id: request_id.to_string(),
                provider_id: MANAGED_PROVIDER_ID.to_string(),
                app_type: app_type.to_string(),
                model: "gpt-5.6-sol".to_string(),
                request_model: "gpt-5.6-sol".to_string(),
                pricing_model: "gpt-5.6-sol".to_string(),
                usage: crate::proxy::usage::TokenUsage {
                    input_tokens: 10,
                    output_tokens: 2,
                    ..Default::default()
                },
                cost: None,
                latency_ms: 20,
                first_token_ms: Some(5),
                status_code,
                error_message: (status_code >= 400).then(|| "test error".to_string()),
                session_id: None,
                provider_type: Some("codex".to_string()),
                is_streaming: true,
                cost_multiplier: "1".to_string(),
            };
        let logger = crate::proxy::usage::UsageLogger::new(state.db.as_ref());
        logger
            .log_request(&request("cli-ok", "codex", 200))
            .unwrap();
        logger
            .log_request(&request("desktop-failed", CHATGPT_DESKTOP_NAMESPACE, 503))
            .unwrap();

        let statuses = yuanheng_tool_activation_statuses_inner(&state)
            .await
            .unwrap();
        let cli = statuses.iter().find(|item| item.app == "codex").unwrap();
        let desktop = statuses
            .iter()
            .find(|item| item.app == CHATGPT_DESKTOP_NAMESPACE)
            .unwrap();
        assert!(cli.request_received);
        assert!(cli.request_succeeded);
        assert_eq!(cli.last_status_code, Some(200));
        assert!(desktop.request_received);
        assert!(!desktop.request_succeeded);
        assert_eq!(desktop.last_status_code, Some(503));
    }

    #[test]
    #[serial]
    fn writing_terminal_surface_does_not_rewrite_codex_app_live_config() {
        let (_home, state) = isolated_state();
        let mut terminal = managed_provider(
            &AppType::Codex,
            "terminal-token",
            "gpt-5.6-sol",
            "premium",
            "high",
        )
        .unwrap();
        terminal.settings_config["yuanhengSurface"] = json!("terminal");
        let mut desktop =
            managed_provider(&AppType::Codex, "desktop-token", "k3", "default", "auto").unwrap();
        desktop.settings_config["yuanhengSurface"] = json!("desktop");
        save_managed_codex_provider(&state, AppType::Codex.as_str(), &terminal).unwrap();
        save_managed_codex_provider(&state, CHATGPT_DESKTOP_NAMESPACE, &desktop).unwrap();

        let original_live = concat!(
            "model_provider = \"official\"\n",
            "model = \"gpt-official\"\n",
            "[model_providers.official]\n",
            "name = \"Official\"\n",
            "base_url = \"https://api.openai.com/v1\"\n",
            "wire_api = \"responses\"\n",
        );
        crate::codex_config::write_codex_live_config_atomic(Some(original_live)).unwrap();
        assert!(!managed_codex_routes_require_core(state.db.as_ref()));

        write_codex_surface_config_at_origin(
            &state,
            CodexSurface::Terminal,
            "http://127.0.0.1:15721",
        )
        .unwrap();

        assert_eq!(
            crate::codex_config::read_codex_config_text().unwrap(),
            original_live
        );
        let terminal_profile = std::fs::read_to_string(codex_terminal_profile_path()).unwrap();
        assert!(terminal_profile.contains("/codex/v1"));
        assert!(!terminal_profile.contains("/chatgpt-desktop/v1"));
        assert!(managed_codex_routes_require_core(state.db.as_ref()));
    }

    #[test]
    #[serial]
    fn writing_desktop_surface_only_updates_codex_app_live_config() {
        let (_home, state) = isolated_state();
        let mut terminal = managed_provider(
            &AppType::Codex,
            "terminal-token",
            "gpt-5.6-sol",
            "premium",
            "high",
        )
        .unwrap();
        terminal.settings_config["yuanhengSurface"] = json!("terminal");
        let mut desktop =
            managed_provider(&AppType::Codex, "desktop-token", "k3", "default", "auto").unwrap();
        desktop.settings_config["yuanhengSurface"] = json!("desktop");
        save_managed_codex_provider(&state, AppType::Codex.as_str(), &terminal).unwrap();
        save_managed_codex_provider(&state, CHATGPT_DESKTOP_NAMESPACE, &desktop).unwrap();
        crate::config::write_text_file(
            &codex_terminal_profile_path(),
            "model_provider = \"terminal-sentinel\"\n",
        )
        .unwrap();
        crate::codex_config::write_codex_live_config_atomic(Some(
            "model_provider = \"official\"\nmodel = \"gpt-official\"\n",
        ))
        .unwrap();
        assert!(!managed_codex_routes_require_core(state.db.as_ref()));

        write_codex_surface_config_at_origin(
            &state,
            CodexSurface::Desktop,
            "http://127.0.0.1:15721",
        )
        .unwrap();

        let live = crate::codex_config::read_codex_config_text().unwrap();
        assert!(live.contains("/chatgpt-desktop/v1"));
        assert!(live.contains("model = \"k3\""));
        assert_eq!(
            std::fs::read_to_string(codex_terminal_profile_path()).unwrap(),
            "model_provider = \"terminal-sentinel\"\n"
        );
        assert!(managed_codex_routes_require_core(state.db.as_ref()));
    }

    #[test]
    #[serial]
    fn legacy_terminal_clone_does_not_claim_codex_app_live_route() {
        let (_home, state) = isolated_state();
        let mut terminal = managed_provider(
            &AppType::Codex,
            "terminal-token",
            "gpt-5.6-sol",
            "premium",
            "high",
        )
        .unwrap();
        terminal.settings_config["yuanhengSurface"] = json!("terminal");
        save_managed_codex_provider(&state, AppType::Codex.as_str(), &terminal).unwrap();
        save_managed_codex_provider(&state, CHATGPT_DESKTOP_NAMESPACE, &terminal).unwrap();
        crate::config::write_text_file(
            &codex_terminal_profile_path(),
            r#"model_provider = "yuanheng"
[model_providers.yuanheng]
base_url = "http://127.0.0.1:15721/codex/v1"
"#,
        )
        .unwrap();
        crate::codex_config::write_codex_live_config_atomic(Some(
            r#"model_provider = "yuanheng"
[model_providers.yuanheng]
base_url = "http://127.0.0.1:15721/chatgpt-desktop/v1"
"#,
        ))
        .unwrap();

        assert!(managed_codex_routes_require_core(state.db.as_ref()));
        assert!(!managed_chatgpt_desktop_route_active(state.db.as_ref()));
    }

    #[test]
    #[serial]
    fn codex_surface_auto_uses_catalog_default_without_writing_medium() {
        let (_home, _state) = isolated_state();
        let provider =
            managed_provider(&AppType::Codex, "token", "gpt-5.6-sol", "default", "auto").unwrap();
        let catalog = json!({
            "modelCatalog": { "models": [{ "model": "gpt-5.6-sol" }] }
        });
        let config = codex_surface_route_config(
            &provider,
            "http://127.0.0.1:15721/codex/v1",
            &catalog,
            CodexSurface::Terminal,
        )
        .unwrap();
        assert!(!config.contains("model_reasoning_effort"));
        let catalog_path = crate::codex_config::get_codex_named_model_catalog_path(
            crate::codex_config::YUANHENG_TERMINAL_MODEL_CATALOG_FILENAME,
        );
        let generated: Value = serde_json::from_str(
            &std::fs::read_to_string(catalog_path).expect("terminal catalog should exist"),
        )
        .unwrap();
        assert_eq!(generated["models"][0]["default_reasoning_level"], "low");
    }

    #[test]
    #[serial]
    fn codex_mixed_catalog_does_not_pin_initial_models_reasoning_level() {
        let (_home, _state) = isolated_state();
        let provider = managed_provider_with_models(
            &AppType::Codex,
            "token",
            "gpt-5.6-sol",
            &["gpt-5.6-sol".to_string(), "deepseek-v4-pro".to_string()],
            "default",
            "xhigh",
        )
        .unwrap();
        let catalog = codex_provider_catalog_settings(&provider);
        let config = codex_surface_route_config(
            &provider,
            "http://127.0.0.1:15721/codex/v1",
            &catalog,
            CodexSurface::Terminal,
        )
        .unwrap();

        assert!(!config.contains("model_reasoning_effort"));
    }

    #[test]
    #[serial]
    fn removes_owned_codex_surface_artifacts() {
        let (_home, state) = isolated_state();
        let desktop = managed_provider(&AppType::Codex, "token", "k3", "default", "high").unwrap();
        save_managed_codex_provider(&state, CHATGPT_DESKTOP_NAMESPACE, &desktop).unwrap();
        crate::config::write_text_file(
            &codex_terminal_profile_path(),
            "model_provider = \"yuanheng\"\nbase_url = \"http://127.0.0.1:15721/codex/v1\"\n",
        )
        .unwrap();

        assert!(remove_codex_surface_artifacts(&state).unwrap());
        assert!(
            managed_codex_provider_for_namespace(&state, CHATGPT_DESKTOP_NAMESPACE)
                .unwrap()
                .is_none()
        );
        assert!(!codex_terminal_profile_path().exists());
    }

    #[tokio::test]
    #[serial]
    async fn diagnostics_guides_disconnected_users_to_login() {
        let (_home, state) = isolated_state();

        let report = diagnose_yuanheng_inner(&state).await.unwrap();

        assert_eq!(report.status, "error");
        assert_eq!(report.ready_tools, 0);
        assert_eq!(report.checks.len(), 1);
        assert_eq!(report.checks[0].id, "connection");
        assert_eq!(report.checks[0].action.as_deref(), Some("login"));
    }

    #[test]
    #[serial]
    fn disconnect_restores_previous_exclusive_tool_config() {
        let (_home, state) = isolated_state();
        let previous = Provider::with_id(
            "previous".to_string(),
            "原配置".to_string(),
            json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "old-token",
                    "ANTHROPIC_BASE_URL": "https://api.example.com",
                    "ANTHROPIC_MODEL": "claude-old"
                }
            }),
            None,
        );
        ProviderService::add(&state, AppType::Claude, previous, true).unwrap();
        configure_tool(
            &state,
            AppType::Claude,
            "yuanheng-token",
            &["claude-sonnet-4-6".to_string()],
            None,
            "default",
            "auto",
        )
        .unwrap();

        let result = disconnect_yuanheng_inner(&state).unwrap();

        assert_eq!(result.restored_tools, vec!["claude"]);
        assert!(result.retained_tools.is_empty());
        assert_eq!(
            ProviderService::current(&state, AppType::Claude).unwrap(),
            "previous"
        );
        assert!(!ProviderService::list(&state, AppType::Claude)
            .unwrap()
            .contains_key(MANAGED_PROVIDER_ID));
        let live = std::fs::read_to_string(crate::config::get_claude_settings_path()).unwrap();
        assert!(live.contains("old-token"));
        assert!(!live.contains("yuanheng-token"));
    }

    #[test]
    #[serial]
    fn disconnect_removes_additive_tool_credentials() {
        let (_home, state) = isolated_state();
        configure_tool(
            &state,
            AppType::OpenCode,
            "yuanheng-token",
            &["gpt-5.6".to_string()],
            None,
            "default",
            "auto",
        )
        .unwrap();

        let result = disconnect_yuanheng_inner(&state).unwrap();

        assert!(result.removed_tools.contains(&"opencode".to_string()));
        assert!(!ProviderService::list(&state, AppType::OpenCode)
            .unwrap()
            .contains_key(MANAGED_PROVIDER_ID));
        let live =
            std::fs::read_to_string(crate::opencode_config::get_opencode_config_path()).unwrap();
        assert!(!live.contains("yuanheng-token"));
        assert!(!live.contains(MANAGED_PROVIDER_ID));
    }

    #[test]
    #[serial]
    fn disconnect_restores_hermes_model_selection() {
        let (_home, state) = isolated_state();
        let previous = crate::hermes_config::HermesModelConfig {
            default: Some("old-model".to_string()),
            provider: Some("old-provider".to_string()),
            ..Default::default()
        };
        crate::hermes_config::set_model_config(&previous).unwrap();
        configure_tool(
            &state,
            AppType::Hermes,
            "yuanheng-token",
            &["gpt-5.6".to_string()],
            None,
            "default",
            "auto",
        )
        .unwrap();

        let result = disconnect_yuanheng_inner(&state).unwrap();
        let restored = crate::hermes_config::get_model_config().unwrap().unwrap();

        assert!(result.removed_tools.contains(&"hermes".to_string()));
        assert_eq!(restored.provider.as_deref(), Some("old-provider"));
        assert_eq!(restored.default.as_deref(), Some("old-model"));
        let live = std::fs::read_to_string(crate::hermes_config::get_hermes_config_path()).unwrap();
        assert!(!live.contains("yuanheng-token"));
    }

    #[test]
    #[serial]
    fn workbuddy_config_uses_chat_endpoint_and_restores_previous_file() {
        let (_home, state) = isolated_state();
        let path = workbuddy_config_path();
        crate::config::write_text_file(&path, r#"{"models":[],"availableModels":[]}"#).unwrap();

        let configured = configure_workbuddy(
            &state,
            "yuanheng-token",
            "k3",
            &["k3".to_string(), "gpt-5.6-sol".to_string()],
            "vip",
        )
        .unwrap();
        assert!(configured.configured);
        let live = read_workbuddy_config().unwrap();
        assert_eq!(
            live.pointer("/models/0/url").and_then(Value::as_str),
            Some("https://meta-api.vip/v1/chat/completions")
        );
        assert!(workbuddy_config_matches(&live, "k3"));
        assert!(workbuddy_config_matches(&live, "gpt-5.6-sol"));
        assert_eq!(live["models"].as_array().unwrap().len(), 2);
        assert!(live["models"].as_array().unwrap().iter().all(|model| {
            model.get("vendor").and_then(Value::as_str) == Some(MANAGED_PROVIDER_DISPLAY_NAME)
        }));
        assert!(!live.to_string().contains("元衡"));
        let mut legacy_vendor = live.clone();
        legacy_vendor["models"][0]["vendor"] = json!("元衡");
        assert!(!workbuddy_config_matches(&legacy_vendor, "k3"));
        let connection = YuanhengConnectionStatus {
            models: vec!["k3".to_string(), "gpt-5.6-sol".to_string()],
            terminal_models: vec!["k3".to_string(), "gpt-5.6-sol".to_string()],
            model_groups: HashMap::from([
                ("k3".to_string(), vec!["vip".to_string()]),
                ("gpt-5.6-sol".to_string(), vec!["vip".to_string()]),
            ]),
            ..YuanhengConnectionStatus::default()
        };
        let status = workbuddy_status(&state, &connection);
        assert!(status.configured);
        assert_eq!(status.group.as_deref(), Some("vip"));

        let result = disconnect_yuanheng_inner(&state).unwrap();
        assert!(result.restored_tools.contains(&"workbuddy".to_string()));
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            r#"{"models":[],"availableModels":[]}"#
        );
    }
}
