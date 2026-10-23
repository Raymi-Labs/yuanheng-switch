mod transport;

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use reqwest::{header, Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_yuanheng_native::NativeExt;
use tokio_util::sync::CancellationToken;
use transport::{api_route, bounded_json, cookie_from_headers, image_credential, image_mime, BASE};

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    cookie: String,
    user_id: i64,
}
#[derive(Default)]
struct LoginState {
    session: Option<Session>,
    pending: Option<String>,
    epoch: u64,
    ai_consent: bool,
}
struct MobileState {
    client: Client,
    login: Mutex<LoginState>,
    auth_lock: tokio::sync::Mutex<()>,
    tasks: Mutex<HashMap<String, CancellationToken>>,
}
impl MobileState {
    fn new() -> Self {
        Self {
            client: Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(20))
                .user_agent("yuanheng-mobile/0.1")
                .build()
                .expect("HTTPS client"),
            login: Mutex::new(LoginState::default()),
            auth_lock: tokio::sync::Mutex::new(()),
            tasks: Mutex::new(HashMap::new()),
        }
    }
    fn snapshot(&self) -> Result<(Session, u64), String> {
        let state = self.login.lock().map_err(|_| "登录状态不可用")?;
        Ok((state.session.clone().ok_or("请先登录")?, state.epoch))
    }
    fn check(&self, epoch: u64) -> Result<(), String> {
        if self.login.lock().map_err(|_| "登录状态不可用")?.epoch == epoch {
            Ok(())
        } else {
            Err("账号已切换，请重新操作".into())
        }
    }
    fn begin_ai(&self, id: &str, epoch: u64) -> Result<CancellationToken, String> {
        let login = self.login.lock().map_err(|_| "登录状态不可用")?;
        if login.session.is_none() || !login.ai_consent || login.epoch != epoch {
            return Err("请先阅读并同意 AI 数据处理说明".into());
        }
        // Hold the same lock as consent withdrawal until the task is registered.
        self.begin(id)
    }
    fn request(&self, method: Method, path: &str, session: &Session) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{BASE}{path}"))
            .header(header::COOKIE, &session.cookie)
            .header("New-Api-User", session.user_id)
            .header(header::ACCEPT, "application/json")
    }
    fn cancel_all(&self) {
        if let Ok(mut tasks) = self.tasks.lock() {
            for (_, task) in tasks.drain() {
                task.cancel();
            }
        }
    }
    fn begin(&self, id: &str) -> Result<CancellationToken, String> {
        if id.len() > 80 || id.is_empty() {
            return Err("任务标识无效".into());
        }
        let mut tasks = self.tasks.lock().map_err(|_| "任务状态不可用")?;
        if tasks.len() >= 2 || tasks.contains_key(id) {
            return Err("已有生成任务，请等待完成或停止后重试".into());
        }
        let token = CancellationToken::new();
        tasks.insert(id.into(), token.clone());
        Ok(token)
    }
}

#[tauri::command]
async fn mobile_restore(app: AppHandle, state: State<'_, MobileState>) -> Result<Value, String> {
    let _lock = state.auth_lock.lock().await;
    let value = app.native().call("readSession", json!({}))?;
    let Some(raw) = value.get("value").and_then(Value::as_str) else {
        return Ok(Value::Null);
    };
    let session: Session =
        serde_json::from_str(raw).map_err(|_| "保存的登录状态无效，请清除后重新登录")?;
    if session.user_id <= 0
        || !session.cookie.starts_with("session=")
        || session.cookie.len() > 8192
    {
        return Err("保存的登录状态无效，请清除后重新登录".into());
    }
    let response = state
        .request(Method::GET, "/api/user/self", &session)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "无法连接元衡，请检查网络后重试")?;
    let account = bounded_json(response, 2 * 1024 * 1024).await?;
    transport::ensure_success(&account)?;
    let mut login = state.login.lock().map_err(|_| "登录状态不可用")?;
    login.session = Some(session);
    login.epoch += 1;
    login.ai_consent = false;
    Ok(account["data"].clone())
}

