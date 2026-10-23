//! Opaque, single-attempt Images API transport. In particular, Codex image edits
//! contain JSON image references; treating them as chat or requiring multipart
//! would destroy the request. Never map models, sanitize media or fail over here.

use super::{
    forwarder::{validate_codex_official_authorization, ActiveConnectionGuard},
    http_client,
    providers::{is_codex_official_provider, AuthStrategy, CodexAdapter, ProviderAdapter},
    server::ProxyState,
    ProxyError,
};
use crate::{app_config::AppType, provider::Provider};
use axum::{
    body::{Body, Bytes},
    extract::{rejection::BytesRejection, DefaultBodyLimit, OriginalUri, State},
    http::{HeaderMap, HeaderValue, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures::StreamExt;
use serde_json::{json, Value};
use std::{collections::BTreeSet, time::Duration};

const IMAGE_REQUEST_LIMIT: usize = 200 * 1024 * 1024;
const IMAGE_RESPONSE_LIMIT: usize = 256 * 1024 * 1024;
const IMAGE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MODEL_CATALOG_TIMEOUT: Duration = Duration::from_secs(15);
const MODEL_CATALOG_LIMIT: usize = 2 * 1024 * 1024;

pub(super) fn routes() -> Router<ProxyState> {
    let mut router = Router::new();
    for prefix in ["", "/v1", "/v1/v1", "/codex/v1", "/chatgpt-desktop/v1"] {
        for operation in ["generations", "edits"] {
            router = router.route(&format!("{prefix}/images/{operation}"), post(handle_images));
        }
    }
    for prefix in ["/codex/v1", "/chatgpt-desktop/v1"] {
        router = router.route(&format!("{prefix}/images/models"), get(handle_image_models));
    }
    router.layer(DefaultBodyLimit::max(IMAGE_REQUEST_LIMIT))
}

async fn handle_images(
    State(state): State<ProxyState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let request_id = uuid::Uuid::new_v4().to_string();
    let guard = ActiveConnectionGuard::acquire(state.status.clone()).await;
    let started = std::time::Instant::now();
    {
        let mut status = state.status.write().await;
        status.total_requests += 1;
        status.last_request_at = Some(chrono::Utc::now().to_rfc3339());
    }
    let mut response = match body {
        Ok(body) => match selected_provider(&state, &uri) {
            Ok(provider) => match prepare_request(&provider, &uri, &headers) {
                Ok((url, outgoing)) => match http_client::image_client() {
                    Ok(client) => {
                        send_once(
                            &client,
                            &url,
                            outgoing,
                            body,
                            IMAGE_TIMEOUT,
                            IMAGE_RESPONSE_LIMIT,
                        )
                        .await
                    }
                    Err(error) => local_error(ProxyError::ConfigError(error)),
                },
                Err(error) => local_error(error),
            },
            Err(error) => local_error(error),
        },
        Err(error) => {
            let mut response = error.into_response();
            mark_source(&mut response, "local");
            response
        }
    };
    response.headers_mut().insert(
        "x-yuanheng-request-id",
        HeaderValue::from_str(&request_id).expect("UUID is a valid header"),
    );
    let status_code = response.status();
    // Log only transport metadata: no OAuth tokens, prompts or base64 image data.
    log::info!(
        "[Images] request_id={} path={} content_type={} status={} upstream_request_id={} elapsed_ms={}",
        request_id,
        uri.path(),
        headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("-"),
        status_code.as_u16(),
        response
            .headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("-"),
        started.elapsed().as_millis(),
    );
    let mut status = state.status.write().await;
    if status_code.is_success() {
        status.success_requests += 1;
    } else {
        status.failed_requests += 1;
        status.last_error = Some(format!(
            "Images HTTP {status_code}, request_id={request_id}"
        ));
    }
    status.success_rate = status.success_requests as f32 / status.total_requests as f32 * 100.0;
    drop(status);
    // Keep Core's idle-upgrade guard until the downstream has consumed the image,
    // not merely until the upstream finishes generating it.
    let (parts, body) = response.into_parts();
    let stream = async_stream::stream! {
        let _guard = guard;
        let mut stream = body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            yield chunk;
        }
    };
    Response::from_parts(parts, Body::from_stream(stream))
}

fn provider_namespace(uri: &Uri) -> &'static str {
    if uri.path().starts_with("/chatgpt-desktop/v1/") {
        "chatgpt-desktop"
    } else {
        "codex"
    }
}

