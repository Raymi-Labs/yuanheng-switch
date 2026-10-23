use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use futures::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone, Debug, PartialEq, Eq)]
struct ModelSelection {
    model: String,
    effort: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingTurn {
    thread_id: String,
    selection: ModelSelection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionBridgeStatus {
    pub running: bool,
    pub endpoint: Option<String>,
    pub connected_terminals: usize,
    pub applied_terminals: usize,
    pub pending_terminals: usize,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

struct BridgeState {
    endpoint: RwLock<Option<String>>,
    selection: RwLock<Option<ModelSelection>>,
    terminal_sequence: AtomicUsize,
    terminal_selections: RwLock<HashMap<usize, ModelSelection>>,
    pending_threads: RwLock<HashMap<String, (usize, ModelSelection)>>,
    connected_terminals: AtomicUsize,
    start_lock: Mutex<()>,
}

impl BridgeState {
    fn new() -> Self {
        Self {
            endpoint: RwLock::new(None),
            selection: RwLock::new(None),
            terminal_sequence: AtomicUsize::new(1),
            terminal_selections: RwLock::new(HashMap::new()),
            pending_threads: RwLock::new(HashMap::new()),
            connected_terminals: AtomicUsize::new(0),
            start_lock: Mutex::new(()),
        }
    }

    fn selection(&self) -> Option<ModelSelection> {
        self.selection
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn set_selection(&self, selection: ModelSelection) {
        *self
            .selection
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Some(selection);
    }

    fn mark_applied(&self, terminal_id: usize, selection: ModelSelection) {
        self.terminal_selections
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .insert(terminal_id, selection);
    }

    fn mark_pending(&self, terminal_id: usize, pending: PendingTurn) {
        let mut threads = self
            .pending_threads
            .write()
            .unwrap_or_else(|error| error.into_inner());
        threads.retain(|_, (id, _)| *id != terminal_id);
        threads.insert(
            normalize_session_id(&pending.thread_id).to_string(),
            (terminal_id, pending.selection),
        );
    }

    fn confirm_outbound_model(&self, session_id: &str, model: &str) -> bool {
        let key = normalize_session_id(session_id);
        let confirmed = {
            let mut threads = self
                .pending_threads
                .write()
                .unwrap_or_else(|error| error.into_inner());
            let exact_match = threads
                .get(key)
                .is_some_and(|(_, selection)| selection.model == model);
            if exact_match {
                threads.remove(key)
            } else {
                let matching = threads
                    .iter()
                    .filter(|(_, (_, selection))| selection.model == model)
                    .map(|(thread_id, _)| thread_id.clone())
                    .collect::<Vec<_>>();
                (matching.len() == 1)
                    .then(|| threads.remove(&matching[0]))
                    .flatten()
            }
        };
        let Some((terminal_id, selection)) = confirmed else {
            return false;
        };
        self.mark_applied(terminal_id, selection);
        true
    }

    fn remove_terminal(&self, terminal_id: usize) {
        self.terminal_selections
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&terminal_id);
        self.pending_threads
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|_, (id, _)| *id != terminal_id);
    }

    fn applied_terminal_count(&self, selection: &ModelSelection) -> usize {
        self.terminal_selections
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .filter(|applied| *applied == selection)
            .count()
    }
}

fn normalize_session_id(value: &str) -> &str {
    value.strip_prefix("codex_").unwrap_or(value)
}

fn bridge_state() -> &'static Arc<BridgeState> {
    static STATE: OnceLock<Arc<BridgeState>> = OnceLock::new();
    STATE.get_or_init(|| Arc::new(BridgeState::new()))
}

fn effective_effort(model: &str, reasoning: &str) -> String {
    crate::model_reasoning::effective_reasoning_level(model, reasoning)
        .unwrap_or_else(|| "none".to_string())
}

pub fn update_codex_session_model(model: &str, reasoning: &str) {
    let model = model.trim();
    if model.is_empty() {
        return;
    }
    let selection = ModelSelection {
        model: model.to_string(),
        effort: effective_effort(model, reasoning),
    };
    bridge_state().set_selection(selection.clone());
    log::info!(
        "[Codex Bridge] 已切换模型: {} ({})",
        selection.model,
        selection.effort
    );
}

/// 切到 OpenAI 官方账号时停止向新会话注入元衡模型选择。
/// 已经启动的 App Server 仍需重启，才能丢弃启动时传入的路由覆盖项。
pub fn clear_codex_session_model() {
    let state = bridge_state();
    if let Ok(mut selection) = state.selection.write() {
        *selection = None;
    }
    if let Ok(mut pending) = state.pending_threads.write() {
        pending.clear();
    }
    if let Ok(mut applied) = state.terminal_selections.write() {
        applied.clear();
    }
    log::info!("[Codex Bridge] 已清除元衡模型注入，等待终端重启加载官方账号");
}

pub fn confirm_codex_session_model(session_id: &str, model: &str) -> bool {
    let confirmed = bridge_state().confirm_outbound_model(session_id, model);
    if confirmed {
        log::info!("[Codex Bridge] 已确认实际请求模型: {model}");
    }
    confirmed
}

pub fn codex_session_profile_path() -> PathBuf {
    crate::config::get_home_dir()
        .join(".codex")
        .join("yuanheng-terminal.config.toml")
}

fn selection_from_profile(path: &Path) -> Option<ModelSelection> {
    let content = std::fs::read_to_string(path).ok()?;
    let config = content.parse::<toml::Value>().ok()?;
    let model = config.get("model")?.as_str()?.trim();
    if model.is_empty() {
        return None;
    }
    let effort = config
        .get("model_reasoning_effort")
        .and_then(toml::Value::as_str)
        .map(|reasoning| effective_effort(model, reasoning))
        .unwrap_or_else(|| effective_effort(model, "auto"));
    Some(ModelSelection {
        model: model.to_string(),
        effort,
    })
}

fn codex_profile_overrides(path: &Path) -> Result<Vec<String>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("读取 Codex 终端配置失败: {error}"))?;
    let config = content
        .parse::<toml::Value>()
        .map_err(|error| format!("解析 Codex 终端配置失败: {error}"))?;
    let provider_name = config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .ok_or_else(|| "Codex 终端配置缺少 model_provider".to_string())?;
    let provider = config
        .get("model_providers")
        .and_then(|providers| providers.get(provider_name))
        .ok_or_else(|| "Codex 终端配置缺少模型供应商".to_string())?;
    let mut overrides = vec![format!(
        "model_provider={}",
        toml::Value::String(provider_name.to_string())
    )];
    for key in ["base_url", "wire_api"] {
        if let Some(value) = provider.get(key).and_then(toml::Value::as_str) {
            overrides.push(format!(
                "model_providers.{provider_name}.{key}={}",
                toml::Value::String(value.to_string())
            ));
        }
    }
    if let Some(catalog) = config
        .get("model_catalog_json")
        .and_then(toml::Value::as_str)
    {
        let catalog = Path::new(catalog);
        let resolved = if catalog.is_absolute() {
            catalog.to_path_buf()
        } else {
            path.parent()
                .unwrap_or_else(|| Path::new("."))
                .join(catalog)
        };
        overrides.push(format!(
            "model_catalog_json={}",
            toml::Value::String(resolved.to_string_lossy().into_owned())
        ));
    }
    Ok(overrides)
}

