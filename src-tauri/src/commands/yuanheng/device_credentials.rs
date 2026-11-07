//! One account token; directory selection never rewrites its server routing rules.
use super::*;
use sha2::{Digest, Sha256};

const SHARED_TOKEN_NAME: &str = "元衡桌面端 - 统一令牌";

fn routing_groups(groups: &[YuanhengGroupOption], preferred: &str) -> Result<Vec<String>, String> {
    let mut result: Vec<_> = groups
        .iter()
        .filter(|g| g.id != "auto")
        .map(|g| g.id.clone())
        .collect();
    result.sort();
    result.dedup();
    if result.is_empty() || result.len() > 100 {
        return Err("统一令牌需要 1 到 100 个真实授权分组，请在平台核对分组权限".into());
    }
    if let Some(index) = result.iter().position(|g| g == preferred) {
        let first = result.remove(index);
        result.insert(0, first);
    }
    Ok(result)
}

fn shared_token(list: &Value, saved_id: Option<i64>) -> Result<Option<&Value>, String> {
    let rows = list
        .pointer("/data/items")
        .and_then(Value::as_array)
        .ok_or("令牌列表格式异常")?;
    // The remembered ID survives renames; an explicit replacement with the canonical name
    // can be adopted after deletion, but deletion alone never silently recreates credentials.
    if let Some(row) = rows
        .iter()
        .find(|r| saved_id.is_some() && r["id"].as_i64() == saved_id)
    {
        return Ok(Some(row));
    }
    let mut matches = rows
        .iter()
        .filter(|r| r["name"].as_str() == Some(SHARED_TOKEN_NAME));
    let first = matches.next();
    if matches.next().is_some() {
        return Err("发现多枚同名统一令牌，请在平台保留一枚后重试；未创建新令牌".into());
    }
    if first.is_none() && saved_id.is_some() {
        return Err("统一令牌已删除，请在平台恢复或新建同名多分组令牌后重试；未自动创建".into());
    }
    Ok(first)
}

