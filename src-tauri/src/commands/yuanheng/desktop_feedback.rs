use super::{
    get_yuanheng_secret, read_cached_status, with_session, yuanheng_client, AppState, BASE_URL,
    SESSION_COOKIE_KEY, USER_ID_KEY,
};
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024;
const ACCOUNT_CHANGED: &str = "账号已切换，请关闭反馈窗口后重新提交";
const LOGIN_REQUIRED: &str = "请先登录元衡账号，再提交问题反馈";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopFeedbackContext {
    pub view: String,
    pub tool: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopFeedbackError {
    pub occurred_at: String,
    pub source: String,
    pub message: String,
}

/// The renderer supplies only the content the user has previewed. Credentials,
/// destination, version and platform are owned by this command, never by input.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopFeedbackRequest {
    pub report_id: String,
    pub description: String,
    pub context: DesktopFeedbackContext,
    pub errors: Vec<DesktopFeedbackError>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopFeedbackStatus {
    Pending,
    InProgress,
    Resolved,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopFeedbackReceipt {
    pub id: i64,
    pub status: DesktopFeedbackStatus,
    pub created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackDocument<'a> {
    #[serde(flatten)]
    request: &'a DesktopFeedbackRequest,
    app_version: &'static str,
    platform: &'static str,
}

struct FeedbackSession {
    user_id: String,
    cookie: String,
}

fn valid_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn valid_text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= limit
        && !value
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
}

fn encode_document(request: &DesktopFeedbackRequest) -> Result<Vec<u8>, String> {
    if request.report_id.len() != 36 || uuid::Uuid::parse_str(&request.report_id).is_err() {
        return Err("反馈编号无效，请重新打开反馈窗口".into());
    }
    if !valid_text(&request.description, 4000) {
        return Err("请填写 1 到 4000 字的问题描述".into());
    }
    if !valid_label(&request.context.view) || !valid_label(&request.context.tool) {
        return Err("反馈来源无效，请重新打开反馈窗口".into());
    }
    if request.errors.len() > 10 {
        return Err("一次最多提交 10 条错误记录".into());
    }
    for error in &request.errors {
        if !valid_label(&error.source)
            || !valid_text(&error.message, 2000)
            || error.occurred_at.len() > 64
            || chrono::DateTime::parse_from_rfc3339(&error.occurred_at).is_err()
        {
            return Err("错误记录格式无效，请重新选择报错后提交".into());
        }
    }
    let platform = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        _ => "unknown",
    };
    let bytes = serde_json::to_vec(&FeedbackDocument {
        request,
        app_version: env!("CARGO_PKG_VERSION"),
        platform,
    })
    .map_err(|_| "无法生成反馈内容")?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("反馈内容过长，请减少错误记录后重试".into());
    }
    Ok(bytes)
}

fn feedback_session(state: &AppState, expected_user_id: &str) -> Result<FeedbackSession, String> {
    if expected_user_id.is_empty() || expected_user_id.len() > 64 {
        return Err(LOGIN_REQUIRED.into());
    }
    let connection = read_cached_status(state).map_err(|_| LOGIN_REQUIRED)?;
    if !connection.connected {
        return Err(LOGIN_REQUIRED.into());
    }
    let user_id = get_yuanheng_secret(state, USER_ID_KEY)
        .map_err(|_| LOGIN_REQUIRED)?
        .filter(|value| !value.is_empty())
        .ok_or(LOGIN_REQUIRED)?;
    let cookie = get_yuanheng_secret(state, SESSION_COOKIE_KEY)
        .map_err(|_| LOGIN_REQUIRED)?
        .filter(|value| !value.is_empty())
        .ok_or(LOGIN_REQUIRED)?;
    if user_id != expected_user_id || connection.user_id.as_deref() != Some(user_id.as_str()) {
        return Err(ACCOUNT_CHANGED.into());
    }
    let session = FeedbackSession { user_id, cookie };
    ensure_session_current(state, &session)?;
    Ok(session)
}

fn ensure_session_current(state: &AppState, session: &FeedbackSession) -> Result<(), String> {
    if get_yuanheng_secret(state, USER_ID_KEY)
        .map_err(|_| ACCOUNT_CHANGED)?
        .as_deref()
        != Some(session.user_id.as_str())
        || get_yuanheng_secret(state, SESSION_COOKIE_KEY)
            .map_err(|_| ACCOUNT_CHANGED)?
            .as_deref()
            != Some(session.cookie.as_str())
    {
        return Err(ACCOUNT_CHANGED.into());
    }
    Ok(())
}

