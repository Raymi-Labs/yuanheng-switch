//! Public metadata only. Never downloads code or changes the compatibility gate.
use serde::{Deserialize, Serialize};
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const URL: &str = "https://work-download.accio-ai.com/package/beta-mac.yml";
const ERROR: &str = "无法查询 Accio 官方版本；本机兼容检查仍有效，请稍后重试。";
const MAX_BYTES: usize = 64 * 1024;
const SUCCESS_TTL: Duration = Duration::from_secs(6 * 3600);
const FAILURE_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStatus {
    pub latest_version: Option<String>,
    pub latest_verified: bool,
    pub checked_at: Option<i64>,
    pub stale: bool,
    pub error: Option<String>,
}

#[derive(Default)]
struct Cache {
    value: Option<ReleaseStatus>,
    attempted: Option<Instant>,
}

impl Cache {
    fn fresh(&self, now: Instant) -> Option<ReleaseStatus> {
        let value = self.value.as_ref()?;
        let ttl = if value.error.is_some() {
            FAILURE_TTL
        } else {
            SUCCESS_TTL
        };
        (now.saturating_duration_since(self.attempted?) < ttl).then(|| value.clone())
    }
    fn store(&mut self, result: Result<String, String>, now: Instant) -> ReleaseStatus {
        let value = match result {
            Ok(version) => ReleaseStatus {
                latest_verified: super::installation::SUPPORTED_VERSIONS
                    .contains(&version.as_str()),
                latest_version: Some(version),
                checked_at: Some(chrono::Utc::now().timestamp()),
                stale: false,
                error: None,
            },
            Err(_) => ReleaseStatus {
                latest_version: self.value.as_ref().and_then(|v| v.latest_version.clone()),
                latest_verified: self.value.as_ref().is_some_and(|v| v.latest_verified),
                checked_at: self.value.as_ref().and_then(|v| v.checked_at),
                stale: true,
                error: Some(ERROR.into()),
            },
        };
        self.attempted = Some(now);
        self.value = Some(value.clone());
        value
    }
}

fn manifest_version(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_BYTES {
        return Err(ERROR.into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| ERROR)?;
    let versions: Vec<_> = text
        .lines()
        .filter_map(|line| line.strip_prefix("version:"))
        .collect();
    if versions.len() != 1 {
        return Err(ERROR.into());
    }
    let value = versions[0].trim();
    let parsed = semver::Version::parse(value).map_err(|_| ERROR)?;
    if value.len() > 40
        || !parsed.pre.is_empty()
        || !parsed.build.is_empty()
        || parsed.to_string() != value
    {
        return Err(ERROR.into());
    }
    Ok(value.into())
}

async fn fetch_version() -> Result<String, String> {
    // Reuse the application's proxy-aware, no-redirect/no-replay transport.
    let client = crate::proxy::http_client::route_probe_client().map_err(|_| ERROR)?;
    fetch_from(&client, URL, Duration::from_secs(8)).await
}

async fn fetch_from(
    client: &reqwest::Client,
    url: &str,
    timeout: Duration,
) -> Result<String, String> {
    let mut response = client
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| ERROR)?;
    if response.status() != reqwest::StatusCode::OK
        || response.url().as_str() != url
        || response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err(ERROR.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
        if chunk.len() > MAX_BYTES.saturating_sub(bytes.len()) {
            return Err(ERROR.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    manifest_version(&bytes)
}

pub async fn status() -> ReleaseStatus {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    cached_status(
        CACHE.get_or_init(|| Mutex::new(Cache::default())),
        fetch_version,
    )
    .await
}

async fn cached_status<F, Fut>(cache: &Mutex<Cache>, fetch: F) -> ReleaseStatus
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    // Single flight: concurrent cards share one bounded network request.
    let mut cache = cache.lock().await;
    if let Some(value) = cache.fresh(Instant::now()) {
        return value;
    }
    let result = tokio::time::timeout(Duration::from_secs(10), fetch())
        .await
        .unwrap_or_else(|_| Err(ERROR.into()));
    cache.store(result, Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn accio_release_concurrent_cards_share_one_fetch_and_failure_backoff() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = Mutex::new(Cache::default());
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Err(ERROR.into())
        };
        let (a, b) = tokio::join!(cached_status(&cache, fetch), cached_status(&cache, fetch));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(a.error.is_some() && b.error.is_some());
        assert!(a.latest_version.is_none());
    }
    #[tokio::test]
    async fn accio_release_http_rejects_redirect_status_oversize_and_timeout() {
        use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let hits = Arc::new(AtomicUsize::new(0));
        let redirected = hits.clone();
        let app = Router::new()
            .route("/ok", get(|| async { "version: 0.37.1\nfiles: []" }))
            .route(
                "/redirect",
                get(|| async { (StatusCode::FOUND, [("location", "/target")], "") }),
            )
            .route(
                "/target",
                get(move || {
                    let hits = redirected.clone();
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        "version: 0.37.1"
                    }
                }),
            )
            .route(
                "/error",
                get(|| async { (StatusCode::SERVICE_UNAVAILABLE, "version: 0.37.1") }),
            )
            .route("/large", get(|| async { "x".repeat(MAX_BYTES + 1) }))
            .route(
                "/slow",
                get(|| async {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    "version: 0.37.1".into_response()
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let ok = fetch_from(&client, &format!("{root}/ok"), Duration::from_secs(2)).await;
        let mut failures = Vec::new();
        for path in ["redirect", "error", "large", "slow"] {
            failures.push(
                fetch_from(
                    &client,
                    &format!("{root}/{path}"),
                    Duration::from_millis(100),
                )
                .await,
            );
        }
        task.abort();
        let _ = task.await;
        assert_eq!(ok.unwrap(), "0.37.1");
        assert!(failures
            .iter()
            .all(|r| r.as_ref().err().map(String::as_str) == Some(ERROR)));
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn accio_manifest_rejects_ambiguous_or_untrusted_versions() {
        assert_eq!(
            manifest_version(b"version: 0.37.1\nfiles:\n - url: app.zip\n").unwrap(),
            "0.37.1"
        );
        for text in [
            "version: 0.37.1\nversion: 0.37.2",
            " version: 0.37.1",
            "version: 0.37.1-beta",
            "version: 0.37.1+build",
            "version: 01.37.1",
            "version: https://evil.test",
            "<html>error</html>",
        ] {
            assert!(manifest_version(text.as_bytes()).is_err(), "{text}");
        }
        assert!(manifest_version(&vec![b'x'; MAX_BYTES + 1]).is_err());
        assert!(manifest_version(&[255]).is_err());
    }
    #[test]
    fn accio_release_cache_preserves_stale_success_and_backs_off_failures() {
        let mut cache = Cache::default();
        let now = Instant::now();
        assert!(cache.fresh(now).is_none());
        let success = cache.store(Ok("0.37.1".into()), now);
        assert!(success.latest_verified);
        assert!(cache
            .fresh(now + SUCCESS_TTL - Duration::from_secs(1))
            .is_some());
        assert!(cache.fresh(now + SUCCESS_TTL).is_none());
        let failed = cache.store(Err("private URL token should never escape".into()), now);
        assert!(failed.stale);
        assert_eq!(failed.error.as_deref(), Some(ERROR));
        assert_eq!(failed.latest_version, success.latest_version);
        assert_eq!(failed.checked_at, success.checked_at);
        assert!(cache.fresh(now + FAILURE_TTL).is_none());
        assert!(!cache.store(Ok("99.0.0".into()), now).latest_verified);
    }
}
