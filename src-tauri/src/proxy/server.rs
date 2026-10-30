//! HTTP代理服务器
//!
//! 基于Axum的HTTP服务器，处理代理请求
//!
//! Uses a manual hyper HTTP/1.1 accept loop with `preserve_header_case(true)` so
//! that the original header-name casing from the CLI client is captured in a
//! `HeaderCaseMap` extension.  This map is later forwarded to the upstream via
//! the hyper-based HTTP client, producing wire-level header casing identical to
//! a direct (non-proxied) CLI request.

use super::{
    failover_switch::FailoverSwitchManager,
    handlers,
    log_codes::srv as log_srv,
    provider_router::ProviderRouter,
    providers::{codex_chat_history::CodexChatHistoryStore, gemini_shadow::GeminiShadowStore},
    types::*,
    ProxyError,
};
use crate::core_daemon::{CoreControl, ProxyAuthManagers};
use crate::database::Database;
use axum::{
    extract::DefaultBodyLimit,
    routing::{any, get, post},
    Router,
};
use hyper_util::rt::TokioIo;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{oneshot, RwLock};
use tokio::task::JoinHandle;

/// 代理服务器状态（共享）
#[derive(Clone)]
pub struct ProxyState {
    pub db: Arc<Database>,
    pub config: Arc<RwLock<ProxyConfig>>,
    pub status: Arc<RwLock<ProxyStatus>>,
    pub start_time: Arc<RwLock<Option<std::time::Instant>>>,
    /// 每个应用类型当前使用的 provider (app_type -> (provider_id, provider_name))
    pub current_providers: Arc<RwLock<std::collections::HashMap<String, (String, String)>>>,
    /// 共享的 ProviderRouter（持有熔断器状态，跨请求保持）
    pub provider_router: Arc<ProviderRouter>,
    /// Gemini Native shadow state，用于 thoughtSignature / tool call 回放
    pub gemini_shadow: Arc<GeminiShadowStore>,
    /// Codex Chat bridge history，用于恢复 previous_response_id 指向的 tool call
    pub codex_chat_history: Arc<CodexChatHistoryStore>,
    /// AppHandle，用于发射事件和更新托盘菜单
    pub app_handle: Option<tauri::AppHandle>,
    /// 独立 Core 的管理通道；GUI 内嵌代理模式下为空。
    pub core_control: Option<CoreControl>,
    /// 独立 Core 直接持有认证管理器，避免依赖 Tauri AppHandle。
    pub auth_managers: Option<ProxyAuthManagers>,
    /// 故障转移切换管理器
    pub failover_manager: Arc<FailoverSwitchManager>,
    /// Only this Core's directly owned Accio process can authorize its route.
    pub accio_runtime: Arc<crate::accio_work::Runtime>,
}

impl ProxyState {
    pub async fn snapshot_status(&self) -> ProxyStatus {
        let mut status = self.status.read().await.clone();
        if let Some(start) = *self.start_time.read().await {
            status.uptime_seconds = start.elapsed().as_secs();
        }

        let current_providers = self.current_providers.read().await;
        status.active_targets = current_providers
            .iter()
            .map(|(app_type, (provider_id, provider_name))| ActiveTarget {
                app_type: app_type.clone(),
                provider_id: provider_id.clone(),
                provider_name: provider_name.clone(),
            })
            .collect();
        // Never expose a persisted or stale periodic target as a live route.
        status
            .active_targets
            .retain(|target| target.app_type != crate::accio_work::SCOPE);
        if crate::accio_work::EXPERIMENTAL_ENABLED {
            if let Ok(profile) = self.accio_runtime.authorized_profile(&self.db) {
                status.active_targets.push(ActiveTarget {
                    app_type: crate::accio_work::SCOPE.into(),
                    provider_id: profile.provider.id,
                    provider_name: profile.provider.name,
                });
            }
        }
        status
    }
}

/// 代理HTTP服务器
pub struct ProxyServer {
    config: ProxyConfig,
    state: ProxyState,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    /// 服务器任务句柄，用于等待服务器实际关闭
    server_handle: Arc<RwLock<Option<JoinHandle<()>>>>,
}

