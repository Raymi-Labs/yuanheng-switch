use crate::app_store;
use crate::config::get_app_config_dir;
use crate::database::Database;
use crate::proxy::providers::codex_oauth_auth::CodexOAuthManager;
use crate::proxy::providers::copilot_auth::CopilotAuthManager;
use crate::proxy::providers::xai_oauth_auth::XaiOAuthManager;
use crate::proxy::server::ProxyServer;
use crate::proxy::{ProxyConfig, ProxyServerInfo, ProxyStatus};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, RwLock};

pub const CORE_PROTOCOL_VERSION: u32 = 2;
const CORE_EXECUTABLE_NAME: &str = if cfg!(windows) {
    "yuanheng-core.exe"
} else {
    "yuanheng-core"
};
const CORE_ADMIN_TOKEN_FILE: &str = "admin.token";
const CORE_RUNTIME_FILE: &str = "runtime.json";
const CORE_START_TIMEOUT: Duration = Duration::from_secs(12);
const CORE_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const CORE_ADMIN_PREFIX: &str = "/__yuanheng/core";

#[derive(Debug)]
pub(crate) enum CoreCommand {
    Reload {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Shutdown {
        reply: oneshot::Sender<Result<(), String>>,
    },
    ResetCircuitBreaker {
        provider_id: String,
        app_type: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

#[derive(Clone)]
pub(crate) struct CoreControl {
    pub token: Arc<str>,
    pub command_tx: mpsc::UnboundedSender<CoreCommand>,
    pub binary_id: Arc<str>,
    pub config_dir: Arc<PathBuf>,
    pub routes: Arc<crate::route_selection::Selector>,
}

#[derive(Clone)]
pub(crate) struct ProxyAuthManagers {
    pub copilot: Arc<RwLock<CopilotAuthManager>>,
    pub codex: Arc<RwLock<CodexOAuthManager>>,
    pub xai: Arc<RwLock<XaiOAuthManager>>,
}

impl ProxyAuthManagers {
    fn new(config_dir: &Path) -> Self {
        Self {
            copilot: Arc::new(RwLock::new(CopilotAuthManager::new(
                config_dir.to_path_buf(),
            ))),
            codex: Arc::new(RwLock::new(CodexOAuthManager::new(
                config_dir.to_path_buf(),
            ))),
            xai: Arc::new(RwLock::new(XaiOAuthManager::new(config_dir.to_path_buf()))),
        }
    }

    async fn reload_from_disk(&self) {
        if let Err(error) = self.copilot.read().await.reload_from_disk() {
            log::warn!("[Core] 重新加载 Copilot 认证数据失败: {error}");
        }
        if let Err(error) = self.codex.read().await.reload_from_disk() {
            log::warn!("[Core] 重新加载 Codex OAuth 数据失败: {error}");
        }
        if let Err(error) = self.xai.read().await.reload_from_disk() {
            log::warn!("[Core] 重新加载 xAI OAuth 数据失败: {error}");
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreInfo {
    pub protocol_version: u32,
    pub version: String,
    pub build_profile: String,
    pub pid: u32,
    pub binary_id: String,
    pub config_dir: String,
    pub status: ProxyStatus,
    /// Optional for older Core binaries; absence must not mean a healthy probe.
    #[serde(default)]
    pub(crate) request_diagnostics: Option<crate::core_diagnostics::Snapshot>,
}

impl CoreInfo {
    pub(crate) async fn from_control(control: &CoreControl, status: ProxyStatus) -> Self {
        Self {
            protocol_version: CORE_PROTOCOL_VERSION,
            version: env!("CARGO_PKG_VERSION").to_string(),
            build_profile: if cfg!(debug_assertions) {
                "debug".to_string()
            } else {
                "release".to_string()
            },
            pid: std::process::id(),
            binary_id: control.binary_id.to_string(),
            config_dir: control.config_dir.display().to_string(),
            status,
            request_diagnostics: crate::core_diagnostics::snapshot(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreRuntimeRecord {
    pid: u32,
    address: String,
    port: u16,
    binary_id: String,
    updated_at: String,
}

pub struct CoreSupervisor {
    config_dir: PathBuf,
}

impl CoreSupervisor {
    pub fn new(config_dir: PathBuf) -> Self {
        Self { config_dir }
    }

    pub async fn status(&self, db: &Database) -> Result<CoreInfo, String> {
        let token = read_admin_token(&self.config_dir)?;
        let config = db
            .get_proxy_config()
            .await
            .map_err(|error| format!("读取代理配置失败: {error}"))?;
        self.query_info(&token, &config).await
    }

    pub async fn ensure_running(&self, db: &Database) -> Result<CoreInfo, String> {
        let source = resolve_bundled_core_path()?;
        self.ensure_running_from(db, &source).await
    }

    pub async fn ensure_running_from(
        &self,
        db: &Database,
        source: &Path,
    ) -> Result<CoreInfo, String> {
        static START_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        let _guard = START_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        let installed = install_versioned_core(&self.config_dir, source)?;
        let token = ensure_admin_token(&self.config_dir)?;
        let config = db
            .get_proxy_config()
            .await
            .map_err(|error| format!("读取代理配置失败: {error}"))?;

        if let Ok(info) = self.query_info(&token, &config).await {
            if info.protocol_version != CORE_PROTOCOL_VERSION {
                if info.status.active_connections > 0 {
                    log::info!(
                        "[Core] 协议版本需要升级，但仍有 {} 个活跃连接，本次延后升级",
                        info.status.active_connections
                    );
                    return Ok(info);
                }
                return self
                    .upgrade_idle_core(&token, &config, &installed, &info)
                    .await;
            }

            // 开发版只复用现有稳定 Core，绝不因为 GUI 重建而替换或重启它。
            if cfg!(debug_assertions) || info.binary_id == installed.id {
                return Ok(info);
            }

            // 发布版只在没有进行中的请求时无感切换，活跃 SSE 会话保持在旧 Core。
            if info.status.active_connections == 0 {
                return self
                    .upgrade_idle_core(&token, &config, &installed, &info)
                    .await;
            }

            log::info!(
                "[Core] 检测到新版本，但仍有 {} 个活跃连接，本次延后升级",
                info.status.active_connections
            );
            return Ok(info);
        }

        activate_core_version(&self.config_dir, &installed.path)?;
        self.install_and_start_service().await?;
        self.wait_until_ready(&token, &config, Some(&installed.id))
            .await
    }

    async fn upgrade_idle_core(
        &self,
        token: &str,
        config: &ProxyConfig,
        installed: &InstalledCore,
        previous: &CoreInfo,
    ) -> Result<CoreInfo, String> {
        // 保存可回退的旧二进制。版本目录不变，失败时不会丢失旧版本。
        let old = install_versioned_core(&self.config_dir, &current_core_path(&self.config_dir))?;
        #[cfg(not(target_os = "macos"))]
        {
            self.request_shutdown(token, config).await?;
            let deadline = tokio::time::Instant::now() + CORE_START_TIMEOUT;
            while read_runtime_record(&self.config_dir)
                .ok()
                .is_some_and(|record| record.pid == previous.pid)
            {
                if tokio::time::Instant::now() >= deadline {
                    return Err("旧 Core 尚未安全退出，未覆盖正在使用的文件".to_string());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        #[cfg(target_os = "macos")]
        let _ = previous;

        let upgrade = async {
            // Windows 进程已停止，但系统可能仍短暂持有映像句柄；只重试共享冲突。
            let deadline = tokio::time::Instant::now() + CORE_START_TIMEOUT;
            loop {
                match activate_core_version(&self.config_dir, &installed.path) {
                    Ok(()) => break,
                    Err(error)
                        if cfg!(windows)
                            && (error.contains("os error 32") || error.contains("os error 5"))
                            && tokio::time::Instant::now() < deadline =>
                    {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    Err(error) => return Err(error),
                }
            }
            #[cfg(target_os = "macos")]
            self.request_shutdown(token, config).await?;
            #[cfg(not(target_os = "macos"))]
            self.install_and_start_service().await?;
            self.wait_until_ready(token, config, Some(&installed.id))
                .await
        }
        .await;
        match upgrade {
            Ok(info) => Ok(info),
            Err(error) => {
                // 启动已经发生时不能覆盖可能仍运行的新进程。
                if self.query_info(token, config).await.is_ok() {
                    return Err(format!("Core 升级核验失败，保留正在运行的核心：{error}"));
                }
                activate_core_version(&self.config_dir, &old.path)?;
                self.install_and_start_service().await?;
                self.wait_until_ready(token, config, Some(&old.id))
                    .await
                    .map_err(|rollback| format!("{error}；旧 Core 恢复失败：{rollback}"))?;
                Err(format!("Core 升级失败，已恢复旧版本：{error}"))
            }
        }
    }

    pub async fn reload(&self, db: &Database) -> Result<(), String> {
        let token = read_admin_token(&self.config_dir)?;
        let config = db
            .get_proxy_config()
            .await
            .map_err(|error| format!("读取代理配置失败: {error}"))?;
        self.post_admin(&token, &config, "reload").await
    }

    pub async fn reset_circuit_breaker(
        &self,
        db: &Database,
        provider_id: &str,
        app_type: &str,
    ) -> Result<(), String> {
        let token = read_admin_token(&self.config_dir)?;
        let config = db
            .get_proxy_config()
            .await
            .map_err(|error| format!("读取代理配置失败: {error}"))?;
        self.post_admin_json(
            &token,
            &config,
            "reset-circuit-breaker",
            serde_json::json!({
                "providerId": provider_id,
                "appType": app_type,
            }),
        )
        .await
    }

    pub(crate) async fn route_request(
        &self,
        db: &Database,
        action: &str,
        body: Option<serde_json::Value>,
    ) -> Result<crate::route_selection::Status, String> {
        let token =
            read_admin_token(&self.config_dir).map_err(|_| "core_unavailable".to_string())?;
        let config = db
            .get_proxy_config()
            .await
            .map_err(|_| "core_unavailable".to_string())?;
        let client = admin_client()?;
        for (address, port) in candidate_ports(&self.config_dir, &config) {
            let url = format!(
                "{}{CORE_ADMIN_PREFIX}/routes{action}",
                proxy_origin(&address, port)
            );
            let request = match &body {
                Some(value) => client.post(url).json(value),
                None => client.get(url),
            };
            // Mutations are not retried after any response: an acknowledgement may be lost.
            match request.bearer_auth(&token).send().await {
                Ok(response) if response.status().is_success() => {
                    return response
                        .json()
                        .await
                        .map_err(|_| "invalid_core_response".into())
                }
                Ok(response) => {
                    if response.status() == reqwest::StatusCode::NOT_FOUND {
                        return Err("core_update_required".into());
                    }
                    let value: serde_json::Value = response.json().await.unwrap_or_default();
                    return Err(value["error"]
                        .as_str()
                        .unwrap_or("route_request_failed")
                        .to_string());
                }
                Err(_) if body.is_some() => return Err("core_unavailable".into()),
                Err(_) => continue,
            }
        }
        Err("core_unavailable".into())
    }

    pub async fn restart(&self, db: &Database) -> Result<CoreInfo, String> {
        let info = self.status(db).await.ok();
        if cfg!(debug_assertions)
            && info
                .as_ref()
                .is_some_and(|current| current.build_profile == "release")
        {
            return Err("开发版不能重启正式版 YuanHeng Core".to_string());
        }

        self.restart_service(true).await?;
        let token = read_admin_token(&self.config_dir)?;
        let config = db
            .get_proxy_config()
            .await
            .map_err(|error| format!("读取代理配置失败: {error}"))?;
        self.wait_until_ready(&token, &config, None).await
    }

    pub async fn stop(&self, db: &Database, force: bool) -> Result<(), String> {
        if !force {
            if let Ok(info) = self.status(db).await {
                if cfg!(debug_assertions) && info.build_profile == "release" {
                    return Err("开发版不能停止正式版 YuanHeng Core".to_string());
                }
            }
        }
        stop_platform_service(&self.config_dir)
    }

    async fn request_shutdown(&self, token: &str, config: &ProxyConfig) -> Result<(), String> {
        self.post_admin(token, config, "shutdown").await
    }

    async fn query_info(&self, token: &str, config: &ProxyConfig) -> Result<CoreInfo, String> {
        let ports = candidate_ports(&self.config_dir, config);
        let client = admin_client()?;
        let mut last_error = String::new();

        for (address, port) in ports {
            let url = format!("{}{CORE_ADMIN_PREFIX}/info", proxy_origin(&address, port));
            match client.get(url).bearer_auth(token).send().await {
                Ok(response) if response.status().is_success() => {
                    return response
                        .json::<CoreInfo>()
                        .await
                        .map_err(|error| format!("解析 Core 状态失败: {error}"));
                }
                Ok(response) => {
                    last_error = format!("Core 状态接口返回 {}", response.status());
                }
                Err(error) => {
                    last_error = error.to_string();
                }
            }
        }

        Err(if last_error.is_empty() {
            "YuanHeng Core 未运行".to_string()
        } else {
            format!("YuanHeng Core 未运行: {last_error}")
        })
    }

    async fn post_admin(
        &self,
        token: &str,
        config: &ProxyConfig,
        action: &str,
    ) -> Result<(), String> {
        let client = admin_client()?;
        let mut last_error = String::new();
        for (address, port) in candidate_ports(&self.config_dir, config) {
            let url = format!(
                "{}{CORE_ADMIN_PREFIX}/{action}",
                proxy_origin(&address, port)
            );
            match client.post(url).bearer_auth(token).send().await {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) => {
                    last_error = format!("Core 管理接口返回 {}", response.status());
                }
                Err(error) => last_error = error.to_string(),
            }
        }
        Err(format!("调用 Core {action} 失败: {last_error}"))
    }

    async fn post_admin_json(
        &self,
        token: &str,
        config: &ProxyConfig,
        action: &str,
        body: serde_json::Value,
    ) -> Result<(), String> {
        let client = admin_client()?;
        let mut last_error = String::new();
        for (address, port) in candidate_ports(&self.config_dir, config) {
            let url = format!(
                "{}{CORE_ADMIN_PREFIX}/{action}",
                proxy_origin(&address, port)
            );
            match client.post(url).bearer_auth(token).json(&body).send().await {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) => {
                    last_error = format!("Core 管理接口返回 {}", response.status());
                }
                Err(error) => last_error = error.to_string(),
            }
        }
        Err(format!("调用 Core {action} 失败: {last_error}"))
    }

    async fn wait_until_ready(
        &self,
        token: &str,
        config: &ProxyConfig,
        expected_binary_id: Option<&str>,
    ) -> Result<CoreInfo, String> {
        let deadline = tokio::time::Instant::now() + CORE_START_TIMEOUT;
        let mut last_error = String::new();
        while tokio::time::Instant::now() < deadline {
            match self.query_info(token, config).await {
                Ok(info)
                    if expected_binary_id.is_none_or(|expected| info.binary_id == expected) =>
                {
                    return Ok(info);
                }
                Ok(info) => {
                    last_error = format!(
                        "仍在运行旧 Core（当前 {}，期望 {}）",
                        info.binary_id,
                        expected_binary_id.unwrap_or_default()
                    );
                }
                Err(error) => last_error = error,
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        Err(format!("等待 YuanHeng Core 启动超时: {last_error}"))
    }

    async fn install_and_start_service(&self) -> Result<(), String> {
        install_platform_service(&self.config_dir)?;
        start_platform_service(&self.config_dir)
    }

    async fn restart_service(&self, keep_enabled: bool) -> Result<(), String> {
        if keep_enabled {
            install_platform_service(&self.config_dir)?;
        }
        restart_platform_service(&self.config_dir)
    }
}

struct InstalledCore {
    id: String,
    path: PathBuf,
}

pub fn run_core_cli() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "status".to_string());
    let mut config_dir = None;

    while let Some(arg) = args.next() {
        if arg == "--config-dir" {
            let value = args
                .next()
                .ok_or_else(|| "--config-dir 缺少路径".to_string())?;
            config_dir = Some(PathBuf::from(value));
        }
    }

    let config_dir = config_dir.unwrap_or_else(get_app_config_dir);
    app_store::set_app_config_dir_override_for_process(Some(config_dir.clone()));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("创建 Core runtime 失败: {error}"))?;

    let result = runtime.block_on(async move {
        match command.as_str() {
            "run" => run_core(config_dir).await,
            "start" | "recover" => {
                let db = Database::init().map_err(|error| error.to_string())?;
                let supervisor = CoreSupervisor::new(config_dir);
                let source = std::env::current_exe()
                    .map_err(|error| format!("获取 Core 可执行文件失败: {error}"))?;
                let info = supervisor.ensure_running_from(&db, &source).await?;
                println!(
                    "running pid={} {}:{} version={} protocol={}",
                    info.pid,
                    info.status.address,
                    info.status.port,
                    info.version,
                    info.protocol_version
                );
                Ok(())
            }
            "stop" => {
                let db = Database::init().map_err(|error| error.to_string())?;
                CoreSupervisor::new(config_dir).stop(&db, true).await?;
                println!("stopped");
                Ok(())
            }
            "reload" => {
                let db = Database::init().map_err(|error| error.to_string())?;
                CoreSupervisor::new(config_dir).reload(&db).await?;
                println!("reloaded");
                Ok(())
            }
            "status" => {
                let db = Database::init().map_err(|error| error.to_string())?;
                let info = CoreSupervisor::new(config_dir).status(&db).await?;
                println!(
                    "running pid={} {}:{} version={} protocol={} active={}",
                    info.pid,
                    info.status.address,
                    info.status.port,
                    info.version,
                    info.protocol_version,
                    info.status.active_connections
                );
                Ok(())
            }
            other => Err(format!(
                "未知命令 {other}，可用命令: run/start/status/reload/stop/recover"
            )),
        }
    });
    runtime.block_on(crate::core_diagnostics::shutdown());
    result
}

async fn run_core(config_dir: PathBuf) -> Result<(), String> {
    init_core_logger();
    crate::core_diagnostics::init(&config_dir);
    app_store::set_app_config_dir_override_for_process(Some(config_dir.clone()));
    crate::settings::reload_settings().map_err(|error| error.to_string())?;

    let db = Arc::new(Database::init().map_err(|error| error.to_string())?);
    let proxy_url = db.get_global_proxy_url().ok().flatten();
    crate::proxy::http_client::init(proxy_url.as_deref())?;

    let config = db
        .get_proxy_config()
        .await
        .map_err(|error| format!("读取代理配置失败: {error}"))?;
    let token = ensure_admin_token(&config_dir)?;
    let binary_id = hash_file(
        &std::env::current_exe().map_err(|error| format!("获取当前 Core 路径失败: {error}"))?,
    )?;
    let auth_managers = ProxyAuthManagers::new(&config_dir);
    let (command_tx, mut command_rx) = mpsc::unbounded_channel();
    let control = CoreControl {
        token: Arc::from(token),
        command_tx,
        binary_id: Arc::from(binary_id.clone()),
        config_dir: Arc::new(config_dir.clone()),
        routes: crate::route_selection::Selector::new(db.clone()),
    };

    let routes = control.routes.clone();
    let server =
        ProxyServer::new_headless(config.clone(), db.clone(), control, auth_managers.clone());
    let info = server
        .start()
        .await
        .map_err(|error| format!("启动代理服务器失败: {error}"))?;
    persist_ephemeral_port(&db, &config, info.port).await?;
    write_runtime_record(&config_dir, &info, &binary_id)?;

    log::info!(
        "[Core] YuanHeng Core 已启动，pid={}，监听 {}:{}",
        std::process::id(),
        info.address,
        info.port
    );

    let mut reload_interval = tokio::time::interval(Duration::from_secs(1));
    reload_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let terminate_signal = wait_for_terminate_signal();
    tokio::pin!(terminate_signal);

    loop {
        tokio::select! {
            _ = reload_interval.tick() => {
                routes.tick();
                if let Err(error) = reload_core_state(&server, &db, &auth_managers).await {
                    log::warn!("[Core] 周期热加载失败: {error}");
                }
            }
            Some(command) = command_rx.recv() => {
                match command {
                    CoreCommand::Reload { reply } => {
                        let result = reload_core_state(&server, &db, &auth_managers).await;
                        let _ = reply.send(result);
                    }
                    CoreCommand::Shutdown { reply } => {
                        if server.get_status().await.active_connections > 0 {
                            let _ = reply.send(Err("仍有活跃请求，暂不停止 Core".to_string()));
                            continue;
                        }
                        let _ = reply.send(Ok(()));
                        tokio::time::sleep(Duration::from_millis(120)).await;
                        break;
                    }
                    CoreCommand::ResetCircuitBreaker {
                        provider_id,
                        app_type,
                        reply,
                    } => {
                        server
                            .reset_provider_circuit_breaker(&provider_id, &app_type)
                            .await;
                        let _ = reply.send(Ok(()));
                    }
                }
            }
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result {
                    log::warn!("[Core] 监听 Ctrl+C 失败: {error}");
                }
                break;
            }
            result = &mut terminate_signal => {
                if let Err(error) = result {
                    log::warn!("[Core] 监听 SIGTERM 失败: {error}");
                } else {
                    log::info!("[Core] 收到 SIGTERM，准备优雅退出");
                }
                break;
            }
        }
    }

    let _ = server.stop().await;
    remove_runtime_record_if_owned(&config_dir, std::process::id());
    log::info!("[Core] YuanHeng Core 已停止");
    Ok(())
}

#[cfg(unix)]
async fn wait_for_terminate_signal() -> Result<(), String> {
    let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| error.to_string())?;
    let _ = signal.recv().await;
    Ok(())
}

#[cfg(not(unix))]
async fn wait_for_terminate_signal() -> Result<(), String> {
    std::future::pending().await
}

async fn reload_core_state(
    server: &ProxyServer,
    db: &Arc<Database>,
    auth_managers: &ProxyAuthManagers,
) -> Result<(), String> {
    crate::settings::reload_settings().map_err(|error| error.to_string())?;
    auth_managers.reload_from_disk().await;

    let proxy_url = db.get_global_proxy_url().ok().flatten();
    crate::proxy::http_client::apply_proxy(proxy_url.as_deref())?;

    let config = db
        .get_proxy_config()
        .await
        .map_err(|error| format!("读取代理配置失败: {error}"))?;
    let status = server.get_status().await;
    if config.listen_address != status.address
        || (config.listen_port != 0 && config.listen_port != status.port)
    {
        log::warn!(
            "[Core] 监听地址已从 {}:{} 改为 {}:{}，需要由 Desktop 重启 Core 后生效",
            status.address,
            status.port,
            config.listen_address,
            config.listen_port
        );
    } else {
        server.apply_runtime_config(&config).await;
    }

    let mut targets = Vec::new();
    for app_type in [
        crate::app_config::AppType::Claude,
        crate::app_config::AppType::Codex,
        crate::app_config::AppType::Gemini,
        crate::app_config::AppType::GrokBuild,
    ] {
        let app_type_str = app_type.as_str();
        let enabled = db
            .get_proxy_config_for_app(app_type_str)
            .await
            .map(|config| config.enabled)
            .unwrap_or(false);
        if !enabled {
            continue;
        }

        let Some(provider_id) =
            crate::settings::get_effective_current_provider(db.as_ref(), &app_type)
                .map_err(|error| format!("读取 {app_type_str} 当前供应商失败: {error}"))?
        else {
            continue;
        };
        if let Some(provider) = db
            .get_provider_by_id(&provider_id, app_type_str)
            .map_err(|error| format!("读取 {app_type_str} 供应商失败: {error}"))?
        {
            targets.push((app_type_str.to_string(), provider.id, provider.name));
        }
    }
    server.replace_active_targets(targets).await;
    Ok(())
}

async fn persist_ephemeral_port(
    db: &Arc<Database>,
    config: &ProxyConfig,
    actual_port: u16,
) -> Result<(), String> {
    if config.listen_port != 0 {
        return Ok(());
    }
    let mut resolved = config.clone();
    resolved.listen_port = actual_port;
    db.update_proxy_config(resolved)
        .await
        .map_err(|error| format!("保存动态代理端口失败: {error}"))
}

fn admin_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_millis(800))
        .timeout(CORE_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("创建 Core 管理客户端失败: {error}"))
}

fn proxy_origin(address: &str, port: u16) -> String {
    let host = match address {
        "0.0.0.0" => "127.0.0.1".to_string(),
        "::" => "::1".to_string(),
        value => value.to_string(),
    };
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host
    };
    format!("http://{host}:{port}")
}

fn candidate_ports(config_dir: &Path, config: &ProxyConfig) -> Vec<(String, u16)> {
    let mut candidates = Vec::new();
    if let Ok(record) = read_runtime_record(config_dir) {
        candidates.push((record.address, record.port));
    }
    if config.listen_port != 0
        && !candidates
            .iter()
            .any(|(address, port)| address == &config.listen_address && *port == config.listen_port)
    {
        candidates.push((config.listen_address.clone(), config.listen_port));
    }
    if candidates.is_empty() {
        candidates.push(("127.0.0.1".to_string(), 15721));
    }
    candidates
}

fn resolve_bundled_core_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("YUANHENG_CORE_SOURCE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let current_exe =
        std::env::current_exe().map_err(|error| format!("获取 Desktop 路径失败: {error}"))?;
    let sibling = current_exe
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(CORE_EXECUTABLE_NAME);
    if sibling.is_file() {
        return Ok(sibling);
    }

    Err(format!(
        "未找到 YuanHeng Core sidecar：{}",
        sibling.display()
    ))
}

fn core_root(config_dir: &Path) -> PathBuf {
    config_dir.join("core")
}

fn current_core_path(config_dir: &Path) -> PathBuf {
    core_root(config_dir)
        .join("current")
        .join(CORE_EXECUTABLE_NAME)
}

fn runtime_record_path(config_dir: &Path) -> PathBuf {
    core_root(config_dir).join(CORE_RUNTIME_FILE)
}

fn admin_token_path(config_dir: &Path) -> PathBuf {
    core_root(config_dir).join(CORE_ADMIN_TOKEN_FILE)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn install_versioned_core(config_dir: &Path, source: &Path) -> Result<InstalledCore, String> {
    let id = hash_file(source)?;
    let version_dir = core_root(config_dir).join("versions").join(&id);
    let destination = version_dir.join(CORE_EXECUTABLE_NAME);
    fs::create_dir_all(&version_dir).map_err(|error| format!("创建 Core 版本目录失败: {error}"))?;

    if !destination.is_file() || hash_file(&destination).ok().as_deref() != Some(id.as_str()) {
        let temporary = destination.with_extension(format!("tmp.{}", std::process::id()));
        fs::copy(source, &temporary).map_err(|error| format!("安装 Core 二进制失败: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("设置 Core 执行权限失败: {error}"))?;
        }
        fs::rename(&temporary, &destination)
            .map_err(|error| format!("提交 Core 二进制失败: {error}"))?;
    }

    Ok(InstalledCore {
        id,
        path: version_dir,
    })
}

fn activate_core_version(config_dir: &Path, version_dir: &Path) -> Result<(), String> {
    if !version_dir.join(CORE_EXECUTABLE_NAME).is_file() {
        return Err("候选 Core 二进制不存在，未切换版本".to_string());
    }
    let root = core_root(config_dir);
    fs::create_dir_all(&root).map_err(|error| format!("创建 Core 目录失败: {error}"))?;
    let current = root.join("current");

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let temporary = root.join(format!("current.tmp.{}", std::process::id()));
        let _ = fs::remove_file(&temporary);
        symlink(version_dir, &temporary)
            .map_err(|error| format!("创建 Core 版本链接失败: {error}"))?;
        if current.is_dir() && !current.is_symlink() {
            return Err(format!(
                "Core current 路径不是符号链接: {}",
                current.display()
            ));
        }
        fs::rename(&temporary, &current).map_err(|error| format!("切换 Core 版本失败: {error}"))?;
    }

    #[cfg(windows)]
    {
        fs::create_dir_all(&current)
            .map_err(|error| format!("创建 Core current 目录失败: {error}"))?;
        let source = version_dir.join(CORE_EXECUTABLE_NAME);
        let destination = current.join(CORE_EXECUTABLE_NAME);
        // 先准备完整文件再替换；复制失败不会截断旧二进制。
        let temporary = current.join("yuanheng-core.next.exe");
        fs::copy(source, &temporary).map_err(|error| format!("准备 Core 版本失败: {error}"))?;
        fs::rename(&temporary, &destination)
            .map_err(|error| format!("切换 Core 版本失败: {error}"))?;
    }

    Ok(())
}

fn ensure_admin_token(config_dir: &Path) -> Result<String, String> {
    if let Ok(token) = read_admin_token(config_dir) {
        if !token.is_empty() {
            return Ok(token);
        }
    }

    let path = admin_token_path(config_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建 Core 目录失败: {error}"))?;
    }
    let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    write_private_file(&path, token.as_bytes())?;
    Ok(token)
}

fn read_admin_token(config_dir: &Path) -> Result<String, String> {
    let path = admin_token_path(config_dir);
    fs::read_to_string(&path)
        .map(|value| value.trim().to_string())
        .map_err(|error| format!("读取 Core 管理令牌失败（{}）: {error}", path.display()))
}

fn write_runtime_record(
    config_dir: &Path,
    info: &ProxyServerInfo,
    binary_id: &str,
) -> Result<(), String> {
    let record = CoreRuntimeRecord {
        pid: std::process::id(),
        address: info.address.clone(),
        port: info.port,
        binary_id: binary_id.to_string(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    let data = serde_json::to_vec_pretty(&record)
        .map_err(|error| format!("序列化 Core 状态失败: {error}"))?;
    write_private_file(&runtime_record_path(config_dir), &data)
}

fn read_runtime_record(config_dir: &Path) -> Result<CoreRuntimeRecord, String> {
    let path = runtime_record_path(config_dir);
    let data = fs::read(&path)
        .map_err(|error| format!("读取 Core runtime 状态失败（{}）: {error}", path.display()))?;
    serde_json::from_slice(&data).map_err(|error| format!("解析 Core runtime 状态失败: {error}"))
}

fn remove_runtime_record_if_owned(config_dir: &Path, pid: u32) {
    if read_runtime_record(config_dir).is_ok_and(|record| record.pid == pid) {
        let _ = fs::remove_file(runtime_record_path(config_dir));
    }
}

fn write_private_file(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建目录 {} 失败: {error}", parent.display()))?;
    }
    let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| format!("写入 {} 失败: {error}", temporary.display()))?;
        file.write_all(data)
            .map_err(|error| format!("写入 {} 失败: {error}", temporary.display()))?;
        file.sync_all()
            .map_err(|error| format!("刷新 {} 失败: {error}", temporary.display()))?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&temporary, data)
            .map_err(|error| format!("写入 {} 失败: {error}", temporary.display()))?;
    }
    fs::rename(&temporary, path).map_err(|error| format!("提交 {} 失败: {error}", path.display()))
}

#[cfg(target_os = "macos")]
fn launchd_label() -> &'static str {
    "com.nanashiwang.yuanhengswitch.core"
}

#[cfg(target_os = "macos")]
fn launchd_plist_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", launchd_label())))
}

#[cfg(target_os = "macos")]
fn launchd_domain() -> String {
    format!("gui/{}", unsafe { libc_getuid() })
}

#[cfg(target_os = "macos")]
unsafe fn libc_getuid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    unsafe { getuid() }
}

#[cfg(target_os = "macos")]
fn launchd_plist(config_dir: &Path) -> Result<String, String> {
    let executable = current_core_path(config_dir);
    let log_dir = core_root(config_dir).join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| format!("创建 Core 日志目录失败: {error}"))?;
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{executable}</string>
    <string>run</string>
    <string>--config-dir</string>
    <string>{config_dir}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>2</integer>
  <key>StandardOutPath</key>
  <string>{stdout}</string>
  <key>StandardErrorPath</key>
  <string>{stderr}</string>
</dict>
</plist>
"#,
        label = xml_escape(launchd_label()),
        executable = xml_escape(&executable.display().to_string()),
        config_dir = xml_escape(&config_dir.display().to_string()),
        stdout = xml_escape(&log_dir.join("core.stdout.log").display().to_string()),
        stderr = xml_escape(&log_dir.join("core.stderr.log").display().to_string()),
    ))
}

