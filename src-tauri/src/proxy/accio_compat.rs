//! Pace stale Accio connector probes; live read-only queries use accio_cloud.
//!
//! In the inspected desktop, a failed authorization snapshot causes an event
//! that clears the renderer's retry cache and immediately fetches it again.
//! `Retry-After` alone therefore cannot pace this feedback loop. A successful
//! empty authorization list is also unsafe: the official consumer persists it
//! as an authoritative removal of previously connected accounts.
use axum::{http::StatusCode, response::IntoResponse, response::Response, Json};
use serde_json::json;
use std::time::Duration;

const RETRY_SECONDS: u64 = 5;

/// Match only the two observed, read-only connector probes. All other paths
/// must continue through the existing allowlist and unknown-path rejection.
pub(super) fn connector_probe(path: &str) -> bool {
    matches!(path, "channel/query" | "channel/authorization/status")
}

async fn paced_rejection(interval: Duration) -> Response {
    // The official manager coalesces requests for the same connector. Delay
    // each failed reply independently, so a new request from that feedback
    // chain cannot be triggered faster than once per interval. A global queue
    // would let one connector delay unrelated probes until they time out.
    // This holds no model/identity slot, and awaiting a timer does not spin or
    // spawn a detached task. Dropping the future also drops its timer.
    tokio::time::sleep(interval).await;
    (
        StatusCode::UNAUTHORIZED,
        [("retry-after", "5"), ("cache-control", "no-store")],
        Json(json!({
            "success": false,
            "code": "YUANHENG_ACCIO_ERROR",
            "message": "Accio 网关配置已失效，请从元衡重新配置并启动"
        })),
    )
        .into_response()
}

/// Call only after capability/runtime rejection, for local POST without query.
/// Failed authorization also needs pacing: an app still running after Core
/// restart would otherwise turn the same feedback loop into immediate 401s.
/// No input identity, credential, provider, account list, or URL is inspected,
/// copied, logged, persisted, or sent elsewhere by this handler.
pub(super) async fn reject_connector_probe(path: &str) -> Option<Response> {
    if !connector_probe(path) {
        return None;
    }
    Some(paced_rejection(Duration::from_secs(RETRY_SECONDS)).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use futures::FutureExt;
    use tokio::time::Instant;

    #[test]
    fn connector_probe_paths_are_exact_and_do_not_include_models_or_mutations() {
        for path in ["channel/query", "channel/authorization/status"] {
            assert!(connector_probe(path));
        }
        for path in [
            "channel/remove",
            "channel/authorization",
            "channel/authorization/status/",
            "channel/authorization/status?provider=alibaba",
            "channel/authorization/status/../remove",
            "api/channel/query",
            "/channel/query",
            "channel%2Fquery",
            "channel/query/extra",
            "Channel/query",
            "mcp/proxy",
            "auth/userinfo",
            "llm/config/v2",
            "adk/llm/generateContent",
        ] {
            assert!(
                !connector_probe(path),
                "unexpected compatibility path: {path}"
            );
        }
    }

    #[tokio::test]
    async fn stale_connector_response_does_not_claim_empty_or_successful_authorization() {
        let response = paced_rejection(Duration::ZERO).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()["retry-after"], RETRY_SECONDS.to_string());
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body = to_bytes(response.into_body(), 2048).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["success"], false);
        assert_eq!(value["code"], "YUANHENG_ACCIO_ERROR");
        assert_eq!(value.as_object().unwrap().len(), 3);
        for field in [
            "data",
            "authorizations",
            "accessToken",
            "provider",
            "token",
            "account",
        ] {
            assert!(value.get(field).is_none(), "unexpected data field: {field}");
        }
    }

    #[tokio::test]
    async fn invalid_connector_capability_is_paced_but_remains_unauthorized() {
        let interval = Duration::from_millis(15);
        let started = Instant::now();
        let response = paced_rejection(interval).await;
        assert!(started.elapsed() >= interval);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()["retry-after"], RETRY_SECONDS.to_string());
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body = to_bytes(response.into_body(), 2048).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["success"], false);
        assert_eq!(value["code"], "YUANHENG_ACCIO_ERROR");
        assert_eq!(
            value["message"],
            "Accio 网关配置已失效，请从元衡重新配置并启动"
        );
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert!(value.get("data").is_none());
        assert!(value.get("authorizations").is_none());
    }

    #[tokio::test]
    async fn stale_connector_replies_wait_without_blocking_each_other_or_other_work() {
        let interval = Duration::from_millis(15);
        let start = Instant::now();
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..3 {
            tasks.spawn(async move {
                assert_eq!(
                    paced_rejection(interval).await.status(),
                    StatusCode::UNAUTHORIZED
                );
                Instant::now()
            });
        }
        // Model/catalog requests do not enter this wait. An unrelated future
        // must be runnable while connector replies await their own cooldown.
        tokio::time::timeout(Duration::from_millis(100), async {
            tokio::task::yield_now().await;
        })
        .await
        .unwrap();
        let mut times = Vec::new();
        while let Some(result) = tasks.join_next().await {
            times.push(result.unwrap());
        }
        assert_eq!(times.len(), 3);
        for time in times {
            assert!(time.duration_since(start) >= interval);
        }
    }

    #[tokio::test]
    async fn cancelled_connector_probe_leaves_no_shared_wait_or_spawned_work() {
        let mut request = Box::pin(paced_rejection(Duration::from_secs(RETRY_SECONDS)));
        assert!(request.as_mut().now_or_never().is_none());
        drop(request);
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(100), paced_rejection(Duration::ZERO))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(reject_connector_probe("mcp/proxy").await.is_none());
        assert!(reject_connector_probe("llm/config/v2").await.is_none());
    }
}
