//! Shared image skill setup. The descriptor contains local routes, never keys.
use super::*;
use crate::services::{skill::ImagegenTarget, SkillService};
use std::path::Path;

static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Default)]
struct RuntimeEpoch {
    generation: u64,
    port: u16,
}
static RUNTIME_LOCK: std::sync::Mutex<RuntimeEpoch> = std::sync::Mutex::new(RuntimeEpoch {
    generation: 0,
    port: 0,
});

fn descriptor(port: u16, terminal: bool, desktop: bool) -> Value {
    let mut value = json!({ "owner": "yuanheng-imagegen", "version": 1, "enabled": false });
    if port == 0 || (!terminal && !desktop) {
        return value;
    }
    value["enabled"] = json!(true);
    if terminal {
        value["terminalBaseUrl"] = json!(format!("http://127.0.0.1:{port}/codex/v1"));
        value["baseUrl"] = value["terminalBaseUrl"].clone();
    }
    if desktop {
        value["desktopBaseUrl"] = json!(format!("http://127.0.0.1:{port}/chatgpt-desktop/v1"));
        value["baseUrl"] = value["desktopBaseUrl"].clone();
    }
    value
}

fn write_descriptor(path: &Path, value: &Value) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() || metadata.len() > 16 * 1024 {
                return Err("图像能力连接文件不是元衡托管文件，请在能力中心检查".into());
            }
            let old: Value = crate::config::read_json_file(path).map_err(|e| e.to_string())?;
            if old.get("owner").and_then(Value::as_str) != Some("yuanheng-imagegen")
                || old.get("version").and_then(Value::as_u64) != Some(1)
            {
                return Err("图像能力连接文件与现有文件冲突，已保留原文件".into());
            }
            if old == *value {
                return Ok(());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Official-only users must not acquire a new YuanHeng descriptor.
            if value["enabled"] == false {
                return Ok(());
            }
        }
        Err(e) => return Err(e.to_string()),
    }
    crate::config::write_json_file(path, value).map_err(|e| e.to_string())
}

fn write_codex_legacy(port: u16, surfaces: &[&str]) -> Result<(), String> {
    let path = ImagegenTarget::Codex
        .skills_dir()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("Codex 技能目录缺少父目录")?
        .join("yuanheng-imagegen.json");
    write_descriptor(
        &path,
        &descriptor(
            port,
            surfaces.contains(&"codex"),
            surfaces.contains(&"chatgpt-desktop"),
        ),
    )
}

fn active_route(state: &AppState, surface: CodexSurface) -> bool {
    let selected = match surface {
        CodexSurface::Terminal => Ok(crate::settings::get_current_provider(&AppType::Codex)
            .or(state.db.get_current_provider("codex").ok().flatten())),
        CodexSurface::Desktop => state.db.get_current_provider(surface.namespace()),
    };
    if selected.ok().flatten().as_deref() != Some(MANAGED_PROVIDER_ID)
        || !managed_codex_surface_route_active(&state.db, surface)
    {
        return false;
    }
    let config = match surface {
        CodexSurface::Terminal => std::fs::read_to_string(codex_terminal_profile_path()).ok(),
        CodexSurface::Desktop => crate::codex_config::read_codex_config_text().ok(),
    };
    config
        .and_then(|config| crate::codex_config::extract_codex_base_url(&config))
        .and_then(|url| url::Url::parse(&url).ok())
        .is_some_and(|url| {
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.path() == format!("/{}/v1", surface.route_prefix())
        })
}

fn configured_surfaces(
    state: &AppState,
    target: ImagegenTarget,
) -> Result<Vec<&'static str>, String> {
    if target == ImagegenTarget::Codex {
        Ok([CodexSurface::Terminal, CodexSurface::Desktop]
            .into_iter()
            .filter(
                |surface| match imagegen_connection::group(&state.db, surface.namespace()) {
                    Ok(Some(_)) => {
                        imagegen_connection::active_reference(&state.db, surface.namespace())
                            .ok()
                            .flatten()
                            .is_some()
                    }
                    Ok(None) => active_route(state, *surface),
                    Err(_) => false,
                },
            )
            .map(|surface| surface.namespace())
            .collect())
    } else {
        Ok(
            if (if imagegen_connection::group(&state.db, target.as_str())?.is_some() {
                imagegen_connection::active_reference(&state.db, target.as_str())?.map(|_| ())
            } else {
                imagegen_provider(&state.db, target.as_str())?.map(|_| ())
            })
            .is_some()
            {
                vec![target.as_str()]
            } else {
                vec![]
            },
        )
    }
}

