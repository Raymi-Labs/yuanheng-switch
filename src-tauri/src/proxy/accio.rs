//! Capability-scoped loopback boundary for Accio. No catch-all official proxy.
use super::{
    content_encoding::{decompress_body_with_limit, get_content_encoding},
    handler_context::RequestContext,
    providers::accio::{accio_to_responses, error_frame, ResponseFrames},
    server::ProxyState,
};
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use futures::StreamExt;
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    sync::{Arc, OnceLock},
    time::Duration,
};

const BODY_LIMIT: usize = 16 * 1024 * 1024;
const EVENT_LIMIT: usize = 16 * 1024 * 1024;

pub(super) fn routes() -> Router<ProxyState> {
    if crate::accio_work::EXPERIMENTAL_ENABLED {
        Router::new()
            .route("/accio-work/:capability/api/*path", any(handle))
            .route("/__yuanheng/core/accio/launch", any(launch))
    } else {
        Router::new()
    }
}

async fn launch(State(state): State<ProxyState>, request: Request) -> Response {
    if !local_caller(request.headers(), request.extensions().get::<SocketAddr>()) {
        return local_error(StatusCode::FORBIDDEN, "Accio 启动仅接受本机管理请求");
    }
    let Some(control) = state.core_control.as_ref() else {
        return local_error(StatusCode::NOT_FOUND, "Accio 需要独立 Core");
    };
    let supplied = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if supplied.len() != control.token.len()
        || supplied
            .bytes()
            .zip(control.token.bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            != 0
    {
        return local_error(StatusCode::UNAUTHORIZED, "Core 管理凭据无效");
    }
    if request.method() != Method::POST || request.uri().query().is_some() {
        return local_error(StatusCode::BAD_REQUEST, "Accio 启动只接受无查询参数的 POST");
    }
    if !request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|s| s.trim().eq_ignore_ascii_case("application/json"))
        })
        || request.headers().contains_key("content-encoding")
    {
        return local_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Accio 启动参数必须为未压缩 JSON",
        );
    }
    let bytes = match tokio::time::timeout(
        Duration::from_secs(3),
        to_bytes(request.into_body(), 16 * 1024),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        _ => return local_error(StatusCode::PAYLOAD_TOO_LARGE, "Accio 启动参数过大或超时"),
    };
    let input: crate::accio_work::LaunchRequest = match serde_json::from_slice(&bytes) {
        Ok(input) => input,
        Err(_) => return local_error(StatusCode::BAD_REQUEST, "Accio 启动参数无效"),
    };
    if input.validate().is_err() {
        return local_error(StatusCode::BAD_REQUEST, "Accio 启动参数无效");
    }
    let port = state.status.read().await.port;
    // A dropped HTTP connection must not drop process ownership/cleanup. The
    // independently bounded task keeps running in this Core and never retries.
    let task =
        tokio::spawn(async move { state.accio_runtime.launch(&state.db, input, port).await });
    match task.await {
        Ok(Ok(())) => Json(json!({"ok":true})).into_response(),
        Ok(Err(error)) => (StatusCode::CONFLICT, Json(json!({"error":error}))).into_response(),
        Err(_) => local_error(StatusCode::INTERNAL_SERVER_ERROR, "Accio 启动状态不可用"),
    }
}

fn local_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({"success":false,"code":"YUANHENG_ACCIO_ERROR","message":message})),
    )
        .into_response()
}

fn sse(value: &Value) -> Bytes {
    Bytes::from(format!("data: {value}\n\n"))
}

fn model_error(message: &str) -> Response {
    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-store"),
        ],
        format!(
            "data: {}\n\ndata: [DONE]\n\n",
            error_frame("YUANHENG_ACCIO_ERROR", message)
        ),
    )
        .into_response()
}

fn local_caller(headers: &HeaderMap, peer: Option<&SocketAddr>) -> bool {
    if !peer.is_some_and(|p| p.ip().is_loopback()) || headers.contains_key("origin") {
        return false;
    }
    let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Ok(url) = url::Url::parse(&format!("http://{host}")) else {
        return false;
    };
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
}

