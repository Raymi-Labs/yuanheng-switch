//! Read-only readiness confirmation. Never retry a management mutation here.
use super::{
    candidate_ports, proxy_origin, recovery, CoreInfo, ProxyConfig, CORE_ADMIN_PREFIX,
    CORE_REQUEST_TIMEOUT, CORE_START_TIMEOUT,
};
use std::path::Path;
use std::time::{Duration, Instant};

const START_ATTEMPTS: usize = 3;
const RETRY_DELAY: Duration = Duration::from_millis(250);

async fn request(
    client: &reqwest::Client,
    address: &str,
    port: u16,
    token: &str,
) -> Result<CoreInfo, (String, bool)> {
    let started = Instant::now();
    let classify = |stage, error: reqwest::Error| {
        let transient = error.is_timeout() || error.is_connect();
        (
            recovery::probe_error(stage, port, started, &error),
            transient,
        )
    };
    let url = format!("{}{CORE_ADMIN_PREFIX}/info", proxy_origin(address, port));
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| classify("request", error))?;
    if !response.status().is_success() {
        return Err((
            format!(
                "stage=http port={port} status={} elapsed_ms={}",
                response.status().as_u16(),
                started.elapsed().as_millis()
            ),
            false,
        ));
    }
    response
        .json::<CoreInfo>()
        .await
        .map_err(|error| classify("decode", error))
}

pub(super) async fn query(
    config_dir: &Path,
    token: &str,
    config: &ProxyConfig,
    confirm_start: bool,
) -> Result<CoreInfo, String> {
    // The previous 800 ms connect deadline can expire before Windows completes
    // a loopback connection. Give TCP the same bounded budget as the GET.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(CORE_REQUEST_TIMEOUT)
        .timeout(CORE_REQUEST_TIMEOUT)
        .build()
        .map_err(|_| "创建 Core 状态客户端失败".to_string())?;
    let mut candidates = candidate_ports(config_dir, config);
    let attempts = if confirm_start { START_ATTEMPTS } else { 1 };
    // One shared deadline includes all candidates, bodies and retry delays.
    let deadline = tokio::time::Instant::now() + CORE_START_TIMEOUT;
    let mut failures = Vec::new();
    for attempt in 1..=attempts {
        let mut retry = Vec::new();
        for (address, port) in candidates {
            match tokio::time::timeout_at(deadline, request(&client, &address, port, token)).await {
                Ok(Ok(info)) => return Ok(info),
                Ok(Err((error, transient))) => {
                    failures.push(format!("attempt={attempt} {error}"));
                    if transient {
                        retry.push((address, port));
                    }
                }
                Err(_) => {
                    failures.push(format!(
                        "attempt={attempt} stage=budget port={port} kind=timeout"
                    ));
                    return Err(format!("Core 状态探测失败: {}", failures.join("; ")));
                }
            }
        }
        if retry.is_empty() || attempt == attempts {
            break;
        }
        candidates = retry;
        tokio::time::sleep_until((tokio::time::Instant::now() + RETRY_DELAY).min(deadline)).await;
    }
    Err(format!("Core 状态探测失败: {}", failures.join("; ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn all_candidates_and_retries_share_start_deadline() {
        use axum::{routing::get, Router};
        let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        super::super::write_runtime_record(
            dir.path(),
            &crate::proxy::ProxyServerInfo {
                address: "127.0.0.1".into(),
                port: first.local_addr().unwrap().port(),
                started_at: String::new(),
            },
            "synthetic",
        )
        .unwrap();
        let config = ProxyConfig {
            listen_address: "127.0.0.1".into(),
            listen_port: second.local_addr().unwrap().port(),
            ..Default::default()
        };
        let router = Router::new().route(
            "/__yuanheng/core/info",
            get(|| async { std::future::pending::<String>().await }),
        );
        let other = router.clone();
        let one = tokio::spawn(async move { axum::serve(first, router).await.unwrap() });
        let two = tokio::spawn(async move { axum::serve(second, other).await.unwrap() });
        let started = Instant::now();
        let error = query(dir.path(), "private-token", &config, true)
            .await
            .unwrap_err();
        one.abort();
        two.abort();
        let _ = one.await;
        let _ = two.await;
        assert!(error.contains("stage=budget"), "{error}");
        assert!(error.contains("attempt=2"), "{error}");
        assert!(!error.contains("private"), "{error}");
        assert!(started.elapsed() < CORE_START_TIMEOUT + Duration::from_secs(2));
    }
}