fn selected_provider(state: &ProxyState, uri: &Uri) -> Result<Provider, ProxyError> {
    // Deliberately bypass the chat failover queue and circuit breaker. Even its
    // first entry could differ from the user's selected account/provider.
    let namespace = provider_namespace(uri);
    let id = if namespace == "codex" {
        crate::settings::get_effective_current_provider(&state.db, &AppType::Codex)
    } else {
        // Desktop has its own account/group selection. Never fall back to the
        // CLI namespace, including when both use the same managed provider ID.
        state.db.get_current_provider(namespace)
    }
    .map_err(|e| ProxyError::DatabaseError(e.to_string()))?
    .ok_or(ProxyError::NoProvidersConfigured)?;
    state
        .db
        .get_provider_by_id(&id, namespace)
        .map_err(|e| ProxyError::DatabaseError(e.to_string()))?
        .ok_or(ProxyError::NoAvailableProvider)
}

async fn handle_image_models(
    State(state): State<ProxyState>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let _guard = ActiveConnectionGuard::acquire(state.status.clone()).await;
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut response = match selected_provider(&state, &uri)
        .and_then(|provider| prepare_model_catalog_request(&provider))
    {
        Ok((url, headers)) => match http_client::image_client() {
            Ok(client) => {
                fetch_image_models(
                    &client,
                    &url,
                    headers,
                    MODEL_CATALOG_TIMEOUT,
                    MODEL_CATALOG_LIMIT,
                )
                .await
            }
            Err(_) => local_error(ProxyError::ConfigError("无法创建图片模型目录连接".into())),
        },
        Err(error) => local_error(error),
    };
    response.headers_mut().insert(
        "x-yuanheng-request-id",
        HeaderValue::from_str(&request_id).expect("UUID is a valid header"),
    );
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    log::info!(
        "[ImageModels] request_id={} namespace={} status={}",
        request_id,
        provider_namespace(&uri),
        response.status().as_u16(),
    );
    response
}

fn prepare_model_catalog_request(provider: &Provider) -> Result<(String, HeaderMap), ProxyError> {
    // This endpoint exposes only YuanHeng's real, token-scoped authorization
    // catalog. Chat /models is a filtered compatibility catalog, not evidence
    // that an image model is authorized. Never borrow an account's global key.
    if provider.id != crate::commands::MANAGED_PROVIDER_ID
        || provider.category.as_deref() != Some("managed")
        || is_codex_official_provider(provider)
        || provider.uses_managed_account_auth()
    {
        return Err(ProxyError::ConfigError(
            "自动图片模型目录仅支持当前工具的元衡中转配置".into(),
        ));
    }
    let adapter = CodexAdapter::new();
    let base_url = adapter.extract_base_url(provider)?;
    if !crate::yuanheng_endpoints::is_managed_endpoint(&base_url, &["", "/v1"], false) {
        return Err(ProxyError::ConfigError(
            "当前工具的元衡接口配置无效，请重新应用元衡中转配置".into(),
        ));
    }
    let auth = adapter
        .extract_auth(provider)
        .filter(|auth| auth.strategy == AuthStrategy::Bearer && !auth.api_key.trim().is_empty())
        .ok_or_else(|| ProxyError::AuthError("当前工具缺少元衡 API 凭据".into()))?;
    let mut headers = HeaderMap::new();
    // Construct from scratch: caller OAuth, cookies, organization and account
    // headers must never be sent to the token-scoped platform catalog.
    for (name, value) in adapter.get_auth_headers(&auth)? {
        headers.insert(name, value);
    }
    headers.insert("accept", HeaderValue::from_static("application/json"));
    headers.insert("accept-encoding", HeaderValue::from_static("identity"));
    Ok((adapter.build_url(&base_url, "/models"), headers))
}

