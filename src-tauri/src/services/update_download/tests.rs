use super::*;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};

struct Reply {
    status: u16,
    headers: String,
    body: Vec<u8>,
    delay: Duration,
    chunk_delay: Duration,
}

struct Server {
    url: Url,
    requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server(handler: impl Fn(&str, usize) -> Reply + Send + Sync + 'static) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/file", listener.local_addr().unwrap())).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let handler = Arc::new(handler);
    let task = tokio::spawn(async move {
        let mut tasks = JoinSet::new();
        loop {
            tokio::select! {
                connection = listener.accept() => {
                    let Ok((mut socket, _)) = connection else { break };
                    let recorded = recorded.clone();
                    let handler = handler.clone();
                    tasks.spawn(async move {
                        let mut request = Vec::new();
                        while !request.ends_with(b"\r\n\r\n") && request.len() < 8192 {
                            let mut byte = [0];
                            if socket.read_exact(&mut byte).await.is_err() { return; }
                            request.push(byte[0]);
                        }
                        let request = String::from_utf8(request).unwrap();
                        let count = {
                            let mut log = recorded.lock().unwrap();
                            log.push(request.clone()); log.len()
                        };
                        let reply = handler(&request, count);
                        tokio::time::sleep(reply.delay).await;
                        let head = format!("HTTP/1.1 {} Response\r\n{}Connection: close\r\n\r\n", reply.status, reply.headers);
                        if socket.write_all(head.as_bytes()).await.is_err() { return; }
                        for bytes in reply.body.chunks(2) {
                            tokio::time::sleep(reply.chunk_delay).await;
                            if socket.write_all(bytes).await.is_err() { return; }
                        }
                    });
                },
                _ = tasks.join_next(), if !tasks.is_empty() => {},
            }
        }
    });
    Server {
        url,
        requests,
        task,
    }
}

fn reply(request: &str, data: &[u8]) -> Reply {
    let lower = request.to_ascii_lowercase();
    let range = lower
        .lines()
        .find_map(|line| line.strip_prefix("range: bytes="))
        .unwrap();
    let (start, end) = range.trim().split_once('-').unwrap();
    let start: usize = start.parse().unwrap();
    let end = end
        .parse::<usize>()
        .unwrap_or(data.len() - 1)
        .min(data.len() - 1);
    assert!(start <= end, "Unexpected request: {request}");
    Reply {
        status: 206,
        headers: format!(
            "Content-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\n",
            end - start + 1,
            data.len()
        ),
        body: data[start..=end].to_vec(),
        delay: Duration::ZERO,
        chunk_delay: Duration::ZERO,
    }
}

fn policy() -> Policy {
    Policy {
        sample: 4,
        probe_timeout: Duration::from_millis(250),
        stall_timeout: Duration::from_millis(150),
        slow_window: Duration::from_millis(35),
        slow_bytes_per_second: 1,
        overall_timeout: Duration::from_secs(3),
    }
}

async fn run(sources: &[&Server], policy: Policy, expected: &[u8]) -> Result<Vec<u8>, String> {
    let client = Client::builder().no_proxy().build().unwrap();
    download_from_sources(
        &client,
        &sources.iter().map(|s| s.url.clone()).collect::<Vec<_>>(),
        policy,
        |bytes| {
            if bytes == expected {
                Ok(())
            } else {
                Err("signature mismatch".into())
            }
        },
        &mut |_, _| {},
    )
    .await
}

#[test]
fn only_exact_project_assets_have_an_alternative() {
    let known = "https://meta-api.vip/desktop/update/releases/0.1.76/YuanHeng.Desktop_0.1.76_aarch64.app.tar.gz";
    let sources = official_sources(&Url::parse(known).unwrap(), "0.1.76").unwrap();
    assert_eq!(sources.len(), 2);
    assert_eq!(
        official_sources(&sources[1], "0.1.76").unwrap()[1],
        sources[0]
    );
    for raw in [
        format!("{known}?token=private"),
        known.replace("https:", "http:"),
        known.replace("meta-api.vip", "meta-api.vip.evil.test"),
        known.replace("meta-api.vip", "user@meta-api.vip"),
        known.replace("aarch64", "other"),
        known.replace("meta-api.vip", "meta-api.vip:444"),
    ] {
        assert!(official_sources(&Url::parse(&raw).unwrap(), "0.1.76").is_none());
    }
    assert!(official_sources(&sources[0], "0.1.75").is_none());
    assert!(official_sources(&sources[0], "../0.1.76").is_none());
}

#[test]
fn validates_ranges_and_bounds() {
    assert_eq!(content_range("bytes 4-7/8").unwrap(), (4, 7, 8));
    for value in [
        "bytes 0-3/*",
        "bytes 4-3/8",
        "bytes 0-8/8",
        "bytes 0-0/0",
        "items 0-2/3",
        "bytes 0-1/99999999999999999999999",
    ] {
        assert!(content_range(value).is_err(), "{value}");
    }
}

#[test]
fn uses_the_tauri_signature_format_and_rejects_tampering() {
    // Public test vector from minisign-verify (MIT), not a project signing key.
    let key = STANDARD.encode("untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3");
    let signature = STANDARD.encode("untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==");
    assert!(verify(b"test", &key, &signature).is_ok());
    assert!(verify(b"Test", &key, &signature).is_err());
    assert!(verify(b"test", &key, "invalid").is_err());
    assert!(verify(b"test", "invalid", &signature).is_err());
}

#[tokio::test]
async fn races_prefixes_and_cancels_the_slow_probe() {
    let slow = server(|request, _| {
        let mut r = reply(request, b"abcdefgh");
        r.delay = Duration::from_secs(2);
        r
    })
    .await;
    let fast = server(|request, _| reply(request, b"abcdefgh")).await;
    assert_eq!(
        run(&[&slow, &fast], policy(), b"abcdefgh").await.unwrap(),
        b"abcdefgh"
    );
    assert_eq!(slow.requests.lock().unwrap().len(), 1);
    assert!(fast.requests.lock().unwrap()[1].contains("bytes=4-"));
}

#[tokio::test]
async fn resumes_after_disconnect_on_the_other_source() {
    let broken = server(|request, n| {
        let mut r = reply(request, b"abcdefgh");
        if n > 1 {
            r.body.truncate(2);
        }
        r
    })
    .await;
    let backup = server(|request, _| {
        let mut r = reply(request, b"abcdefgh");
        r.delay = Duration::from_millis(40);
        r
    })
    .await;
    assert_eq!(
        run(&[&broken, &backup], policy(), b"abcdefgh")
            .await
            .unwrap(),
        b"abcdefgh"
    );
    assert!(backup
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.contains("bytes=6-")));
}