impl ProxyServer {
    pub fn new(
        config: ProxyConfig,
        db: Arc<Database>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Self {
        Self::new_with_runtime(config, db, app_handle, None, None)
    }

    pub(crate) fn new_headless(
        config: ProxyConfig,
        db: Arc<Database>,
        core_control: CoreControl,
        auth_managers: ProxyAuthManagers,
    ) -> Self {
        Self::new_with_runtime(config, db, None, Some(core_control), Some(auth_managers))
    }

    fn new_with_runtime(
        config: ProxyConfig,
        db: Arc<Database>,
        app_handle: Option<tauri::AppHandle>,
        core_control: Option<CoreControl>,
        auth_managers: Option<ProxyAuthManagers>,
    ) -> Self {
        // 创建共享的 ProviderRouter（熔断器状态将跨所有请求保持）
        let provider_router = Arc::new(ProviderRouter::new(db.clone()));
        // 创建故障转移切换管理器
        let failover_manager = Arc::new(FailoverSwitchManager::new(db.clone()));

        let state = ProxyState {
            db,
            config: Arc::new(RwLock::new(config.clone())),
            status: Arc::new(RwLock::new(ProxyStatus::default())),
            start_time: Arc::new(RwLock::new(None)),
            current_providers: Arc::new(RwLock::new(std::collections::HashMap::new())),
            provider_router,
            gemini_shadow: Arc::new(GeminiShadowStore::default()),
            codex_chat_history: Arc::new(CodexChatHistoryStore::default()),
            app_handle,
            core_control,
            auth_managers,
            failover_manager,
            accio_runtime: Arc::new(crate::accio_work::Runtime::default()),
        };

        Self {
            config,
            state,
            shutdown_tx: Arc::new(RwLock::new(None)),
            server_handle: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn start(&self) -> Result<ProxyServerInfo, ProxyError> {
        // 检查是否已在运行
        if self.shutdown_tx.read().await.is_some() {
            return Err(ProxyError::AlreadyRunning);
        }

        let addr: SocketAddr =
            format!("{}:{}", self.config.listen_address, self.config.listen_port)
                .parse()
                .map_err(|e| ProxyError::BindFailed(format!("无效的地址: {e}")))?;

        // 创建关闭通道
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        // 构建路由
        let app = self.build_router();

        // 绑定监听器
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .map_err(|e| ProxyError::BindFailed(e.to_string()))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| ProxyError::BindFailed(e.to_string()))?;
        let actual_port = local_addr.port();

        // A duplicate Core that cannot bind must never revoke the live Core's
        // profile. Reset only after binding and before any HTTP is accepted.
        if crate::accio_work::EXPERIMENTAL_ENABLED
            && self.state.core_control.is_some()
            && crate::accio_work::reset_for_core_start(&self.state.db).is_err()
        {
            log::warn!("旧 Accio 配置无法清理；Core 将拒绝未受控启动的连接");
        }

        log::info!("[{}] 代理服务器启动于 {local_addr}", log_srv::STARTED);

        // 更新全局代理端口，用于系统代理检测
        crate::proxy::http_client::set_proxy_port(actual_port);

        // 保存关闭句柄
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        // 更新状态
        let mut status = self.state.status.write().await;
        status.running = true;
        status.address = self.config.listen_address.clone();
        status.port = actual_port;
        drop(status);

        // 记录启动时间
        *self.state.start_time.write().await = Some(std::time::Instant::now());

        // 启动服务器 — 使用手动 hyper HTTP/1.1 accept loop
        // 开启 preserve_header_case 以捕获客户端请求头的原始大小写
        let state = self.state.clone();
        let handle = tokio::spawn(async move {
            let mut shutdown_rx = shutdown_rx;
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let (stream, remote_addr) = match result {
                            Ok(v) => v,
                            Err(e) => {
                                log::error!("[{SRV}] accept 失败: {e}", SRV = log_srv::ACCEPT_ERR);
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                continue;
                            }
                        };

                        let app = app.clone();
                        tokio::spawn(async move {
                            // Peek raw TCP bytes to capture original header casing
                            // before hyper parses (and lowercases) the header names.
                            let original_cases = {
                                let mut peek_buf = vec![0u8; 8192];
                                match stream.peek(&mut peek_buf).await {
                                    Ok(n) => {
                                        let cases = super::hyper_client::OriginalHeaderCases::from_raw_bytes(&peek_buf[..n]);
                                        log::debug!(
                                            "[ProxyServer] Peeked {} bytes, captured {} header casings",
                                            n, cases.cases.len()
                                        );
                                        cases
                                    }
                                    Err(e) => {
                                        log::debug!("[ProxyServer] peek failed (non-fatal): {e}");
                                        super::hyper_client::OriginalHeaderCases::default()
                                    }
                                }
                            };

                            // service_fn 将 axum Router（tower::Service）桥接到 hyper
                            let service = hyper::service::service_fn(move |mut req: hyper::Request<hyper::body::Incoming>| {
                                req.extensions_mut().insert(remote_addr);
                                let mut router = app.clone();
                                let cases = original_cases.clone();
                                async move {
                                    // 将 hyper::body::Incoming 转为 axum::body::Body，保留 extensions
                                    let (mut parts, body) = req.into_parts();

                                    // Insert our own header case map alongside hyper's internal one
                                    parts.extensions.insert(cases);

                                    let body = axum::body::Body::new(body);
                                    let axum_req = http::Request::from_parts(parts, body);
                                    <Router as tower::Service<http::Request<axum::body::Body>>>::call(&mut router, axum_req).await
                                }
                            });

                            if let Err(e) = hyper::server::conn::http1::Builder::new()
                                .preserve_header_case(true)
                                .serve_connection(TokioIo::new(stream), service)
                                .await
                            {
                                // Connection reset / broken pipe 等在代理场景下很常见，debug 级别
                                log::debug!("[{SRV}] connection error: {e}", SRV = log_srv::CONN_ERR);
                            }
                        });
                    }
                    _ = &mut shutdown_rx => {
                        break;
                    }
                }
            }

            // 服务器停止后更新状态
            state.status.write().await.running = false;
            *state.start_time.write().await = None;
        });

        // 保存服务器任务句柄
        *self.server_handle.write().await = Some(handle);

