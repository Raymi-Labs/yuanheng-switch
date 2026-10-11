//! 全局 HTTP 客户端模块
//!
//! 提供支持全局代理配置的 HTTP 客户端。
//! 所有需要发送 HTTP 请求的模块都应使用此模块提供的客户端。

use once_cell::sync::{Lazy, OnceCell};
use reqwest::Client;
use std::env;
use std::net::IpAddr;
use std::sync::RwLock;
use std::time::Duration;

/// 全局 HTTP 客户端实例
static GLOBAL_CLIENT: Lazy<RwLock<ClientState>> = Lazy::new(|| RwLock::new(ClientState::default()));

// No Debug implementation: snapshots can contain proxy credentials. Never log them.
#[derive(PartialEq, Eq)]
struct ClientConfig {
    proxy_url: Option<String>,
    system: Option<SystemProxySnapshot>,
}

#[derive(PartialEq, Eq)]
struct SystemProxySnapshot {
    environment: Vec<Option<std::ffi::OsString>>,
    platform: Vec<Option<String>>,
    local_port: u16,
}

impl ClientConfig {
    fn capture(proxy_url: Option<&str>) -> Self {
        let proxy_url = proxy_url
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let system = proxy_url.is_none().then(|| SystemProxySnapshot {
            environment: [
                "HTTP_PROXY",
                "http_proxy",
                "HTTPS_PROXY",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
                "NO_PROXY",
                "no_proxy",
                "REQUEST_METHOD",
            ]
            .iter()
            .map(env::var_os)
            .collect(),
            platform: super::system_proxy::snapshot(),
            local_port: get_proxy_port(),
        });
        Self { proxy_url, system }
    }
}

#[derive(Default)]
struct ClientState {
    configured: Option<(ClientConfig, Client)>,
}

impl ClientState {
    fn apply(&mut self, config: ClientConfig) -> Result<bool, String> {
        if self
            .configured
            .as_ref()
            .is_some_and(|(current, _)| *current == config)
        {
            return Ok(false);
        }
        // Build before replacing either field; failure leaves the working client intact.
        let client = build_client(config.proxy_url.as_deref())?;
        self.configured = Some((config, client));
        Ok(true)
    }
}

/// YuanHeng Switch 代理服务器当前监听的端口
static CC_SWITCH_PROXY_PORT: OnceCell<RwLock<u16>> = OnceCell::new();

/// 设置 YuanHeng Switch 代理服务器的监听端口
///
/// 应在代理服务器启动时调用，以便系统代理检测能正确识别自己的端口
pub fn set_proxy_port(port: u16) {
    if let Some(lock) = CC_SWITCH_PROXY_PORT.get() {
        if let Ok(mut current_port) = lock.write() {
            *current_port = port;
            log::debug!("[GlobalProxy] Updated YuanHeng Switch proxy port to {port}");
        }
    } else {
        let _ = CC_SWITCH_PROXY_PORT.set(RwLock::new(port));
        log::debug!("[GlobalProxy] Initialized YuanHeng Switch proxy port to {port}");
    }
}

/// 获取 YuanHeng Switch 代理服务器的监听端口
fn get_proxy_port() -> u16 {
    CC_SWITCH_PROXY_PORT
        .get()
        .and_then(|lock| lock.read().ok())
        .map(|port| *port)
        .unwrap_or(15721) // 默认端口作为回退
}

/// 初始化全局 HTTP 客户端
///
/// 应在应用启动时调用一次。
///
/// # Arguments
/// * `proxy_url` - 代理 URL，如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:1080`
///   传入 None 或空字符串表示跟随系统代理
pub fn init(proxy_url: Option<&str>) -> Result<(), String> {
    apply_proxy(proxy_url)
}

/// 验证代理配置（不应用）
///
/// 只验证代理 URL 是否有效，不实际更新全局客户端。
/// 用于在持久化之前验证配置的有效性。
///
/// # Arguments
/// * `proxy_url` - 代理 URL，None 或空字符串表示跟随系统代理
///
/// # Returns
/// 验证成功返回 Ok(())，失败返回错误信息
pub fn validate_proxy(proxy_url: Option<&str>) -> Result<(), String> {
    let effective_url = proxy_url.map(str::trim).filter(|s| !s.is_empty());
    // 只调用 build_client 来验证，但不应用
    build_client(effective_url)?;
    Ok(())
}