#[tokio::test]
async fn restarts_cleanly_when_a_server_ignores_range() {
    let s = server(|_, _| Reply {
        status: 200,
        headers: "Content-Length: 8\r\n".into(),
        body: b"abcdefgh".to_vec(),
        delay: Duration::ZERO,
        chunk_delay: Duration::ZERO,
    })
    .await;
    assert_eq!(
        run(&[&s], policy(), b"abcdefgh").await.unwrap(),
        b"abcdefgh"
    );
}

#[tokio::test]
async fn signature_failure_discards_mixed_bytes_before_retry() {
    let bad = server(|request, _| reply(request, b"ABCDefgh")).await;
    let good = server(|request, _| {
        let mut r = reply(request, b"abcdefgh");
        r.delay = Duration::from_millis(40);
        r
    })
    .await;
    assert_eq!(
        run(&[&bad, &good], policy(), b"abcdefgh").await.unwrap(),
        b"abcdefgh"
    );
    assert!(good
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.contains("bytes=0-\r\n")));
}

#[tokio::test]
async fn switches_after_sustained_low_speed() {
    let slow = server(|request, n| {
        let mut r = reply(request, b"abcdefghijklmnop");
        if n > 1 {
            r.chunk_delay = Duration::from_millis(40);
        }
        r
    })
    .await;
    let fast = server(|request, _| {
        let mut r = reply(request, b"abcdefghijklmnop");
        r.delay = Duration::from_millis(25);
        r
    })
    .await;
    let mut p = policy();
    p.slow_bytes_per_second = 1000;
    assert_eq!(
        run(&[&slow, &fast], p, b"abcdefghijklmnop").await.unwrap(),
        b"abcdefghijklmnop"
    );
    assert!(fast
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.contains("bytes=6-")));
}

