use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

struct Pending {
    id: String,
    request: String,
    verifier: String,
    expires: Instant,
    next_poll: Instant,
    busy: bool,
}
#[derive(Default)]
struct Slot {
    generation: u64,
    pending: Option<Pending>,
}
static SLOT: OnceLock<Mutex<Slot>> = OnceLock::new();
fn slot() -> &'static Mutex<Slot> {
    SLOT.get_or_init(|| Mutex::new(Slot::default()))
}
pub(super) fn invalidate() {
    if let Ok(mut s) = slot().lock() {
        s.generation = s.generation.wrapping_add(1);
        s.pending = None;
    }
}
fn valid(s: &str) -> bool {
    URL_SAFE_NO_PAD
        .decode(s)
        .is_ok_and(|b| b.len() == 32 && URL_SAFE_NO_PAD.encode(b) == s)
}
fn verifier() -> String {
    let mut b = Vec::new();
    b.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    b.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(b)
}
fn challenge(s: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(s.as_bytes()))
}
const UNAVAILABLE: &str =
    "网站尚未开放客户端浏览器登录，或服务暂不可用；请稍后重试，现有密码登录不受影响";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLoginStart {
    attempt_id: String,
    display_code: String,
    expires_in: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLoginPoll {
    status: String,
    connection: Option<YuanhengConnectionStatus>,
}

async fn request(
    client: &reqwest::Client,
    path: &str,
    body: Option<Value>,
) -> Result<(Value, HeaderMap), String> {
    request_at(client, BASE_URL, path, body).await
}
async fn request_at(
    client: &reqwest::Client,
    origin: &str,
    path: &str,
    body: Option<Value>,
) -> Result<(Value, HeaderMap), String> {
    let url = format!("{origin}/api/desktop-auth/{path}");
    let req = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    let mut response = req
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| UNAVAILABLE)?;
    if !response.status().is_success() {
        return Err(if response.status().as_u16() == 410 {
            "授权已失效或被拒绝，请重新发起登录"
        } else {
            UNAVAILABLE
        }
        .into());
    }
    let headers = response.headers().clone();
    if response.content_length().is_some_and(|n| n > 65536) {
        return Err(UNAVAILABLE.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        if bytes.len() + chunk.len() > 65536 {
            return Err(UNAVAILABLE.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    if value["success"] != true {
        return Err(UNAVAILABLE.into());
    }
    Ok((value, headers))
}

#[tauri::command]
pub async fn get_yuanheng_browser_login_providers() -> Result<Vec<String>, String> {
    let (v, _) = request(&yuanheng_client()?, "capabilities", None).await?;
    if v["data"]["protocol_version"] != 1 {
        return Err(UNAVAILABLE.into());
    }
    Ok(v["data"]["providers"]
        .as_array()
        .ok_or(UNAVAILABLE)?
        .iter()
        .filter_map(Value::as_str)
        .filter(|p| ["github", "google"].contains(p))
        .map(str::to_string)
        .collect())
}
#[tauri::command]
pub async fn start_yuanheng_browser_login(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
) -> Result<BrowserLoginStart, String> {
    if !["github", "google"].contains(&provider.as_str()) {
        return Err("不支持的登录方式".into());
    }
    if read_cached_status(&state)?.connected {
        return Err("请先退出当前元衡账号".into());
    }
    let generation = {
        let mut s = slot().lock().map_err(|_| "登录状态不可用")?;
        s.generation = s.generation.wrapping_add(1);
        s.pending = None;
        s.generation
    };
    let proof = verifier();
    let client = yuanheng_client()?;
    let (v, _) = request(
        &client,
        "start",
        Some(json!({"provider":provider,"challenge":challenge(&proof)})),
    )
    .await?;
    let request_id = v["data"]["request_id"]
        .as_str()
        .filter(|s| valid(s))
        .ok_or(UNAVAILABLE)?
        .to_string();
    let code = v["data"]["display_code"]
        .as_str()
        .filter(|s| s.len() == 8 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or(UNAVAILABLE)?
        .to_string();
    if v["data"]["expires_in"] != 300 {
        return Err(UNAVAILABLE.into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut s = slot().lock().map_err(|_| "登录状态不可用")?;
        if s.generation != generation || read_cached_status(&state)?.connected {
            return Err("登录已取消或账号已变化".into());
        }
        s.pending = Some(Pending {
            id: id.clone(),
            request: request_id.clone(),
            verifier: proof,
            expires: Instant::now() + Duration::from_secs(300),
            next_poll: Instant::now(),
            busy: false,
        });
    }
    let url = format!("{BASE_URL}/desktop-login?request_id={request_id}");
    if app.opener().open_url(&url, None::<String>).is_err() {
        invalidate();
        return Err("无法打开系统浏览器，请检查默认浏览器后重试".into());
    }
    Ok(BrowserLoginStart {
        attempt_id: id,
        display_code: code,
        expires_in: 300,
    })
}

#[tauri::command]
pub fn cancel_yuanheng_browser_login(attempt_id: Option<String>) -> Result<(), String> {
    let mut s = slot().lock().map_err(|_| "登录状态不可用")?;
    if attempt_id.is_none()
        || s.pending
            .as_ref()
            .is_some_and(|p| Some(&p.id) == attempt_id.as_ref())
    {
        s.generation = s.generation.wrapping_add(1);
        s.pending = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn poll_yuanheng_browser_login(
    state: State<'_, AppState>,
    attempt_id: String,
) -> Result<BrowserLoginPoll, String> {
    let waiting = || BrowserLoginPoll {
        status: "pending".into(),
        connection: None,
    };
    let (generation, request_id, proof) = {
        let mut s = slot().lock().map_err(|_| "登录状态不可用")?;
        let generation = s.generation;
        let p = s
            .pending
            .as_mut()
            .filter(|p| p.id == attempt_id)
            .ok_or("登录已取消或已结束")?;
        if Instant::now() >= p.expires {
            s.pending = None;
            return Err("授权已过期，请重新发起".into());
        }
        if p.busy || Instant::now() < p.next_poll {
            return Ok(waiting());
        }
        p.busy = true;
        p.next_poll = Instant::now() + Duration::from_secs(3);
        (generation, p.request.clone(), p.verifier.clone())
    };
    let result = async {
        let client = yuanheng_client()?;
        let (v, headers) = request(
            &client,
            "exchange",
            Some(json!({"request_id":request_id,"verifier":proof})),
        )
        .await?;
        if v["data"]["status"].as_str() == Some("pending") {
            return Ok(None);
        }
        let uid = v["data"]["id"]
            .as_i64()
            .filter(|n| *n > 0)
            .ok_or(UNAVAILABLE)?
            .to_string();
        let cookie = extract_cookie(&headers, "session").ok_or(UNAVAILABLE)?;
        let connection = sync_connection(&state, &client, &cookie, &uid).await?;
        Ok::<_, String>(Some((cookie, uid, connection)))
    }
    .await;
    finish_poll(&state, generation, &attempt_id, result)
}

type LoginResponse = Result<Option<(String, String, YuanhengConnectionStatus)>, String>;
fn finish_poll(
    state: &AppState,
    generation: u64,
    attempt_id: &str,
    result: LoginResponse,
) -> Result<BrowserLoginPoll, String> {
    let mut s = slot().lock().map_err(|_| "登录状态不可用")?;
    if s.generation != generation
        || s.pending.as_ref().is_none_or(|p| p.id != attempt_id)
        || read_cached_status(state)?.connected
    {
        return Err("登录已取消或账号已变化，未覆盖现有登录".into());
    }
    if s.pending
        .as_ref()
        .is_some_and(|p| Instant::now() >= p.expires)
    {
        s.pending = None;
        return Err("授权已过期，请重新发起".into());
    }
    match result {
        Ok(None) => {
            s.pending.as_mut().unwrap().busy = false;
            Ok(BrowserLoginPoll {
                status: "pending".into(),
                connection: None,
            })
        }
        Ok(Some((cookie, uid, connection))) => {
            s.pending = None;
            if connection.user_id.as_deref() != Some(uid.as_str()) {
                return Err("授权账号响应不一致，请重新登录".into());
            }
            persist_connection_for_group(state, &cookie, &uid, "", 0, &connection, "")?;
            Ok(BrowserLoginPoll {
                status: "complete".into(),
                connection: Some(read_cached_status(state)?),
            })
        }
        Err(error) => {
            s.pending = None;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pending(id: &str, expired: bool) -> u64 {
        let mut s = slot().lock().unwrap();
        s.generation += 1;
        s.pending = Some(Pending {
            id: id.into(),
            request: verifier(),
            verifier: verifier(),
            expires: if expired {
                Instant::now() - Duration::from_secs(1)
            } else {
                Instant::now() + Duration::from_secs(60)
            },
            next_poll: Instant::now(),
            busy: true,
        });
        s.generation
    }
    fn login_response() -> LoginResponse {
        Ok(Some((
            "session=synthetic-cookie".into(),
            "42".into(),
            YuanhengConnectionStatus {
                connected: true,
                user_id: Some("42".into()),
                ..Default::default()
            },
        )))
    }
    #[test]
    #[serial_test::serial]
    fn final_commit_rejects_cancel_expiry_replaced_attempt_and_existing_account() {
        for mode in ["cancel", "expired", "replacement", "existing"] {
            crate::secure_storage::clear_for_tests();
            let (_home, state) = super::super::tests::isolated_state();
            let generation = pending("attempt", mode == "expired");
            match mode {
                "cancel" => invalidate(),
                "replacement" => {
                    pending("replacement", false);
                }
                "existing" => {
                    let status = YuanhengConnectionStatus {
                        connected: true,
                        user_id: Some("99".into()),
                        ..Default::default()
                    };
                    persist_connection_for_group(&state, "session=other", "99", "", 0, &status, "")
                        .unwrap();
                }
                _ => {}
            }
            assert!(finish_poll(&state, generation, "attempt", login_response()).is_err());
            assert_ne!(
                get_yuanheng_secret(&state, USER_ID_KEY).unwrap().as_deref(),
                Some("42")
            );
            if mode == "existing" {
                assert_eq!(
                    read_cached_status(&state).unwrap().user_id.as_deref(),
                    Some("99")
                );
            }
            invalidate();
        }
    }
    #[test]
    #[serial_test::serial]
    fn final_commit_persists_once_and_pending_never_logs_in() {
        crate::secure_storage::clear_for_tests();
        let (_home, state) = super::super::tests::isolated_state();
        let generation = pending("attempt", false);
        assert_eq!(
            finish_poll(&state, generation, "attempt", Ok(None))
                .unwrap()
                .status,
            "pending"
        );
        assert!(!read_cached_status(&state).unwrap().connected);
        let result = finish_poll(&state, generation, "attempt", login_response()).unwrap();
        assert_eq!(result.status, "complete");
        assert_eq!(result.connection.unwrap().user_id.as_deref(), Some("42"));
        assert!(finish_poll(&state, generation, "attempt", login_response()).is_err());
        assert!(state.db.get_setting(SESSION_COOKIE_KEY).unwrap().is_none());
        invalidate();
    }
    #[test]
    fn proof_and_challenge_are_fixed_length_and_not_interchangeable() {
        let v = verifier();
        assert!(valid(&v));
        assert!(valid(&challenge(&v)));
        assert_ne!(v, challenge(&v));
        assert!(!valid("https://attacker"));
        assert!(!valid(&(v + "=")));
    }
    #[test]
    #[serial_test::serial]
    fn cancel_is_attempt_scoped_and_invalidates_late_results() {
        invalidate();
        let generation = {
            let mut s = slot().lock().unwrap();
            s.pending = Some(Pending {
                id: "current".into(),
                request: verifier(),
                verifier: verifier(),
                expires: Instant::now() + Duration::from_secs(300),
                next_poll: Instant::now(),
                busy: true,
            });
            s.generation
        };
        cancel_yuanheng_browser_login(Some("old".into())).unwrap();
        assert_eq!(slot().lock().unwrap().generation, generation);
        cancel_yuanheng_browser_login(Some("current".into())).unwrap();
        let s = slot().lock().unwrap();
        assert!(s.pending.is_none());
        assert_ne!(s.generation, generation);
    }
    #[tokio::test]
    async fn http_errors_do_not_echo_secrets_and_large_or_malformed_bodies_fail() {
        use axum::{routing::get, Router};
        for (status, body) in [
            (403, "secret-from-server".into()),
            (200, "not json".into()),
            (200, "x".repeat(65537)),
            (
                200,
                r#"{"success":false,"message":"secret-from-server"}"#.into(),
            ),
        ] {
            let app =
                Router::new().route(
                    "/api/desktop-auth/capabilities",
                    get(move || async move {
                        (axum::http::StatusCode::from_u16(status).unwrap(), body)
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let c = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .build()
                .unwrap();
            let result = request_at(&c, &origin, "capabilities", None).await;
            task.abort();
            let _ = task.await;
            let error = result.unwrap_err();
            assert!(!error.contains("secret-from-server"));
        }
    }
}
