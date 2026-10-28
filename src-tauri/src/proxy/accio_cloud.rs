//! Inspected read-only Accio account/catalog queries. Never tool execution.
use super::{content_encoding, server::ProxyState};
use axum::{
    body::to_bytes,
    extract::Request,
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, OnceLock},
    time::Duration,
};

const REQUEST_LIMIT: usize = 16 * 1024;
const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const ERROR_DELAY: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Query {
    Plugins,
    Plugin,
    Channels,
    ChannelStatus,
}

impl Query {
    pub(super) fn from_path(path: &str) -> Option<Self> {
        match path {
            "plugin/list" => Some(Self::Plugins),
            "plugin/detail" => Some(Self::Plugin),
            "channel/query" => Some(Self::Channels),
            "channel/authorization/status" => Some(Self::ChannelStatus),
            _ => None,
        }
    }

    fn method(self) -> Method {
        if self.connector() {
            Method::POST
        } else {
            Method::GET
        }
    }

    fn connector(self) -> bool {
        matches!(self, Self::Channels | Self::ChannelStatus)
    }

    fn url(self) -> &'static str {
        match self {
            Self::Plugins => "https://phoenix-gw.alibaba.com/api/plugin/list",
            Self::Plugin => "https://phoenix-gw.alibaba.com/api/plugin/detail",
            Self::Channels => "https://phoenix-gw.alibaba.com/api/channel/query",
            Self::ChannelStatus => {
                "https://phoenix-gw.alibaba.com/api/channel/authorization/status"
            }
        }
    }
}

// Struct decoding rejects duplicate JSON keys, unlike decoding into Value first.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Fields {
    access_token: Option<String>,
    lang: Option<String>,
    plugin_code: Option<String>,
    provider: Option<String>,
    package_region: Option<String>,
    ip_region: Option<String>,
    version: Option<String>,
    utdid: Option<String>,
}

fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

fn normalized(query: Query, raw_query: Option<&str>, body: &[u8]) -> Result<Value, ()> {
    let fields: Fields = if query.connector() {
        if raw_query.is_some() {
            return Err(());
        }
        serde_json::from_slice(body).map_err(|_| ())?
    } else {
        if !body.is_empty() {
            return Err(());
        }
        let raw = raw_query.unwrap_or("");
        if raw.len() > REQUEST_LIMIT {
            return Err(());
        }
        let mut values = BTreeMap::new();
        for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
            if values
                .insert(key.into_owned(), value.into_owned())
                .is_some()
            {
                return Err(());
            }
        }
        serde_json::from_value(serde_json::to_value(values).map_err(|_| ())?).map_err(|_| ())?
    };
    let mut out = serde_json::Map::new();
    if let Some(token) = fields.access_token {
        if token.is_empty()
            || token.len() > 8192
            || !token.bytes().all(|c| (33..=126).contains(&c))
            || token == "PROXY_MANAGED"
        {
            return Err(());
        }
        out.insert("accessToken".into(), json!(token));
    } else if query.connector() {
        return Err(());
    }
    for (key, value, allowed, max) in [
        ("lang", fields.lang, !query.connector(), 32),
        (
            "pluginCode",
            fields.plugin_code,
            query == Query::Plugin,
            128,
        ),
        (
            "provider",
            fields.provider,
            query == Query::ChannelStatus,
            128,
        ),
        (
            "packageRegion",
            fields.package_region,
            query.connector(),
            32,
        ),
        ("ipRegion", fields.ip_region, query.connector(), 2),
        ("version", fields.version, true, 32),
    ] {
        if let Some(value) = value {
            if !allowed || !identifier(&value, max) {
                return Err(());
            }
            out.insert(key.into(), json!(value));
        }
    }
    if query == Query::Plugin && !out.contains_key("pluginCode")
        || query == Query::ChannelStatus && !out.contains_key("provider")
    {
        return Err(());
    }
    // The inspected official interceptor adds a device ID to every request.
    // Accept its shape for compatibility but never transmit it on this route.
    if fields
        .utdid
        .is_some_and(|id| id.len() > 256 || id.chars().any(char::is_control))
    {
        return Err(());
    }
    Ok(Value::Object(out))
}