        Ok(ProxyServerInfo {
            address: self.config.listen_address.clone(),
            port: actual_port,
            started_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    pub async fn stop(&self) -> Result<(), ProxyError> {
        // Revoke routing without killing an official app that may contain work.
        let _ = self.state.accio_runtime.invalidate(&self.state.db);
        // 1. 发送关闭信号
        if let Some(tx) = self.shutdown_tx.write().await.take() {
            let _ = tx.send(());
        } else {
            return Err(ProxyError::NotRunning);
        }

        // 2. 等待服务器任务结束（带 5 秒超时保护）
        if let Some(handle) = self.server_handle.write().await.take() {
            match tokio::time::timeout(std::time::Duration::from_secs(5), handle).await {
                Ok(Ok(())) => {
                    log::info!("[{}] 代理服务器已完全停止", log_srv::STOPPED);
                    Ok(())
                }
                Ok(Err(e)) => {
                    log::warn!("[{}] 代理服务器任务异常终止: {e}", log_srv::TASK_ERROR);
                    Err(ProxyError::StopFailed(e.to_string()))
                }
                Err(_) => {
                    log::warn!(
                        "[{}] 代理服务器停止超时（5秒），强制继续",
                        log_srv::STOP_TIMEOUT
                    );
                    Err(ProxyError::StopTimeout)
                }
            }
        } else {
            Ok(())
        }
    }

    pub async fn get_status(&self) -> ProxyStatus {
        self.state.snapshot_status().await
    }

    pub(crate) fn reap_accio(&self) {
        if self.state.accio_runtime.reap(&self.state.db).is_err() {
            log::warn!("Accio 退出状态清理失败，已拒绝旧连接");
        }
    }

    /// 更新某个应用类型当前“目标供应商”（用于 UI 展示 active_targets）
    ///
    /// 注意：这不代表该供应商一定已经处理过请求，而是用于“热切换/启用故障转移立即切 P1”
    /// 等场景下，让 UI 能立刻反映最新目标。
    pub async fn set_active_target(&self, app_type: &str, provider_id: &str, provider_name: &str) {
        let mut current_providers = self.state.current_providers.write().await;
        current_providers.insert(
            app_type.to_string(),
            (provider_id.to_string(), provider_name.to_string()),
        );
    }

    pub async fn replace_active_targets(&self, targets: Vec<(String, String, String)>) {
        let mut current_providers = self.state.current_providers.write().await;
        current_providers.clear();
        current_providers.extend(targets.into_iter().map(
            |(app_type, provider_id, provider_name)| (app_type, (provider_id, provider_name)),
        ));
    }

    fn build_router(&self) -> Router {
        Router::new()
            // 健康检查
            .route("/health", get(handlers::health_check))
            .route("/status", get(handlers::get_status))
            .route("/__yuanheng/core/info", get(handlers::get_core_info))
            .route("/__yuanheng/core/routes", get(handlers::get_core_routes))
            .route(
                "/__yuanheng/core/routes/policy",
                post(handlers::set_core_route_policy),
            )
            .route(
                "/__yuanheng/core/routes/probe",
                post(handlers::probe_core_routes),
            )
            .route(
                "/__yuanheng/core/routes/cancel",
                post(handlers::cancel_core_route_probe),
            )
            .route("/__yuanheng/core/reload", post(handlers::reload_core))
            .route(
                "/__yuanheng/core/imagegen/credentials",
                post(handlers::sync_imagegen_credentials),
            )
            .route("/__yuanheng/core/shutdown", post(handlers::shutdown_core))
            .route(
                "/__yuanheng/core/reset-circuit-breaker",
                post(handlers::reset_core_circuit_breaker),
            )
            // Claude API (支持带前缀和不带前缀两种格式)
            .route("/v1/messages", post(handlers::handle_messages))
            .route("/claude/v1/messages", post(handlers::handle_messages))
            // Claude Desktop 3P 本地 gateway（独立 provider namespace）
            .route(
                "/claude-desktop/v1/models",
                get(handlers::handle_claude_desktop_models),
            )
            .route(
                "/claude-desktop/v1/messages",
                post(handlers::handle_claude_desktop_messages),
            )
            // OpenAI Chat Completions API (Codex CLI，支持带前缀和不带前缀)
            .route("/chat/completions", post(handlers::handle_chat_completions))
            .route(
                "/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            .route(
                "/v1/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            .route(
                "/codex/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            // OpenAI Models API (Codex CLI reachability check)
            .route("/models", get(handlers::handle_models))
            .route("/v1/models", get(handlers::handle_models))
            .route("/codex/v1/models", get(handlers::handle_models))
            .route("/chatgpt-desktop/v1/models", get(handlers::handle_models))
            // Images must bypass chat model mapping, conversion and failover.
            .merge(super::images::routes())
            .merge(super::accio::routes())
            // OpenAI Responses API (Codex CLI，支持带前缀和不带前缀)
            .route("/responses", post(handlers::handle_responses))
            .route("/v1/responses", post(handlers::handle_responses))
            .route("/v1/v1/responses", post(handlers::handle_responses))
            .route("/codex/v1/responses", post(handlers::handle_responses))
            .route(
                "/chatgpt-desktop/v1/responses",
                post(handlers::handle_chatgpt_desktop_responses),
            )
            // Grok Build uses the Responses protocol but has an independent
            // provider namespace and failover queue.
            .route(
                "/grokbuild/v1/responses",
                post(handlers::handle_grokbuild_responses),
            )
            // OpenAI Responses Compact API (Codex CLI 远程压缩，透传)
            .route(
                "/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/v1/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/codex/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/chatgpt-desktop/v1/responses/compact",
                post(handlers::handle_chatgpt_desktop_responses_compact),
            )
            .route(
                "/grokbuild/v1/responses/compact",
                post(handlers::handle_grokbuild_responses_compact),
            )
            // Gemini API (支持带前缀和不带前缀)
            //
            // 用 `any(..)` 覆盖所有 HTTP 方法：除了 POST `:generateContent` /
            // `:streamGenerateContent` / `:countTokens` 之外，Gemini SDK / CLI 还会发
            // GET `/models`、GET `/models/<id>` 等只读端点。如果只挂 POST，这些 GET
            // 请求会在路由层 404，绕过本地代理的统计、整流和故障转移。
            .route("/v1beta/*path", any(handlers::handle_gemini))
            .route("/gemini/v1beta/*path", any(handlers::handle_gemini))
            // Gemini 的 GA 版本也叫 /v1，给原 SDK 留一条出口
            .route("/gemini/v1/*path", any(handlers::handle_gemini))
            // 提高默认请求体大小限制（避免 413 Payload Too Large）
            .layer(DefaultBodyLimit::max(200 * 1024 * 1024))
            .with_state(self.state.clone())
    }

    /// 在不重启服务的情况下更新运行时配置
    pub async fn apply_runtime_config(&self, config: &ProxyConfig) {
        *self.state.config.write().await = config.clone();
    }

    /// 热更新熔断器配置
    ///
    /// 将新配置应用到所有已创建的熔断器实例
    pub async fn update_circuit_breaker_configs(
        &self,
        config: super::circuit_breaker::CircuitBreakerConfig,
    ) {
        self.state.provider_router.update_all_configs(config).await;
    }

    pub async fn update_circuit_breaker_config_for_app(
        &self,
        app_type: &str,
        config: super::circuit_breaker::CircuitBreakerConfig,
    ) {
        self.state
            .provider_router
            .update_app_configs(app_type, config)
            .await;
    }

    /// 重置指定 Provider 的熔断器
    pub async fn reset_provider_circuit_breaker(&self, provider_id: &str, app_type: &str) {
        self.state
            .provider_router
            .reset_provider_breaker(provider_id, app_type)
            .await;
    }
}

#[cfg(test)]
mod image_route_tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };

    #[cfg(all(feature = "accio-work-experimental", target_os = "macos"))]
    mod native_probe_reports {
        use serde::{Deserialize, Deserializer, Serialize};
        use std::{io::Write, path::PathBuf, time::Duration};

        pub(super) struct DurationSeconds(pub(super) u64);

        impl Default for DurationSeconds {
            fn default() -> Self {
                Self(300)
            }
        }

        impl<'de> Deserialize<'de> for DurationSeconds {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = u64::deserialize(deserializer)?;
                if !(30..=900).contains(&value) {
                    return Err(serde::de::Error::custom(
                        "native probe durationSeconds must be between 30 and 900",
                    ));
                }
                Ok(Self(value))
            }
        }

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        pub(super) struct ModelResult {
            pub(super) model: String,
            pub(super) status: u16,
            pub(super) input_tokens: u64,
            pub(super) output_tokens: u64,
        }

        pub(super) struct ProgressWriter {
            directory: PathBuf,
            last_write: Option<Duration>,
            last_content: Vec<u8>,
        }

        impl ProgressWriter {
            pub(super) fn new(directory: PathBuf) -> Self {
                Self {
                    directory,
                    last_write: None,
                    last_content: Vec::new(),
                }
            }

            pub(super) fn update(
                &mut self,
                elapsed: Duration,
                models: &[ModelResult],
            ) -> Result<bool, String> {
                if self
                    .last_write
                    .is_some_and(|last| elapsed.saturating_sub(last) < Duration::from_secs(2))
                {
                    return Ok(false);
                }
                // This explicit projection cannot expose the fixture, prompts,
                // credentials, identity, raw errors or local capability URL.
                let content = serde_json::to_vec(&serde_json::json!({
                    "elapsedSeconds": elapsed.as_secs(),
                    "models": models,
                }))
                .map_err(|_| "Native probe progress serialization failed")?;
                if content == self.last_content {
                    return Ok(false);
                }
                // A same-directory rename replaces the old report atomically.
                // NamedTempFile uses mode 0600; failed writes remove its temp.
                let mut temporary = tempfile::Builder::new()
                    .prefix(".native-progress-")
                    .tempfile_in(&self.directory)
                    .map_err(|_| "Native probe progress temporary file unavailable")?;
                temporary
                    .write_all(&content)
                    .and_then(|_| temporary.flush())
                    .map_err(|_| "Native probe progress write failed")?;
                temporary
                    .persist(self.directory.join("progress.json"))
                    .map_err(|_| "Native probe progress replacement failed")?;
                self.last_write = Some(elapsed);
                self.last_content = content;
                Ok(true)
            }
        }

        #[test]
        fn native035probe_duration_is_bounded_before_launch() {
            #[derive(Deserialize)]
            struct DurationFixture {
                #[serde(default, rename = "durationSeconds")]
                duration_seconds: DurationSeconds,
            }
            let omitted: DurationFixture = serde_json::from_str("{}").unwrap();
            assert_eq!(omitted.duration_seconds.0, 300);
            for seconds in [30, 300, 900] {
                let fixture: DurationFixture =
                    serde_json::from_value(serde_json::json!({"durationSeconds": seconds}))
                        .unwrap();
                assert_eq!(fixture.duration_seconds.0, seconds);
            }
            for value in [
                serde_json::json!(0),
                serde_json::json!(29),
                serde_json::json!(901),
                serde_json::json!(-1),
                serde_json::json!(30.5),
                serde_json::json!("300"),
                serde_json::json!(null),
                serde_json::json!(u64::MAX),
            ] {
                assert!(serde_json::from_value::<DurationFixture>(
                    serde_json::json!({"durationSeconds": value}),
                )
                .is_err());
            }
        }

        #[test]
        fn native035probe_progress_is_private_atomic_and_throttled() {
            use std::{fs, os::unix::fs::MetadataExt};
            let directory = tempfile::tempdir().unwrap();
            let mut writer = ProgressWriter::new(directory.path().into());
            let path = directory.path().join("progress.json");
            assert!(writer.update(Duration::ZERO, &[]).unwrap());
            let initial = fs::metadata(&path).unwrap();
            assert_eq!(initial.mode() & 0o077, 0);
            let rows = [ModelResult {
                model: "synthetic-model".into(),
                status: 200,
                input_tokens: 17,
                output_tokens: 3,
            }];
            assert!(!writer.update(Duration::from_millis(1999), &rows).unwrap());
            assert_eq!(fs::metadata(&path).unwrap().ino(), initial.ino());
            assert!(writer.update(Duration::from_secs(2), &rows).unwrap());
            let replaced = fs::metadata(&path).unwrap();
            assert_ne!(replaced.ino(), initial.ino());
            assert_eq!(replaced.mode() & 0o077, 0);
            assert!(!writer.update(Duration::from_secs(2), &rows).unwrap());
            let report: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(
                report,
                serde_json::json!({
                    "elapsedSeconds": 2,
                    "models": [{"model":"synthetic-model", "status":200, "inputTokens":17, "outputTokens":3}],
                })
            );
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    /// Manual, paid native acceptance only. The parent harness owns the private
    /// profile, official login, app-data isolation and UI actions. This test does
    /// not create/copy credentials or change the production version allowlist.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires a private fixture and explicit native Accio 0.35.2 acceptance"]
    #[cfg(all(feature = "accio-work-experimental", target_os = "macos"))]
    async fn native035probe() -> Result<(), String> {
        use native_probe_reports::{DurationSeconds, ModelResult, ProgressWriter};
        use std::{
            io::{Read, Write},
            os::unix::fs::{MetadataExt, OpenOptionsExt},
            path::{Path, PathBuf},
            time::{Duration, Instant, SystemTime, UNIX_EPOCH},
        };

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Fixture {
            profile: crate::accio_work::Profile,
            app_path: PathBuf,
            report_dir: PathBuf,
            #[serde(default)]
            duration_seconds: DurationSeconds,
        }

        fn private_path(path: &Path, directory: bool) -> Result<(), String> {
            let metadata = std::fs::symlink_metadata(path)
                .map_err(|_| "Native probe private path is unavailable")?;
            if !path.is_absolute()
                || metadata.file_type().is_symlink()
                || metadata.is_dir() != directory
                || (!directory && !metadata.is_file())
                || metadata.mode() & 0o077 != 0
                || metadata.uid() != unsafe { libc::getuid() }
            {
                return Err("Native probe fixture/report path must be private and owned".into());
            }
            Ok(())
        }

        fn write_report(path: &Path, report: &serde_json::Value) -> Result<(), String> {
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .map_err(|_| "Native probe report already exists or is unavailable")?;
            let content = serde_json::to_vec(report)
                .map_err(|_| "Native probe report serialization failed")?;
            output
                .write_all(&content)
                .map_err(|_| "Native probe report write failed".into())
        }

        fn model_results(db: &Database) -> Result<Vec<ModelResult>, String> {
            let conn = db
                .conn
                .lock()
                .map_err(|_| "Native probe database unavailable")?;
            let mut statement = conn
                .prepare(
                    "SELECT model, status_code, input_tokens, output_tokens
                     FROM proxy_request_logs WHERE app_type = 'accio-work'
                     ORDER BY rowid LIMIT 100",
                )
                .map_err(|_| "Native probe usage summary unavailable")?;
            let results = statement
                .query_map([], |row| {
                    Ok(ModelResult {
                        model: row.get(0)?,
                        status: row.get(1)?,
                        input_tokens: row.get(2)?,
                        output_tokens: row.get(3)?,
                    })
                })
                .map_err(|_| "Native probe usage query failed")?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "Native probe usage row is invalid".into());
            results
        }

        let fixture_path = std::env::var_os("YUANHENG_ACCIO_NATIVE_FIXTURE")
            .map(PathBuf::from)
            .ok_or("Native probe requires YUANHENG_ACCIO_NATIVE_FIXTURE")?;
        private_path(&fixture_path, false)?;
        let test_home = std::env::var_os("YUANHENG_SWITCH_TEST_HOME")
            .map(PathBuf::from)
            .ok_or("Native probe requires an isolated YUANHENG_SWITCH_TEST_HOME")?;
        private_path(&test_home, true)?;
        if std::env::var_os("HOME").map(PathBuf::from).as_ref() == Some(&test_home) {
            return Err("Native probe cannot use the user's real home as its test home".into());
        }
        let mut bytes = Vec::new();
        std::fs::File::open(&fixture_path)
            .map_err(|_| "Native probe fixture cannot be opened")?
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Native probe fixture cannot be read")?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("Native probe fixture exceeds its size bound".into());
        }
        let mut fixture: Fixture =
            serde_json::from_slice(&bytes).map_err(|_| "Native probe fixture schema is invalid")?;
        bytes.fill(0);
        private_path(&fixture.report_dir, true)?;
        if fixture.report_dir.join("stop").exists() {
            return Err("Native probe stop marker already exists".into());
        }
        fixture.profile.active = false;
        fixture.profile.validate()?;
        let db = Arc::new(Database::memory().map_err(|_| "Native probe database init failed")?);
        crate::accio_work::save(&db, &fixture.profile)?;
        let server = ProxyServer::new(
            ProxyConfig {
                listen_address: "127.0.0.1".into(),
                listen_port: 0,
                enable_logging: true,
                ..ProxyConfig::default()
            },
            db.clone(),
            None,
        );
        let info = server
            .start()
            .await
            .map_err(|_| "Native probe server start failed")?;
        let mut probe = match server
            .state
            .accio_runtime
            .native035probe_launch(&db, fixture.app_path, info.port)
            .await
        {
            Ok(probe) => probe,
            Err(error) => {
                let _ = server.stop().await;
                return Err(error);
            }
        };
        // From this point every normal return runs explicit app/helper cleanup.
        // The process-group guard also handles test assertion unwinding.
        let result = async {
            let started_at = Instant::now();
            let duration = Duration::from_secs(fixture.duration_seconds.0);
            let deadline = started_at + duration;
            let hard_deadline_unix_seconds = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "Native probe system clock is invalid")?
                .as_secs()
                + fixture.duration_seconds.0;
            let mut progress = ProgressWriter::new(fixture.report_dir.clone());
            progress.update(Duration::ZERO, &[])?;
            write_report(
                &fixture.report_dir.join("ready.json"),
                &serde_json::json!({
                    "port": info.port,
                    "pid": probe.pid,
                    "models": fixture.profile.models,
                    "durationSeconds": fixture.duration_seconds.0,
                    "hardDeadlineUnixSeconds": hard_deadline_unix_seconds,
                }),
            )?;
            let reason = loop {
                if fixture.report_dir.join("stop").exists() {
                    break "stop_marker";
                }
                if Instant::now() >= deadline {
                    break "time_limit";
                }
                let rows = model_results(&db)?;
                progress.update(started_at.elapsed(), &rows)?;
                if rows.len() >= 10 {
                    break "model_record_limit";
                }
                if server.state.accio_runtime.authorized_profile(&db).is_err() {
                    break "app_exited";
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            };
            Ok::<_, String>(reason)
        }
        .await;
        let cleanup = server
            .state
            .accio_runtime
            .native035probe_stop(&db, &mut probe)
            .await;
        let shutdown = server
            .stop()
            .await
            .map_err(|_| "Native probe server shutdown failed");
        let rows = model_results(&db)?;
        // Only model/status/token summaries leave the in-memory database. No
        // provider, account, token, capability URL, prompt or raw error is saved.
        for row in &rows {
            println!(
                "{}",
                serde_json::to_string(row).map_err(|_| "Native probe summary failed")?
            );
        }
        write_report(
            &fixture.report_dir.join("summary.json"),
            &serde_json::json!({
                "endedBy": result.as_ref().ok(),
                "models": rows,
                "processGroupClean": cleanup.is_ok(),
                "listenerStopped": shutdown.is_ok(),
                "productionVersionGateChanged": false,
            }),
        )?;
        result?;
        cleanup?;
        shutdown?;
        Ok(())
    }