pub fn codex_session_bridge_status() -> CodexSessionBridgeStatus {
    let state = bridge_state();
    let endpoint = state.endpoint.read().ok().and_then(|value| value.clone());
    let selection = state.selection();
    let connected_terminals = state.connected_terminals.load(Ordering::Relaxed);
    let applied_terminals = selection
        .as_ref()
        .map(|selection| state.applied_terminal_count(selection))
        .unwrap_or(0)
        .min(connected_terminals);
    let pending_terminals = if selection.is_some() {
        connected_terminals.saturating_sub(applied_terminals)
    } else {
        0
    };
    CodexSessionBridgeStatus {
        running: endpoint.is_some(),
        endpoint,
        connected_terminals,
        applied_terminals,
        pending_terminals,
        model: selection.as_ref().map(|value| value.model.clone()),
        reasoning_effort: selection.map(|value| value.effort),
    }
}

pub async fn ensure_codex_session_bridge(codex_executable: PathBuf) -> Result<String, String> {
    ensure_codex_session_bridge_inner(codex_executable, Some(codex_session_profile_path())).await
}

async fn ensure_codex_session_bridge_inner(
    codex_executable: PathBuf,
    model_profile: Option<PathBuf>,
) -> Result<String, String> {
    let state = bridge_state().clone();
    if let Some(endpoint) = state.endpoint.read().ok().and_then(|value| value.clone()) {
        return Ok(endpoint);
    }

    let _start_guard = state.start_lock.lock().await;
    if let Some(endpoint) = state.endpoint.read().ok().and_then(|value| value.clone()) {
        return Ok(endpoint);
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("启动 Codex 会话桥接失败: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("读取 Codex 会话桥接地址失败: {error}"))?;
    let endpoint = format!("ws://{address}");
    state
        .endpoint
        .write()
        .map_err(|_| "Codex 会话桥接状态不可用".to_string())?
        .replace(endpoint.clone());

    tokio::spawn(run_listener(
        listener,
        state.clone(),
        codex_executable,
        model_profile,
    ));
    Ok(endpoint)
}

async fn run_listener(
    listener: TcpListener,
    state: Arc<BridgeState>,
    codex_executable: PathBuf,
    model_profile: Option<PathBuf>,
) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let state = state.clone();
                let executable = codex_executable.clone();
                let model_profile = model_profile.clone();
                tokio::spawn(async move {
                    if let Err(error) =
                        handle_terminal(stream, state, executable, model_profile).await
                    {
                        log::warn!("[Codex Bridge] {error}");
                    }
                });
            }
            Err(error) => {
                log::error!("[Codex Bridge] 接受终端连接失败: {error}");
                break;
            }
        }
    }
    if let Ok(mut endpoint) = state.endpoint.write() {
        *endpoint = None;
    }
}