fn outgoing_headers(source: &HeaderMap) -> Result<HeaderMap, ()> {
    let mut headers = HeaderMap::new();
    for name in [
        "x-team-id",
        "x-language",
        "x-locale",
        "x-app-version",
        "x-package-region",
        "x-ip-region",
        "x-platform",
        "x-os",
        "x-deploy-target",
        "x-source",
    ] {
        if let Some(value) = source.get(name) {
            let text = value.to_str().map_err(|_| ())?;
            if text.len() > 256 || !text.bytes().all(|c| (32..=126).contains(&c)) {
                return Err(());
            }
            headers.insert(name, value.clone());
        }
    }
    headers.insert("accept", HeaderValue::from_static("application/json"));
    headers.insert("accept-encoding", HeaderValue::from_static("identity"));
    Ok(headers)
}

struct Reply {
    status: StatusCode,
    body: Vec<u8>,
    failed: bool,
}

fn matches_model_secret(value: &Value, token: &str) -> bool {
    match value {
        Value::String(text) => {
            text == token
                || text.lines().any(|line| {
                    line.split_once('=')
                        .is_some_and(|(_, v)| v.trim().trim_matches('"') == token)
                })
        }
        Value::Object(fields) => fields
            .values()
            .any(|value| matches_model_secret(value, token)),
        Value::Array(values) => values
            .iter()
            .any(|value| matches_model_secret(value, token)),
        _ => false,
    }
}

fn valid_success(query: Query, value: &Value) -> bool {
    let data = value.get("data").unwrap_or(value);
    match query {
        Query::Plugins => data.is_array() || data.get("plugins").is_some_and(Value::is_array),
        Query::Plugin => {
            data.is_null()
                || data.get("pluginCode").is_some_and(Value::is_string)
                || data.get("components").is_some_and(Value::is_array)
                || data.get("manifest").is_some_and(Value::is_object)
        }
        Query::Channels | Query::ChannelStatus => {
            let Some(fields) = data.as_object() else {
                return false;
            };
            if let Some(authorizations) = fields.get("authorizations") {
                return authorizations.as_array().is_some_and(|items| {
                    items.iter().all(|item| {
                        item.get("provider")
                            .and_then(Value::as_str)
                            .is_some_and(|name| !name.is_empty())
                    })
                });
            }
            // Older official replies group authorizations by provider name.
            // Unknown/empty objects must not erase the app's stored accounts.
            fields
                .iter()
                .any(|(key, value)| key != "connectorVisibility" && value.is_array())
                && fields
                    .iter()
                    .filter(|(key, _)| *key != "connectorVisibility")
                    .all(|(_, value)| {
                        value
                            .as_array()
                            .is_some_and(|items| items.iter().all(Value::is_object))
                    })
        }
    }
}

async fn send(
    client: &reqwest::Client,
    query: Query,
    url: &str,
    headers: HeaderMap,
    input: &Value,
) -> Result<Reply, ()> {
    let mut request = client.request(query.method(), url).headers(headers);
    request = if query.connector() {
        request.json(input)
    } else {
        request.query(input)
    };
    let response = request.send().await.map_err(|_| ())?;
    let status = response.status();
    if status.is_redirection()
        || !response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
            })
    {
        return Err(());
    }
    let encoding = content_encoding::get_content_encoding(response.headers());
    if encoding.as_ref().is_some_and(|v| v.contains(',')) {
        return Err(());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ())?;
        if body.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    if let Some(encoding) = encoding {
        body = content_encoding::decompress_body_with_limit(&encoding, &body, RESPONSE_LIMIT)
            .map_err(|_| ())?
            .ok_or(())?;
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| ())?;
    if !(value.is_object() || value.is_array() || (query == Query::Plugin && value.is_null())) {
        return Err(());
    }
    let failed = !status.is_success() || value.get("success") == Some(&Value::Bool(false));
    if !failed && !valid_success(query, &value) {
        return Err(());
    }
    Ok(Reply {
        status,
        body,
        failed,
    })
}