async fn fetch_image_models(
    client: &reqwest::Client,
    url: &str,
    headers: HeaderMap,
    timeout: Duration,
    response_limit: usize,
) -> Response {
    let upstream = match client
        .get(url)
        .headers(headers)
        .timeout(timeout)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return catalog_transport_error(error),
    };
    if !upstream.status().is_success() {
        // Preserve useful 4xx/5xx status but never proxy response bodies or
        // headers: upstream failures may echo credentials or private metadata.
        let status = if upstream.status().is_redirection() {
            502
        } else {
            upstream.status().as_u16()
        };
        let mut response = local_error(ProxyError::UpstreamError { status, body: None });
        mark_source(&mut response, "upstream");
        return response;
    }
    let mut stream = upstream.bytes_stream();
    let mut bytes = bytes::BytesMut::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) if bytes.len().saturating_add(chunk.len()) <= response_limit => {
                bytes.extend_from_slice(&chunk);
            }
            Ok(_) => return local_error(ProxyError::ResponseBodyTooLarge(response_limit)),
            Err(error) => return catalog_transport_error(error),
        }
    }
    match parse_image_models(&bytes) {
        Ok(models) => {
            let mut response = Json(models).into_response();
            mark_source(&mut response, "upstream");
            response
        }
        Err(error) => local_error(error),
    }
}

fn catalog_transport_error(error: reqwest::Error) -> Response {
    // Avoid even URL-free transport details: lower-level sources can include
    // proxy configuration. Catalog lookup has no paid image side effects.
    local_error(if error.is_timeout() {
        ProxyError::Timeout("读取图片模型目录超时".into())
    } else {
        ProxyError::ForwardFailed("读取图片模型目录失败".into())
    })
}

fn parse_image_models(bytes: &[u8]) -> Result<Value, ProxyError> {
    let invalid = || ProxyError::ForwardFailed("上游图片模型目录格式无效".into());
    let body: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let entries = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let mut models = BTreeSet::new();
    for entry in entries {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        if id.is_empty() || id.len() > 256 || id.trim() != id || id.chars().any(char::is_control) {
            return Err(invalid());
        }
        if crate::model_capabilities::is_image_generation_only_model(id) {
            models.insert(id);
        }
    }
    // No owner, permission, URLs, pricing or other upstream fields cross this
    // boundary. An empty authorized image catalog is valid and stays empty.
    Ok(
        json!({"object": "list", "data": models.into_iter().map(|id| json!({"id": id})).collect::<Vec<_>>() }),
    )
}

fn prepare_request(
    provider: &Provider,
    uri: &Uri,
    incoming: &HeaderMap,
) -> Result<(String, HeaderMap), ProxyError> {
    let operation = uri.path().rsplit('/').next().unwrap_or_default();
    if !matches!(operation, "generations" | "edits") {
        return Err(ProxyError::InvalidRequest("未知图片操作".into()));
    }
    let adapter = CodexAdapter::new();
    let official = is_codex_official_provider(provider);
    let mut outgoing = end_to_end_headers(incoming);
    // Host/length belong to the new connection. Other content headers (including
    // multipart boundary or JSON content type) and the body remain byte-for-byte.
    for name in [
        "host",
        "content-length",
        "proxy-authorization",
        "cookie",
        "x-api-key",
        "x-goog-api-key",
    ] {
        outgoing.remove(name);
    }
    if official {
        // The adapter pins the official origin. Never send ChatGPT credentials
        // to a user-editable base URL, nor substitute a stored API key.
        validate_codex_official_authorization(&outgoing)?;
    } else {
        // A client OAuth identity must never leak to a different provider.
        for name in [
            "authorization",
            "chatgpt-account-id",
            "openai-organization",
            "openai-project",
        ] {
            outgoing.remove(name);
        }
        if provider.uses_managed_account_auth() {
            return Err(ProxyError::ConfigError(
                "当前托管供应商尚不支持图片透传；Codex 官方登录请使用 OpenAI Official".into(),
            ));
        }
        let auth = adapter
            .extract_auth(provider)
            .ok_or_else(|| ProxyError::AuthError("当前图片供应商缺少自己的鉴权配置".into()))?;
        if auth.strategy != AuthStrategy::Bearer {
            return Err(ProxyError::ConfigError(
                "当前供应商不是 OpenAI Images 兼容接口".into(),
            ));
        }
        for (name, value) in adapter.get_auth_headers(&auth)? {
            outgoing.insert(name, value);
        }
    }
    let base_url = adapter.extract_base_url(provider)?;
    let mut url = adapter.build_url(&base_url, &format!("/images/{operation}"));
    if let Some(query) = uri.query() {
        url.push('?');
        url.push_str(query);
    }
    Ok((url, outgoing))
}