struct TerminalConnection {
    state: Arc<BridgeState>,
    id: usize,
}

impl TerminalConnection {
    fn new(state: Arc<BridgeState>) -> Self {
        state.connected_terminals.fetch_add(1, Ordering::Relaxed);
        let id = state.terminal_sequence.fetch_add(1, Ordering::Relaxed);
        Self { state, id }
    }
}

impl Drop for TerminalConnection {
    fn drop(&mut self) {
        self.state.remove_terminal(self.id);
        self.state
            .connected_terminals
            .fetch_sub(1, Ordering::Relaxed);
    }
}

async fn handle_terminal(
    stream: TcpStream,
    state: Arc<BridgeState>,
    codex_executable: PathBuf,
    model_profile: Option<PathBuf>,
) -> Result<(), String> {
    let mut socket = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|error| format!("Codex 终端握手失败: {error}"))?;
    let connection = TerminalConnection::new(state.clone());

    let executable_parent = codex_executable.parent().map(PathBuf::from);
    let mut command = Command::new(&codex_executable);
    if let Some(profile_path) = model_profile.as_deref().filter(|path| path.is_file()) {
        command.env("YUANHENG_IMAGEGEN_SURFACE", "codex");
        command.env("CODEX_HOME", crate::codex_config::get_codex_config_dir());
        // App Server 禁用 --profile；只覆盖非敏感路由字段，凭据继续来自 live 配置。
        for config_override in codex_profile_overrides(profile_path)? {
            command.args(["-c", &config_override]);
        }
    }
    command.args(["app-server", "--stdio"]);
    if let Some(parent) = executable_parent {
        let current_path = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![parent];
        paths.extend(std::env::split_paths(&current_path));
        if let Ok(path) = std::env::join_paths(paths) {
            command.env("PATH", path);
        }
    }
    log::info!(
        "[Codex Bridge] 启动 App Server: {}",
        codex_executable.display()
    );
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("启动 Codex App Server 失败: {error}"))?;
    let mut child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex App Server 标准输入不可用".to_string())?;
    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex App Server 标准输出不可用".to_string())?;
    let mut output_lines = BufReader::new(child_stdout).lines();

    let stderr_output = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut stderr_task = child.stderr.take().map(|stderr| {
        let stderr_output = stderr_output.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stderr_output.lock().await.push(line);
            }
        })
    });

    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(incoming) = incoming else { break; };
                let message = incoming.map_err(|error| format!("读取 Codex 终端消息失败: {error}"))?;
                match message {
                    Message::Text(text) => {
                        let profile_selection = model_profile
                            .as_deref()
                            .and_then(selection_from_profile);
                        if let Some(selection) = profile_selection.as_ref() {
                            state.set_selection(selection.clone());
                        }
                        let selection = profile_selection.or_else(|| state.selection());
                        let (text, pending_turn) = rewrite_turn_start(
                            &text,
                            selection,
                        );
                        child_stdin.write_all(text.as_bytes()).await
                            .map_err(|error| format!("转发 Codex 请求失败: {error}"))?;
                        child_stdin.write_all(b"\n").await
                            .map_err(|error| format!("转发 Codex 请求失败: {error}"))?;
                        child_stdin.flush().await
                            .map_err(|error| format!("刷新 Codex 请求失败: {error}"))?;
                        if let Some(pending) = pending_turn {
                            state.mark_pending(connection.id, pending);
                        }
                    }
                    Message::Ping(payload) => {
                        socket.send(Message::Pong(payload)).await
                            .map_err(|error| format!("回复 Codex 终端心跳失败: {error}"))?;
                    }
                    Message::Close(frame) => {
                        let _ = socket.close(frame).await;
                        break;
                    }
                    Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
                }
            }
            line = output_lines.next_line() => {
                match line.map_err(|error| format!("读取 Codex App Server 响应失败: {error}"))? {
                    Some(line) => socket.send(Message::Text(line)).await
                        .map_err(|error| format!("转发 Codex 响应失败: {error}"))?,
                    None => {
                        let status = child.wait().await
                            .map_err(|error| format!("等待 Codex App Server 退出失败: {error}"))?;
                        if let Some(task) = stderr_task.take() {
                            let _ = task.await;
                        }
                        let stderr = stderr_output.lock().await.join("\n");
                        let detail = if stderr.trim().is_empty() {
                            format!("退出状态 {status}")
                        } else {
                            stderr.trim().to_string()
                        };
                        let error = format!("Codex App Server 已退出：{detail}");
                        let _ = socket.close(Some(CloseFrame {
                            code: CloseCode::Error,
                            reason: Cow::Owned(truncate_close_reason(&error)),
                        })).await;
                        return Err(error);
                    },
                }
            }
        }
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
    if let Some(task) = stderr_task.take() {
        let _ = task.await;
    }
    Ok(())
}