fn enabled(state: &AppState, target: ImagegenTarget) -> Result<bool, String> {
    Ok(state
        .db
        .get_installed_skill("builtin:meta-api-imagegen")
        .map_err(|e| e.to_string())?
        .is_some_and(|skill| target.is_enabled(&skill.apps)))
}

fn runtime(target: ImagegenTarget, port: u16, surfaces: &[&str]) -> Value {
    let routes: serde_json::Map<String, Value> = surfaces
        .iter()
        .filter(|_| port != 0)
        .map(|surface| {
            (
                surface.to_string(),
                json!(format!("http://127.0.0.1:{port}/{surface}/v1")),
            )
        })
        .collect();
    let default_surface = surfaces.last().copied().unwrap_or(target.as_str());
    json!({ "owner": "yuanheng-imagegen", "version": 2, "target": target.as_str(),
        "enabled": !routes.is_empty(), "defaultSurface": default_surface,
        "directOnly": target != ImagegenTarget::Codex, "routes": routes })
}

fn connection_runtime(
    db: &crate::database::Database,
    target: ImagegenTarget,
    port: u16,
    surfaces: &[&str],
) -> Result<Value, String> {
    let mut value = runtime(target, port, surfaces);
    for surface in surfaces.iter().filter(|_| port != 0) {
        if imagegen_connection::group(db, surface)?.is_some() {
            value["routes"][*surface] =
                json!(format!("http://127.0.0.1:{port}/imagegen/{surface}/v1"));
        }
    }
    // The helper enforces direct-only on the selected dedicated route. Keeping
    // Codex's global flag false preserves another surface's native fallback.
    Ok(value)
}

fn legacy_surfaces<'a>(value: &Value, surfaces: &[&'a str]) -> Vec<&'a str> {
    surfaces
        .iter()
        .copied()
        .filter(|surface| {
            value["routes"][*surface]
                .as_str()
                .and_then(|s| url::Url::parse(s).ok())
                .is_some_and(|url| url.path() == format!("/{surface}/v1"))
        })
        .collect()
}

fn read_runtime(path: &Path, target: ImagegenTarget) -> Result<Option<Value>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() || metadata.len() > 16 * 1024 {
                return Err("图像连接文件不是元衡托管文件，已保留原文件".into());
            }
            let value: Value = crate::config::read_json_file(path).map_err(|e| e.to_string())?;
            if value["owner"] != "yuanheng-imagegen"
                || value["version"] != 2
                || value["target"] != target.as_str()
            {
                return Err("图像连接文件与当前工具不匹配，已保留原文件".into());
            }
            Ok(Some(value))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn current_port(
    epoch: &RuntimeEpoch,
    observed_generation: u64,
    port: u16,
    can_enable: bool,
) -> u16 {
    // A disable must stay disabled; an older running snapshot must never
    // overwrite the port just published by a supervised Core restart.
    if !can_enable {
        0
    } else if epoch.generation != observed_generation {
        epoch.port
    } else {
        port
    }
}

fn publish_runtime(
    db: &crate::database::Database,
    target: ImagegenTarget,
    port: u16,
    surfaces: &[&str],
    create: bool,
    can_enable: bool,
    observed_generation: u64,
) -> Result<u16, String> {
    let epoch = RUNTIME_LOCK
        .lock()
        .map_err(|_| "图像连接同步锁不可用".to_string())?;
    let port = current_port(&epoch, observed_generation, port, can_enable);
    let value = connection_runtime(db, target, port, surfaces)?;
    write_runtime_unlocked(target, &value, create)?;
    if target == ImagegenTarget::Codex {
        let legacy = legacy_surfaces(&value, surfaces);
        // v1 has one ambiguous baseUrl: any override must disable it entirely,
        // otherwise a desktop helper could silently choose the CLI account.
        let has_override = ["codex", "chatgpt-desktop"]
            .into_iter()
            .any(|s| !matches!(imagegen_connection::group(db, s), Ok(None)));
        write_codex_legacy(if has_override { 0 } else { port }, &legacy)?;
    }
    Ok(port)
}

