//! Fixed official identity endpoints only. Never a fallback for model requests.
use axum::{
    body::Bytes,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use futures::StreamExt;
use std::time::Duration;

pub(super) const REQUEST_LIMIT: usize = 256 * 1024;
const RESPONSE_LIMIT: usize = 1024 * 1024;

pub(super) fn endpoint(path: &str) -> Option<&'static str> {
    match path {
        "oauth/token" => Some("https://phoenix-gw.alibaba.com/api/oauth/token"),
        "auth/userinfo" => Some("https://phoenix-gw.alibaba.com/api/auth/userinfo"),
        "auth/refresh_token" => Some("https://phoenix-gw.alibaba.com/api/auth/refresh_token"),
        "auth/safe/refresh_token" => {
            Some("https://phoenix-gw.alibaba.com/api/auth/safe/refresh_token")
        }
        _ => None,
    }
}

fn headers_for_identity(source: &HeaderMap) -> HeaderMap {
    let mut headers = HeaderMap::new();
    // Don't forward Referer, Origin, proxy auth, hop headers or capability URLs.
    for name in [
        "authorization",
        "cookie",
        "x-access-token",
        "token",
        "x-app-version",
        "x-package-region",
        "x-language",
        "accept-language",
        "utdid",
        "version",
        "appkey",
    ] {
        if let Some(value) = source.get(name) {
            headers.insert(name, value.clone());
        }
    }
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers.insert("accept", HeaderValue::from_static("application/json"));
    headers.insert("accept-encoding", HeaderValue::from_static("identity"));
    headers
}

async fn send(
    client: &reqwest::Client,
    url: &str,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ()> {
    let response = client
        .post(url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|_| ())?;
    if response.status().is_redirection() {
        return Err(());
    }
    let status = response.status();
    if !response
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
    let encoding = super::content_encoding::get_content_encoding(response.headers());
    if encoding.as_ref().is_some_and(|v| v.contains(',')) {
        return Err(());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ())?;
        if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Some(encoding) = encoding {
        bytes =
            super::content_encoding::decompress_body_with_limit(&encoding, &bytes, RESPONSE_LIMIT)
                .map_err(|_| ())?
                .ok_or(())?;
    }
    serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|_| ())?;
    Ok((
        status,
        [
            ("content-type", "application/json"),
            ("cache-control", "no-store"),
        ],
        bytes,
    )
        .into_response())
}

pub(super) async fn forward(url: &'static str, headers: &HeaderMap, body: Bytes) -> Response {
    let client = match super::http_client::route_client() {
        Ok(client) => client,
        Err(_) => return unavailable(),
    };
    // route_client disables redirects and implicit retries; timeout includes body.
    match tokio::time::timeout(
        Duration::from_secs(20),
        send(&client, url, headers_for_identity(headers), body),
    )
    .await
    {
        Ok(Ok(response)) => response,
        _ => unavailable(),
    }
}

fn unavailable() -> Response {
    (
        StatusCode::BAD_GATEWAY,
        [("cache-control", "no-store")],
        axum::Json(serde_json::json!({
            "success":false,"code":"YUANHENG_ACCIO_AUTH_UNAVAILABLE",
            "message":"Accio 官方身份服务连接失败；未重试，未改用元衡模型凭据"
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accio_identity_paths_and_headers_cannot_become_general_proxy() {
        for path in [
            "oauth/token",
            "auth/userinfo",
            "auth/refresh_token",
            "auth/safe/refresh_token",
        ] {
            let url = url::Url::parse(endpoint(path).unwrap()).unwrap();
            assert_eq!(
                url.origin().ascii_serialization(),
                "https://phoenix-gw.alibaba.com"
            );
        }
        for path in [
            "auth/userinfo/../llm",
            "auth/userinfo?next=evil",
            "oauth/token/",
            "adk/llm/generateContent",
            "mcp/proxy",
            "https://example.test",
            "log/upload",
        ] {
            assert!(endpoint(path).is_none());
        }
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("authorization", "Bearer official-synthetic"),
            ("referer", "http://localhost/private-capability"),
            ("proxy-authorization", "secret"),
            ("host", "evil.test"),
            ("x-api-key", "yuanheng-secret"),
            ("accept-encoding", "gzip"),
        ] {
            headers.insert(name, value.parse().unwrap());
        }
        let outgoing = headers_for_identity(&headers);
        assert_eq!(outgoing["authorization"], "Bearer official-synthetic");
        for name in ["referer", "proxy-authorization", "host", "x-api-key"] {
            assert!(outgoing.get(name).is_none());
        }
        assert_eq!(outgoing["accept-encoding"], "identity");
    }

    #[tokio::test]
    async fn accio_identity_transport_rejects_redirect_and_html_preserves_unauthorized() {
        use axum::{routing::post, Router};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let app = Router::new()
            .route(
                "/redirect",
                post(|| async { (StatusCode::TEMPORARY_REDIRECT, [("location", "/target")]) }),
            )
            .route(
                "/target",
                post(move || {
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        axum::Json(serde_json::json!({"ok":true}))
                    }
                }),
            )
            .route("/html", post(|| async { axum::response::Html("not json") }))
            .route(
                "/oversize",
                post(|| async {
                    (
                        [("content-type", "application/json")],
                        " ".repeat(RESPONSE_LIMIT + 1),
                    )
                }),
            )
            .route(
                "/encoded",
                post(|| async {
                    (
                        [
                            ("content-type", "application/json"),
                            ("content-encoding", "gzip"),
                        ],
                        "{}",
                    )
                }),
            )
            .route(
                "/denied",
                post(|| async {
                    (
                        StatusCode::UNAUTHORIZED,
                        axum::Json(serde_json::json!({"success":false,"code":"LOGIN_REQUIRED"})),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = super::super::http_client::image_no_replay_policy(
            reqwest::Client::builder().no_proxy(),
        )
        .build()
        .unwrap();
        let redirect = send(
            &client,
            &format!("{base}/redirect"),
            HeaderMap::new(),
            Bytes::from_static(b"{}"),
        )
        .await;
        let html = send(
            &client,
            &format!("{base}/html"),
            HeaderMap::new(),
            Bytes::from_static(b"{}"),
        )
        .await;
        let denied = send(
            &client,
            &format!("{base}/denied"),
            HeaderMap::new(),
            Bytes::from_static(b"{}"),
        )
        .await;
        let oversized = send(
            &client,
            &format!("{base}/oversize"),
            HeaderMap::new(),
            Bytes::from_static(b"{}"),
        )
        .await;
        let encoded = send(
            &client,
            &format!("{base}/encoded"),
            HeaderMap::new(),
            Bytes::from_static(b"{}"),
        )
        .await;
        task.abort();
        let _ = task.await;
        assert!(redirect.is_err());
        assert!(html.is_err());
        assert!(oversized.is_err());
        assert!(encoded.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(denied.unwrap().status(), StatusCode::UNAUTHORIZED);
    }
}
