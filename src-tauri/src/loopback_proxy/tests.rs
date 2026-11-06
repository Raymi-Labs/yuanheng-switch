use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[test]
fn merges_both_cases_preserving_existing_rules_idempotently() {
    assert_eq!(merge(&[]), "localhost,127.0.0.1,::1");
    let value = merge(&[" internal.test,10.0.0.0/8,localhost", "other.test,::1"]);
    assert_eq!(
        value,
        "internal.test,10.0.0.0/8,localhost,other.test,::1,127.0.0.1"
    );
    assert_eq!(merge(&[&value, &value]), value);
    assert!(protected(&merge(&["*"])));
}

#[tokio::test]
async fn simulated_proxy_observes_failure_then_bypass_keeps_public_proxy() {
    use axum::{routing::get, Router};
    let core = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = core.local_addr().unwrap().port();
    let core_task = tokio::spawn(async move {
        axum::serve(
            core,
            Router::new().route(
                "/health",
                get(|| async {
                    axum::Json(serde_json::json!({"service": "yuanheng-core", "status": "healthy"}))
                }),
            ),
        )
        .await
        .unwrap();
    });
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let proxy_task = tokio::spawn(async move {
        axum::serve(
            proxy,
            Router::new().fallback(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                async {
                    (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "simulated forwarding failure",
                    )
                }
            }),
        )
        .await
        .unwrap();
    });
    let proxied = reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(&proxy_url).unwrap())
        .build()
        .unwrap();
    let direct = probe(probe_client(true).unwrap(), port).await;
    let broken = probe(proxied, port).await;
    assert_eq!(direct, ProbeResult::Healthy);
    assert_eq!(broken, ProbeResult::UnexpectedResponse);
    assert_eq!(assessment(&direct, &broken).0, "warning");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    let fixed = reqwest::Client::builder()
        .no_proxy()
        .proxy(
            reqwest::Proxy::all(&proxy_url)
                .unwrap()
                .no_proxy(reqwest::NoProxy::from_string(&merge(&["internal.test"]))),
        )
        .build()
        .unwrap();
    assert_eq!(probe(fixed.clone(), port).await, ProbeResult::Healthy);
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "loopback must not reach proxy"
    );
    let response = fixed
        .get("http://public.invalid/health")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "public traffic still uses proxy"
    );
    assert_eq!(
        assessment(&ProbeResult::Unavailable, &ProbeResult::Unavailable).0,
        "warning"
    );
    assert!(!assessment(&ProbeResult::Unavailable, &broken)
        .1
        .contains("代理可能"));
    core_task.abort();
    proxy_task.abort();
}

#[cfg(unix)]
#[test]
fn terminal_shell_preserves_its_own_entries_without_evaluating_them() {
    let output = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(cli_command("printf '%s\\n' \"$NO_PROXY\" \"$no_proxy\""))
        .env("NO_PROXY", "upper.test,$(false)")
        .env("no_proxy", "lower.test")
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    let values: Vec<_> = text.lines().collect();
    assert_eq!(values[0], values[1]);
    assert!(values[0].contains("upper.test,$(false),lower.test"));
    assert!(protected(values[0]));
}