fn feedback_request(
    client: &reqwest::Client,
    body: Vec<u8>,
    session: &FeedbackSession,
) -> reqwest::RequestBuilder {
    with_session(
        client
            .post(format!("{BASE_URL}/api/user/desktop-feedback"))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("User-Agent", "yuanheng-desktop/0.1")
            .body(body),
        Some(&session.cookie),
        Some(&session.user_id),
    )
}

async fn read_receipt(mut response: reqwest::Response) -> Result<DesktopFeedbackReceipt, String> {
    match response.status().as_u16() {
        401 | 403 => return Err("登录状态已失效，请重新登录后提交反馈".into()),
        404 => return Err("平台暂未开放问题反馈，请稍后重试".into()),
        429 => return Err("反馈提交过于频繁，请稍后重试".into()),
        _ if !response.status().is_success() => {
            return Err("平台暂时无法接收反馈，请稍后重试".into());
        }
        _ => {}
    }
    if response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES as u64 {
        return Err("反馈响应过大，无法确认提交结果；请保留当前反馈后重试".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取反馈结果失败；请保留当前反馈后重试")?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("反馈响应过大，无法确认提交结果；请保留当前反馈后重试".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    #[derive(Deserialize)]
    struct Envelope {
        success: bool,
        data: Option<DesktopFeedbackReceipt>,
    }
    let envelope: Envelope = serde_json::from_slice(&bytes)
        .map_err(|_| "反馈结果格式异常，无法确认提交结果；请保留当前反馈后重试")?;
    if !envelope.success {
        return Err("平台未接收此次反馈，请确认内容后重试".into());
    }
    envelope
        .data
        .filter(|receipt| receipt.id > 0 && receipt.created_at > 0)
        .ok_or_else(|| "反馈结果缺少有效编号，无法确认提交结果；请保留当前反馈后重试".into())
}

/// Explicit, account-bound submission only. No diagnostics or logs are read,
/// no model requests are made, and uncertain results are never auto-replayed.
#[tauri::command]
pub async fn submit_desktop_feedback(
    state: State<'_, AppState>,
    request: DesktopFeedbackRequest,
    expected_user_id: String,
) -> Result<DesktopFeedbackReceipt, String> {
    let body = encode_document(&request)?;
    let session = feedback_session(&state, &expected_user_id)?;
    // Reuse the account client: 15-second timeout and redirects disabled, so
    // credentials are only sent to the fixed first-party endpoint above.
    let client = yuanheng_client().map_err(|_| "无法建立反馈连接，请稍后重试")?;
    ensure_session_current(&state, &session)?;
    let response = feedback_request(&client, body, &session)
        .send()
        .await
        .map_err(|_| "反馈提交未确认，请检查网络并保留当前反馈后重试")?;
    let receipt = read_receipt(response).await?;
    if ensure_session_current(&state, &session).is_err() {
        return Err("反馈已发送，但提交期间账号发生变化；请切回原账号后重试以确认结果".into());
    }
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn request() -> DesktopFeedbackRequest {
        DesktopFeedbackRequest {
            report_id: "2966ba5a-c157-4d12-bf84-331670da09b6".into(),
            description: "刷新模型列表时失败".into(),
            context: DesktopFeedbackContext {
                view: "workspace".into(),
                tool: "dsh".into(),
            },
            errors: vec![DesktopFeedbackError {
                occurred_at: "2026-10-26T09:00:00.000Z".into(),
                source: "toast.error".into(),
                message: "读取账号模型失败".into(),
            }],
        }
    }

    #[test]
    fn validates_unicode_bounds_and_rejects_hidden_fields_or_invalid_metadata() {
        let mut value = request();
        value.description = "错".repeat(4000);
        value.errors[0].message = "误".repeat(2000);
        value.errors = vec![value.errors[0].clone(); 10];
        assert!(encode_document(&value).is_ok());
        value.description.push('错');
        assert!(encode_document(&value).is_err());
        value.description = "valid".into();
        value.errors.push(value.errors[0].clone());
        assert!(encode_document(&value).is_err());
        value.errors.clear();
        assert!(encode_document(&value).is_ok());

        for (field, unexpected) in [
            ("url", json!("https://example.invalid")),
            ("cookie", json!("secret")),
            ("appVersion", json!("fake-version")),
            ("platform", json!("other-platform")),
            ("diagnostics", json!({"rawLog": "private"})),
        ] {
            let mut raw = serde_json::to_value(request()).unwrap();
            raw[field] = unexpected;
            assert!(serde_json::from_value::<DesktopFeedbackRequest>(raw).is_err());
        }
        for invalid in ["", " ", "private/account", "https://example.test", "a b"] {
            let mut value = request();
            value.context.tool = invalid.into();
            assert!(encode_document(&value).is_err());
        }
        let mut value = request();
        value.report_id = "not-a-uuid".into();
        assert!(encode_document(&value).is_err());
        value = request();
        value.errors[0].occurred_at = "yesterday".into();
        assert!(encode_document(&value).is_err());
        value = request();
        value.errors[0].message.push('\0');
        assert!(encode_document(&value).is_err());
    }

    #[test]
    fn fixed_destination_and_auth_headers_do_not_enter_the_previewed_document() {
        let payload = request();
        let body = encode_document(&payload).unwrap();
        let document: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(document["reportId"], payload.report_id);
        assert_eq!(document["appVersion"], env!("CARGO_PKG_VERSION"));
        assert!(["windows", "macos", "linux", "unknown"]
            .contains(&document["platform"].as_str().unwrap()));
        let session = FeedbackSession {
            user_id: "42".into(),
            cookie: "session=synthetic-private-cookie".into(),
        };
        let request = feedback_request(&yuanheng_client().unwrap(), body, &session)
            .build()
            .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.url().as_str(),
            "https://meta-api.vip/api/user/desktop-feedback"
        );
        assert_eq!(request.headers()["New-Api-User"], "42");
        assert_eq!(request.headers()["Cookie"], session.cookie);
        let body = std::str::from_utf8(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert!(!body.contains("synthetic-private-cookie"));
        assert!(!body.contains("expectedUserId"));
        assert!(!body.contains("Authorization"));
    }

    #[test]
    #[serial_test::serial]
    fn requires_current_authenticated_account_and_detects_relogin_or_signout() {
        use super::super::{credential_session, YuanhengConnectionStatus};
        use crate::{database::Database, secure_storage};
        use std::sync::Arc;

        secure_storage::clear_for_tests();
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        assert!(feedback_session(&state, "42").is_err());
        let status = YuanhengConnectionStatus::default();
        credential_session::persist(&state, "session=one", "42", "sk-test", 1, &status).unwrap();
        let session = feedback_session(&state, "42").unwrap();
        assert!(feedback_session(&state, "43").is_err());
        assert!(ensure_session_current(&state, &session).is_ok());
        credential_session::persist(&state, "session=two", "42", "sk-test", 1, &status).unwrap();
        assert!(ensure_session_current(&state, &session).is_err());
        assert!(feedback_session(&state, "42").is_ok());
        credential_session::clear(&state).unwrap();
        assert!(feedback_session(&state, "42").is_err());
        assert!(ensure_session_current(&state, &session).is_err());
        secure_storage::clear_for_tests();
    }

    fn response(body: String, status: u16) -> reqwest::Response {
        axum::http::Response::builder()
            .status(status)
            .body(body)
            .unwrap()
            .into()
    }

    #[tokio::test]
    async fn accepts_only_confirmed_receipts_and_never_echoes_server_error_bodies() {
        let receipt = read_receipt(response(
            json!({"success":true,"data":{"id":12,"status":"pending","createdAt":1793000000}})
                .to_string(),
            200,
        ))
        .await
        .unwrap();
        assert_eq!(receipt.id, 12);
        assert_eq!(receipt.status, DesktopFeedbackStatus::Pending);
        for (body, status) in [
            (
                json!({"success":false,"message":"secret-session-cookie"}).to_string(),
                200,
            ),
            (json!({"success":true}).to_string(), 200),
            (
                json!({"success":true,"data":{"id":0,"status":"pending","createdAt":1}})
                    .to_string(),
                200,
            ),
            (
                json!({"success":true,"data":{"id":1,"status":"unknown","createdAt":1}})
                    .to_string(),
                200,
            ),
            ("secret-session-cookie".into(), 200),
            ("secret-session-cookie".into(), 302),
            ("secret-session-cookie".into(), 401),
            ("secret-session-cookie".into(), 403),
            ("secret-session-cookie".into(), 404),
            ("secret-session-cookie".into(), 429),
            ("secret-session-cookie".into(), 500),
            ("x".repeat(MAX_RESPONSE_BYTES + 1), 200),
        ] {
            let error = read_receipt(response(body, status)).await.unwrap_err();
            assert!(!error.contains("secret-session-cookie"));
        }
    }
}