fn end_to_end_headers(headers: &HeaderMap) -> HeaderMap {
    let mut result = headers.clone();
    // RFC hop-by-hop headers include names nominated by Connection, not just
    // the standard list. Preserve upstream error/request IDs and encodings.
    for value in headers.get_all("connection") {
        if let Ok(value) = value.to_str() {
            for name in value.split(',').map(str::trim) {
                result.remove(name);
            }
        }
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        result.remove(name);
    }
    result
}

async fn send_once(
    client: &reqwest::Client,
    url: &str,
    headers: HeaderMap,
    body: Bytes,
    timeout: Duration,
    response_limit: usize,
) -> Response {
    let upstream = match client
        .post(url)
        .headers(headers)
        .body(body)
        .timeout(timeout)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return transport_error(error),
    };
    let status = upstream.status();
    let mut headers = end_to_end_headers(upstream.headers());
    headers.remove("content-length");
    let mut stream = upstream.bytes_stream();
    let mut bytes = bytes::BytesMut::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) if bytes.len().saturating_add(chunk.len()) <= response_limit => {
                bytes.extend_from_slice(&chunk)
            }
            chunk => {
                let mut response = match chunk {
                    Err(error) => transport_error(error),
                    Ok(_) => local_error(ProxyError::ResponseBodyTooLarge(response_limit)),
                };
                // The response failed after upstream accepted the operation.
                // Retain its identifiers for support/reconciliation, never retry.
                for name in [
                    "x-request-id",
                    "request-id",
                    "x-codex-imagegen-request-id",
                    "cf-ray",
                ] {
                    if let Some(value) = headers.get(name) {
                        response.headers_mut().insert(name, value.clone());
                    }
                }
                response.headers_mut().insert(
                    "x-yuanheng-upstream-status",
                    HeaderValue::from(status.as_u16()),
                );
                return response;
            }
        }
    }
    let mut response = Response::new(Body::from(bytes.freeze()));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    // Even an empty upstream 404 can now be distinguished from a missing route.
    mark_source(&mut response, "upstream");
    response
}

fn transport_error(error: reqwest::Error) -> Response {
    let timed_out = error.is_timeout();
    let message = format!(
        "图片请求结果可能未确定，未自动重试或切换供应商，请核实后再提交: {}",
        error.without_url(),
    );
    local_error(if timed_out {
        ProxyError::Timeout(message)
    } else {
        ProxyError::ForwardFailed(message)
    })
}

fn local_error(error: ProxyError) -> Response {
    let mut response = error.into_response();
    mark_source(&mut response, "local");
    response
}