/// 应用代理配置（假设已验证）
///
/// 直接应用代理配置到全局客户端，不做额外验证。
/// 应在 validate_proxy 成功后调用。
///
/// # Arguments
/// * `proxy_url` - 代理 URL，None 或空字符串表示跟随系统代理
pub fn apply_proxy(proxy_url: Option<&str>) -> Result<(), String> {
    let mut state = GLOBAL_CLIENT
        .write()
        .map_err(|_| "Failed to update proxy: lock poisoned".to_string())?;
    let config = ClientConfig::capture(proxy_url);
    if state.apply(config)? {
        let mode = state
            .configured
            .as_ref()
            .and_then(|(config, _)| config.proxy_url.as_deref())
            .map(mask_url)
            .unwrap_or_else(|| "system proxy (or direct when unavailable)".to_string());
        log::info!("[GlobalProxy] Applied: {mode}");
    }
    Ok(())
}

/// 更新代理配置（热更新）
///
/// 可在运行时调用以更改代理设置，无需重启应用。
/// 注意：此函数同时验证和应用，如果需要先验证后持久化再应用，
/// 请使用 validate_proxy + apply_proxy 组合。
///
/// # Arguments
/// * `proxy_url` - 新的代理 URL，None 或空字符串表示跟随系统代理
#[allow(dead_code)]
pub fn update_proxy(proxy_url: Option<&str>) -> Result<(), String> {
    apply_proxy(proxy_url)
}

/// 获取全局 HTTP 客户端
///
/// 返回配置了代理的客户端（如果已配置代理），否则返回跟随系统代理的客户端。
pub fn get() -> Client {
    GLOBAL_CLIENT
        .read()
        .ok()
        .and_then(|state| state.configured.as_ref().map(|(_, client)| client.clone()))
        .unwrap_or_else(|| {
            log::warn!("[GlobalProxy] [GP-004] Client not initialized, using fallback");
            build_client(None).unwrap_or_default()
        })
}

/// 获取当前代理 URL
///
/// 返回当前配置的代理 URL，None 表示跟随系统代理。
pub fn get_current_proxy_url() -> Option<String> {
    GLOBAL_CLIENT.read().ok().and_then(|state| {
        state
            .configured
            .as_ref()
            .and_then(|(config, _)| config.proxy_url.clone())
    })
}

/// 检查是否正在使用代理
#[allow(dead_code)]
pub fn is_proxy_enabled() -> bool {
    get_current_proxy_url().is_some()
}

/// 构建 HTTP 客户端
fn build_client(proxy_url: Option<&str>) -> Result<Client, String> {
    build_client_with_image_policy(proxy_url, false)
}

/// Images are non-idempotent. Never replay a POST on redirect or transport retry.
/// Use the same configured network proxy as chat without changing its policy.
pub(super) fn image_client() -> Result<Client, String> {
    build_client_with_image_policy(get_current_proxy_url().as_deref(), true)
}

pub(super) fn image_no_replay_policy(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
}

fn build_client_with_image_policy(proxy_url: Option<&str>, images: bool) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(10)
        .tcp_keepalive(Duration::from_secs(60))
        // 禁用 reqwest 自动解压：防止 reqwest 覆盖客户端原始 accept-encoding header。
        // 响应解压由 response_processor 根据 content-encoding 手动处理。
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd();

    if images {
        builder = image_no_replay_policy(builder);
    }

    // 有代理地址则使用代理，否则跟随系统代理
    if let Some(url) = proxy_url {
        // 先验证 URL 格式和 scheme
        let parsed = url::Url::parse(url)
            .map_err(|e| format!("Invalid proxy URL '{}': {}", mask_url(url), e))?;

        let scheme = parsed.scheme();
        if !["http", "https", "socks5", "socks5h"].contains(&scheme) {
            return Err(format!(
                "Invalid proxy scheme '{}' in URL '{}'. Supported: http, https, socks5, socks5h",
                scheme,
                mask_url(url)
            ));
        }

        let proxy = reqwest::Proxy::all(url)
            .map_err(|e| format!("Invalid proxy URL '{}': {}", mask_url(url), e))?;
        builder = builder.proxy(proxy);
        log::debug!("[GlobalProxy] Proxy configured: {}", mask_url(url));
    } else {
        // 未设置全局代理时，让 reqwest 自动检测系统代理（环境变量）
        // 若系统代理指向本机，禁用系统代理避免自环
        if system_proxy_points_to_loopback() {
            builder = builder.no_proxy();
            log::warn!(
                "[GlobalProxy] System proxy points to localhost, bypassing to avoid recursion"
            );
        } else {
            log::debug!("[GlobalProxy] Following system proxy (no explicit proxy configured)");
        }
    }

    builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