#[tauri::command]
async fn mobile_login(
    app: AppHandle,
    state: State<'_, MobileState>,
    body: Value,
    two_factor: bool,
) -> Result<Value, String> {
    let _lock = state.auth_lock.lock().await;
    if serde_json::to_vec(&body).map_err(|_| "参数无效")?.len() > 4096 {
        return Err("登录信息过长".into());
    }
    let mut req = state
        .client
        .post(format!(
            "{BASE}/api/user/{}",
            if two_factor { "login/2fa" } else { "login" }
        ))
        .timeout(Duration::from_secs(30))
        .json(&body);
    if two_factor {
        let pending = state
            .login
            .lock()
            .map_err(|_| "登录状态不可用")?
            .pending
            .clone()
            .ok_or("请重新输入账号密码")?;
        req = req.header(header::COOKIE, pending);
    }
    let response = req.send().await.map_err(|_| "无法连接元衡，请稍后重试")?;
    let cookie = cookie_from_headers(response.headers());
    let value = bounded_json(response, 1024 * 1024).await?;
    transport::ensure_success(&value)?;
    let cookie = cookie.ok_or("服务端未返回会话，请重试")?;
    if value.pointer("/data/require_2fa").and_then(Value::as_bool) == Some(true) {
        state.login.lock().map_err(|_| "登录状态不可用")?.pending = Some(cookie);
        return Ok(json!({"requiresTwoFactor": true}));
    }
    let user_id = value
        .pointer("/data/id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or("登录响应缺少用户信息")?;
    let session = Session { cookie, user_id };
    let account = bounded_json(
        state
            .request(Method::GET, "/api/user/self", &session)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "读取账号失败")?,
        2 * 1024 * 1024,
    )
    .await?;
    transport::ensure_success(&account)?;
    app.native().call(
        "writeSession",
        json!({"value": serde_json::to_string(&session).map_err(|_| "会话保存失败")?}),
    )?;
    state.cancel_all();
    let mut login = state.login.lock().map_err(|_| "登录状态不可用")?;
    login.session = Some(session);
    login.pending = None;
    login.epoch += 1;
    login.ai_consent = false;
    Ok(json!({"account": account["data"]}))
}

#[tauri::command]
async fn mobile_logout(app: AppHandle, state: State<'_, MobileState>) -> Result<(), String> {
    let _lock = state.auth_lock.lock().await;
    // Fail visibly if the platform cannot remove the persisted session.
    app.native().call("clearSession", json!({}))?;
    state.cancel_all();
    let mut login = state.login.lock().map_err(|_| "登录状态不可用")?;
    login.session = None;
    login.pending = None;
    login.epoch += 1;
    login.ai_consent = false;
    Ok(())
}

#[tauri::command]
fn mobile_capabilities(app: AppHandle) -> Value {
    json!({"purchases": !cfg!(target_os = "ios"), "version": app.package_info().version.to_string()})
}

#[tauri::command]
async fn mobile_ai_consent(
    state: State<'_, MobileState>,
    accepted: bool,
    user_id: i64,
) -> Result<(), String> {
    let _lock = state.auth_lock.lock().await;
    let mut login = state.login.lock().map_err(|_| "登录状态不可用")?;
    if login.session.as_ref().map(|s| s.user_id) != Some(user_id) {
        return Err("账号已切换，请重新操作".into());
    }
    login.ai_consent = accepted;
    if !accepted {
        state.cancel_all();
    }
    Ok(())
}

#[tauri::command]
async fn mobile_api(
    state: State<'_, MobileState>,
    operation: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let body = body.unwrap_or_else(|| json!({}));
    transport::check_api_access(&operation, cfg!(target_os = "ios"))?;
    let (method, path) = api_route(&operation, &body)?;
    let request = state
        .client
        .request(method.clone(), format!("{BASE}{path}"))
        .timeout(Duration::from_secs(45));
    let (request, epoch) = if operation == "status" {
        (request, None)
    } else {
        let (session, epoch) = state.snapshot()?;
        (
            request
                .header(header::COOKIE, session.cookie)
                .header("New-Api-User", session.user_id),
            Some(epoch),
        )
    };
    let request = if method == Method::GET {
        request
    } else {
        request.json(&body)
    };
    let response = request
        .send()
        .await
        .map_err(|_| "网络请求失败，请检查连接后重试")?;
    let result = bounded_json(response, 4 * 1024 * 1024).await?;
    if let Some(epoch) = epoch {
        state.check(epoch)?;
    }
    Ok(result)
}