async fn handle(
    State(state): State<ProxyState>,
    Path((capability, path)): Path<(String, String)>,
    request: Request,
) -> Response {
    if !local_caller(request.headers(), request.extensions().get::<SocketAddr>()) {
        return local_error(StatusCode::FORBIDDEN, "Accio 网关只接受本机应用请求");
    }
    match state.accio_runtime.authorized_profile(&state.db) {
        Ok(profile) if profile.authorizes(&capability) => {}
        _ => {
            if request.method() == Method::POST
                && request.uri().query().is_none()
                && super::accio_compat::connector_probe(&path)
            {
                drop(request);
                if let Some(response) = super::accio_compat::reject_connector_probe(&path).await {
                    return response;
                }
            }
            return local_error(
                StatusCode::UNAUTHORIZED,
                "Accio 网关配置已失效，请从元衡重新配置并启动",
            );
        }
    };
    if let Some(query) = super::accio_cloud::Query::from_path(&path) {
        if request.uri().path() != format!("/accio-work/{capability}/api/{path}") {
            return local_error(StatusCode::BAD_REQUEST, "Accio 只读查询路径编码无效");
        }
        return super::accio_cloud::handle(&state, &capability, query, request).await;
    }
    if request.method() != Method::POST {
        return local_error(StatusCode::METHOD_NOT_ALLOWED, "此 Accio 端点仅支持 POST");
    }
    let official_identity = super::accio_auth::endpoint(&path);
    if official_identity.is_some() && request.uri().query().is_some() {
        return local_error(StatusCode::BAD_REQUEST, "Accio 身份端点不接受查询参数");
    }
    if !matches!(path.as_str(), "llm/config/v2" | "adk/llm/generateContent")
        && official_identity.is_none()
    {
        return local_error(
            StatusCode::NOT_IMPLEMENTED,
            "该 Accio 官方云端功能尚未接入；未转发到官方或元衡",
        );
    }
    static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = match SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
        .try_acquire_owned()
    {
        Ok(permit) => permit,
        Err(_) => {
            return local_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Accio 本机同时进行的请求过多",
            )
        }
    };
    let body_limit = if official_identity.is_some() {
        super::accio_auth::REQUEST_LIMIT
    } else if path == "llm/config/v2" {
        64 * 1024
    } else {
        BODY_LIMIT
    };
    let (parts, body) = request.into_parts();
    if !parts
        .headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|s| s.trim().eq_ignore_ascii_case("application/json"))
        })
    {
        return local_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Accio 请求必须为 JSON");
    }
    let bytes =
        match tokio::time::timeout(Duration::from_secs(30), to_bytes(body, body_limit)).await {
            Ok(Ok(bytes)) => bytes,
            _ => return local_error(StatusCode::PAYLOAD_TOO_LARGE, "Accio 请求过大或读取超时"),
        };
    let bytes = if let Some(encoding) = get_content_encoding(&parts.headers) {
        if encoding.contains(',') {
            return local_error(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Accio 不支持叠加压缩编码",
            );
        }
        match decompress_body_with_limit(&encoding, &bytes, body_limit) {
            Ok(Some(bytes)) => Bytes::from(bytes),
            Ok(None) => {
                return local_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Accio 压缩格式不支持")
            }
            Err(_) => return local_error(StatusCode::BAD_REQUEST, "Accio 压缩内容无效或超限"),
        }
    } else {
        bytes
    };
    let mut input: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return local_error(StatusCode::BAD_REQUEST, "Accio 请求 JSON 无效"),
    };
    if !input.is_object() {
        return local_error(StatusCode::BAD_REQUEST, "Accio 请求必须为 JSON 对象");
    }
    // Reading a slow body must not carry a now-revoked account/child snapshot
    // into a new upstream request. Already-forwarded streams are unaffected.
    let profile = match state.accio_runtime.authorized_profile(&state.db) {
        Ok(profile) if profile.authorizes(&capability) => profile,
        _ => {
            return local_error(
                StatusCode::UNAUTHORIZED,
                "Accio 连接已失效，请从元衡重新启动",
            )
        }
    };
    if let Some(url) = official_identity {
        let _connection =
            super::forwarder::ActiveConnectionGuard::acquire(state.status.clone()).await;
        let response = super::accio_auth::forward(url, &parts.headers, bytes).await;
        // `path` is from the exact identity allowlist; no query/body/token here.
        log::info!(
            "[Accio] official_identity={} status={}",
            path,
            response.status().as_u16()
        );
        return response;
    }
    if path == "llm/config/v2" {
        return Json(profile.catalog()).into_response();
    }
    // Auto stays inside the selected group. It never means official fallback.
    if input["model"] == "auto" {
        input["model"] = json!(profile.model);
    }
    if !input
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|m| profile.models.iter().any(|allowed| allowed == m))
    {
        return model_error("该模型不在当前元衡分组目录中，请刷新模型列表");
    }
    let mut body = match accio_to_responses(&input) {
        Ok(body) => body,
        Err(error) => return model_error(&error),
    };
    if body.get("reasoning").is_none()
        && body["model"] == profile.model
        && profile.reasoning != "auto"
    {
        body["reasoning"] = json!({"effort":profile.reasoning});
    }
    // All official headers/body metadata have now been discarded.
    drop(input);
    let log_scope = profile.request_log_scope();
    let ctx = match RequestContext::for_accio(&state, &body, profile.provider, log_scope).await {
        Ok(ctx) => ctx,
        Err(_) => return model_error("Accio 元衡路由初始化失败"),
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        http::HeaderValue::from_static("application/json"),
    );
    headers.insert(
        "accept",
        http::HeaderValue::from_static("text/event-stream"),
    );
    let response = match super::handlers::forward_responses_with_context(
        &state,
        ctx,
        Method::POST,
        "/responses".into(),
        body,
        headers,
        http::Extensions::new(),
    )
    .await
    {
        Ok(response) => response,
        Err(error) => return model_error(&super::accio_diagnostics::proxy_message(&error)),
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = tokio::time::timeout(
            Duration::from_secs(3),
            to_bytes(response.into_body(), 64 * 1024),
        )
        .await
        .ok()
        .and_then(Result::ok);
        let text = body
            .as_deref()
            .and_then(|bytes| std::str::from_utf8(bytes).ok());
        return model_error(&super::accio_diagnostics::http_message(status, text));
    }
    let is_sse = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"));
    if !is_sse {
        return match tokio::time::timeout(
            Duration::from_secs(120),
            to_bytes(response.into_body(), BODY_LIMIT),
        )
        .await
        {
            Ok(Ok(bytes)) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => match ResponseFrames::default()
                    .push(&json!({"type":"response.completed","response":value}))
                {
                    Ok(frames) => (
                        [
                            ("content-type", "text/event-stream"),
                            ("cache-control", "no-store"),
                        ],
                        frames
                            .iter()
                            .map(|v| format!("data: {v}\n\n"))
                            .collect::<String>()
                            + "data: [DONE]\n\n",
                    )
                        .into_response(),
                    Err(error) => model_error(&error),
                },
                Err(_) => model_error("元衡上游返回了无法解析的响应"),
            },
            _ => model_error("元衡上游响应读取失败或超时"),
        };
    }
    let stream = convert_stream(response.into_body(), permit);
    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-store"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