fn system_proxy_points_to_loopback() -> bool {
    const KEYS: [&str; 6] = [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ];

    KEYS.iter()
        .filter_map(|key| env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .any(|value| proxy_points_to_loopback(&value))
}

fn proxy_points_to_loopback(value: &str) -> bool {
    fn host_is_loopback(host: &str) -> bool {
        if host.eq_ignore_ascii_case("localhost") {
            return true;
        }
        host.parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
    }

    // 检查是否指向 YuanHeng Switch 自己的代理端口
    // 只有指向自己的代理才需要跳过，避免递归
    fn is_cc_switch_proxy_port(port: Option<u16>) -> bool {
        let cc_switch_port = get_proxy_port();
        port == Some(cc_switch_port)
    }

    if let Ok(parsed) = url::Url::parse(value) {
        if let Some(host) = parsed.host_str() {
            // 只有当主机是 loopback 且端口是 YuanHeng Switch 的端口时才返回 true
            return host_is_loopback(host) && is_cc_switch_proxy_port(parsed.port());
        }
        return false;
    }

    let with_scheme = format!("http://{value}");
    if let Ok(parsed) = url::Url::parse(&with_scheme) {
        if let Some(host) = parsed.host_str() {
            return host_is_loopback(host) && is_cc_switch_proxy_port(parsed.port());
        }
    }

    false
}

/// 隐藏 URL 中的敏感信息（用于日志）
pub fn mask_url(url: &str) -> String {
    if let Ok(parsed) = url::Url::parse(url) {
        // 隐藏用户名和密码，保留 scheme、host 和端口
        let host = parsed.host_str().unwrap_or("?");
        match parsed.port() {
            Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
            None => format!("{}://{}", parsed.scheme(), host),
        }
    } else {
        // URL 解析失败，返回部分内容
        if url.len() > 20 {
            format!("{}...", &url[..20])
        } else {
            url.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct TestProxy {
        url: String,
        accepts: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        slow_started: std::sync::Arc<tokio::sync::Notify>,
        slow_release: std::sync::Arc<tokio::sync::Notify>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TestProxy {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn test_proxy(label: &'static str) -> TestProxy {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let accepts = Arc::new(AtomicUsize::new(0));
        let slow_started = Arc::new(tokio::sync::Notify::new());
        let slow_release = Arc::new(tokio::sync::Notify::new());
        let (count, started, release) =
            (accepts.clone(), slow_started.clone(), slow_release.clone());
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                count.fetch_add(1, Ordering::SeqCst);
                let (started, release) = (started.clone(), release.clone());
                tokio::spawn(async move {
                    let mut stream = BufReader::new(socket);
                    loop {
                        let mut first = String::new();
                        if stream.read_line(&mut first).await.unwrap_or(0) == 0 {
                            break;
                        }
                        loop {
                            let mut line = String::new();
                            if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
                                return;
                            }
                            if line == "\r\n" {
                                break;
                            }
                        }
                        if first.contains("/slow") {
                            started.notify_one();
                            release.notified().await;
                        }
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{label}",
                            label.len()
                        );
                        if stream.write_all(response.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        TestProxy {
            url,
            accepts,
            slow_started,
            slow_release,
            task,
        }
    }

    async fn read_proxy(state: &ClientState) -> String {
        state
            .configured
            .as_ref()
            .unwrap()
            .1
            .get("http://upstream.invalid/test")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn unchanged_refresh_reuses_tcp_and_failed_update_keeps_working_pool() {
        use std::sync::atomic::Ordering;
        let proxy = test_proxy("first").await;
        let mut state = ClientState::default();
        assert!(state
            .apply(ClientConfig::capture(Some(&proxy.url)))
            .unwrap());
        assert_eq!(read_proxy(&state).await, "first");
        for _ in 0..20 {
            assert!(!state
                .apply(ClientConfig::capture(Some(&format!(" {} ", proxy.url))))
                .unwrap());
        }
        assert_eq!(read_proxy(&state).await, "first");
        assert!(state
            .apply(ClientConfig::capture(Some("invalid-scheme://localhost:1")))
            .is_err());
        assert_eq!(read_proxy(&state).await, "first");
        assert_eq!(
            proxy.accepts.load(Ordering::SeqCst),
            1,
            "refresh or failed update discarded the TCP pool"
        );
    }

    #[tokio::test]
    async fn proxy_change_routes_new_requests_without_interrupting_in_flight_response() {
        let first = test_proxy("first").await;
        let second = test_proxy("second").await;
        let mut state = ClientState::default();
        state
            .apply(ClientConfig::capture(Some(&first.url)))
            .unwrap();
        let old_client = state.configured.as_ref().unwrap().1.clone();
        let pending = tokio::spawn(async move {
            old_client
                .get("http://upstream.invalid/slow")
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
        });
        tokio::time::timeout(Duration::from_secs(5), first.slow_started.notified())
            .await
            .unwrap();
        assert!(state
            .apply(ClientConfig::capture(Some(&second.url)))
            .unwrap());
        assert_eq!(read_proxy(&state).await, "second");
        first.slow_release.notify_one();
        assert_eq!(pending.await.unwrap(), "first");
    }

    #[test]
    fn system_configuration_changes_refresh_but_identical_snapshot_does_not() {
        let mut state = ClientState::default();
        let config = |port: &str, bypass: &str, local_port| ClientConfig {
            proxy_url: None,
            system: Some(SystemProxySnapshot {
                platform: vec![Some(port.to_owned())],
                environment: vec![Some(bypass.into())],
                local_port,
            }),
        };
        assert!(state.apply(config("1082", "localhost", 15721)).unwrap());
        assert!(!state.apply(config("1082", "localhost", 15721)).unwrap());
        assert!(state.apply(config("7890", "localhost", 15721)).unwrap());
        assert!(state.apply(config("7890", "*", 15721)).unwrap());
        assert!(state.apply(config("7890", "*", 15722)).unwrap());
        assert!(state
            .apply(ClientConfig::capture(Some("http://127.0.0.1:1082")))
            .unwrap());
    }

    #[test]
    fn explicit_proxy_snapshot_includes_auth_but_does_not_depend_on_system() {
        let first = ClientConfig::capture(Some("http://user:first@localhost:1082"));
        let second = ClientConfig::capture(Some("http://user:second@localhost:1082"));
        assert!(first.system.is_none());
        assert!(
            first != second,
            "credential rotation must refresh the client"
        );
        assert!(ClientConfig::capture(None).system.is_some());
        assert!(ClientConfig::capture(Some("   ")).proxy_url.is_none());
    }

    #[test]
    fn test_mask_url() {
        assert_eq!(mask_url("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
        assert_eq!(
            mask_url("http://user:pass@127.0.0.1:7890"),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            mask_url("socks5://admin:secret@proxy.example.com:1080"),
            "socks5://proxy.example.com:1080"
        );
        // 无端口的 URL 不应显示 ":?"
        assert_eq!(
            mask_url("http://proxy.example.com"),
            "http://proxy.example.com"
        );
        assert_eq!(
            mask_url("https://user:pass@proxy.example.com"),
            "https://proxy.example.com"
        );
    }

    #[test]
    fn test_build_client_direct() {
        let result = build_client(None);
        assert!(result.is_ok());
    }

    #[test]
    fn test_build_client_with_http_proxy() {
        let result = build_client(Some("http://127.0.0.1:7890"));
        assert!(result.is_ok());
    }

    #[test]
    fn test_build_client_with_socks5_proxy() {
        let result = build_client(Some("socks5://127.0.0.1:1080"));
        assert!(result.is_ok());
    }

    #[test]
    fn test_build_client_invalid_url() {
        // reqwest::Proxy::all 对某些无效 URL 不会立即报错
        // 使用明确无效的 scheme 来触发错误
        let result = build_client(Some("invalid-scheme://127.0.0.1:7890"));
        assert!(result.is_err(), "Should reject invalid proxy scheme");
    }

    #[test]
    fn test_proxy_points_to_loopback() {
        // 设置 YuanHeng Switch 代理端口为 15721（默认值）
        set_proxy_port(15721);

        // 只有指向 YuanHeng Switch 自己端口的 loopback 地址才返回 true
        assert!(proxy_points_to_loopback("http://127.0.0.1:15721"));
        assert!(proxy_points_to_loopback("socks5://localhost:15721"));
        assert!(proxy_points_to_loopback("127.0.0.1:15721"));

        // 其他 loopback 端口不应该被跳过（允许使用其他本地代理工具）
        assert!(!proxy_points_to_loopback("http://127.0.0.1:7890"));
        assert!(!proxy_points_to_loopback("socks5://localhost:1080"));

        // 非 loopback 地址不应该被跳过
        assert!(!proxy_points_to_loopback("http://192.168.1.10:7890"));
        assert!(!proxy_points_to_loopback("http://192.168.1.10:15721"));
    }

    #[test]
    fn test_system_proxy_points_to_loopback() {
        let _guard = env_lock().lock().unwrap();

        // 设置 YuanHeng Switch 代理端口
        set_proxy_port(15721);

        let keys = [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ];

        for key in &keys {
            std::env::remove_var(key);
        }

        // 指向 YuanHeng Switch 端口的代理应该被跳过
        std::env::set_var("HTTP_PROXY", "http://127.0.0.1:15721");
        assert!(system_proxy_points_to_loopback());

        // 指向其他端口的本地代理不应该被跳过
        std::env::set_var("HTTP_PROXY", "http://127.0.0.1:7890");
        assert!(!system_proxy_points_to_loopback());

        // 非 loopback 地址不应该被跳过
        std::env::set_var("HTTP_PROXY", "http://10.0.0.2:7890");
        assert!(!system_proxy_points_to_loopback());

        for key in &keys {
            std::env::remove_var(key);
        }
    }
}