#[tauri::command]
async fn mobile_chat(
    state: State<'_, MobileState>,
    id: String,
    body: Value,
    on_chunk: Channel<Vec<u8>>,
) -> Result<(), String> {
    transport::validate_chat(&body)?;
    let (session, epoch) = state.snapshot()?;
    let cancel = state.begin_ai(&id, epoch)?;
    let work = async {
        let response = state
            .request(Method::POST, "/pg/chat/completions", &session)
            .json(&body)
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(|_| "聊天连接失败或等待超时，请先查看用量后再决定是否重试")?;
        if !response.status().is_success() {
            return Err(format!(
                "聊天请求失败（HTTP {}）",
                response.status().as_u16()
            ));
        }
        if !response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .starts_with("text/event-stream")
        {
            let result = bounded_json(response, 1024 * 1024).await?;
            return Err(transport::message(
                &result,
                "模型未返回流式响应，请换一个模型重试",
            ));
        }
        let mut stream = response.bytes_stream();
        let mut received = 0usize;
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(180), stream.next())
            .await
            .map_err(|_| "回复等待超时，可手动重试")?
        {
            let chunk = chunk.map_err(|_| "连接中断，已收到的回复已保留")?;
            received += chunk.len();
            if received > 16 * 1024 * 1024 {
                return Err("回复超过长度限制，已停止接收".into());
            }
            state.check(epoch)?;
            on_chunk
                .send(chunk.to_vec())
                .map_err(|_| "聊天页面已关闭")?;
        }
        state.check(epoch)
    };
    let result = tokio::select! { _ = cancel.cancelled() => Err("已停止生成".into()), result = work => result };
    if let Ok(mut tasks) = state.tasks.lock() {
        tasks.remove(&id);
    }
    result
}

#[tauri::command]
fn mobile_cancel(state: State<'_, MobileState>, id: String) {
    if let Ok(tasks) = state.tasks.lock() {
        if let Some(token) = tasks.get(&id) {
            token.cancel();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageRequest {
    prompt: String,
    model: String,
    size: String,
    reference: Option<String>,
}

#[tauri::command]
async fn mobile_image(
    state: State<'_, MobileState>,
    id: String,
    input: ImageRequest,
) -> Result<Value, String> {
    if input.prompt.trim().is_empty()
        || input.prompt.len() > 32000
        || input.model.is_empty()
        || input.model.len() > 160
    {
        return Err("请输入有效的提示词和模型".into());
    }
    if !["auto", "1024x1024", "1536x1024", "1024x1536"].contains(&input.size.as_str()) {
        return Err("图片尺寸无效".into());
    }
    let (session, epoch) = state.snapshot()?;
    let cancel = state.begin_ai(&id, epoch)?;
    let work = async {
        let credential = bounded_json(
            state
                .request(Method::POST, "/api/image-playground/session", &session)
                .json(&json!({}))
                .timeout(Duration::from_secs(45))
                .send()
                .await
                .map_err(|_| "创建生图会话失败")?,
            1024 * 1024,
        )
        .await?;
        transport::ensure_success(&credential)?;
        let key = image_credential(&credential)?;
        state.check(epoch)?;
        let req = if let Some(reference) = input.reference {
            let bytes = STANDARD.decode(reference).map_err(|_| "参考图格式无效")?;
            if bytes.len() > 10 * 1024 * 1024 {
                return Err("参考图不能超过 10 MB".into());
            }
            let mime = image_mime(&bytes)?;
            let filename = match mime {
                "image/jpeg" => "reference.jpg",
                "image/webp" => "reference.webp",
                _ => "reference.png",
            };
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(filename)
                .mime_str(mime)
                .map_err(|_| "参考图格式无效")?;
            state
                .client
                .post(format!("{BASE}/v1/images/edits"))
                .bearer_auth(&key)
                .multipart(
                    reqwest::multipart::Form::new()
                        .text("model", input.model)
                        .text("prompt", input.prompt)
                        .text("size", input.size)
                        .text("n", "1")
                        .text("response_format", "b64_json")
                        .part("image", part),
                )
        } else {
            state.client.post(format!("{BASE}/v1/images/generations")).bearer_auth(&key)
                .json(&json!({"model":input.model,"prompt":input.prompt,"size":input.size,"n":1,"response_format":"b64_json"}))
        };
        let response = req
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(|_| "生图连接中断或超时，请先查看用量再决定是否重试")?;
        let value = bounded_json(response, 48 * 1024 * 1024).await?;
        state.check(epoch)?;
        let data = value
            .pointer("/data/0/b64_json")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                transport::message(&value, "未收到图片数据；请查看用量记录，不会自动重试")
            })?;
        let bytes = STANDARD.decode(data).map_err(|_| "图片数据无效")?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err("图片超过 32 MB，请缩小尺寸后重试".into());
        }
        let mime = image_mime(&bytes)?;
        Ok(json!({"data":data,"mime":mime}))
    };
    let result = tokio::select! { _ = cancel.cancelled() => Err("已停止等待；服务端可能仍在生成，请查看用量后再重试".into()), result = work => result };
    if let Ok(mut tasks) = state.tasks.lock() {
        tasks.remove(&id);
    }
    result
}