fn take_block(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let lf = buffer.windows(2).position(|v| v == b"\n\n").map(|i| (i, 2));
    let crlf = buffer
        .windows(4)
        .position(|v| v == b"\r\n\r\n")
        .map(|i| (i, 4));
    let (at, len) = match (lf, crlf) {
        (Some(a), Some(b)) => a.min(b),
        (a, b) => a.or(b)?,
    };
    let block = buffer[..at].to_vec();
    buffer.drain(..at + len);
    Some(block)
}

fn parse_block(block: &[u8]) -> Result<Option<Value>, String> {
    let block = std::str::from_utf8(block).map_err(|_| "上游 SSE 包含无效 UTF-8")?;
    let data = block
        .lines()
        .filter_map(|line| {
            line.strip_prefix("data:")
                .map(|s| s.strip_prefix(' ').unwrap_or(s))
        })
        .collect::<Vec<_>>()
        .join("\n");
    if block.lines().any(|line| {
        line.strip_prefix("event:")
            .is_some_and(|v| v.trim() == "error")
    }) {
        let value = serde_json::from_str::<Value>(&data).ok();
        return Err(super::accio_diagnostics::message(
            "sse_error",
            value.as_ref(),
        ));
    }
    if data.is_empty() {
        return Ok(None);
    }
    if data == "[DONE]" {
        return Err("上游流结束但缺少 response.completed".into());
    }
    serde_json::from_str(&data)
        .map(Some)
        .map_err(|_| "上游 SSE JSON 无效".into())
}

