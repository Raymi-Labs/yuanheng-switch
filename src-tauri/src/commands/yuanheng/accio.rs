use super::*;
use crate::accio_work::{self, Profile, SCOPE};

pub(super) fn credential(state: &AppState, group: &str) -> Result<Option<String>, String> {
    let Some(profile) = accio_work::load(&state.db)? else {
        return Ok(None);
    };
    let connection = read_cached_status(state)?;
    if connection.user_id.as_deref() != Some(&profile.owner) || profile.group != group {
        return Ok(None);
    }
    Ok(Some(
        profile
            .provider
            .resolve_usage_credentials(&AppType::Codex)
            .1,
    ))
}

pub(super) fn configure(
    state: &AppState,
    token: &str,
    model: &str,
    models: &[String],
    group: &str,
    reasoning: &str,
) -> Result<YuanhengToolConfigureResult, String> {
    if !accio_work::EXPERIMENTAL_ENABLED || !cfg!(target_os = "macos") {
        return Err("Accio 主模型桥接目前只完成 macOS 适配，当前平台尚未验收".into());
    }
    let owner = read_cached_status(state)?
        .user_id
        .ok_or("请先连接元衡账号")?;
    let profile = Profile {
        owner,
        model: model.into(),
        group: group.into(),
        reasoning: reasoning.into(),
        models: terminal_catalog_models(model, models),
        provider: managed_provider_with_models(
            &AppType::Codex,
            token,
            model,
            models,
            group,
            reasoning,
        )?,
        capability: accio_work::new_capability(),
        active: false,
    };
    accio_work::save_configuration(&state.db, profile)?;
    Ok(YuanhengToolConfigureResult {
        app:SCOPE.into(),configured:true,model:Some(model.into()),error:None,
        warnings:vec!["Accio 配置已保存。请点击“启动/应用并启动”后使用；普通打开 Accio 不会自动走元衡。输入框模型菜单可选当前分组模型。插件目录与连接状态查询走官方账号服务，云端业务工具尚未接入。".into()],
    })
}

pub(super) fn status(
    state: &AppState,
    connection: &YuanhengConnectionStatus,
) -> YuanhengToolStatus {
    let loaded = accio_work::load(&state.db);
    let profile = loaded
        .as_ref()
        .ok()
        .and_then(|p| p.as_ref())
        .filter(|p| connection.user_id.as_deref() == Some(&p.owner));
    let available =
        profile.map(|p| cached_models_for_group(connection, Some(&p.group), Some(p.model.clone())));
    let current = profile.is_some_and(|p| {
        available.as_ref().is_some_and(|models| {
            models.iter().collect::<BTreeSet<_>>() == p.models.iter().collect::<BTreeSet<_>>()
        })
    });
    YuanhengToolStatus {
        app: SCOPE.into(),
        supported: accio_work::EXPERIMENTAL_ENABLED && cfg!(target_os = "macos"),
        configured: accio_work::EXPERIMENTAL_ENABLED
            && cfg!(target_os = "macos")
            && profile.is_some()
            && current,
        needs_update: profile.is_some() && !current,
        model: profile.map(|p| p.model.clone()),
        group: profile.map(|p| p.group.clone()),
        reasoning: profile.map(|p| p.reasoning.clone()),
        recommended_model: recommended_model(&AppType::Codex, &connection.terminal_models),
        message: Some(if let Err(error) = loaded {
            error
        } else if cfg!(target_os = "macos") {
            "请从元衡启动 Accio；在输入框模型菜单切换当前分组模型。普通打开应用不会自动使用此配置。"
                .into()
        } else {
            "当前平台的 Accio 桥接尚未验收".into()
        }),
        runtime_warning: None,
        runtime_status: None,
    }
}

/// A cheap, read-only version hint. Full signature checks run on explicit
/// preflight/configure/launch; a polling result never grants execution.
pub(super) async fn annotate_installation(app: &AppHandle, status: &mut YuanhengToolStatus) {
    #[cfg(target_os = "macos")]
    {
        let result = async {
            let path = accio_work::installation::resolve(app).await?;
            let version = accio_work::installation::version_at(&path).await?;
            accio_work::installation::require_supported_version(&version)?;
            Ok::<(), String>(())
        }
        .await;
        status.runtime_warning = result.err();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, status);
    }
}

pub(super) fn log_scope(state: &AppState, connection: &YuanhengConnectionStatus) -> Option<String> {
    accio_work::load(&state.db)
        .ok()
        .flatten()
        .filter(|profile| connection.user_id.as_deref() == Some(&profile.owner))
        .map(|profile| profile.request_log_scope())
}

pub(super) fn activation_message(
    configured: bool,
    route_ready: bool,
    received: bool,
    succeeded: bool,
    status_code: Option<u16>,
) -> String {
    if !configured {
        "请先选择模型和分组，为 Accio 保存配置".into()
    } else if !route_ready {
        "配置已保存，但 Accio 尚未接通元衡。请保存工作并完整退出 Accio，再点击元衡中的启动；普通打开应用不会自动接入。".into()
    } else if !received {
        "Accio 已由元衡启动，等待第一条模型请求；可在输入框的模型菜单直接切换。".into()
    } else if succeeded {
        "本次启动已收到 Accio 请求并确认元衡模型输出。".into()
    } else if matches!(status_code, Some(401 | 403)) {
        "Accio 模型请求的元衡分组凭据被拒绝，请重新配置；Accio 官方登录与模型凭据需分别检查。"
            .into()
    } else if status_code.is_some_and(|status| (200..300).contains(&status)) {
        "已收到 Accio 请求，但尚未确认完整模型输出，请检查对话结果或诊断记录。".into()
    } else {
        format!(
            "本次启动已收到 Accio 请求，但调用失败（HTTP {}），请检查元衡分组和诊断记录。",
            status_code
                .map(|s| s.to_string())
                .unwrap_or_else(|| "未知".into())
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_config_and_historical_success_are_not_a_live_route() {
        let message = activation_message(true, false, true, false, Some(200));
        assert!(message.contains("尚未接通"));
        assert!(message.contains("普通打开"));
        assert!(!message.contains("调用成功"));
        assert!(activation_message(true, true, false, false, None).contains("等待第一条"));
        assert!(activation_message(true, true, true, false, Some(200)).contains("尚未确认完整"));
        assert!(activation_message(true, true, true, false, Some(401)).contains("Accio 官方登录"));
        assert!(activation_message(true, true, true, true, Some(200)).contains("确认元衡模型输出"));
    }

    #[test]
    fn usage_query_keeps_old_launches_and_other_tools_out() {
        let db = crate::database::Database::memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            for (id, app, scope) in [
                ("current", "accio-work", "current-launch"),
                ("previous", "accio-work", "previous-launch"),
                ("other-tool", "codex", "current-launch"),
            ] {
                conn.execute("INSERT INTO proxy_request_logs(request_id,provider_id,app_type,model,latency_ms,status_code,created_at,session_id) VALUES(?1,'yuanheng-managed',?2,'synthetic-model',1,200,1,?3)", rusqlite::params![id,app,scope]).unwrap();
            }
        }
        assert_eq!(
            db.get_latest_proxy_request_for_app_scoped("accio-work", 0, Some("current-launch"))
                .unwrap()
                .unwrap()
                .request_id,
            "current"
        );
        assert!(db
            .get_latest_proxy_request_for_app_scoped("accio-work", 0, Some("never-launched"))
            .unwrap()
            .is_none());
        assert_eq!(
            db.get_latest_proxy_request_for_app("accio-work", 0)
                .unwrap()
                .unwrap()
                .request_id,
            "previous"
        );
    }
}