fn validate_shared_token(row: &Value, now: i64) -> Result<i64, String> {
    if row["status"].as_i64() != Some(1)
        || row["expired_time"]
            .as_i64()
            .is_some_and(|t| t > 0 && t <= now)
        || (row["unlimited_quota"].as_bool() != Some(true)
            && row["remain_quota"].as_i64().unwrap_or(0) <= 0)
    {
        return Err("统一令牌已停用、过期或额度不足，请在平台处理；未创建新令牌".into());
    }
    let config: Value = serde_json::from_str(row["routing_config"].as_str().unwrap_or(""))
        .map_err(|_| "统一令牌缺少有效的多分组路由，请在平台配置后重试")?;
    let groups = config["groups"].as_array().ok_or("统一令牌路由格式异常")?;
    let mut seen = BTreeSet::new();
    if groups.is_empty()
        || groups.len() > 100
        || groups.iter().any(|g| {
            g.as_str()
                .is_none_or(|g| g.is_empty() || g == "auto" || g.trim() != g || !seen.insert(g))
        })
        || groups.first().and_then(Value::as_str) != row["group"].as_str()
    {
        return Err("统一令牌路由配置无效，请在平台核对；未覆盖已有规则".into());
    }
    row["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(|| "统一令牌缺少有效 ID".into())
}

pub(super) fn check_owner(state: &AppState, cookie: &str, user: &str) -> Result<(), String> {
    if get_yuanheng_secret(state, USER_ID_KEY)?.as_deref() != Some(user)
        || get_yuanheng_secret(state, SESSION_COOKIE_KEY)?.as_deref() != Some(cookie)
    {
        return Err("登录状态已变化，请重新操作".into());
    }
    Ok(())
}

pub(super) async fn groups_at(
    client: &reqwest::Client,
    origin: &str,
    cookie: &str,
    user: &str,
) -> Result<Vec<YuanhengGroupOption>, String> {
    let value = fetch_json(
        client,
        &format!("{origin}/api/user/self/groups"),
        Some(cookie),
        Some(user),
    )
    .await?;
    parse_user_groups(&value)
}

async fn token_list(
    client: &reqwest::Client,
    origin: &str,
    cookie: &str,
    user: &str,
) -> Result<Value, String> {
    let mut items = Vec::new();
    // Incomplete pagination must never be mistaken for absence of an existing token.
    for page in 1..=100 {
        let value = fetch_json(
            client,
            &format!("{origin}/api/token/?p={page}&size=100"),
            Some(cookie),
            Some(user),
        )
        .await?;
        ensure_api_success(&value, "读取元衡工具凭据失败")?;
        let rows = value
            .pointer("/data/items")
            .and_then(Value::as_array)
            .ok_or("令牌列表格式异常，未创建凭据")?;
        items.extend(rows.iter().cloned());
        if rows.len() < 100 {
            return Ok(json!({"data": {"items": items}}));
        }
    }
    Err("令牌列表超出检查范围，未创建凭据，请先核对平台记录".into())
}

pub(super) async fn ensure_at(
    state: &AppState,
    client: &reqwest::Client,
    origin: &str,
    cookie: &str,
    user: &str,
    group: &str,
) -> Result<(String, i64), String> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    check_owner(state, cookie, user)?;
    let groups = groups_at(client, origin, cookie, user).await?;
    if group.is_empty() || !groups.iter().any(|item| item.id == group) {
        return Err("所选凭据分组已不可用，请刷新并选择有效分组；未创建令牌".into());
    }
    let marker = format!(
        "yuanheng_token_pending_{:x}",
        Sha256::digest(user.as_bytes())
    );
    let identity = format!(
        "yuanheng_shared_token_id_{:x}",
        Sha256::digest(user.as_bytes())
    );
    let saved_id = state
        .db
        .get_setting(&identity)
        .map_err(|e| e.to_string())?
        .map(|id| {
            id.parse::<i64>()
                .map_err(|_| "统一令牌记录异常，请检查本机配置")
        })
        .transpose()?;
    let now = chrono::Utc::now().timestamp();
    let list = token_list(client, origin, cookie, user).await?;
    let id = if let Some(row) = shared_token(&list, saved_id)? {
        validate_shared_token(row, now)?
    } else {
        check_owner(state, cookie, user)?;
        if state
            .db
            .get_setting(&marker)
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Err("上次创建凭据的结果尚未确认，未重复创建；请核对平台令牌记录".into());
        }
        let routing = routing_groups(&groups, group)?;
        // Written BEFORE the POST: timeout/crash/restart must not create another token.
        state
            .db
            .set_setting(&marker, "pending")
            .map_err(|e| e.to_string())?;
        let (created, _) = post_json(
            client,
            &format!("{origin}/api/token/"),
            &json!({
                "name": SHARED_TOKEN_NAME, "expired_time": -1, "remain_quota": 0,
                "unlimited_quota": true, "model_limits_enabled": false, "group": routing[0],
                "routing_config": serde_json::to_string(&json!({"groups": routing})).map_err(|e| e.to_string())?
            }),
            Some(cookie),
            Some(user),
        )
        .await?;
        ensure_api_success(&created, "创建本机工具凭据未确认，请核对平台记录后再试")?;
        let list = token_list(client, origin, cookie, user).await?;
        let row =
            shared_token(&list, None)?.ok_or("凭据创建结果尚未确认，未重复创建，请核对平台记录")?;
        validate_shared_token(row, now)?
    };
    check_owner(state, cookie, user)?;
    state
        .db
        .set_setting(&identity, &id.to_string())
        .map_err(|e| e.to_string())?;
    let value = fetch_json(
        client,
        &format!("{origin}/api/token/{id}/key"),
        Some(cookie),
        Some(user),
    )
    .await?;
    ensure_api_success(&value, "读取本机工具凭据失败")?;
    let token = normalize_api_token(
        value
            .pointer("/data/key")
            .and_then(Value::as_str)
            .ok_or("凭据响应缺少 key")?,
    )?;
    check_owner(state, cookie, user)?;
    state
        .db
        .delete_setting(&marker)
        .map_err(|e| e.to_string())?;
    Ok((token, id))
}