pub(super) fn convert_stream(
    body: Body,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> + Send {
    async_stream::stream! {
        let _permit = permit;
        let mut upstream = body.into_data_stream();
        let mut buffer = Vec::new();
        let mut converter = ResponseFrames::default();
        let mut failure = None;
        yield Ok(Bytes::from_static(b": yuanheng\n\n"));
        'stream: loop {
            let chunk = match tokio::time::timeout(Duration::from_secs(120),upstream.next()).await {
                Ok(Some(Ok(chunk))) => chunk,
                Ok(None) => break,
                _ => { failure = Some("元衡上游流断开或超时".to_string()); break; },
            };
            if buffer.len().saturating_add(chunk.len()) > EVENT_LIMIT {
                failure = Some("元衡上游流事件超出大小限制".into()); break;
            }
            buffer.extend_from_slice(&chunk);
            while let Some(block) = take_block(&mut buffer) {
                let value = match parse_block(&block) {
                    Ok(Some(value)) => value,
                    Ok(None) => continue,
                    Err(error) => { failure = Some(error); break 'stream; },
                };
                match converter.push(&value) {
                    Ok(frames) => for frame in frames { yield Ok(sse(&frame)); },
                    Err(error) => { failure = Some(error); break 'stream; },
                }
                if converter.complete { break 'stream; }
            }
        }
        if !converter.complete {
            let message = failure.as_deref().unwrap_or("元衡上游未发送完整结束事件；没有自动重发");
            yield Ok(sse(&error_frame("YUANHENG_STREAM_INCOMPLETE",message)));
        }
        yield Ok(Bytes::from_static(b"data: [DONE]\n\n"));
        // Dropping Body cancels the upstream; no detached forwarding task exists.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_remote_origin_host_and_missing_peer() {
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:15721".parse().unwrap());
        let peer = "127.0.0.1:30000".parse().unwrap();
        assert!(local_caller(&headers, Some(&peer)));
        assert!(!local_caller(&headers, None));
        assert!(!local_caller(
            &headers,
            Some(&"192.0.2.1:30000".parse().unwrap())
        ));
        headers.insert("origin", "https://example.test".parse().unwrap());
        assert!(!local_caller(&headers, Some(&peer)));
        headers.remove("origin");
        headers.insert("host", "evil.test".parse().unwrap());
        assert!(!local_caller(&headers, Some(&peer)));
    }
    #[test]
    fn sse_boundaries_handle_crlf_utf8_and_explicit_errors() {
        let mut buffer = b"data: {\"type\":\"x\",\"text\":\"".to_vec();
        let text = "你好".as_bytes();
        buffer.extend_from_slice(&text[..1]);
        assert!(take_block(&mut buffer).is_none());
        buffer.extend_from_slice(&text[1..]);
        buffer.extend_from_slice(b"\"}\r\n\r\n");
        assert_eq!(
            parse_block(&take_block(&mut buffer).unwrap())
                .unwrap()
                .unwrap()["text"],
            "你好"
        );
        assert!(parse_block(b"event: error\ndata: {}").is_err());
        assert!(parse_block(b"data: [DONE]").is_err());
    }

    #[tokio::test]
    async fn accio_upstream_error_envelopes_keep_safe_diagnostic_not_private_payload() {
        for event in [
            "event: error\ndata: {\"error\":{\"code\":\"server_error\",\"message\":\"Our servers are overloaded. sk-private /Users/private-person/a.txt\"}}\n\n",
            "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"invalid_function_parameters\",\"message\":\"invalid JSON for write alice@example.test\"}}}\n\n",
        ] {
            let slots = Arc::new(tokio::sync::Semaphore::new(1));
            let body = Body::from_stream(convert_stream(Body::from(event), slots.clone().acquire_owned().await.unwrap()));
            let bytes = to_bytes(body, BODY_LIMIT).await.unwrap();
            let text = String::from_utf8(bytes.to_vec()).unwrap();
            assert!(text.contains("YUANHENG_STREAM_INCOMPLETE"));
            assert!(text.contains("诊断编号"));
            assert!(!text.contains("sk-private"));
            assert!(!text.contains("private-person"));
            assert!(!text.contains("alice@example"));
            assert_eq!(text.matches("data: [DONE]").count(), 1);
            assert_eq!(slots.available_permits(), 1);
        }
    }

    #[tokio::test]
    async fn accio_stream_truncation_is_visible_and_cancellation_releases_resources() {
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let source = Body::from("data: {\"type\":\"response.output_text.delta\",\"item_id\":\"m\",\"content_index\":0,\"delta\":\"partial\"}\n\n");
        let body = Body::from_stream(convert_stream(
            source,
            slots.clone().acquire_owned().await.unwrap(),
        ));
        let output = to_bytes(body, BODY_LIMIT).await.unwrap();
        assert!(String::from_utf8_lossy(&output).contains("YUANHENG_STREAM_INCOMPLETE"));
        assert_eq!(slots.available_permits(), 1);

        struct Pending(Arc<std::sync::atomic::AtomicBool>);
        impl futures::Stream for Pending {
            type Item = Result<Bytes, std::io::Error>;
            fn poll_next(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Option<Self::Item>> {
                std::task::Poll::Pending
            }
        }
        impl Drop for Pending {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut output = Box::pin(convert_stream(
            Body::from_stream(Pending(dropped.clone())),
            slots.clone().acquire_owned().await.unwrap(),
        ));
        assert!(output.next().await.unwrap().is_ok());
        drop(output);
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(slots.available_permits(), 1);
    }
}