fn mark_source(response: &mut Response, source: &'static str) {
    response.headers_mut().insert(
        "x-yuanheng-response-source",
        HeaderValue::from_static(source),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use crate::proxy::{
        failover_switch::FailoverSwitchManager,
        provider_router::ProviderRouter,
        providers::{codex_chat_history::CodexChatHistoryStore, gemini_shadow::GeminiShadowStore},
        types::{ProxyConfig, ProxyStatus},
    };
    use axum::{body::to_bytes, http::StatusCode, routing::any};
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::RwLock;

    fn managed(key: &str) -> Provider {
        let mut provider = Provider::with_id(
            crate::commands::MANAGED_PROVIDER_ID.into(),
            "YuanHeng".into(),
            json!({"base_url": crate::yuanheng_endpoints::API_URL, "auth": {"OPENAI_API_KEY": key}}),
            None,
        );
        provider.category = Some("managed".into());
        provider
    }

    fn state(db: Arc<Database>) -> ProxyState {
        ProxyState {
            db: db.clone(),
            config: Arc::new(RwLock::new(ProxyConfig::default())),
            status: Arc::new(RwLock::new(ProxyStatus::default())),
            start_time: Arc::new(RwLock::new(None)),
            current_providers: Arc::new(RwLock::new(std::collections::HashMap::new())),
            provider_router: Arc::new(ProviderRouter::new(db.clone())),
            gemini_shadow: Arc::new(GeminiShadowStore::default()),
            codex_chat_history: Arc::new(CodexChatHistoryStore::default()),
            app_handle: None,
            core_control: None,
            auth_managers: None,
            failover_manager: Arc::new(FailoverSwitchManager::new(db)),
        }
    }

    #[test]
    #[serial_test::serial]
    fn image_namespaces_use_their_own_current_account_and_never_fall_back() {
        struct RestoreHome(Option<std::ffi::OsString>);
        impl Drop for RestoreHome {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(value) => std::env::set_var("YUANHENG_SWITCH_TEST_HOME", value),
                    None => std::env::remove_var("YUANHENG_SWITCH_TEST_HOME"),
                }
                let _ = crate::settings::reload_settings();
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let _restore = RestoreHome(std::env::var_os("YUANHENG_SWITCH_TEST_HOME"));
        std::env::set_var("YUANHENG_SWITCH_TEST_HOME", dir.path());
        crate::settings::reload_settings().unwrap();
        let db = Arc::new(Database::memory().unwrap());
        for (namespace, key) in [("codex", "cli-key"), ("chatgpt-desktop", "desktop-key")] {
            let provider = managed(key);
            db.save_provider(namespace, &provider).unwrap();
            db.set_current_provider(namespace, &provider.id).unwrap();
        }
        let state = state(db.clone());
        for (prefix, expected) in [
            ("", "Bearer cli-key"),
            ("/v1", "Bearer cli-key"),
            ("/v1/v1", "Bearer cli-key"),
            ("/codex/v1", "Bearer cli-key"),
            ("/chatgpt-desktop/v1", "Bearer desktop-key"),
        ] {
            for operation in ["generations", "edits", "models"] {
                let uri = format!("{prefix}/images/{operation}").parse().unwrap();
                let provider = selected_provider(&state, &uri).unwrap();
                let (_, headers) = if operation == "models" {
                    prepare_model_catalog_request(&provider).unwrap()
                } else {
                    prepare_request(&provider, &uri, &oauth_headers()).unwrap()
                };
                assert_eq!(headers["authorization"], expected, "{uri}");
                assert!(!headers.contains_key("chatgpt-account-id"));
            }
        }
        db.delete_provider("chatgpt-desktop", &managed("unused").id)
            .unwrap();
        let uri = "/chatgpt-desktop/v1/images/models".parse().unwrap();
        assert!(matches!(
            selected_provider(&state, &uri),
            Err(ProxyError::NoProvidersConfigured)
        ));
        assert!(selected_provider(&state, &"/codex/v1/images/models".parse().unwrap()).is_ok());
    }

    #[test]
    fn catalog_requires_genuine_current_yuanheng_provider_and_own_bearer() {
        let valid = managed("test-platform-key");
        let (url, headers) = prepare_model_catalog_request(&valid).unwrap();
        assert_eq!(url, "https://meta-api.vip/v1/models");
        assert_eq!(headers["authorization"], "Bearer test-platform-key");
        assert_eq!(headers.len(), 3);
        assert_eq!(headers["accept-encoding"], "identity");
        let mut wrong_id = valid.clone();
        wrong_id.id = "external-provider".into();
        let mut wrong_category = valid.clone();
        wrong_category.category = Some("custom".into());
        let mut managed_oauth = valid.clone();
        managed_oauth.meta = Some(crate::provider::ProviderMeta {
            provider_type: Some("codex_oauth".into()),
            ..Default::default()
        });
        for provider in [official(), wrong_id, wrong_category, managed_oauth] {
            assert!(matches!(
                prepare_model_catalog_request(&provider),
                Err(ProxyError::ConfigError(_))
            ));
        }
        for endpoint in [
            "https://cn.meta-api.vip/v1",
            "https://outside.example/v1",
            "https://meta-api.vip.evil.example/v1",
            "http://meta-api.vip/v1",
            "https://meta-api.vip/v1?key=secret",
        ] {
            let mut provider = valid.clone();
            provider.settings_config["base_url"] = json!(endpoint);
            assert!(matches!(
                prepare_model_catalog_request(&provider),
                Err(ProxyError::ConfigError(_))
            ));
        }
        let mut no_key = valid;
        no_key.settings_config["auth"] = json!({});
        assert!(matches!(
            prepare_model_catalog_request(&no_key),
            Err(ProxyError::AuthError(_))
        ));
    }

    #[test]
    fn image_catalog_validates_shape_filters_images_and_drops_upstream_fields() {
        let raw = json!({"private":"secret", "data":[
            {"id":"gpt-6-astra", "owner":"account-a"},
            {"id":"gpt-image-2.5-sunburst", "permission":{"key":"secret"}},
            {"id":"gpt-image-2.5-flare", "url":"https://private.example"},
            {"id":"gpt-image-2.5-sunburst"},
            {"id":"gpt-image-3"}
        ]});
        assert_eq!(
            parse_image_models(&serde_json::to_vec(&raw).unwrap()).unwrap(),
            json!({"object":"list", "data":[
                {"id":"gpt-image-2.5-flare"},
                {"id":"gpt-image-2.5-sunburst"},
                {"id":"gpt-image-3"}
            ]})
        );
        for raw in [r#"{"data":[]}"#, r#"{"data":[{"id":"text-model"}]}"#] {
            assert_eq!(
                parse_image_models(raw.as_bytes()).unwrap(),
                json!({"object":"list","data":[]})
            );
        }
        for raw in [
            "not json",
            r#"{"error":"secret"}"#,
            r#"{"data":{}}"#,
            r#"{"data":["gpt-image-2.5"]}"#,
            r#"{"data":[{"id":5}]}"#,
            r#"{"data":[{"id":" gpt-image-2.5"}]}"#,
            r#"{"data":[{"id":"gpt-image-2.5\nsecret"}]}"#,
        ] {
            let error = parse_image_models(raw.as_bytes()).unwrap_err();
            assert!(!error.to_string().contains("secret"));
            assert!(matches!(error, ProxyError::ForwardFailed(_)));
        }
    }

    fn official() -> Provider {
        let mut provider = Provider::with_id(
            "codex-official".into(),
            "OpenAI Official".into(),
            json!({"base_url":"https://wrong.example", "model":"chat-model", "auth":{"OPENAI_API_KEY":"wrong-key"}}),
            None,
        );
        provider.category = Some("official".into());
        provider
    }

    fn oauth_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("authorization", "Bearer test-oauth"),
            ("chatgpt-account-id", "test-account"),
            ("originator", "codex_cli_rs"),
            ("version", "0.155.0-alpha.16.4"),
            ("session_id", "test-session"),
            ("x-codex-imagegen-request-id", "image-id"),
            ("x-codex-image-turn-id", "turn-id"),
            ("content-type", "application/json"),
            ("host", "localhost:15721"),
            ("connection", "keep-alive, x-hop"),
            ("x-hop", "secret-hop"),
        ] {
            headers.insert(name, HeaderValue::from_static(value));
        }
        headers
    }

    #[test]
    fn official_images_pin_origin_and_preserve_client_oauth_identity() {
        for operation in ["generations", "edits"] {
            for prefix in ["", "/v1", "/v1/v1", "/codex/v1"] {
                let uri = format!("{prefix}/images/{operation}?trace=1")
                    .parse()
                    .unwrap();
                let (url, headers) = prepare_request(&official(), &uri, &oauth_headers()).unwrap();
                assert_eq!(
                    url,
                    format!("https://chatgpt.com/backend-api/codex/images/{operation}?trace=1")
                );
                for name in [
                    "authorization",
                    "chatgpt-account-id",
                    "originator",
                    "version",
                    "session_id",
                    "x-codex-imagegen-request-id",
                    "x-codex-image-turn-id",
                    "content-type",
                ] {
                    assert_eq!(headers[name], oauth_headers()[name]);
                }
                for name in ["host", "connection", "x-hop"] {
                    assert!(!headers.contains_key(name));
                }
            }
        }
    }

    #[test]
    fn official_images_require_client_oauth_and_third_parties_use_own_key() {
        let uri = "/v1/images/edits".parse().unwrap();
        assert!(matches!(
            prepare_request(&official(), &uri, &HeaderMap::new()),
            Err(ProxyError::AuthError(_))
        ));
        let mut headers = oauth_headers();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer PROXY_MANAGED"),
        );
        assert!(matches!(
            prepare_request(&official(), &uri, &headers),
            Err(ProxyError::AuthError(_))
        ));
        let provider = Provider::with_id(
            "api".into(),
            "API".into(),
            json!({
                "base_url": "https://api.example/v1", "auth": {"OPENAI_API_KEY": "own-key"}
            }),
            None,
        );
        let (url, headers) = prepare_request(&provider, &uri, &oauth_headers()).unwrap();
        assert_eq!(url, "https://api.example/v1/images/edits");
        assert_eq!(headers["authorization"], "Bearer own-key");
        assert!(!headers.contains_key("chatgpt-account-id"));
    }

    async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (url, task)
    }

    fn client() -> reqwest::Client {
        http_client::image_no_replay_policy(reqwest::Client::builder().no_proxy())
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn catalog_get_uses_only_provider_credentials_and_returns_only_model_ids() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (url, task) = serve(Router::new().route(
            "/v1/models",
            get(move |headers: HeaderMap| {
                let tx = tx.clone();
                async move {
                    tx.send(headers).unwrap();
                    (
                        [("x-private", "secret"), ("set-cookie", "secret-cookie")],
                        Json(json!({"data":[{"id":"gpt-image-2.5-sunburst", "owner":"secret-owner"}, {"id":"gpt-6-astra"}]})),
                    )
                }
            }),
        ))
        .await;
        let (_, headers) = prepare_model_catalog_request(&managed("own-test-key")).unwrap();
        let response = fetch_image_models(
            &client(),
            &format!("{url}/v1/models"),
            headers,
            Duration::from_secs(2),
            1024,
        )
        .await;
        let received = rx.recv().await.unwrap();
        assert_eq!(received["authorization"], "Bearer own-test-key");
        for name in [
            "chatgpt-account-id",
            "openai-organization",
            "openai-project",
            "cookie",
        ] {
            assert!(!received.contains_key(name));
        }
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key("x-private"));
        assert!(!response.headers().contains_key("set-cookie"));
        assert_eq!(
            serde_json::from_slice::<Value>(&to_bytes(response.into_body(), 1024).await.unwrap())
                .unwrap(),
            json!({"object":"list", "data":[{"id":"gpt-image-2.5-sunburst"}]})
        );
        task.abort();
    }

    #[tokio::test]
    async fn catalog_errors_and_redirects_are_redacted_and_never_replayed() {
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::TEMPORARY_REDIRECT,
        ] {
            let count = Arc::new(AtomicUsize::new(0));
            let seen = count.clone();
            let (url, task) = serve(Router::new().fallback(any(move || {
                let seen = seen.clone();
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    (
                        status,
                        [("location", "/redirect"), ("x-private", "secret")],
                        "test-oauth test-platform-key secret-account",
                    )
                }
            })))
            .await;
            let response = fetch_image_models(
                &client(),
                &url,
                HeaderMap::new(),
                Duration::from_secs(2),
                1024,
            )
            .await;
            assert_eq!(
                response.status(),
                if status.is_redirection() {
                    StatusCode::BAD_GATEWAY
                } else {
                    status
                }
            );
            assert!(!response.headers().contains_key("location"));
            assert!(!response.headers().contains_key("x-private"));
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            let text = String::from_utf8_lossy(&body);
            for secret in ["test-oauth", "test-platform-key", "secret-account"] {
                assert!(!text.contains(secret));
            }
            assert_eq!(count.load(Ordering::SeqCst), 1);
            task.abort();
        }
    }

    #[tokio::test]
    async fn catalog_response_size_timeout_and_invalid_json_fail_without_retry() {
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let (url, task) = serve(Router::new().fallback(any(move || {
            let seen = seen.clone();
            async move {
                seen.fetch_add(1, Ordering::SeqCst);
                Body::from_stream(async_stream::stream! {
                    yield Ok::<_, std::io::Error>(Bytes::from_static(b"private-error-contents"));
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    yield Ok(Bytes::from_static(b"invalid-json"));
                })
            }
        })))
        .await;
        for (timeout, limit, expected) in [
            (Duration::from_secs(2), 4, StatusCode::BAD_GATEWAY),
            (Duration::from_millis(30), 1024, StatusCode::GATEWAY_TIMEOUT),
            (Duration::from_secs(2), 1024, StatusCode::BAD_GATEWAY),
        ] {
            let response =
                fetch_image_models(&client(), &url, HeaderMap::new(), timeout, limit).await;
            assert_eq!(response.status(), expected);
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            assert!(!String::from_utf8_lossy(&body).contains("private-error-contents"));
        }
        assert_eq!(count.load(Ordering::SeqCst), 3);
        task.abort();
    }

    #[tokio::test]
    async fn json_image_references_and_multipart_are_forwarded_byte_for_byte() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let router = Router::new().route(
            "/images/edits",
            post(move |headers: HeaderMap, body: Bytes| {
                let tx = tx.clone();
                async move {
                    tx.send((headers, body)).unwrap();
                    (
                        [
                            ("x-request-id", "upstream-image-id"),
                            ("content-type", "application/json"),
                        ],
                        r#"{"data":[{"b64_json":"aW1hZ2U="}]}"#,
                    )
                }
            }),
        );
        let (url, task) = serve(router).await;
        for (content_type, body) in [
            ("application/json", r#"{ "model":"gpt-image-2", "images":[{"image_url":"data:image/png;base64,aW1hZ2U="}], "prompt":"make it blue", "size":"1024x1024", "quality":"low", "n":1 }"#),
            ("multipart/form-data; boundary=test", "--test\r\nContent-Disposition: form-data; name=\"image\"; filename=\"test.png\"\r\nContent-Type: image/png\r\n\r\nimage\r\n--test--\r\n"),
        ] {
            let mut headers = oauth_headers();
            headers.insert("content-type", HeaderValue::from_str(content_type).unwrap());
            let response = send_once(&client(), &format!("{url}/images/edits"), headers, Bytes::from(body), Duration::from_secs(2), 1024).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["x-request-id"], "upstream-image-id");
            let (received_headers, received_body) = rx.recv().await.unwrap();
            assert_eq!(received_body, body);
            assert_eq!(received_headers["content-type"], content_type);
            assert_eq!(received_headers["authorization"], "Bearer test-oauth");
            assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), r#"{"data":[{"b64_json":"aW1hZ2U="}]}"#);
        }
        task.abort();
    }

    #[tokio::test]
    async fn upstream_errors_and_redirects_preserve_status_body_ids_without_replay() {
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::TEMPORARY_REDIRECT,
        ] {
            let count = Arc::new(AtomicUsize::new(0));
            let seen = count.clone();
            let (url, task) = serve(Router::new().fallback(any(move || {
                let seen = seen.clone();
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    (
                        status,
                        [
                            ("x-request-id", "upstream-error-id"),
                            ("location", "/redirect"),
                            ("retry-after", "30"),
                        ],
                        "upstream error unchanged",
                    )
                }
            })))
            .await;
            let response = send_once(
                &client(),
                &url,
                oauth_headers(),
                Bytes::from_static(b"{}"),
                Duration::from_secs(2),
                1024,
            )
            .await;
            assert_eq!(response.status(), status);
            assert_eq!(response.headers()["x-request-id"], "upstream-error-id");
            assert_eq!(response.headers()["retry-after"], "30");
            assert_eq!(response.headers()["x-yuanheng-response-source"], "upstream");
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap(),
                "upstream error unchanged"
            );
            assert_eq!(count.load(Ordering::SeqCst), 1);
            task.abort();
        }
    }

    #[tokio::test]
    async fn image_response_limit_and_body_timeout_keep_upstream_request_id() {
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let (url, task) = serve(Router::new().fallback(any(move || {
            let seen = seen.clone();
            async move {
                seen.fetch_add(1, Ordering::SeqCst);
                let body = Body::from_stream(async_stream::stream! {
                    yield Ok::<_, std::io::Error>(Bytes::from_static(b"first"));
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    yield Ok(Bytes::from_static(b"last"));
                });
                ([("x-request-id", "partial-image-id")], body)
            }
        })))
        .await;
        for (timeout, limit, expected) in [
            (Duration::from_secs(2), 4, StatusCode::BAD_GATEWAY),
            (Duration::from_millis(50), 1024, StatusCode::GATEWAY_TIMEOUT),
        ] {
            let response = send_once(
                &client(),
                &url,
                HeaderMap::new(),
                Bytes::new(),
                timeout,
                limit,
            )
            .await;
            assert_eq!(response.status(), expected);
            assert_eq!(response.headers()["x-request-id"], "partial-image-id");
            assert_eq!(response.headers()["x-yuanheng-response-source"], "local");
            assert_eq!(response.headers()["x-yuanheng-upstream-status"], "200");
        }
        assert_eq!(count.load(Ordering::SeqCst), 2);
        task.abort();
    }
}
