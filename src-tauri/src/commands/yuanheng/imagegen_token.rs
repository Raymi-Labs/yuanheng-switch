//! Dedicated group credentials for the bundled image skill only.
//! Never edits account-wide routing or adopts the shared chat token.
use super::*;
use sha2::{Digest, Sha256};

const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const TOKEN_LIST_LIMIT: usize = 8 * 1024 * 1024;

async fn account_json(
    request: reqwest::RequestBuilder,
    cookie: &str,
    user: &str,
) -> Result<(Value, usize), String> {
    use futures::StreamExt;
    let response = with_session(request, Some(cookie), Some(user))
        .send()
        .await
        .map_err(|_| "图片凭据请求失败，请检查网络后重试")?;
    if !response.status().is_success() {
        return Err(format!(
            "图片凭据请求失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "图片凭据响应未完成")?;
        if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
            return Err("图片凭据响应过大，未继续配置".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "图片凭据响应格式无效")?;
    if value["success"].as_bool() != Some(true) {
        return Err("图片凭据操作未成功，请在平台核对后重试".into());
    }
    Ok((value, bytes.len()))
}

async fn token_list(
    client: &reqwest::Client,
    origin: &str,
    cookie: &str,
    user: &str,
) -> Result<Value, String> {
    let mut items = Vec::new();
    let mut total = 0usize;
    let mut expected_count = None;
    for page in 1..=100 {
        let (value, bytes) = account_json(
            client.get(format!("{origin}/api/token/?p={page}&size=100")),
            cookie,
            user,
        )
        .await?;
        total = total.saturating_add(bytes);
        if total > TOKEN_LIST_LIMIT {
            return Err("图片令牌列表超出检查范围，未创建凭据".into());
        }
        let rows = value
            .pointer("/data/items")
            .and_then(Value::as_array)
            .ok_or("图片令牌列表格式无效")?;
        if rows.len() > 100 {
            return Err("图片令牌分页格式无效，未创建凭据".into());
        }
        if let Some(count) = value.pointer("/data/total") {
            let count = count.as_u64().ok_or("图片令牌总数无效")?;
            if count > 10_000 || expected_count.is_some_and(|old| old != count) {
                return Err("图片令牌列表已变化或超出检查范围，请重新核对".into());
            }
            expected_count = Some(count);
        }
        items.extend(rows.iter().cloned());
        if rows.len() < 100 {
            if expected_count.is_some_and(|count| count != items.len() as u64) {
                return Err("图片令牌列表不完整，未创建凭据".into());
            }
            return Ok(json!({"data":{"items":items}}));
        }
    }
    Err("图片令牌列表超出检查范围，未创建凭据".into())
}

fn identity(user: &str, group: &str) -> (String, String) {
    let hash = format!("{:x}", Sha256::digest(group.as_bytes()));
    let owner = format!("{:x}", Sha256::digest(user.as_bytes()));
    (
        format!("元衡图片 - {}", &hash[..16]),
        format!("yuanheng_image_token_{owner}_{hash}"),
    )
}

fn selected<'a>(
    list: &'a Value,
    name: &str,
    saved: Option<i64>,
) -> Result<Option<&'a Value>, String> {
    let rows = list
        .pointer("/data/items")
        .and_then(Value::as_array)
        .ok_or("图片令牌列表格式异常")?;
    if let Some(id) = saved {
        if let Some(row) = rows.iter().find(|row| row["id"].as_i64() == Some(id)) {
            return Ok(Some(row));
        }
    }
    let mut found = rows.iter().filter(|row| row["name"].as_str() == Some(name));
    let first = found.next();
    if found.next().is_some() {
        return Err("发现多枚同名图片令牌，请在平台核对；未自动新建".into());
    }
    if first.is_none() && saved.is_some() {
        return Err("原图片令牌已删除，请在平台核对；未自动新建".into());
    }
    Ok(first)
}

fn validate(row: &Value, group: &str, now: i64) -> Result<i64, String> {
    if row["status"].as_i64() != Some(1)
        || row["expired_time"]
            .as_i64()
            .is_none_or(|t| t != -1 && t <= now)
        || (row["unlimited_quota"].as_bool() != Some(true)
            && row["remain_quota"].as_i64().unwrap_or(0) <= 0)
    {
        return Err("图片令牌已停用、过期或额度不足，请在平台处理；未自动新建".into());
    }
    if row["group"].as_str() != Some(group)
        || row
            .get("auto_group_fallback")
            .is_some_and(|v| v != &Value::Bool(false))
        || row
            .get("cross_group_retry")
            .is_some_and(|v| v != &Value::Bool(false))
    {
        return Err("图片令牌分组或回退规则与选择不符，请在平台核对；未覆盖原规则".into());
    }
    match row.get("routing_config") {
        None | Some(Value::Null) => {}
        Some(Value::String(raw)) if raw.is_empty() => {}
        // Routing-config tokens can return 200 + an empty model directory when
        // their group is revoked. Plain single-group TokenAuth instead rejects
        // revoked groups before serving a catalog; absence is then unambiguous.
        _ => return Err("图片令牌必须为普通单组令牌，不能设置多组路由；未覆盖原规则".into()),
    }
    row["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(|| "图片令牌编号无效".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Path, Query, State},
        routing::get,
        Json, Router,
    };
    use serial_test::serial;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    #[derive(Clone)]
    struct Fixture {
        rows: Arc<Mutex<Vec<Value>>>,
        posts: Arc<AtomicUsize>,
        unknown: bool,
        key_gate: Option<(Arc<tokio::sync::Semaphore>, Arc<tokio::sync::Semaphore>)>,
    }
    struct Server {
        origin: String,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn server(f: Fixture) -> Server {
        let router=Router::new()
            .route("/api/user/self/groups",get(||async {Json(json!({"success":true,"data":{"生图和视频":{},"福利":{},"other-images":{},"auto":{}}}))}))
            .route("/api/token/",get(|State(f):State<Fixture>,Query(q):Query<HashMap<String,String>>|async move {
                let page:usize=q["p"].parse().unwrap();
                Json(json!({"success":true,"data":{"items":f.rows.lock().unwrap().iter().skip((page-1)*100).take(100).cloned().collect::<Vec<_>>()}}))
            }).post(|State(f):State<Fixture>,Json(mut row):Json<Value>|async move {
                f.posts.fetch_add(1,Ordering::SeqCst);
                if f.unknown{return (axum::http::StatusCode::GATEWAY_TIMEOUT,Json(json!({"success":false})));}
                let mut rows=f.rows.lock().unwrap();row["id"]=json!(100+rows.len());row["status"]=json!(1);rows.push(row);
                (axum::http::StatusCode::OK,Json(json!({"success":true})))
            }))
            .route("/api/token/:id/key",get(|State(f):State<Fixture>,Path(id):Path<i64>|async move {
                if let Some((started,proceed))=f.key_gate {started.add_permits(1);proceed.acquire().await.unwrap().forget();}
                Json(json!({"success":true,"data":{"key":format!("imagekey{id}")}}))
            }))
            .with_state(f);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Server { origin, task }
    }
    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(2))
            .retry(reqwest::retry::never())
            .build()
            .unwrap()
    }
    fn fixture() -> Fixture {
        Fixture {
            rows: Arc::new(Mutex::new(vec![
                json!({"id":1,"name":"元衡桌面端 - 统一令牌","status":1,"group":"chat","routing_config":"{\"groups\":[\"chat\",\"生图和视频\"]}"}),
            ])),
            posts: Default::default(),
            unknown: false,
            key_gate: None,
        }
    }
    fn login(state: &AppState) {
        let status = YuanhengConnectionStatus {
            connected: true,
            user_id: Some("synthetic-user".into()),
            ..Default::default()
        };
        persist_connection_for_group(
            state,
            "session=synthetic",
            "synthetic-user",
            "sk-chat-untouched",
            1,
            &status,
            "auto",
        )
        .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn concurrent_tools_reuse_only_image_group_token_and_leave_chat_unchanged() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let f = fixture();
        let chat = f.rows.lock().unwrap()[0].clone();
        let s = server(f.clone()).await;
        let c = client();
        let (a, b) = tokio::join!(
            ensure_at(
                &state,
                &c,
                &s.origin,
                "session=synthetic",
                "synthetic-user",
                "生图和视频"
            ),
            ensure_at(
                &state,
                &c,
                &s.origin,
                "session=synthetic",
                "synthetic-user",
                "生图和视频"
            )
        );
        let a = a.unwrap();
        assert_eq!(a, b.unwrap());
        assert_eq!(f.posts.load(Ordering::SeqCst), 1);
        let other = ensure_at(
            &state,
            &c,
            &s.origin,
            "session=synthetic",
            "synthetic-user",
            "other-images",
        )
        .await
        .unwrap();
        assert_ne!(a, other);
        assert_eq!(f.posts.load(Ordering::SeqCst), 2);
        let rows = f.rows.lock().unwrap();
        assert_eq!(rows[0], chat);
        assert_eq!(rows[1]["group"], "生图和视频");
        assert_eq!(rows[2]["group"], "other-images");
        assert_eq!(rows[1]["auto_group_fallback"], false);
        assert_eq!(rows[1]["cross_group_retry"], false);
        assert_eq!(rows[1]["routing_config"], "");
        assert_eq!(
            get_yuanheng_secret(&state, API_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("sk-chat-untouched")
        );
    }

    #[tokio::test]
    #[serial]
    async fn primary_and_welfare_tokens_remain_separate_and_single_group() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let f = fixture();
        let original_chat = f.rows.lock().unwrap()[0].clone();
        let s = server(f.clone()).await;
        let c = client();
        for _ in 0..2 {
            for group in ["生图和视频", "福利"] {
                ensure_at(
                    &state,
                    &c,
                    &s.origin,
                    "session=synthetic",
                    "synthetic-user",
                    group,
                )
                .await
                .unwrap();
            }
        }
        let rows = f.rows.lock().unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], original_chat);
        for (row, group) in rows[1..].iter().zip(["生图和视频", "福利"]) {
            assert_eq!(row["group"], group);
            assert_eq!(row["auto_group_fallback"], false);
            assert_eq!(row["cross_group_retry"], false);
            assert_eq!(row["routing_config"], "");
        }
        assert_eq!(f.posts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    #[serial]
    async fn blocked_changed_or_deleted_token_never_recreates_or_rewrites() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let f = fixture();
        let s = server(f.clone()).await;
        let c = client();
        ensure_at(
            &state,
            &c,
            &s.origin,
            "session=synthetic",
            "synthetic-user",
            "生图和视频",
        )
        .await
        .unwrap();
        let original = f.rows.lock().unwrap()[1].clone();
        for (field, value) in [
            ("status", json!(2)),
            ("group", json!("chat")),
            ("auto_group_fallback", json!(true)),
            (
                "routing_config",
                json!(r#"{"groups":["chat","生图和视频"]}"#),
            ),
            ("expired_time", json!(0)),
        ] {
            let mut altered = original.clone();
            altered[field] = value;
            f.rows.lock().unwrap()[1] = altered.clone();
            assert!(ensure_at(
                &state,
                &c,
                &s.origin,
                "session=synthetic",
                "synthetic-user",
                "生图和视频"
            )
            .await
            .is_err());
            assert_eq!(f.rows.lock().unwrap()[1], altered);
            assert_eq!(f.posts.load(Ordering::SeqCst), 1);
        }
        f.rows.lock().unwrap().pop();
        assert!(ensure_at(
            &state,
            &c,
            &s.origin,
            "session=synthetic",
            "synthetic-user",
            "生图和视频"
        )
        .await
        .is_err());
        assert_eq!(f.posts.load(Ordering::SeqCst), 1);
        let mut replacement = original;
        replacement["id"] = json!(333);
        f.rows.lock().unwrap().push(replacement);
        assert_eq!(
            ensure_at(
                &state,
                &c,
                &s.origin,
                "session=synthetic",
                "synthetic-user",
                "生图和视频"
            )
            .await
            .unwrap(),
            "sk-imagekey333"
        );
        assert_eq!(
            f.posts.load(Ordering::SeqCst),
            1,
            "explicit platform replacement can be adopted without client POST"
        );
    }

    #[tokio::test]
    #[serial]
    async fn unknown_creation_and_account_change_fail_without_duplicate_post() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let mut f = fixture();
        f.unknown = true;
        let s = server(f.clone()).await;
        let c = client();
        for _ in 0..2 {
            assert!(ensure_at(
                &state,
                &c,
                &s.origin,
                "session=synthetic",
                "synthetic-user",
                "生图和视频"
            )
            .await
            .is_err());
        }
        assert_eq!(f.posts.load(Ordering::SeqCst), 1);
        assert!(ensure_at(
            &state,
            &c,
            &s.origin,
            "session=other",
            "other-user",
            "other-images"
        )
        .await
        .is_err());
        assert!(ensure_at(
            &state,
            &c,
            &s.origin,
            "session=synthetic",
            "synthetic-user",
            "auto"
        )
        .await
        .is_err());
        assert!(ensure_at(
            &state,
            &c,
            &s.origin,
            "session=synthetic",
            "synthetic-user",
            "missing"
        )
        .await
        .is_err());
        assert_eq!(f.posts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    #[serial]
    async fn late_key_response_cannot_cross_an_account_switch() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let mut f = fixture();
        let started = Arc::new(tokio::sync::Semaphore::new(0));
        let proceed = Arc::new(tokio::sync::Semaphore::new(0));
        f.key_gate = Some((started.clone(), proceed.clone()));
        let s = server(f).await;
        let c = client();
        let request = ensure_at(
            &state,
            &c,
            &s.origin,
            "session=synthetic",
            "synthetic-user",
            "生图和视频",
        );
        let switched = async {
            let permit = tokio::time::timeout(std::time::Duration::from_secs(2), started.acquire())
                .await
                .unwrap()
                .unwrap();
            permit.forget();
            let status = YuanhengConnectionStatus {
                connected: true,
                user_id: Some("other".into()),
                ..Default::default()
            };
            persist_connection_for_group(
                &state,
                "session=other",
                "other",
                "sk-other-chat",
                9,
                &status,
                "other-group",
            )
            .unwrap();
            proceed.add_permits(1);
        };
        let (result, _) = tokio::join!(request, switched);
        assert!(result.unwrap_err().contains("登录状态已变化"));
        assert_eq!(
            get_yuanheng_secret(&state, API_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("sk-other-chat")
        );
    }

    #[tokio::test]
    #[serial]
    async fn pagination_reuses_existing_token_and_duplicate_names_block() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let f = fixture();
        let (name, _) = identity("synthetic-user", "生图和视频");
        let row = json!({"id":222,"name":name,"group":"生图和视频","status":1,"expired_time":-1,"unlimited_quota":true,"routing_config":""});
        *f.rows.lock().unwrap() = (0..105)
            .map(|i| json!({"id":i+1000,"name":"unrelated"}))
            .chain([row.clone()])
            .collect();
        let s = server(f.clone()).await;
        assert_eq!(
            ensure_at(
                &state,
                &client(),
                &s.origin,
                "session=synthetic",
                "synthetic-user",
                "生图和视频"
            )
            .await
            .unwrap(),
            "sk-imagekey222"
        );
        assert_eq!(f.posts.load(Ordering::SeqCst), 0);
        let list = json!({"data":{"items":[row.clone(),row]}});
        assert!(selected(&list, &name, None).is_err());
    }

    #[test]
    fn group_scope_checks_all_routing_layers_and_preserves_restrictions() {
        let row = json!({"id":7,"status":1,"expired_time":-1,"unlimited_quota":true,"group":"images","model_limits_enabled":true,"model_limits":"gpt-image-2","routing_config":""});
        assert_eq!(validate(&row, "images", 1).unwrap(), 7);
        for value in [
            r#"{"groups":["images"]}"#,
            r#"{"groups":["images"],"auto_fallback":true}"#,
            r#"{"groups":["images"],"model_groups":{"x":["chat"]}}"#,
            "null",
            "invalid",
        ] {
            let mut bad = row.clone();
            bad["routing_config"] = json!(value);
            assert!(validate(&bad, "images", 1).is_err());
        }
        let mut exhausted = row.clone();
        exhausted["unlimited_quota"] = json!(false);
        exhausted["remain_quota"] = json!(0);
        assert!(validate(&exhausted, "images", 1).is_err());
        assert!(identity("user", "图片组").0.len() <= 50);
    }

    #[tokio::test]
    async fn account_reads_are_bounded_per_response_and_across_token_pages() {
        let pages = Arc::new(AtomicUsize::new(0));
        let seen = pages.clone();
        let app = Router::new()
            .route("/oversized",get(||async { "x".repeat(RESPONSE_LIMIT + 1) }))
            .route("/api/token/",get(move || {
                let seen = seen.clone();
                async move {
                    seen.fetch_add(1,Ordering::SeqCst);
                    Json(json!({"success":true,"padding":"x".repeat(1024*1024),"data":{"items":(0..100).map(|id|json!({"id":id})).collect::<Vec<_>>()}}))
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let s = Server { origin, task };
        assert!(account_json(
            client().get(format!("{}/oversized", s.origin)),
            "session=synthetic",
            "synthetic-user"
        )
        .await
        .unwrap_err()
        .contains("过大"));
        assert!(
            token_list(&client(), &s.origin, "session=synthetic", "synthetic-user")
                .await
                .unwrap_err()
                .contains("超出检查范围")
        );
        assert!(pages.load(Ordering::SeqCst) <= 9);
    }
}

pub(super) async fn ensure_at(
    state: &AppState,
    client: &reqwest::Client,
    origin: &str,
    cookie: &str,
    user: &str,
    group: &str,
) -> Result<String, String> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _lock = LOCK.lock().await;
    device_credentials::check_owner(state, cookie, user)?;
    if group.is_empty()
        || group == "auto"
        || group.trim() != group
        || group.len() > 256
        || group.chars().any(char::is_control)
    {
        return Err("请选择实际图片分组，不能使用自动分组".into());
    }
    let (value, _) = account_json(
        client.get(format!("{origin}/api/user/self/groups")),
        cookie,
        user,
    )
    .await?;
    let groups = parse_user_groups(&value)?;
    if !groups.iter().any(|g| g.id == group) {
        return Err("当前账号不可使用所选图片分组，请重新选择".into());
    }
    let (name, identity) = identity(user, group);
    let pending = format!("{identity}_pending");
    let saved = state
        .db
        .get_setting(&identity)
        .map_err(|e| e.to_string())?
        .map(|s| s.parse::<i64>().map_err(|_| "图片令牌记录异常".to_string()))
        .transpose()?;
    let list = token_list(client, origin, cookie, user).await?;
    device_credentials::check_owner(state, cookie, user)?;
    let id =
        if let Some(row) = selected(&list, &name, saved)? {
            validate(row, group, chrono::Utc::now().timestamp())?
        } else {
            if state
                .db
                .get_setting(&pending)
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err("上次图片令牌创建结果尚未确认，请先核对平台记录；未重复创建".into());
            }
            state
                .db
                .set_setting(&pending, "pending")
                .map_err(|e| e.to_string())?;
            account_json(client.post(format!("{origin}/api/token/")).json(&json!({
            "name":name,"group":group,"expired_time":-1,"unlimited_quota":true,"remain_quota":0,
            "model_limits_enabled":false,"auto_group_fallback":false,"cross_group_retry":false,
            "routing_config":""
        })),cookie,user).await?;
            device_credentials::check_owner(state, cookie, user)?;
            let list = token_list(client, origin, cookie, user).await?;
            let row =
                selected(&list, &name, None)?.ok_or("创建图片令牌结果尚未确认，未重复创建")?;
            validate(row, group, chrono::Utc::now().timestamp())?
        };
    device_credentials::check_owner(state, cookie, user)?;
    state
        .db
        .set_setting(&identity, &id.to_string())
        .map_err(|e| e.to_string())?;
    let (value, _) = account_json(
        client.get(format!("{origin}/api/token/{id}/key")),
        cookie,
        user,
    )
    .await?;
    let key = normalize_api_token(
        value
            .pointer("/data/key")
            .and_then(Value::as_str)
            .ok_or("图片令牌缺少key")?,
    )?;
    device_credentials::check_owner(state, cookie, user)?;
    state
        .db
        .delete_setting(&pending)
        .map_err(|e| e.to_string())?;
    Ok(key)
}