pub(super) async fn repair_at(
    state: &AppState,
    client: &reqwest::Client,
    origin: &str,
    session: (&str, &str),
    group: &str,
    status: &YuanhengConnectionStatus,
) -> Result<(), String> {
    let (cookie, user) = session;
    let (token, id) = ensure_at(state, client, origin, cookie, user, group).await?;
    fetch_api_models_at(client, origin, &token).await?;
    check_owner(state, cookie, user)?;
    persist_connection_for_group(state, cookie, user, &token, id, status, "auto")
}

pub(super) fn rejected_check(error: &str) -> YuanhengDiagnosticCheck {
    let forbidden = error.contains("HTTP 403");
    YuanhengDiagnosticCheck {
        id: "credential".into(),
        status: "warning".into(),
        title: if forbidden {
            "通用凭据访问被拒绝（403）"
        } else {
            "通用凭据认证失败（401）"
        }
        .into(),
        message: if forbidden {
            "请核对分组权限或网关限制；403 不代表令牌过期。工具凭据单独检查；请在平台管理统一令牌的权限与路由。"
        } else {
            "通用凭据未通过认证，请选择有效分组重新配置；正常工具配置保持不变。"
        }
        .into(),
        action: Some("repair_credentials".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Query, State},
        routing::get,
        Json, Router,
    };
    use serial_test::serial;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[derive(Clone)]
    struct Fixture {
        posts: Arc<AtomicUsize>,
        groups: Value,
        rows: Arc<std::sync::Mutex<Vec<Value>>>,
        unknown: bool,
        catalog_forbidden: Arc<std::sync::atomic::AtomicBool>,
        catalog_gate: Option<(Arc<tokio::sync::Semaphore>, Arc<tokio::sync::Semaphore>)>,
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
        let app = Router::new()
            .route("/api/user/self/groups", get(|State(f): State<Fixture>| async move { Json(f.groups) }))
            .route("/api/token/", get(|State(f): State<Fixture>, Query(q): Query<HashMap<String,String>>| async move {
                let page: usize = q["p"].parse().unwrap();
                let rows = f.rows.lock().unwrap();
                Json(json!({"success":true,"data":{"items": rows.iter().skip((page-1)*100).take(100).cloned().collect::<Vec<_>>()}}))
            }).post(|State(f): State<Fixture>, Json(body): Json<Value>| async move {
                f.posts.fetch_add(1, Ordering::SeqCst);
                if f.unknown { return (axum::http::StatusCode::GATEWAY_TIMEOUT, Json(json!({"message":"timeout"}))); }
                let mut row = body;
                row["id"] = json!(7); row["status"] = json!(1);
                f.rows.lock().unwrap().push(row);
                (axum::http::StatusCode::OK, Json(json!({"success":true})))
            }))
            .route("/api/token/:id/key", get(|| async { Json(json!({"success":true,"data":{"key":"synthetic"}})) }))
            .route("/v1/models", get(|State(f): State<Fixture>| async move {
                if let Some((started, proceed)) = f.catalog_gate {
                    started.add_permits(1);
                    proceed.acquire().await.unwrap().forget();
                }
                if f.catalog_forbidden.load(Ordering::SeqCst) {
                    (axum::http::StatusCode::FORBIDDEN, Json(json!({"error":"forbidden"})))
                } else { (axum::http::StatusCode::OK, Json(json!({"data":[{"id":"test-model"}]}))) }
            }))
            .with_state(f);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Server { origin, task }
    }
    fn fixture(groups: Value, unknown: bool) -> Fixture {
        Fixture {
            posts: Arc::new(AtomicUsize::new(0)),
            groups,
            rows: Default::default(),
            unknown,
            catalog_forbidden: Default::default(),
            catalog_gate: None,
        }
    }
    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap()
    }
    fn login(state: &AppState) {
        let status = YuanhengConnectionStatus {
            connected: true,
            user_id: Some("test-user".into()),
            ..Default::default()
        };
        persist_connection_for_group(state, "session=test", "test-user", "", 0, &status, "")
            .unwrap();
        assert!(read_cached_status(state).unwrap().connected);
    }
    #[tokio::test]
    #[serial]
    async fn unavailable_empty_and_failed_groups_never_create_tokens() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        for groups in [
            json!({"success":true,"data":{"premium":{"desc":"Premium"}}}),
            json!({"success":true,"data":{}}),
            json!({"success":false,"message":"unavailable"}),
        ] {
            let f = fixture(groups, false);
            let s = server(f.clone()).await;
            let err = ensure_at(
                &state,
                &client(),
                &s.origin,
                "session=test",
                "test-user",
                "default",
            )
            .await
            .unwrap_err();
            assert!(!err.is_empty());
            assert_eq!(f.posts.load(Ordering::SeqCst), 0);
        }
    }
    #[tokio::test]
    #[serial]
    async fn concurrent_requests_and_retries_reuse_one_token() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let f = fixture(json!({"success":true,"data":{"premium":{}}}), false);
        let s = server(f.clone()).await;
        let c = client();
        let (a, b) = tokio::join!(
            ensure_at(
                &state,
                &c,
                &s.origin,
                "session=test",
                "test-user",
                "premium",
            ),
            ensure_at(
                &state,
                &c,
                &s.origin,
                "session=test",
                "test-user",
                "premium",
            )
        );
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(f.posts.load(Ordering::SeqCst), 1);
        assert!(get_yuanheng_secret(&state, API_TOKEN_KEY)
            .unwrap()
            .unwrap()
            .is_empty());
    }
    #[tokio::test]
    #[serial]
    async fn switching_groups_and_consumers_preserves_one_account_token_and_server_rules() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let f = fixture(
            json!({"success":true,"data":{"premium":{},"default":{},"auto":{}}}),
            false,
        );
        let server = server(f.clone()).await;
        let c = client();
        let first = ensure_at(
            &state,
            &c,
            &server.origin,
            "session=test",
            "test-user",
            "premium",
        )
        .await
        .unwrap();
        {
            let mut rows = f.rows.lock().unwrap();
            assert_eq!(rows.len(), 1);
            let row = &mut rows[0];
            assert_eq!(row["name"], SHARED_TOKEN_NAME);
            assert_eq!(
                serde_json::from_str::<Value>(row["routing_config"].as_str().unwrap()).unwrap(),
                json!({"groups":["premium","default"]})
            );
            // A user edits the shared token in the console, including its name.
            row["name"] = json!("我的工具令牌");
            row["group"] = json!("default");
            row["routing_config"] =
                json!(r#"{"groups":["default"],"model_groups":{"test-model":["default"]}}"#);
            row["model_limits_enabled"] = json!(true);
            row["model_limits"] = json!("test-model");
            row["unlimited_quota"] = json!(false);
            row["remain_quota"] = json!(123);
        }
        let edited = f.rows.lock().unwrap().clone();
        let restarted = AppState::new(state.db.clone());
        for group in ["default", "premium", "auto"] {
            assert_eq!(
                ensure_at(
                    &restarted,
                    &c,
                    &server.origin,
                    "session=test",
                    "test-user",
                    group
                )
                .await
                .unwrap(),
                first
            );
        }
        // Credential repair is another consumer; it must adopt the same ID/key.
        let status = read_cached_status(&state).unwrap();
        repair_at(
            &state,
            &c,
            &server.origin,
            ("session=test", "test-user"),
            "default",
            &status,
        )
        .await
        .unwrap();
        assert_eq!(f.posts.load(Ordering::SeqCst), 1);
        assert_eq!(*f.rows.lock().unwrap(), edited);
    }

    #[tokio::test]
    #[serial]
    async fn blocked_deleted_duplicate_and_unsupported_tokens_never_create_replacements() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let f = fixture(
            json!({"success":true,"data":{"premium":{},"default":{}}}),
            false,
        );
        let server = server(f.clone()).await;
        let c = client();
        ensure_at(
            &state,
            &c,
            &server.origin,
            "session=test",
            "test-user",
            "premium",
        )
        .await
        .unwrap();
        let original = f.rows.lock().unwrap()[0].clone();
        for (field, value) in [
            ("status", json!(2)),
            ("expired_time", json!(1)),
            ("routing_config", json!("")),
        ] {
            let mut row = original.clone();
            row[field] = value;
            *f.rows.lock().unwrap() = vec![row];
            assert!(ensure_at(
                &state,
                &c,
                &server.origin,
                "session=test",
                "test-user",
                "default"
            )
            .await
            .is_err());
        }
        let mut exhausted = original.clone();
        exhausted["unlimited_quota"] = json!(false);
        exhausted["remain_quota"] = json!(0);
        *f.rows.lock().unwrap() = vec![exhausted];
        assert!(ensure_at(
            &state,
            &c,
            &server.origin,
            "session=test",
            "test-user",
            "default"
        )
        .await
        .is_err());
        f.rows.lock().unwrap().clear();
        assert!(ensure_at(
            &state,
            &c,
            &server.origin,
            "session=test",
            "test-user",
            "default"
        )
        .await
        .is_err());
        assert_eq!(f.posts.load(Ordering::SeqCst), 1);
        assert!(
            shared_token(&json!({"data":{"items":[original.clone(),original]}}), None).is_err()
        );
    }

    #[test]
    fn routing_excludes_auto_and_rejects_empty_or_oversized_scope() {
        let parse = |data| parse_user_groups(&json!({"data":data})).unwrap();
        assert_eq!(
            routing_groups(&parse(json!({"premium":{},"default":{},"auto":{}})), "auto").unwrap(),
            vec!["default", "premium"]
        );
        assert!(routing_groups(&parse(json!({"auto":{}})), "auto").is_err());
        let data: Map<String, Value> = (0..101).map(|i| (format!("group{i}"), json!({}))).collect();
        assert!(routing_groups(&parse(json!(data)), "group0").is_err());
    }

    #[tokio::test]
    #[serial]
    async fn uncertain_creation_persists_guard_and_reconciles_later() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let f = fixture(json!({"success":true,"data":{"premium":{}}}), true);
        let s = server(f.clone()).await;
        // Recreate process-local state between attempts: the guard lives in SQLite.
        let restarted = AppState::new(state.db.clone());
        for owner in [&state, &restarted, &restarted] {
            assert!(ensure_at(
                owner,
                &client(),
                &s.origin,
                "session=test",
                "test-user",
                "premium",
            )
            .await
            .is_err());
        }
        assert_eq!(f.posts.load(Ordering::SeqCst), 1);
        f.rows.lock().unwrap().push(json!({"id":7,"name":SHARED_TOKEN_NAME,"group":"premium","routing_config":"{\"groups\":[\"premium\"]}","status":1,"unlimited_quota":true,"expired_time":-1}));
        assert!(ensure_at(
            &state,
            &client(),
            &s.origin,
            "session=test",
            "test-user",
            "premium",
        )
        .await
        .is_ok());
        assert_eq!(f.posts.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    #[serial]
    async fn pagination_finds_existing_token_and_stale_login_cannot_create() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let f = fixture(json!({"success":true,"data":{"premium":{}}}), false);
        *f.rows.lock().unwrap() = vec![json!({"name":"unrelated"}); 100];
        f.rows.lock().unwrap().push(json!({"id":7,"name":SHARED_TOKEN_NAME,"group":"premium","routing_config":"{\"groups\":[\"premium\"]}","status":1,"unlimited_quota":true}));
        let s = server(f.clone()).await;
        assert!(ensure_at(
            &state,
            &client(),
            &s.origin,
            "session=test",
            "test-user",
            "premium",
        )
        .await
        .is_ok());
        assert!(ensure_at(
            &state,
            &client(),
            &s.origin,
            "session=old",
            "test-user",
            "premium",
        )
        .await
        .is_err());
        assert_eq!(f.posts.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn forbidden_does_not_claim_expiration_or_break_working_tools() {
        let check = rejected_check("模型目录鉴权检查失败（HTTP 403）");
        assert_eq!(check.status, "warning");
        assert!(check.title.contains("403"));
        assert!(!check.title.contains("失效"));
        assert!(rejected_check("HTTP 401").title.contains("401"));
    }

    #[tokio::test]
    #[serial]
    async fn rejected_catalog_preserves_previous_credential_and_retry_reuses_created_token() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let status = read_cached_status(&state).unwrap();
        persist_connection_for_group(
            &state,
            "session=test",
            "test-user",
            "sk-original",
            3,
            &status,
            "old-group",
        )
        .unwrap();
        let f = fixture(json!({"success":true,"data":{"premium":{}}}), false);
        f.catalog_forbidden.store(true, Ordering::SeqCst);
        let s = server(f.clone()).await;
        for _ in 0..2 {
            let error = repair_at(
                &state,
                &client(),
                &s.origin,
                ("session=test", "test-user"),
                "premium",
                &status,
            )
            .await
            .unwrap_err();
            assert!(error.contains("HTTP 403"));
            assert_eq!(
                get_yuanheng_secret(&state, API_TOKEN_KEY)
                    .unwrap()
                    .as_deref(),
                Some("sk-original")
            );
            assert_eq!(
                state
                    .db
                    .get_setting(API_TOKEN_GROUP_KEY)
                    .unwrap()
                    .as_deref(),
                Some("old-group")
            );
        }
        assert_eq!(f.posts.load(Ordering::SeqCst), 1);
        f.catalog_forbidden.store(false, Ordering::SeqCst);
        repair_at(
            &state,
            &client(),
            &s.origin,
            ("session=test", "test-user"),
            "premium",
            &status,
        )
        .await
        .unwrap();
        assert_eq!(
            get_yuanheng_secret(&state, API_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("sk-synthetic")
        );
        assert_eq!(
            state
                .db
                .get_setting(API_TOKEN_GROUP_KEY)
                .unwrap()
                .as_deref(),
            Some("auto")
        );
        assert_eq!(f.posts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    #[serial]
    async fn account_change_during_verification_cannot_overwrite_new_login() {
        let (_home, state) = super::super::tests::isolated_state();
        login(&state);
        let status = read_cached_status(&state).unwrap();
        let started = Arc::new(tokio::sync::Semaphore::new(0));
        let proceed = Arc::new(tokio::sync::Semaphore::new(0));
        let mut f = fixture(json!({"success":true,"data":{"premium":{}}}), false);
        f.catalog_gate = Some((started.clone(), proceed.clone()));
        let s = server(f).await;
        let c = client();
        let repair = repair_at(
            &state,
            &c,
            &s.origin,
            ("session=test", "test-user"),
            "premium",
            &status,
        );
        let switch = async {
            tokio::time::timeout(std::time::Duration::from_secs(5), started.acquire())
                .await
                .unwrap()
                .unwrap()
                .forget();
            let next = YuanhengConnectionStatus {
                connected: true,
                user_id: Some("other-user".into()),
                ..Default::default()
            };
            persist_connection_for_group(
                &state,
                "session=other",
                "other-user",
                "sk-other",
                19,
                &next,
                "other-group",
            )
            .unwrap();
            proceed.add_permits(1);
        };
        let (result, ()) = tokio::join!(repair, switch);
        assert!(result.unwrap_err().contains("登录状态已变化"));
        assert_eq!(
            get_yuanheng_secret(&state, API_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("sk-other")
        );
        assert_eq!(
            read_cached_status(&state).unwrap().user_id.as_deref(),
            Some("other-user")
        );
    }
}