    #[tokio::test]
    #[cfg(all(feature = "accio-work-experimental", unix))]
    async fn accio_capability_catalog_scope_and_disconnect_fail_closed() {
        use http_body_util::BodyExt;
        let db = Arc::new(Database::memory().unwrap());
        let profile = crate::accio_work::synthetic_profile();
        crate::accio_work::save(&db, &profile).unwrap();
        let server = ProxyServer::new(ProxyConfig::default(), db.clone(), None);
        let orphan = Request::builder()
            .method("POST")
            .uri(format!(
                "/accio-work/{}/api/llm/config/v2",
                profile.capability
            ))
            .header("host", "127.0.0.1:15721")
            .header("content-type", "application/json")
            .extension("127.0.0.1:30000".parse::<std::net::SocketAddr>().unwrap())
            .body(Body::from("{}"))
            .unwrap();
        let denied = tower::Service::call(&mut server.build_router(), orphan)
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert!(server.get_status().await.active_targets.is_empty());
        server.state.accio_runtime.synthetic_child(&db);
        let profile = server.state.accio_runtime.authorized_profile(&db).unwrap();
        for (token, path, body, expected) in [
            ("wrong", "llm/config/v2", "{}", 401),
            ("wrong", "oauth/token", "{}", 401),
            (profile.capability.as_str(), "llm/config/v2", "{}", 200),
            (profile.capability.as_str(), "image/generate", "{}", 501),
            (
                profile.capability.as_str(),
                "auth/userinfo?redirect=elsewhere",
                "{}",
                400,
            ),
            (
                profile.capability.as_str(),
                "adk/llm/generateContent",
                r#"{"model":"outside-group","contents":[]}"#,
                200,
            ),
        ] {
            let request = Request::builder()
                .method("POST")
                .uri(format!("/accio-work/{token}/api/{path}"))
                .header("host", "127.0.0.1:15721")
                .header("content-type", "application/json")
                .extension("127.0.0.1:30000".parse::<std::net::SocketAddr>().unwrap())
                .body(Body::from(body))
                .unwrap();
            let response = tower::Service::call(&mut server.build_router(), request)
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), expected);
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let text = String::from_utf8_lossy(&bytes);
            assert!(!text.contains(&profile.capability));
            assert!(!text.contains("synthetic-accio-key"));
            if path == "adk/llm/generateContent" {
                assert!(text.contains("errorCode"));
            }
        }
        assert_eq!(server.state.status.read().await.total_requests, 0);
        crate::accio_work::remove(&db).unwrap();
        assert!(crate::accio_work::load_active(&db).is_err());
        server.state.accio_runtime.stop_synthetic_child(&db).await;
    }

    #[tokio::test]
    #[cfg(feature = "accio-work-experimental")]
    async fn accio_management_requires_local_authenticated_bounded_requests() {
        let db = Arc::new(Database::memory().unwrap());
        let mut server = ProxyServer::new(ProxyConfig::default(), db.clone(), None);
        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        server.state.core_control = Some(crate::core_daemon::CoreControl {
            token: Arc::from("synthetic-admin"),
            command_tx,
            binary_id: Arc::from("synthetic-build"),
            config_dir: Arc::new(std::path::PathBuf::from("/synthetic")),
            routes: crate::route_selection::Selector::new(db.clone()),
        });
        // A rooted Unix path is not absolute on Windows. Use a native absolute
        // fixture so this case reaches the authenticated runtime rejection.
        let path = if cfg!(windows) {
            r"C:\synthetic\Accio.app"
        } else {
            "/synthetic/Accio.app"
        };
        let body = serde_json::to_string(&serde_json::json!({
            "path":path, "revision":"0".repeat(64),
        }))
        .unwrap();
        for (peer, host, origin, token, payload, expected) in [
            (
                "192.0.2.1:9000",
                "127.0.0.1",
                None,
                "synthetic-admin",
                body.as_str(),
                403,
            ),
            (
                "127.0.0.1:9000",
                "example.invalid",
                None,
                "synthetic-admin",
                body.as_str(),
                403,
            ),
            (
                "127.0.0.1:9000",
                "127.0.0.1",
                Some("https://example.invalid"),
                "synthetic-admin",
                body.as_str(),
                403,
            ),
            (
                "127.0.0.1:9000",
                "127.0.0.1",
                None,
                "wrong",
                body.as_str(),
                401,
            ),
            (
                "127.0.0.1:9000",
                "127.0.0.1",
                None,
                "synthetic-admin",
                "{\"path\":\"relative\",\"revision\":\"x\"}",
                400,
            ),
            (
                "127.0.0.1:9000",
                "127.0.0.1",
                None,
                "synthetic-admin",
                "{\"unknown\":true}",
                400,
            ),
            // No configuration exists. The authenticated handler must stop
            // before verifying or running any application.
            (
                "127.0.0.1:9000",
                "127.0.0.1",
                None,
                "synthetic-admin",
                body.as_str(),
                409,
            ),
        ] {
            let mut request = Request::builder()
                .method("POST")
                .uri("/__yuanheng/core/accio/launch")
                .header("host", host)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .extension(peer.parse::<std::net::SocketAddr>().unwrap());
            if let Some(origin) = origin {
                request = request.header("origin", origin);
            }
            let response = tower::Service::call(
                &mut server.build_router(),
                request.body(Body::from(payload.to_owned())).unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(response.status().as_u16(), expected);
        }
        let oversized = Request::builder()
            .method("POST")
            .uri("/__yuanheng/core/accio/launch")
            .header("host", "127.0.0.1")
            .header("content-type", "application/json")
            .header("authorization", "Bearer synthetic-admin")
            .extension("127.0.0.1:9000".parse::<std::net::SocketAddr>().unwrap())
            .body(Body::from("x".repeat(16 * 1024 + 1)))
            .unwrap();
        let response = tower::Service::call(&mut server.build_router(), oversized)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(server.state.accio_runtime.authorized_profile(&db).is_err());
    }

    #[tokio::test]
    #[cfg(all(feature = "accio-work-experimental", unix))]
    async fn accio_body_wait_cannot_keep_revoked_authority() {
        for (path, text) in [
            ("llm/config/v2", "{}"),
            ("channel/query", r#"{"accessToken":"official-synthetic"}"#),
            (
                "adk/llm/generateContent",
                r#"{"model":"outside-group","contents":[]}"#,
            ),
        ] {
            let db = Arc::new(Database::memory().unwrap());
            crate::accio_work::save(&db, &crate::accio_work::synthetic_profile()).unwrap();
            let server = ProxyServer::new(ProxyConfig::default(), db.clone(), None);
            server.state.accio_runtime.synthetic_child(&db);
            let active = server.state.accio_runtime.authorized_profile(&db).unwrap();
            let (reading_tx, reading_rx) = tokio::sync::oneshot::channel();
            let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
            let body = Body::from_stream(futures::stream::once(async move {
                reading_tx.send(()).unwrap();
                finish_rx.await.unwrap();
                Ok::<_, std::io::Error>(bytes::Bytes::from_static(text.as_bytes()))
            }));
            let request = Request::builder()
                .method("POST")
                .uri(format!("/accio-work/{}/api/{path}", active.capability))
                .header("host", "127.0.0.1")
                .header("content-type", "application/json")
                .extension("127.0.0.1:9000".parse::<std::net::SocketAddr>().unwrap())
                .body(body)
                .unwrap();
            let mut router = server.build_router();
            let reply =
                tokio::spawn(
                    async move { tower::Service::call(&mut router, request).await.unwrap() },
                );
            tokio::time::timeout(std::time::Duration::from_secs(2), reading_rx)
                .await
                .unwrap()
                .unwrap();
            crate::accio_work::remove(&db).unwrap();
            finish_tx.send(()).unwrap();
            assert_eq!(reply.await.unwrap().status(), StatusCode::UNAUTHORIZED);
            assert_eq!(server.get_status().await.total_requests, 0);
            server.state.accio_runtime.stop_synthetic_child(&db).await;
        }
    }

    #[tokio::test]
    #[cfg(all(feature = "accio-work-experimental", unix))]
    async fn accio_connector_http_denials_are_paced_without_delaying_catalog() {
        let db = Arc::new(Database::memory().unwrap());
        crate::accio_work::save(&db, &crate::accio_work::synthetic_profile()).unwrap();
        let config = ProxyConfig {
            listen_port: 0,
            listen_address: "127.0.0.1".into(),
            ..Default::default()
        };
        let server = ProxyServer::new(config, db.clone(), None);
        server.state.accio_runtime.synthetic_child(&db);
        let active = server.state.accio_runtime.authorized_profile(&db).unwrap();
        let info = server.start().await.unwrap();
        let origin = format!("http://127.0.0.1:{}/accio-work", info.port);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .unwrap();
        let start = std::time::Instant::now();
        let mut tasks = tokio::task::JoinSet::new();
        for (capability, expected) in [(active.capability.clone(), 400), ("0".repeat(64), 401)] {
            let client = client.clone();
            let url = format!("{origin}/{capability}/api/channel/authorization/status");
            tasks.spawn(async move {
                let response = client
                    .post(url)
                    .json(&serde_json::json!({"token":"synthetic-identity-never-forwarded"}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status().as_u16(), expected);
                assert_eq!(response.headers()["retry-after"], "5");
                assert!(!response
                    .text()
                    .await
                    .unwrap()
                    .contains("synthetic-identity"));
                assert!(start.elapsed() >= std::time::Duration::from_secs(5));
            });
        }
        let catalog = client
            .post(format!("{origin}/{}/api/llm/config/v2", active.capability))
            .json(&serde_json::json!({}))
            .send();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(2), catalog)
                .await
                .unwrap()
                .unwrap()
                .status(),
            reqwest::StatusCode::OK
        );
        // These requests must fail locally. No official credential is used.
        for (suffix, method, expected) in [
            (
                "plugin%2Flist?accessToken=synthetic",
                reqwest::Method::GET,
                400,
            ),
            (
                "plugin/list?accessToken=a&accessToken=b",
                reqwest::Method::GET,
                400,
            ),
            ("plugin/list", reqwest::Method::POST, 400),
            ("plugin/download-ticket", reqwest::Method::POST, 501),
            ("mcp/proxy", reqwest::Method::POST, 501),
        ] {
            let response = client
                .request(
                    method,
                    format!("{origin}/{}/api/{suffix}", active.capability),
                )
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), expected, "{suffix}");
        }
        for token in [&active.capability, "synthetic-accio-key"] {
            let response = client
                .get(format!("{origin}/{}/api/plugin/list", active.capability))
                .query(&[("accessToken", token)])
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert!(!response.text().await.unwrap().contains(token));
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        assert_eq!(server.get_status().await.total_requests, 0);
        server.state.accio_runtime.stop_synthetic_child(&db).await;
        server.stop().await.unwrap();
    }

    #[tokio::test]
    #[cfg(all(feature = "accio-work-experimental", unix))]
    async fn accio_failed_duplicate_bind_cannot_revoke_running_core() {
        let db = Arc::new(Database::memory().unwrap());
        crate::accio_work::save(&db, &crate::accio_work::synthetic_profile()).unwrap();
        let first = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                ..Default::default()
            },
            db.clone(),
            None,
        );
        first.state.accio_runtime.synthetic_child(&db);
        let info = first.start().await.unwrap();
        let active = first.state.accio_runtime.authorized_profile(&db).unwrap();
        let mut second = ProxyServer::new(
            ProxyConfig {
                listen_address: info.address.clone(),
                listen_port: info.port,
                ..Default::default()
            },
            db.clone(),
            None,
        );
        let (command_tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        second.state.core_control = Some(crate::core_daemon::CoreControl {
            token: Arc::from("synthetic-admin"),
            command_tx,
            binary_id: Arc::from("synthetic"),
            config_dir: Arc::new(std::path::PathBuf::from("/synthetic")),
            routes: crate::route_selection::Selector::new(db.clone()),
        });
        assert!(second.start().await.is_err());
        assert_eq!(
            first
                .state
                .accio_runtime
                .authorized_profile(&db)
                .unwrap()
                .capability,
            active.capability
        );
        assert_eq!(first.get_status().await.active_targets.len(), 1);
        first.state.accio_runtime.stop_synthetic_child(&db).await;
        first.stop().await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn accio_forward_error_keeps_upstream_http_provenance() {
        use crate::proxy::handler_context::RequestContext;
        use serde_json::json;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let app = Router::new().route("/v1/responses", post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({"error":{"code":"server_error","message":"overloaded synthetic-secret"}})))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}/v1", listener.local_addr().unwrap());
        let mock = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let server = ProxyServer::new(
            ProxyConfig::default(),
            Arc::new(Database::memory().unwrap()),
            None,
        );
        let mut provider = crate::provider::Provider::with_id(
            "synthetic-local-failure".into(),
            "Synthetic".into(),
            json!({"auth":{"OPENAI_API_KEY":"synthetic-not-real"}, "config":format!("model_provider = \"custom\"\nmodel = \"synthetic-model\"\n[model_providers.custom]\nbase_url = \"{origin}\"\nwire_api = \"responses\"\n")}),
            None,
        );
        provider.meta = Some(crate::provider::ProviderMeta {
            api_format: Some("openai_responses".into()),
            ..Default::default()
        });
        let body = json!({"model":"synthetic-model","input":"synthetic","stream":true});
        let ctx = RequestContext::for_accio(
            &server.state,
            &body,
            provider,
            "synthetic-failure-scope".into(),
        )
        .await
        .unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            super::handlers::forward_responses_with_context(
                &server.state,
                ctx,
                http::Method::POST,
                "/responses".into(),
                body,
                http::HeaderMap::new(),
                http::Extensions::new(),
            ),
        )
        .await;
        mock.abort();
        let _ = mock.await;
        let result = result.unwrap();
        let error = result.expect_err("Accio must retain the original forwarding error type");
        assert!(
            matches!(error, super::ProxyError::UpstreamError { status: 503, .. }),
            "unexpected synthetic error: {error:?}"
        );
        let message = super::super::accio_diagnostics::proxy_message(&error);
        assert!(message.contains("HTTP 503"));
        assert!(message.contains("服务过载"));
        assert!(!message.contains("本地 HTTP"));
        assert!(!message.contains("synthetic-not-real"));
        assert!(!message.contains("synthetic-secret"));
        assert!(!message.contains(&origin));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(server.get_status().await.active_connections, 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn accio_round_trip_reuses_three_protocols_without_touching_codex_scope() {
        use crate::proxy::{handler_context::RequestContext, providers::accio::accio_to_responses};
        use axum::{extract::Json, http::HeaderMap, response::IntoResponse};
        use serde_json::{json, Value};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let app = Router::new().route("/v1/*endpoint",post(move |axum::extract::Path(endpoint): axum::extract::Path<String>, headers:HeaderMap, Json(body):Json<Value>| {
            let observed = observed.clone();
            async move {
                observed.fetch_add(1,Ordering::SeqCst);
                assert_eq!(headers["authorization"],"Bearer synthetic-upstream");
                assert!(headers.get("utdid").is_none());
                assert!(body.get("token").is_none());
                let model = body["model"].as_str().unwrap();
                let text = "synthetic OK";
                let events = match endpoint.as_str() {
                    "chat/completions" => {
                        assert_eq!(model,"chat-model");
                        vec![
                            json!({"id":"chat-synthetic","model":model,"choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]}),
                            json!({"id":"chat-synthetic","model":model,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}),
                        ]
                    },
                    "responses" => {
                        assert_eq!(model,"native-model");
                        vec![
                            json!({"type":"response.output_text.delta","item_id":"msg-native","content_index":0,"delta":text}),
                            json!({"type":"response.completed","response":{"id":"resp-native","status":"completed","model":model,"output":[{"id":"msg-native","type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}),
                        ]
                    },
                    "messages" => {
                        assert_eq!(model,"claude-model");
                        vec![
                            json!({"type":"message_start","message":{"id":"msg-claude","role":"assistant","model":model,"content":[],"usage":{"input_tokens":1,"output_tokens":0}}}),
                            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
                            json!({"type":"content_block_stop","index":0}),
                            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}),
                            json!({"type":"message_stop"}),
                        ]
                    },
                    _ => panic!("unexpected upstream endpoint"),
                };
                let text = events.iter().map(|event|format!("data: {event}\n\n")).collect::<String>();
                ([ ("content-type","text/event-stream") ],text+"data: [DONE]\n\n").into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let mock = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let server = ProxyServer::new(
            ProxyConfig::default(),
            Arc::new(Database::memory().unwrap()),
            None,
        );
        let mut provider = crate::provider::Provider::with_id(
            "synthetic".into(),
            "Synthetic".into(),
            json!({
                "auth":{"OPENAI_API_KEY":"synthetic-upstream"},
                "config":format!("model_provider = \"custom\"\nmodel = \"wrong-default\"\n[model_providers.custom]\nbase_url = \"{upstream_url}\"\nwire_api = \"responses\"\n"),
                "modelCatalog":{"models":[
                    {"model":"chat-model","apiFormat":"openai_chat"},
                    {"model":"native-model","apiFormat":"openai_responses"},
                    {"model":"claude-model","apiFormat":"anthropic"}
                ]}
            }),
            None,
        );
        provider.meta = Some(crate::provider::ProviderMeta {
            api_format: Some("openai_responses".into()),
            ..Default::default()
        });
        for model in ["chat-model", "native-model", "claude-model"] {
            let body = accio_to_responses(&json!({"model":model,"token":"synthetic-official-token","contents":[{"role":"user","parts":[{"text":"synthetic test"}]}]})).unwrap();
            let ctx = RequestContext::for_accio(
                &server.state,
                &body,
                provider.clone(),
                "synthetic-accio-scope".into(),
            )
            .await
            .unwrap();
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                super::super::handlers::forward_responses_with_context(
                    &server.state,
                    ctx,
                    http::Method::POST,
                    "/responses".into(),
                    body,
                    HeaderMap::new(),
                    http::Extensions::new(),
                ),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(response.status().is_success());
            let slots = Arc::new(tokio::sync::Semaphore::new(1));
            let body = Body::from_stream(super::super::accio::convert_stream(
                response.into_body(),
                slots.clone().acquire_owned().await.unwrap(),
            ));
            let bytes = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                axum::body::to_bytes(body, 1024 * 1024),
            )
            .await
            .unwrap()
            .unwrap();
            let text = String::from_utf8_lossy(&bytes);
            assert!(text.contains("synthetic OK"), "{model}: {text}");
            assert!(!text.contains("errorCode"), "{model}: {text}");
            assert!(text.contains("\"turnComplete\":true"));
            assert_eq!(slots.available_permits(), 1);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        let targets = server.state.current_providers.read().await;
        assert!(targets.contains_key("accio-work"));
        assert!(!targets.contains_key("codex"));
        mock.abort();
        let _ = mock.await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn imagegen_admin_authenticates_before_body_and_exposes_only_public_refs() {
        use http_body_util::BodyExt;
        let (_cleanup, db, entries) = crate::imagegen_core::test_support::fixture();
        let db = Arc::new(db);
        let mut server = ProxyServer::new(ProxyConfig::default(), db.clone(), None);
        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        server.state.core_control = Some(CoreControl {
            token: "synthetic-admin-token".into(),
            command_tx,
            binary_id: "synthetic-core".into(),
            config_dir: Arc::new(std::path::PathBuf::from("synthetic-config")),
            routes: crate::route_selection::Selector::new(db),
        });
        let pending_body = Body::from_stream(futures::stream::pending::<
            Result<bytes::Bytes, std::io::Error>,
        >());
        let mut router = server.build_router();
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            tower::Service::call(
                &mut router,
                Request::builder()
                    .method("POST")
                    .uri("/__yuanheng/core/imagegen/credentials")
                    .body(pending_body)
                    .unwrap(),
            ),
        )
        .await
        .expect("unauthorized requests must not wait for a body")
        .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let valid = serde_json::to_vec(&crate::imagegen_core::CredentialSnapshot {
            entries: entries.clone(),
        })
        .unwrap();
        for (auth, body, expected) in [
            (
                None,
                vec![b'x'; crate::imagegen_core::MAX_BODY + 1],
                StatusCode::UNAUTHORIZED,
            ),
            (Some("wrong"), valid.clone(), StatusCode::UNAUTHORIZED),
            (
                Some("synthetic-admin-token"),
                vec![b'x'; crate::imagegen_core::MAX_BODY + 1],
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
            (
                Some("synthetic-admin-token"),
                b"{".to_vec(),
                StatusCode::BAD_REQUEST,
            ),
            (
                Some("synthetic-admin-token"),
                b"{\"entries\":[]}".to_vec(),
                StatusCode::CONFLICT,
            ),
            (Some("synthetic-admin-token"), valid, StatusCode::OK),
        ] {
            let mut request = Request::builder()
                .method("POST")
                .uri("/__yuanheng/core/imagegen/credentials")
                .header("content-type", "application/json");
            if let Some(auth) = auth {
                request = request.header("authorization", format!("Bearer {auth}"));
            }
            let response = tower::Service::call(
                &mut server.build_router(),
                request.body(Body::from(body)).unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), expected);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            assert!(!String::from_utf8_lossy(&body).contains("sk-synthetic"));
            if expected == StatusCode::OK {
                assert_eq!(body.as_ref(), br#"{"ok":true}"#);
            }
        }
        let response = tower::Service::call(
            &mut server.build_router(),
            Request::builder()
                .uri("/__yuanheng/core/info")
                .header("authorization", "Bearer synthetic-admin-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(!String::from_utf8_lossy(&body).contains("sk-synthetic"));
        let info: crate::core_daemon::CoreInfo = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            info.imagegen_credential_refs.get("dsh"),
            Some(&entries[0].connection_ref)
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn desktop_gateway_auth_parse_and_mapping_failures_are_http_responses() {
        use http_body_util::BodyExt;
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
        let token = crate::claude_desktop_config::get_or_create_gateway_token(&db).unwrap();
        let provider = crate::provider::Provider::with_id(
            "synthetic-provider".into(),
            "Synthetic".into(),
            serde_json::json!({"env": {
                "ANTHROPIC_BASE_URL": "http://127.0.0.1:1",
                "ANTHROPIC_AUTH_TOKEN": "synthetic-upstream-token"
            }}),
            None,
        );
        // Intentionally omit routes: a valid Messages request must fail locally
        // with 400, never contact even the synthetic upstream.
        db.save_provider("claude-desktop", &provider).unwrap();
        db.set_current_provider("claude-desktop", &provider.id)
            .unwrap();
        let server = ProxyServer::new(ProxyConfig::default(), db, None);
        for (auth, body, expected) in [
            (None, "{}", 401),
            (Some("wrong-token"), "{", 401),
            (Some(token.as_str()), "{", 500),
            (
                Some(token.as_str()),
                r#"{"model":"claude-sonnet-5","messages":[{"role":"user","content":"synthetic"}],"max_tokens":1}"#,
                400,
            ),
        ] {
            let mut request = Request::builder()
                .method("POST")
                .uri("/claude-desktop/v1/messages")
                .header("content-type", "application/json");
            if let Some(auth) = auth {
                request = request.header("authorization", format!("Bearer {auth}"));
            }
            let response = tower::Service::call(
                &mut server.build_router(),
                request.body(Body::from(body)).unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(response.status().as_u16(), expected);
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert!(json.get("error").is_some());
            assert!(!String::from_utf8_lossy(&bytes).contains(&token));
        }
    }

    #[tokio::test]
    async fn image_routes_and_existing_chat_routes_are_registered() {
        let server = ProxyServer::new(
            ProxyConfig::default(),
            Arc::new(Database::memory().unwrap()),
            None,
        );
        for prefix in ["", "/v1", "/v1/v1", "/codex/v1"] {
            for endpoint in [
                "images/generations",
                "images/edits",
                "responses",
                "chat/completions",
            ] {
                let mut router = server.build_router();
                let response = tower::Service::call(
                    &mut router,
                    Request::builder()
                        .method("OPTIONS")
                        .uri(format!("{prefix}/{endpoint}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
                assert_eq!(
                    response.status(),
                    StatusCode::METHOD_NOT_ALLOWED,
                    "{prefix}/{endpoint}"
                );
                assert_eq!(response.headers()["allow"], "POST");
            }
        }
        for (path, method) in [
            ("/chatgpt-desktop/v1/images/generations", "POST"),
            ("/chatgpt-desktop/v1/images/edits", "POST"),
            ("/codex/v1/images/models", "GET,HEAD"),
            ("/chatgpt-desktop/v1/images/models", "GET,HEAD"),
            ("/claude/v1/images/models", "GET,HEAD"),
            ("/gemini/v1/images/models", "GET,HEAD"),
            ("/grokbuild/v1/images/models", "GET,HEAD"),
            ("/opencode/v1/images/models", "GET,HEAD"),
            ("/hermes/v1/images/models", "GET,HEAD"),
            ("/dsh/v1/images/models", "GET,HEAD"),
            ("/workbuddy/v1/images/models", "GET,HEAD"),
            ("/claude/v1/images/generations", "POST"),
            ("/gemini/v1/images/edits", "POST"),
            ("/grokbuild/v1/images/generations", "POST"),
            ("/opencode/v1/images/edits", "POST"),
            ("/hermes/v1/images/generations", "POST"),
            ("/dsh/v1/images/edits", "POST"),
            ("/workbuddy/v1/images/generations", "POST"),
        ] {
            let response = tower::Service::call(
                &mut server.build_router(),
                Request::builder()
                    .method("OPTIONS")
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED, "{path}");
            assert_eq!(response.headers()["allow"], method, "{path}");
        }
    }
}