#[cfg(target_os = "macos")]
fn install_platform_service(config_dir: &Path) -> Result<(), String> {
    let plist_path = launchd_plist_path()?;
    let content = launchd_plist(config_dir)?;
    if fs::read_to_string(&plist_path).ok().as_deref() != Some(content.as_str()) {
        write_private_file(&plist_path, content.as_bytes())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_platform_service(_config_dir: &Path) -> Result<(), String> {
    let domain = launchd_domain();
    let service = format!("{domain}/{}", launchd_label());
    if command_success("launchctl", &["print", &service]) {
        // 查询失败时可能是 app_config_dir 已切换；重新 bootstrap 才会加载新 plist。
        command_checked("launchctl", &["bootout", &service])?;
    }
    let plist = launchd_plist_path()?;
    command_checked(
        "launchctl",
        &["bootstrap", &domain, &plist.display().to_string()],
    )
}

#[cfg(target_os = "macos")]
fn restart_platform_service(config_dir: &Path) -> Result<(), String> {
    let domain = launchd_domain();
    let service = format!("{domain}/{}", launchd_label());
    if command_success("launchctl", &["print", &service]) {
        command_checked("launchctl", &["kickstart", "-k", &service])
    } else {
        start_platform_service(config_dir)
    }
}

#[cfg(target_os = "macos")]
fn stop_platform_service(_config_dir: &Path) -> Result<(), String> {
    let domain = launchd_domain();
    let service = format!("{domain}/{}", launchd_label());
    if !command_success("launchctl", &["print", &service]) {
        return Ok(());
    }
    command_checked("launchctl", &["bootout", &service])
}

#[cfg(not(target_os = "macos"))]
fn install_platform_service(_config_dir: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn start_platform_service(config_dir: &Path) -> Result<(), String> {
    spawn_detached_core(config_dir)
}

#[cfg(not(target_os = "macos"))]
fn restart_platform_service(config_dir: &Path) -> Result<(), String> {
    let _ = stop_platform_service(config_dir);
    spawn_detached_core(config_dir)
}

#[cfg(not(target_os = "macos"))]
fn stop_platform_service(config_dir: &Path) -> Result<(), String> {
    let record = match read_runtime_record(config_dir) {
        Ok(record) => record,
        Err(_) => return Ok(()),
    };
    #[cfg(unix)]
    {
        command_checked("kill", &["-TERM", &record.pid.to_string()])
    }
    #[cfg(windows)]
    {
        command_checked("taskkill", &["/PID", &record.pid.to_string(), "/T", "/F"])
    }
}

#[cfg(not(target_os = "macos"))]
fn spawn_detached_core(config_dir: &Path) -> Result<(), String> {
    let mut command = Command::new(current_core_path(config_dir));
    command.arg("run").arg("--config-dir").arg(config_dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const DETACHED_PROCESS: u32 = 0x00000008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动 YuanHeng Core 失败: {error}"))
}

#[cfg(target_os = "macos")]
fn command_success(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .is_ok_and(|output| output.status.success())
}

fn command_checked(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("执行 {program} 失败: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{program} {} 失败: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

struct CoreLogger;

impl log::Log for CoreLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!(
                "{} {:<5} {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                record.level(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

fn init_core_logger() {
    static LOGGER: CoreLogger = CoreLogger;
    static INITIALIZED: OnceLock<()> = OnceLock::new();
    INITIALIZED.get_or_init(|| {
        if log::set_logger(&LOGGER).is_ok() {
            log::set_max_level(log::LevelFilter::Info);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::proxy_origin;
    #[cfg(target_os = "macos")]
    use super::xml_escape;
    #[cfg(windows)]
    use super::CORE_EXECUTABLE_NAME;
    use super::{activate_core_version, current_core_path, install_versioned_core};

    #[test]
    fn proxy_origin_normalizes_bind_all_addresses() {
        assert_eq!(proxy_origin("0.0.0.0", 15721), "http://127.0.0.1:15721");
        assert_eq!(proxy_origin("::", 15721), "http://[::1]:15721");
    }

    #[test]
    fn activating_missing_core_preserves_previous_binary() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.bin");
        std::fs::write(&source, b"old-version").unwrap();
        let installed = install_versioned_core(dir.path(), &source).unwrap();
        activate_core_version(dir.path(), &installed.path).unwrap();
        // 缺失候选版本必须在切换指针或覆盖二进制之前拒绝。
        assert!(activate_core_version(dir.path(), &dir.path().join("missing")).is_err());
        assert_eq!(
            std::fs::read(current_core_path(dir.path())).unwrap(),
            b"old-version"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_locked_core_is_not_truncated_and_switches_after_handle_closes() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old");
        let next = dir.path().join("next");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&next).unwrap();
        std::fs::write(old.join(CORE_EXECUTABLE_NAME), b"old-version").unwrap();
        std::fs::write(next.join(CORE_EXECUTABLE_NAME), b"new-version").unwrap();
        activate_core_version(dir.path(), &old).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(current_core_path(dir.path()))
            .unwrap();
        assert!(activate_core_version(dir.path(), &next).is_err());
        drop(lock);
        assert_eq!(
            std::fs::read(current_core_path(dir.path())).unwrap(),
            b"old-version"
        );
        activate_core_version(dir.path(), &next).unwrap();
        assert_eq!(
            std::fs::read(current_core_path(dir.path())).unwrap(),
            b"new-version"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launchd_values_are_xml_escaped() {
        assert_eq!(xml_escape("a&<b>\"'"), "a&amp;&lt;b&gt;&quot;&apos;");
    }
}