fn truncate_close_reason(value: &str) -> String {
    const MAX_BYTES: usize = 123;
    if value.len() <= MAX_BYTES {
        return value.to_string();
    }
    let mut end = MAX_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn rewrite_turn_start(
    message: &str,
    selection: Option<ModelSelection>,
) -> (String, Option<PendingTurn>) {
    let Some(selection) = selection else {
        return (message.to_string(), None);
    };
    let Ok(mut value) = serde_json::from_str::<Value>(message) else {
        return (message.to_string(), None);
    };
    if value.get("method").and_then(Value::as_str) != Some("turn/start") {
        return (message.to_string(), None);
    }
    let Some(params) = value.get_mut("params").and_then(Value::as_object_mut) else {
        return (message.to_string(), None);
    };
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .map(str::to_string);
    params.insert("model".to_string(), Value::String(selection.model.clone()));
    params.insert(
        "effort".to_string(),
        Value::String(selection.effort.clone()),
    );
    // Codex collaboration mode takes precedence over the top-level turn overrides.
    if let Some(settings) = params
        .get_mut("collaborationMode")
        .and_then(Value::as_object_mut)
        .and_then(|mode| mode.get_mut("settings"))
        .and_then(Value::as_object_mut)
    {
        settings.insert("model".to_string(), Value::String(selection.model.clone()));
        settings.insert(
            "reasoning_effort".to_string(),
            Value::String(selection.effort.clone()),
        );
    }
    log::info!(
        "[Codex Bridge] 下一条消息模型: {} ({})",
        params["model"],
        params["effort"]
    );
    (
        serde_json::to_string(&value).unwrap_or_else(|_| message.to_string()),
        thread_id.map(|thread_id| PendingTurn {
            thread_id,
            selection,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn rewrites_turn_start_model_and_effort() {
        let (rewritten, applied) = rewrite_turn_start(
            r#"{"method":"turn/start","id":4,"params":{"threadId":"t1","input":[]}}"#,
            Some(ModelSelection {
                model: "k3".to_string(),
                effort: "high".to_string(),
            }),
        );
        let value: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(value["params"]["model"], json!("k3"));
        assert_eq!(value["params"]["effort"], json!("high"));
        assert_eq!(value["params"]["threadId"], json!("t1"));
        let pending = applied.unwrap();
        assert_eq!(pending.thread_id, "t1");
        assert_eq!(pending.selection.model, "k3");
    }

    #[test]
    fn rewrites_collaboration_mode_selection() {
        let (rewritten, _) = rewrite_turn_start(
            r#"{"method":"turn/start","id":4,"params":{"threadId":"t1","input":[],"collaborationMode":{"mode":"default","settings":{"model":"gpt-5.6-sol","reasoning_effort":"xhigh"}}}}"#,
            Some(ModelSelection {
                model: "k3".to_string(),
                effort: "medium".to_string(),
            }),
        );
        let value: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(value["params"]["model"], json!("k3"));
        assert_eq!(value["params"]["effort"], json!("medium"));
        assert_eq!(
            value["params"]["collaborationMode"]["settings"]["model"],
            json!("k3")
        );
        assert_eq!(
            value["params"]["collaborationMode"]["settings"]["reasoning_effort"],
            json!("medium")
        );
    }

    #[test]
    fn leaves_other_messages_unchanged() {
        let message = r#"{"method":"thread/read","id":5,"params":{"threadId":"t1"}}"#;
        let (rewritten, applied) = rewrite_turn_start(
            message,
            Some(ModelSelection {
                model: "k3".to_string(),
                effort: "medium".to_string(),
            }),
        );
        assert_eq!(rewritten, message);
        assert!(applied.is_none());
    }

    #[test]
    fn reports_pending_and_applied_terminals_for_current_selection() {
        let state = Arc::new(BridgeState::new());
        let first = TerminalConnection::new(state.clone());
        let second = TerminalConnection::new(state.clone());
        let k3 = ModelSelection {
            model: "k3".to_string(),
            effort: "high".to_string(),
        };
        state.set_selection(k3.clone());
        assert_eq!(state.applied_terminal_count(&k3), 0);

        state.mark_pending(
            first.id,
            PendingTurn {
                thread_id: "thread-1".to_string(),
                selection: k3.clone(),
            },
        );
        assert!(!state.confirm_outbound_model("codex_thread-1", "gpt-5.6-sol"));
        assert!(state.confirm_outbound_model("generated-request-id", "k3"));
        assert_eq!(state.applied_terminal_count(&k3), 1);

        let gpt = ModelSelection {
            model: "gpt-5.6-sol".to_string(),
            effort: "xhigh".to_string(),
        };
        state.set_selection(gpt.clone());
        assert_eq!(state.applied_terminal_count(&gpt), 0);
        state.mark_applied(second.id, gpt.clone());
        assert_eq!(state.applied_terminal_count(&gpt), 1);

        drop(first);
        assert_eq!(state.connected_terminals.load(Ordering::Relaxed), 1);
        assert_eq!(state.applied_terminal_count(&k3), 0);
    }

    #[test]
    fn ambiguous_pending_terminals_are_not_confirmed_by_model_only() {
        let state = Arc::new(BridgeState::new());
        let first = TerminalConnection::new(state.clone());
        let second = TerminalConnection::new(state.clone());
        let selection = ModelSelection {
            model: "k3".to_string(),
            effort: "high".to_string(),
        };
        for (terminal, thread_id) in [(first.id, "thread-1"), (second.id, "thread-2")] {
            state.mark_pending(
                terminal,
                PendingTurn {
                    thread_id: thread_id.to_string(),
                    selection: selection.clone(),
                },
            );
        }

        assert!(!state.confirm_outbound_model("generated-request-id", "k3"));
        assert_eq!(state.applied_terminal_count(&selection), 0);
    }

    #[test]
    fn auto_effort_matches_terminal_profile_default() {
        assert_eq!(effective_effort("gpt-5.6-sol", "auto"), "low");
        assert_eq!(effective_effort("gpt-5.6-sol", "xhigh"), "xhigh");
    }

    #[test]
    fn websocket_close_reason_stays_within_protocol_limit() {
        let reason = truncate_close_reason(&"启动失败".repeat(100));
        assert!(reason.len() <= 123);
        assert!(std::str::from_utf8(reason.as_bytes()).is_ok());
    }

    #[test]
    fn reads_current_model_from_terminal_profile() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("terminal.config.toml");
        std::fs::write(
            &profile,
            "model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"xhigh\"\n",
        )
        .unwrap();
        assert_eq!(
            selection_from_profile(&profile),
            Some(ModelSelection {
                model: "gpt-5.6-sol".to_string(),
                effort: "xhigh".to_string(),
            })
        );
    }

    #[test]
    fn derives_non_sensitive_app_server_overrides_from_terminal_profile() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("yuanheng-terminal.config.toml");
        std::fs::write(
            &profile,
            r#"model_provider = "custom"
model_catalog_json = "yuanheng-terminal-model-catalog.json"
[model_providers.custom]
base_url = "http://127.0.0.1:15721/codex/v1"
wire_api = "responses"
experimental_bearer_token = "secret"
"#,
        )
        .unwrap();
        let overrides = codex_profile_overrides(&profile).unwrap();
        assert_eq!(
            overrides,
            vec![
                r#"model_provider="custom""#.to_string(),
                r#"model_providers.custom.base_url="http://127.0.0.1:15721/codex/v1""#.to_string(),
                r#"model_providers.custom.wire_api="responses""#.to_string(),
                format!(
                    "model_catalog_json={}",
                    toml::Value::String(
                        temp.path()
                            .join("yuanheng-terminal-model-catalog.json")
                            .to_string_lossy()
                            .into_owned()
                    )
                )
            ]
        );
        assert!(overrides.iter().all(|value| !value.contains("secret")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bridge_forwards_rewritten_requests_over_websocket() {
        let temp = tempfile::tempdir().unwrap();
        let fake_codex = temp.path().join("codex");
        std::fs::write(
            &fake_codex,
            "#!/bin/sh\n[ \"$*\" = \"app-server --stdio\" ] || exit 64\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake_codex, std::fs::Permissions::from_mode(0o755)).unwrap();

        update_codex_session_model("k3", "xhigh");
        let endpoint = ensure_codex_session_bridge_inner(fake_codex, None)
            .await
            .unwrap();
        let (mut socket, _) = tokio_tungstenite::connect_async(endpoint).await.unwrap();
        socket
            .send(Message::Text(
                r#"{"method":"turn/start","id":9,"params":{"threadId":"t1","input":[]}}"#
                    .to_string(),
            ))
            .await
            .unwrap();

        let echoed = socket.next().await.unwrap().unwrap().into_text().unwrap();
        let value: Value = serde_json::from_str(&echoed).unwrap();
        assert_eq!(value["params"]["model"], json!("k3"));
        assert_eq!(value["params"]["effort"], json!("xhigh"));
        socket.close(None).await.unwrap();
    }
}
