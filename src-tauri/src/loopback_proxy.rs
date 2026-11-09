//! Protection of tool → Core traffic, independent of Core's outbound proxy.
use serde::Serialize;

pub(crate) const KEYS: [&str; 2] = ["NO_PROXY", "no_proxy"];
const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

pub(crate) fn merge(values: &[&str]) -> String {
    let mut entries: Vec<&str> = Vec::new();
    for entry in values.iter().flat_map(|v| v.split(',')).chain(LOOPBACK) {
        let entry = entry.trim();
        if !entry.is_empty() && !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    entries.join(",")
}

pub(crate) fn environment() -> [(String, String); 2] {
    let upper = std::env::var(KEYS[0]).unwrap_or_default();
    let lower = std::env::var(KEYS[1]).unwrap_or_default();
    let merged = merge(&[&upper, &lower]);
    KEYS.map(|key| (key.into(), merged.clone()))
}

// Evaluated in the terminal, preserving its own (possibly newer) environment too.
#[cfg(not(target_os = "windows"))]
pub(crate) fn cli_command(command: &str) -> String {
    let baseline = environment()[0].1.replace('\'', "'\"'\"'");
    format!("NO_PROXY=\"${{NO_PROXY:-}},${{no_proxy:-}},\"'{baseline}'\nexport NO_PROXY\nno_proxy=\"$NO_PROXY\"\nexport no_proxy\n{command}")
}

#[cfg(target_os = "windows")]
pub(crate) fn cli_command(command: &str) -> String {
    // Encode the script; user environment values never become batch/PowerShell code.
    use base64::Engine as _;
    let baseline = environment()[0].1.replace('\'', "''");
    let script = format!("$env:NO_PROXY = [string]::Join(',', @($env:NO_PROXY, '{baseline}', 'localhost', '127.0.0.1', '::1')); {command}; exit $LASTEXITCODE");
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell -NoProfile -NonInteractive -EncodedCommand {}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

#[cfg(any(target_os = "macos", test))]
fn protected(value: &str) -> bool {
    let entries: Vec<_> = value.split(',').map(str::trim).collect();
    entries.contains(&"*") || LOOPBACK.iter().all(|item| entries.contains(item))
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityStatus {
    pub supported: bool,
    pub installed: bool,
    pub login_environment_protected: bool,
    pub desktop_processes: usize,
    pub backend_processes: usize,
    pub protected_processes: usize,
    pub unverified_processes: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProbeResult {
    Healthy,
    Unavailable,
    UnexpectedResponse,
}

pub(crate) async fn probe(client: reqwest::Client, port: u16) -> ProbeResult {
    // Never send tokens, follow redirects, or call a model during this check.
    let response = client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await;
    let Ok(mut response) = response else {
        return ProbeResult::Unavailable;
    };
    if response.status() != reqwest::StatusCode::OK {
        return ProbeResult::UnexpectedResponse;
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= 4096 => body.extend_from_slice(&chunk),
            Ok(None) => break,
            _ => return ProbeResult::UnexpectedResponse,
        }
    }
    match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(value) if value["service"] == "yuanheng-core" && value["status"] == "healthy" => {
            ProbeResult::Healthy
        }
        _ => ProbeResult::UnexpectedResponse,
    }
}

pub(crate) fn probe_client(direct: bool) -> Result<reqwest::Client, reqwest::Error> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none());
    if direct {
        builder = builder.no_proxy();
    }
    builder.build()
}

pub(crate) fn assessment(
    direct: &ProbeResult,
    client: &ProbeResult,
) -> (&'static str, &'static str) {
    match (direct, client) {
        (ProbeResult::Healthy, ProbeResult::Healthy) => ("ok", "本机直连及当前客户端代理路径均通过无计费探针；仍需核对实际 Codex 进程与流式调用。"),
        (ProbeResult::Healthy, _) => ("warning", "本机直连成功，但当前客户端代理路径失败或返回非 Core 响应：代理可能影响本机连接。请核对 Codex 进程环境与客户端日志，再启用本机绕过兼容。"),
        _ => ("warning", "本机直连探针未通过，不能判定为代理绕过缺失。请先检查 Core 进程、监听端口和本机服务日志。"),
    }
}