async fn failure(query: Query, status: StatusCode, message: &'static str) -> Response {
    if query.connector() {
        tokio::time::sleep(ERROR_DELAY).await;
    }
    (
        status,
        [("cache-control", "no-store"), ("retry-after", "5")],
        Json(json!({"success":false,"code":"YUANHENG_ACCIO_CLOUD_QUERY_FAILED","message":message})),
    )
        .into_response()
}

pub(super) async fn handle(
    state: &ProxyState,
    capability: &str,
    query: Query,
    request: Request,
) -> Response {
    if request.method() != query.method() || request.headers().contains_key("content-encoding") {
        return failure(
            query,
            StatusCode::BAD_REQUEST,
            "Accio 只读查询的方法或编码无效",
        )
        .await;
    }
    if query.connector()
        && !request
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
            })
    {
        return failure(
            query,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Accio 连接状态查询必须为 JSON",
        )
        .await;
    }
    static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = match SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
        .try_acquire_owned()
    {
        Ok(permit) => permit,
        Err(_) => {
            return failure(
                query,
                StatusCode::TOO_MANY_REQUESTS,
                "Accio 官方只读查询过多，请稍后重试",
            )
            .await
        }
    };
    let (parts, body) = request.into_parts();
    let bytes =
        match tokio::time::timeout(Duration::from_secs(3), to_bytes(body, REQUEST_LIMIT)).await {
            Ok(Ok(bytes)) => bytes,
            _ => {
                return failure(
                    query,
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Accio 只读查询过大或读取超时",
                )
                .await
            }
        };
    let input = match normalized(query, parts.uri.query(), &bytes) {
        Ok(input) => input,
        Err(_) => {
            return failure(
                query,
                StatusCode::BAD_REQUEST,
                "Accio 只读查询字段无效；请求未发送",
            )
            .await
        }
    };
    let headers = match outgoing_headers(&parts.headers) {
        Ok(headers) => headers,
        Err(_) => return failure(query, StatusCode::BAD_REQUEST, "Accio 只读查询请求头无效").await,
    };
    // Recheck the live child after reading a potentially slow request body.
    match state.accio_runtime.authorized_profile(&state.db) {
        Ok(profile) if profile.authorizes(capability) => {
            if input
                .get("accessToken")
                .and_then(Value::as_str)
                .is_some_and(|token| {
                    token == capability
                        || state
                            .core_control
                            .as_ref()
                            .is_some_and(|control| control.token.as_ref() == token)
                        || matches_model_secret(&profile.provider.settings_config, token)
                })
            {
                return failure(
                    query,
                    StatusCode::BAD_REQUEST,
                    "Accio 只读查询不能使用元衡模型凭据",
                )
                .await;
            }
        }
        _ => {
            return failure(
                query,
                StatusCode::UNAUTHORIZED,
                "Accio 连接已失效，请从元衡重新启动",
            )
            .await
        }
    }
    let client = match super::http_client::route_client() {
        Ok(client) => client,
        Err(_) => {
            return failure(
                query,
                StatusCode::BAD_GATEWAY,
                "Accio 官方只读服务连接失败；未重试",
            )
            .await
        }
    };
    let connection = super::forwarder::ActiveConnectionGuard::acquire(state.status.clone()).await;
    let reply = tokio::time::timeout(
        Duration::from_secs(20),
        send(&client, query, query.url(), headers, &input),
    )
    .await;
    drop(connection);
    drop(input);
    drop(bytes);
    drop(parts);
    drop(permit);
    match reply {
        Ok(Ok(reply)) => {
            if reply.failed && query.connector() {
                tokio::time::sleep(ERROR_DELAY).await;
            }
            (
                reply.status,
                [
                    ("content-type", "application/json"),
                    ("cache-control", "no-store"),
                    ("retry-after", "5"),
                ],
                reply.body,
            )
                .into_response()
        }
        _ => {
            failure(
                query,
                StatusCode::BAD_GATEWAY,
                "Accio 官方只读服务连接失败；未重试，未返回空授权",
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accio_readonly_queries_have_exact_paths_methods_and_official_origin() {
        for path in [
            "plugin/list",
            "plugin/detail",
            "channel/query",
            "channel/authorization/status",
        ] {
            let query = Query::from_path(path).unwrap();
            let url = url::Url::parse(query.url()).unwrap();
            assert_eq!(
                url.origin().ascii_serialization(),
                "https://phoenix-gw.alibaba.com"
            );
            assert_eq!(
                query.method(),
                if path.starts_with("plugin/") {
                    Method::GET
                } else {
                    Method::POST
                }
            );
        }
        for path in [
            "mcp/proxy",
            "channel/remove",
            "plugin/download-ticket",
            "plugin/list/",
            "plugin/list?url=x",
            "plugin%2Flist",
            "Plugin/list",
            "channel/authorization",
            "adk/llm/generateContent",
            "plugin/detail/../install",
        ] {
            assert!(Query::from_path(path).is_none());
        }
    }

    #[test]
    fn accio_readonly_rebuilds_inputs_and_discards_device_identity() {
        let value = normalized(Query::Channels, None, br#"{"accessToken":"official-synthetic","utdid":"device-secret","version":"0.35.3","packageRegion":"global","ipRegion":"US"}"#).unwrap();
        assert_eq!(value["accessToken"], "official-synthetic");
        assert!(value.get("utdid").is_none());
        let detail = normalized(Query::Plugin, Some("accessToken=official-synthetic&pluginCode=alibaba-seller&lang=en-US&utdid=device-secret&version=0.35.3"), b"").unwrap();
        assert_eq!(detail["pluginCode"], "alibaba-seller");
        assert!(!detail.to_string().contains("device-secret"));
        assert!(normalized(Query::Plugins, None, b"").is_ok());
    }

    #[test]
    fn accio_readonly_rejects_ambiguous_fields_and_mutation_payloads() {
        for body in [
            r#"{"accessToken":"a","accessToken":"b"}"#,
            r#"{"accessToken":"a","url":"https://example.test"}"#,
            r#"{"accessToken":"a","method":"tools/call"}"#,
            r#"{"accessToken":"PROXY_MANAGED"}"#,
            r#"{"accessToken":42}"#,
            "{}",
        ] {
            assert!(
                normalized(Query::Channels, None, body.as_bytes()).is_err(),
                "{body}"
            );
        }
        for raw in [
            "pluginCode=x&pluginCode=y",
            "pluginCode=x&accessToken=a&accessToken=b",
            "pluginCode=x&url=evil",
            "pluginCode=..%2Finstall",
            "pluginCode=x&provider=shop",
        ] {
            assert!(normalized(Query::Plugin, Some(raw), b"").is_err());
        }
        assert!(normalized(Query::Channels, Some("accessToken=x"), b"{}").is_err());
        assert!(normalized(Query::Plugins, None, b"{}").is_err());
        assert!(normalized(Query::Plugin, None, b"").is_err());
        assert!(normalized(Query::ChannelStatus, None, br#"{"accessToken":"x"}"#).is_err());
    }

    #[test]
    fn accio_readonly_headers_do_not_forward_model_credentials_or_tracking() {
        let mut incoming = HeaderMap::new();
        for name in [
            "authorization",
            "cookie",
            "x-api-key",
            "x-utdid",
            "x-cna",
            "referer",
            "origin",
            "proxy-authorization",
            "host",
        ] {
            incoming.insert(name, HeaderValue::from_static("sensitive-synthetic"));
        }
        incoming.insert("x-team-id", HeaderValue::from_static("team-synthetic"));
        let outgoing = outgoing_headers(&incoming).unwrap();
        assert_eq!(outgoing.len(), 3);
        assert_eq!(outgoing["x-team-id"], "team-synthetic");
        assert_eq!(outgoing["accept-encoding"], "identity");
    }

    #[test]
    fn accio_readonly_rejects_ambiguous_success_and_known_model_secrets() {
        for data in [
            json!({}),
            json!({"authorizations":null}),
            json!({"authorizations":[{}]}),
            json!({"success":true,"data":null}),
        ] {
            assert!(!valid_success(Query::Channels, &data));
        }
        assert!(valid_success(
            Query::Channels,
            &json!({"success":true,"data":{"authorizations":[]}})
        ));
        assert!(valid_success(Query::Channels, &json!({"alibaba":[]})));
        assert!(!valid_success(Query::Plugins, &json!({"success":true})));
        assert!(valid_success(
            Query::Plugins,
            &json!({"success":true,"data":{"plugins":[]}})
        ));
        assert!(valid_success(Query::Plugin, &json!(null)));
        assert!(!valid_success(
            Query::Plugin,
            &json!({"error":"invalid-session"})
        ));
        assert!(matches_model_secret(
            &json!({"auth":{"OPENAI_API_KEY":"model-synthetic"}}),
            "model-synthetic"
        ));
        assert!(matches_model_secret(
            &json!({"config":"api_key = \"model-synthetic\""}),
            "model-synthetic"
        ));
        assert!(!matches_model_secret(
            &json!({"auth":{"OPENAI_API_KEY":"model-synthetic"}}),
            "model"
        ));
    }

    #[tokio::test]
    async fn accio_readonly_transport_preserves_errors_and_refuses_redirect_html_oversize() {
        use axum::{routing::any, Router};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let app = Router::new()
            .route(
                "/ok",
                any(|| async {
                    Json(json!({"success":true,"data":{"authorizations":[{"provider":"test"}]}}))
                }),
            )
            .route(
                "/denied",
                any(|| async {
                    (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({"success":false,"code":"LOGIN_REQUIRED"})),
                    )
                }),
            )
            .route(
                "/false",
                any(|| async { Json(json!({"success":false,"code":"LOGIN_REQUIRED"})) }),
            )
            .route(
                "/redirect",
                any(|| async { (StatusCode::TEMPORARY_REDIRECT, [("location", "/target")]) }),
            )
            .route(
                "/target",
                any(move || {
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        Json(json!({}))
                    }
                }),
            )
            .route(
                "/html",
                any(|| async { axum::response::Html("login page") }),
            )
            .route(
                "/oversize",
                any(|| async {
                    (
                        [("content-type", "application/json")],
                        " ".repeat(RESPONSE_LIMIT + 1),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = super::super::http_client::image_no_replay_policy(
            reqwest::Client::builder().no_proxy(),
        )
        .build()
        .unwrap();
        let input = json!({"accessToken":"synthetic"});
        let ok = send(
            &client,
            Query::Channels,
            &format!("{origin}/ok"),
            HeaderMap::new(),
            &input,
        )
        .await
        .unwrap();
        let denied = send(
            &client,
            Query::Channels,
            &format!("{origin}/denied"),
            HeaderMap::new(),
            &input,
        )
        .await
        .unwrap();
        let false_reply = send(
            &client,
            Query::Channels,
            &format!("{origin}/false"),
            HeaderMap::new(),
            &input,
        )
        .await
        .unwrap();
        let mut rejected = Vec::new();
        for path in ["redirect", "html", "oversize"] {
            rejected.push(
                send(
                    &client,
                    Query::Plugins,
                    &format!("{origin}/{path}"),
                    HeaderMap::new(),
                    &json!({}),
                )
                .await
                .is_err(),
            );
        }
        task.abort();
        let _ = task.await;
        assert!(!ok.failed);
        assert!(String::from_utf8(ok.body)
            .unwrap()
            .contains("authorizations"));
        assert_eq!(denied.status, StatusCode::UNAUTHORIZED);
        assert!(denied.failed && false_reply.failed);
        assert!(rejected.into_iter().all(|v| v));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