#[tokio::test]
async fn stalls_and_http_errors_have_bounded_retries() {
    let s = server(|request, _| {
        let mut r = reply(request, b"abcdefgh");
        r.delay = Duration::from_secs(2);
        r
    })
    .await;
    assert!(run(&[&s], policy(), b"abcdefgh").await.is_err());
    assert_eq!(s.requests.lock().unwrap().len(), 3); // one probe + two attempts
    let unavailable = server(|request, _| {
        let mut r = reply(request, b"abcdefgh");
        r.status = 503;
        r
    })
    .await;
    assert!(run(&[&unavailable], policy(), b"abcdefgh")
        .await
        .unwrap_err()
        .contains("503"));
    assert_eq!(unavailable.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn rejects_malformed_and_oversized_responses() {
    for header in [
        "Content-Range: bytes 1-4/8\r\nContent-Length: 4\r\n",
        "Content-Range: bytes 0-3/8\r\nContent-Length: 2\r\n",
    ] {
        let s = server(move |_, _| Reply {
            status: 206,
            headers: header.into(),
            body: b"bad!".to_vec(),
            delay: Duration::ZERO,
            chunk_delay: Duration::ZERO,
        })
        .await;
        assert!(run(&[&s], policy(), b"abcdefgh").await.is_err());
    }
    let s = server(|_, _| Reply {
        status: 200,
        headers: format!("Content-Length: {}\r\n", MAX_BYTES + 1),
        body: vec![],
        delay: Duration::ZERO,
        chunk_delay: Duration::ZERO,
    })
    .await;
    assert!(run(&[&s], policy(), b"abcdefgh")
        .await
        .unwrap_err()
        .contains("大小"));
}

#[tokio::test]
async fn overall_deadline_bounds_slow_but_active_streams() {
    let s = server(|request, _| {
        let mut r = reply(request, b"abcdefghijklmnop");
        r.chunk_delay = Duration::from_millis(30);
        r
    })
    .await;
    let mut p = policy();
    p.overall_timeout = Duration::from_millis(90);
    assert!(run(&[&s], p, b"abcdefghijklmnop")
        .await
        .unwrap_err()
        .contains("超时"));
}

#[tokio::test]
#[ignore = "Downloads a public release for manual network/signature acceptance; never installs"]
async fn live_signed_release_download() {
    let mut builder = Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10));
    if let Some(proxy) = crate::services::updater_proxy::resolve_updater_proxy() {
        builder = builder.proxy(reqwest::Proxy::all(proxy.as_str()).unwrap());
    }
    let client = builder.build().unwrap();
    let manifest: serde_json::Value = client
        .get("https://meta-api.vip/desktop/update/latest.json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let platform = &manifest["platforms"]["darwin-aarch64"];
    let version = manifest["version"].as_str().unwrap();
    let signature = platform["signature"].as_str().unwrap();
    let sources = official_sources(
        &Url::parse(platform["url"].as_str().unwrap()).unwrap(),
        version,
    )
    .unwrap();
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../tauri.conf.json")).unwrap();
    let public_key = config["plugins"]["updater"]["pubkey"].as_str().unwrap();
    let started = Instant::now();
    let mut last = 0;
    let bytes = download_from_sources(
        &client,
        &sources,
        Policy::default(),
        |bytes| verify(bytes, public_key, signature),
        &mut |size, _| {
            last = size;
        },
    )
    .await
    .unwrap();
    println!(
        "Live release verified: v{version}, {} bytes, {:.2}s; no installation",
        bytes.len(),
        started.elapsed().as_secs_f64()
    );
    assert!(last > 0);
}
