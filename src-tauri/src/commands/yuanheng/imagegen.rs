//! Shared image skill setup. The descriptor contains local routes, never keys.
use super::*;
use crate::services::SkillService;
use std::path::Path;

static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

fn active_route(state: &AppState, surface: CodexSurface) -> bool {
    let selected = match surface {
        CodexSurface::Terminal => {
            crate::settings::get_effective_current_provider(&state.db, &AppType::Codex)
        }
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

pub(crate) async fn sync(state: &AppState, auto_install: bool) -> Result<(), String> {
    let _sync_guard = SYNC_LOCK.lock().await;
    // Finish asynchronous Core lookup before taking the current user-state
    // snapshot. A later toggle/switch sync must publish after this one.
    let status = state.proxy_service.get_status().await?;
    let skills_dir =
        SkillService::get_app_skills_dir(&AppType::Codex).map_err(|e| e.to_string())?;
    let path = skills_dir
        .parent()
        .ok_or("Codex 技能目录缺少父目录")?
        .join("yuanheng-imagegen.json");
    let terminal = active_route(state, CodexSurface::Terminal);
    let desktop = active_route(state, CodexSurface::Desktop);
    if !terminal && !desktop {
        return write_descriptor(&path, &descriptor(0, false, false));
    }
    let enabled = if auto_install {
        SkillService::ensure_builtin_imagegen(&state.db)
            .map_err(|e| e.to_string())?
            .is_some()
    } else {
        SkillService::get_all_installed(&state.db)
            .map_err(|e| e.to_string())?
            .iter()
            .any(|skill| skill.id == "builtin:meta-api-imagegen" && skill.apps.codex)
    };
    let port = if enabled && status.running {
        status.port
    } else {
        0
    };
    write_descriptor(&path, &descriptor(port, terminal, desktop))
}

#[cfg(test)]
mod tests {
    use super::*;

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