fn write_runtime_unlocked(
    target: ImagegenTarget,
    value: &Value,
    create: bool,
) -> Result<(), String> {
    let path = target.runtime_path().map_err(|e| e.to_string())?;
    let old = read_runtime(&path, target)?;
    if old.as_ref() == Some(value) || (old.is_none() && !create) {
        return Ok(());
    }
    crate::config::write_json_file(&path, value).map_err(|e| e.to_string())
}

/// A supervised Core may select a new local port. Refresh only existing,
/// enabled bindings; this never enables a skill or reads/copies a credential.
pub(crate) fn refresh_port(port: u16) -> Result<(), String> {
    if port == 0 {
        return Ok(());
    }
    let mut epoch = RUNTIME_LOCK
        .lock()
        .map_err(|_| "图像连接同步锁不可用".to_string())?;
    epoch.generation = epoch.generation.wrapping_add(1);
    epoch.port = port;
    let mut errors = Vec::new();
    for target in ImagegenTarget::all() {
        let result = (|| {
            let path = target.runtime_path().map_err(|e| e.to_string())?;
            let Some(mut value) = read_runtime(&path, target)? else {
                return Ok(());
            };
            if value["enabled"] != true {
                if target == ImagegenTarget::Codex {
                    write_codex_legacy(0, &[])?;
                }
                return Ok(());
            }
            let allowed: &[&str] = if target == ImagegenTarget::Codex {
                &["codex", "chatgpt-desktop"]
            } else {
                &[target.as_str()]
            };
            let surfaces: Vec<_> = allowed
                .iter()
                .copied()
                .filter(|surface| {
                    value["routes"][*surface]
                        .as_str()
                        .and_then(|url| url::Url::parse(url).ok())
                        .is_some_and(|url| {
                            url.scheme() == "http"
                                && url.host_str() == Some("127.0.0.1")
                                && (url.path() == format!("/{surface}/v1")
                                    || url.path() == format!("/imagegen/{surface}/v1"))
                                && url.username().is_empty()
                                && url.password().is_none()
                                && url.query().is_none()
                                && url.fragment().is_none()
                        })
                })
                .collect();
            let mut routes = serde_json::Map::new();
            for surface in &surfaces {
                let mut url = url::Url::parse(
                    value["routes"][*surface]
                        .as_str()
                        .ok_or("图像连接地址无效")?,
                )
                .map_err(|_| "图像连接地址无效")?;
                url.set_port(Some(port)).map_err(|_| "图像连接端口无效")?;
                routes.insert((*surface).to_string(), json!(url.as_str()));
            }
            value["routes"] = json!(routes);
            value["enabled"] = json!(!surfaces.is_empty());
            write_runtime_unlocked(target, &value, false)?;
            if target == ImagegenTarget::Codex {
                let legacy = legacy_surfaces(&value, &surfaces);
                let overridden = legacy.len() != surfaces.len();
                // A disabled v1 may reflect an invalidated/removed override.
                // Port refresh must not resurrect its ambiguous default route.
                let path = ImagegenTarget::Codex
                    .skills_dir()
                    .map_err(|e| e.to_string())?
                    .parent()
                    .ok_or("Codex 技能目录缺少父目录")?
                    .join("yuanheng-imagegen.json");
                let was_enabled = crate::config::read_json_file::<Value>(&path)
                    .ok()
                    .is_some_and(|v| v["owner"] == "yuanheng-imagegen" && v["enabled"] == true);
                write_codex_legacy(if overridden || !was_enabled { 0 } else { port }, &legacy)?;
            }
            Ok::<_, String>(())
        })();
        if let Err(error) = result {
            errors.push(format!("{}: {error}", target.as_str()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

pub(crate) async fn sync(state: &AppState, auto_install: bool) -> Result<(), String> {
    sync_targets(state, &ImagegenTarget::all(), auto_install).await
}

pub(crate) async fn sync_tool(
    state: &AppState,
    tool: &str,
    auto_install: bool,
) -> Result<(), String> {
    let target = ImagegenTarget::parse(tool).map_err(|e| e.to_string())?;
    sync_targets(state, &[target], auto_install).await
}

async fn sync_targets(
    state: &AppState,
    targets: &[ImagegenTarget],
    auto_install: bool,
) -> Result<(), String> {
    let _sync_guard = SYNC_LOCK.lock().await;
    let mut errors = Vec::new();
    let mut blocked = std::collections::HashSet::new();
    let mut needs_core = false;
    for &target in targets {
        let result = (|| {
            if configured_surfaces(state, target)?.is_empty() {
                return Ok(());
            }
            if auto_install {
                SkillService::ensure_builtin_imagegen_for(&state.db, target)
                    .map_err(|e| e.to_string())?;
            }
            needs_core |= enabled(state, target)?;
            Ok::<_, String>(())
        })();
        if let Err(error) = result {
            blocked.insert(target);
            errors.push(format!("{}: {error}", target.as_str()));
        }
    }
    let observed_generation = RUNTIME_LOCK
        .lock()
        .map_err(|_| "图像连接同步锁不可用".to_string())?
        .generation;
    let mut status = state.proxy_service.get_status().await?;
    if needs_core && !status.running {
        if let Err(error) = state.proxy_service.start().await {
            errors.push(format!("图像本地连接启动失败: {error}"));
        }
        status = state.proxy_service.get_status().await?;
    }
    if status.running {
        if let Err(error) = state.proxy_service.sync_imagegen_credentials().await {
            errors.push(format!("图像凭据同步失败：{error}"));
        }
    }
    // All asynchronous work precedes this snapshot. User disable/switch syncs
    // queue on this lock and cannot be overwritten by an older start result.
    for &target in targets {
        let result = (|| {
            let enabled = enabled(state, target)?;
            let surfaces = match configured_surfaces(state, target) {
                Ok(surfaces) if !blocked.contains(&target) => surfaces,
                Ok(_) => Vec::new(),
                Err(error) => {
                    if !blocked.contains(&target) {
                        errors.push(format!("{}: {error}", target.as_str()));
                    }
                    Vec::new()
                }
            };
            let valid = !enabled
                || SkillService::validate_builtin_imagegen_projection(&state.db, target)
                    .map_err(|e| e.to_string())
                    .map_err(|error| {
                        errors.push(format!("{}: {error}", target.as_str()));
                        error
                    })
                    .is_ok();
            let port = if enabled && valid && status.running {
                status.port
            } else {
                0
            };
            publish_runtime(
                &state.db,
                target,
                port,
                &surfaces,
                enabled,
                enabled && valid,
                observed_generation,
            )?;
            Ok::<_, String>(())
        })();
        if let Err(error) = result {
            errors.push(format!("{}: {error}", target.as_str()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagegenToolStatus {
    tool: String,
    target: Option<String>,
    supported: bool,
    enabled: bool,
    configured: bool,
    ready: bool,
    error: Option<String>,
    scope: String,
    image_group: Option<String>,
    image_models: Vec<String>,
    selected_image_model: Option<String>,
    catalog_checked: bool,
}

impl ImagegenToolStatus {
    pub(super) fn set_error(&mut self, error: String) {
        self.ready = false;
        self.error = Some(error);
    }
}

pub(crate) async fn tool_status(
    state: &AppState,
    tool: &str,
) -> Result<ImagegenToolStatus, String> {
    tool_status_with_catalog(state, tool, || async move {
        state.proxy_service.sync_imagegen_credentials().await?;
        let core = state.proxy_service.get_status().await?;
        if !core.running {
            return Err("图像连接的 Core 尚未运行，请重新启用图像技能".into());
        }
        // Check through the actual Core process: desktop Keychain access alone
        // cannot prove that the background process can read the selected item.
        crate::proxy::images::local_image_model_ids(
            core.port,
            tool,
            imagegen_connection::has_connection(&state.db, tool)?,
        )
        .await
    })
    .await
}

pub(super) async fn tool_status_with_catalog<F, Fut>(
    state: &AppState,
    tool: &str,
    fetch: F,
) -> Result<ImagegenToolStatus, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<String>, String>>,
{
    let mut result = ImagegenToolStatus {
        tool: tool.into(),
        target: None,
        supported: false,
        enabled: false,
        configured: false,
        ready: false,
        error: None,
        scope: "unsupported".into(),
        image_group: None,
        image_models: Vec::new(),
        selected_image_model: None,
        catalog_checked: false,
    };
    let Ok(target) = ImagegenTarget::parse(tool) else {
        return Ok(result);
    };
    result.target = Some(target.as_str().into());
    result.supported = true;
    result.scope = if target == ImagegenTarget::WorkBuddy {
        "code-and-office-import"
    } else {
        "local-skill"
    }
    .into();
    let core = state.proxy_service.get_status().await?;
    result.image_group = match imagegen_connection::group(&state.db, tool) {
        Ok(group) => group,
        Err(error) => {
            result.error = Some(error);
            None
        }
    };
    result.enabled = enabled(state, target)?;
    let surfaces = match configured_surfaces(state, target) {
        Ok(surfaces) => surfaces,
        Err(error) => {
            result.error = Some(error);
            Vec::new()
        }
    };
    result.configured = if target == ImagegenTarget::Codex {
        surfaces.contains(&tool)
    } else {
        !surfaces.is_empty()
    };
    if result.enabled {
        match SkillService::validate_builtin_imagegen_projection(&state.db, target) {
            Err(error) => result.error = Some(error.to_string()),
            Ok(()) => {
                match read_runtime(&target.runtime_path().map_err(|e| e.to_string())?, target) {
                    Ok(Some(value)) => {
                        result.ready = result.configured
                            && core.running
                            && value == connection_runtime(&state.db, target, core.port, &surfaces)?
                    }
                    Ok(None) => {}
                    Err(error) => result.error = Some(error),
                }
            }
        }
    }
    if result.enabled && result.configured {
        let identity = status_identity(state, tool);
        match identity {
            Ok(Some(identity)) => {
                let checked = fetch().await;
                // An in-flight read cannot publish a previous account/group as
                // ready after a switch, logout, replacement, or skill disable.
                let unchanged = enabled(state, target)?
                    && imagegen_connection::group(&state.db, tool).ok().as_ref()
                        == Some(&result.image_group)
                    && status_identity(state, tool).ok().flatten().as_ref() == Some(&identity);
                if !unchanged {
                    result.set_error("图像连接已变化，请刷新状态".into());
                } else {
                    apply_catalog(&mut result, checked);
                }
            }
            Ok(None) => result.set_error("当前工具没有可用的元衡图像连接".into()),
            Err(error) => result.set_error(error),
        }
    } else if result.image_group.is_some() {
        if let Err(error) = imagegen_connection::active_reference(&state.db, tool) {
            result.set_error(error);
        }
    }
    Ok(result)
}

fn status_identity(state: &AppState, tool: &str) -> Result<Option<Value>, String> {
    if let Some(reference) = imagegen_connection::active_reference(&state.db, tool)? {
        return Ok(Some(json!({"imageConnectionRef": reference})));
    }
    if matches!(tool, "codex" | "chatgpt-desktop") {
        let selected = if tool == "codex" {
            crate::settings::get_current_provider(&AppType::Codex).or(state
                .db
                .get_current_provider(tool)
                .map_err(|e| e.to_string())?)
        } else {
            state
                .db
                .get_current_provider(tool)
                .map_err(|e| e.to_string())?
        };
        if selected.as_deref() != Some(MANAGED_PROVIDER_ID) {
            return Ok(None);
        }
        return state
            .db
            .get_provider_by_id(MANAGED_PROVIDER_ID, tool)
            .map(|p| p.map(|p| p.settings_config))
            .map_err(|e| e.to_string());
    }
    imagegen_provider(&state.db, tool).map(|p| p.map(|p| p.settings_config))
}

fn apply_catalog(result: &mut ImagegenToolStatus, checked: Result<Vec<String>, String>) {
    match checked {
        Ok(models) => {
            result.catalog_checked = true;
            result.image_models = models
                .into_iter()
                .filter(|m| imagegen_connection::select_model(std::slice::from_ref(m)).is_some())
                .collect();
            result.selected_image_model = imagegen_connection::select_model(&result.image_models);
            if result.selected_image_model.is_none() {
                result.set_error("当前图像连接未授权带版本号的 GPT Image 模型，请选择支持图像生成的独立分组；聊天配置无需改变".into());
            }
        }
        Err(error) => result.set_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[serial_test::serial]
    async fn actual_catalog_permission_controls_ready_and_stale_group_results_are_rejected() {
        use crate::commands::{
            imagegen_connection_test_support as connections, imagegen_test_support as fixture,
        };
        use std::sync::Arc;
        let _home = fixture::TestHome::new();
        crate::secure_storage::clear_for_tests();
        let db = Arc::new(crate::database::Database::memory().unwrap());
        let state = AppState::new(db.clone());
        let mut config = db.get_proxy_config().await.unwrap();
        config.listen_port = 0;
        db.update_proxy_config(config).await.unwrap();
        fixture::install(&db, "dsh", "sk-chat-synthetic");
        connections::account(&db, "A", false);
        connections::install(&db, "dsh", "image-old", "sk-image-old");
        sync(&state, true).await.unwrap();
        let empty = tool_status_with_catalog(&state, "dsh", || async {
            Ok(vec!["qwen-image".into(), "gpt-image-latest".into()])
        })
        .await
        .unwrap();
        assert!(!empty.ready && empty.catalog_checked);
        assert!(empty.image_models.is_empty() && empty.selected_image_model.is_none());
        assert!(empty.error.unwrap().contains("独立分组"));
        let failed =
            tool_status_with_catalog(&state, "dsh", || async { Err("synthetic HTTP 403".into()) })
                .await
                .unwrap();
        assert!(!failed.ready && !failed.catalog_checked);
        let stale = tool_status_with_catalog(&state, "dsh", || async {
            connections::install(&db, "dsh", "image-new", "sk-image-new");
            Ok(vec!["gpt-image-2.5-sunburst".into()])
        })
        .await
        .unwrap();
        assert!(!stale.ready && !stale.catalog_checked && stale.selected_image_model.is_none());
        let good = tool_status_with_catalog(&state, "dsh", || async {
            Ok(vec![
                "gpt-image-2.5-flare".into(),
                "OpenAI/gpt-image-2.5-sunburst".into(),
            ])
        })
        .await
        .unwrap();
        assert!(good.ready && good.catalog_checked);
        assert_eq!(good.image_group.as_deref(), Some("image-new"));
        assert_eq!(
            good.selected_image_model.as_deref(),
            Some("OpenAI/gpt-image-2.5-sunburst")
        );
        assert_eq!(
            imagegen_provider(&db, "dsh")
                .unwrap()
                .unwrap()
                .settings_config["auth"]["OPENAI_API_KEY"],
            "sk-chat-synthetic"
        );
        fixture::enable(&db, "dsh", false);
        let disabled = tool_status_with_catalog(&state, "dsh", || async {
            panic!("disabled skill must not query a catalog")
        })
        .await
        .unwrap();
        assert!(!disabled.ready && !disabled.catalog_checked);
        state.proxy_service.stop().await.unwrap();
        crate::secure_storage::clear_for_tests();
    }

    #[test]
    #[serial_test::serial]
    fn inactive_codex_override_disables_legacy_across_core_port_refresh() {
        use crate::commands::{
            imagegen_connection_test_support as connections, imagegen_test_support as fixture,
        };
        let _home = fixture::TestHome::new();
        crate::secure_storage::clear_for_tests();
        let db = crate::database::Database::memory().unwrap();
        connections::account(&db, "A", false);
        connections::install(&db, "chatgpt-desktop", "images", "sk-image-desktop");
        write_codex_legacy(1234, &["codex", "chatgpt-desktop"]).unwrap();
        let epoch = RUNTIME_LOCK.lock().unwrap().generation;
        publish_runtime(
            &db,
            ImagegenTarget::Codex,
            1234,
            &["codex"],
            true,
            true,
            epoch,
        )
        .unwrap();
        let path = ImagegenTarget::Codex
            .skills_dir()
            .unwrap()
            .parent()
            .unwrap()
            .join("yuanheng-imagegen.json");
        let legacy: Value = crate::config::read_json_file(&path).unwrap();
        assert_eq!(legacy["enabled"], false);
        refresh_port(5678).unwrap();
        let legacy: Value = crate::config::read_json_file(&path).unwrap();
        assert_eq!(legacy["enabled"], false);
        let value = read_runtime(
            &ImagegenTarget::Codex.runtime_path().unwrap(),
            ImagegenTarget::Codex,
        )
        .unwrap()
        .unwrap();
        assert_eq!(value["routes"]["codex"], "http://127.0.0.1:5678/codex/v1");
        let epoch = RUNTIME_LOCK.lock().unwrap().generation;
        publish_runtime(
            &db,
            ImagegenTarget::Codex,
            5678,
            &["codex", "chatgpt-desktop"],
            true,
            true,
            epoch,
        )
        .unwrap();
        refresh_port(6789).unwrap();
        let value = read_runtime(
            &ImagegenTarget::Codex.runtime_path().unwrap(),
            ImagegenTarget::Codex,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            value["routes"]["chatgpt-desktop"],
            "http://127.0.0.1:6789/imagegen/chatgpt-desktop/v1"
        );
        assert_eq!(value["routes"]["codex"], "http://127.0.0.1:6789/codex/v1");
        assert!(!value.to_string().contains("sk-image"));
        crate::secure_storage::clear_for_tests();
    }

    #[test]
    fn newer_core_port_wins_over_an_in_flight_snapshot_without_reenabling_disabled() {
        let epoch = RuntimeEpoch {
            generation: 2,
            port: 2345,
        };
        assert_eq!(current_port(&epoch, 1, 1234, true), 2345);
        assert_eq!(current_port(&epoch, 1, 0, false), 0);
        assert_eq!(current_port(&epoch, 1, 0, true), 2345);
        assert_eq!(current_port(&epoch, 2, 3456, true), 3456);
    }

    #[test]
    fn runtime_selects_only_bound_namespaces_and_disables_without_a_port() {
        let dsh = runtime(ImagegenTarget::Dsh, 15721, &["dsh"]);
        assert_eq!(
            dsh["routes"],
            json!({"dsh":"http://127.0.0.1:15721/dsh/v1"})
        );
        assert_eq!(dsh["defaultSurface"], "dsh");
        assert_eq!(dsh["directOnly"], true);
        let codex = runtime(ImagegenTarget::Codex, 15721, &["codex", "chatgpt-desktop"]);
        assert_eq!(codex["defaultSurface"], "chatgpt-desktop");
        assert_eq!(codex["directOnly"], false);
        let disabled = runtime(ImagegenTarget::WorkBuddy, 0, &["workbuddy"]);
        assert_eq!(disabled["enabled"], false);
        assert_eq!(disabled["routes"], json!({}));
    }

    #[test]
    fn runtime_refuses_other_targets_and_foreign_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.json");
        std::fs::write(
            &path,
            runtime(ImagegenTarget::Dsh, 1234, &["dsh"]).to_string(),
        )
        .unwrap();
        assert!(read_runtime(&path, ImagegenTarget::Dsh).unwrap().is_some());
        assert!(read_runtime(&path, ImagegenTarget::WorkBuddy).is_err());
        std::fs::write(&path, "{\"owner\":\"user\"}").unwrap();
        assert!(read_runtime(&path, ImagegenTarget::Dsh).is_err());
    }

    #[test]
    fn descriptor_preserves_surface_routes_without_credentials() {
        let both = descriptor(15721, true, true);
        assert_eq!(both["baseUrl"], both["desktopBaseUrl"]);
        assert_eq!(both["terminalBaseUrl"], "http://127.0.0.1:15721/codex/v1");
        assert_eq!(
            descriptor(15721, true, false)["baseUrl"],
            both["terminalBaseUrl"]
        );
        assert!(descriptor(0, true, true).get("baseUrl").is_none());
        assert_eq!(descriptor(15721, false, false)["enabled"], false);
        assert_eq!(both.as_object().unwrap().len(), 6);
    }

    #[test]
    fn descriptor_is_idempotent_disables_owned_and_preserves_foreign_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("yuanheng-imagegen.json");
        write_descriptor(&path, &descriptor(0, false, false)).unwrap();
        assert!(!path.exists());
        let active = descriptor(15721, true, false);
        write_descriptor(&path, &active).unwrap();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        write_descriptor(&path, &active).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before
        );
        write_descriptor(&path, &descriptor(0, false, false)).unwrap();
        let disabled: Value = crate::config::read_json_file(&path).unwrap();
        assert_eq!(disabled["enabled"], false);
        assert!(disabled.get("baseUrl").is_none());
        std::fs::write(&path, "{\"owner\":\"user\"}").unwrap();
        assert!(write_descriptor(&path, &active).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"owner\":\"user\"}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_refuses_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("external.json");
        std::fs::write(&target, "{}").unwrap();
        let path = dir.path().join("yuanheng-imagegen.json");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(write_descriptor(&path, &descriptor(1234, true, false)).is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "{}");
    }
}