#[tauri::command]
pub async fn get_loopback_proxy_compatibility() -> Result<CompatibilityStatus, String> {
    tokio::task::spawn_blocking(status)
        .await
        .map_err(|_| "读取本机代理兼容状态失败".to_string())?
}

#[tauri::command]
pub async fn set_loopback_proxy_compatibility(
    enabled: bool,
) -> Result<CompatibilityStatus, String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        macos::set_enabled(enabled)?;
        #[cfg(not(target_os = "macos"))]
        {
            let _ = enabled;
            Err("当前平台不支持用户登录环境修复".into())
        }
        #[cfg(target_os = "macos")]
        status()
    })
    .await
    .map_err(|_| "更新本机代理兼容设置失败".to_string())?
}

pub(crate) fn status() -> Result<CompatibilityStatus, String> {
    #[cfg(target_os = "macos")]
    {
        macos::status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(CompatibilityStatus::default())
    }
}

#[cfg(target_os = "macos")]
mod macos;

#[cfg(test)]
mod tests;

#[cfg(target_os = "macos")]
pub(crate) use macos::{
    desktop_environment, macos_app_needs_restart, restart_macos_app, verify_macos_app,
};

pub(crate) async fn diagnostic_checks(
    state: &crate::store::AppState,
) -> Vec<crate::commands::YuanhengDiagnosticCheck> {
    use crate::commands::YuanhengDiagnosticCheck as Check;
    let mut checks = Vec::new();
    let proxy = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        state.proxy_service.get_status(),
    )
    .await;
    if let Ok(Ok(proxy)) = proxy {
        if let (Ok(direct), Ok(client)) = (probe_client(true), probe_client(false)) {
            let (direct, client) =
                tokio::join!(probe(direct, proxy.port), probe(client, proxy.port));
            let (status, message) = assessment(&direct, &client);
            checks.push(Check {
                id: "loopback_transport".into(),
                status: status.into(),
                title: "工具到 Core · 本机连接对照".into(),
                message: message.into(),
                action: None,
            });
        }
        // Reuse Core's existing non-billable route measurements, never confuse
        // the GUI's account endpoint with Core's own outbound transport.
        let routes = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            crate::core_daemon::CoreSupervisor::new(crate::config::get_app_config_dir())
                .route_request(&state.db, "", None),
        )
        .await;
        let healthy = matches!(&routes, Ok(Ok(s)) if s.status == "healthy" && s.last_checked_at.as_deref().and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok()).is_some_and(|v| (0..=900).contains(&(chrono::Utc::now().timestamp() - v.timestamp()))));
        checks.push(Check { id: "core_upstream_transport".into(), status: if healthy { "ok" } else { "warning" }.into(), title: "Core 到上游 · 连接线路".into(), message: if healthy { "Core 最近 15 分钟内的无计费线路检查通过；不代表模型权限或流式推理成功。" } else { "Core 上游连接尚无近期通过证据，请在设置的连接线路中运行轻量检查。与工具到 Core 的本机连接分别定位，不自动重试模型请求。" }.into(), action: None });
    } else {
        checks.push(Check { id: "loopback_transport".into(), status: "warning".into(), title: "Core 状态尚未确认".into(), message: "无法读取 Core 状态；这不等于进程退出，也不能判定为系统代理影响。请核对本机进程与日志。".into(), action: None });
    }
    #[cfg(target_os = "macos")]
    if let Ok(Ok(s)) = tokio::task::spawn_blocking(status).await {
        checks.push(Check { id: "loopback_process_environment".into(), status: if s.backend_processes > 0 && s.unverified_processes == 0 { "ok" } else { "warning" }.into(), title: "Codex 实际进程 · 本机绕过".into(), message: format!("桌面进程 {} 个，模型后端 {} 个，已确认绕过 {} 个，未确认 {} 个。未启动的后端无法验证；已有进程需保存任务后重启。进程环境通过仍需真实流式调用验收。", s.desktop_processes, s.backend_processes, s.protected_processes, s.unverified_processes), action: None });
    }
    checks
}