#[tauri::command]
async fn mobile_save_image(app: AppHandle, data: String) -> Result<(), String> {
    if data.len() > 45 * 1024 * 1024 {
        return Err("图片过大".into());
    }
    let bytes = STANDARD.decode(&data).map_err(|_| "图片数据无效")?;
    let mime = image_mime(&bytes)?;
    app.native()
        .call("saveImage", json!({"data":data,"mime":mime}))?;
    Ok(())
}

#[tauri::command]
fn mobile_open_website(app: AppHandle, destination: String) -> Result<(), String> {
    let url = transport::website_url(&destination)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "无法打开浏览器，请稍后重试".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_yuanheng_native::init())
        .plugin(tauri_plugin_opener::init())
        .manage(MobileState::new())
        .invoke_handler(tauri::generate_handler![
            mobile_restore,
            mobile_capabilities,
            mobile_ai_consent,
            mobile_login,
            mobile_logout,
            mobile_api,
            mobile_chat,
            mobile_cancel,
            mobile_image,
            mobile_save_image,
            mobile_open_website
        ])
        .run(tauri::generate_context!())
        .expect("启动元衡移动端失败");
}

#[cfg(test)]
mod state_tests {
    use super::*;
    #[test]
    fn ai_tasks_require_current_account_consent() {
        let state = MobileState::new();
        assert!(state.begin_ai("no-session", 0).is_err());
        {
            let mut login = state.login.lock().unwrap();
            login.session = Some(Session {
                cookie: "session=test-only".into(),
                user_id: 7,
            });
            login.epoch = 1;
        }
        assert!(state.begin_ai("no-consent", 1).is_err());
        state.login.lock().unwrap().ai_consent = true;
        assert!(state.begin_ai("old-account", 0).is_err());
        let task = state.begin_ai("accepted", 1).unwrap();
        state.login.lock().unwrap().ai_consent = false;
        state.cancel_all();
        assert!(task.is_cancelled());
        assert!(state.begin_ai("withdrawn", 1).is_err());
    }
    #[test]
    fn switching_account_invalidates_old_snapshot_and_cancels_work() {
        let state = MobileState::new();
        assert!(state.snapshot().is_err());
        {
            let mut login = state.login.lock().unwrap();
            login.session = Some(Session {
                cookie: "session=test-only".into(),
                user_id: 7,
            });
        }
        let (_, epoch) = state.snapshot().unwrap();
        let task = state.begin("chat").unwrap();
        state.cancel_all();
        state.login.lock().unwrap().epoch += 1;
        assert!(task.is_cancelled());
        assert!(state.check(epoch).is_err());
        assert!(state.tasks.lock().unwrap().is_empty());
    }
    #[test]
    fn task_capacity_prevents_duplicate_billable_requests() {
        let state = MobileState::new();
        state.begin("chat").unwrap();
        assert!(state.begin("chat").is_err());
        state.begin("image").unwrap();
        assert!(state.begin("third").is_err());
        state.cancel_all();
        assert!(state.begin("third").is_ok());
    }
}
