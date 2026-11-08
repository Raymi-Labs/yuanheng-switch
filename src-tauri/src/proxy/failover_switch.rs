//! 故障转移切换模块
//!
//! 处理故障转移成功后的供应商切换逻辑，包括：
//! - 去重控制（避免多个请求同时触发）
//! - 托盘菜单更新
//! - 前端事件发射

use crate::database::Database;
use crate::error::AppError;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::RwLock;

/// 故障转移切换管理器
///
/// 负责处理故障转移成功后的供应商切换，确保 UI 能够直观反映当前使用的供应商。
#[derive(Clone)]
pub struct FailoverSwitchManager {
    /// 正在处理中的切换（key = "app_type:provider_id"）
    pending_switches: Arc<RwLock<HashSet<String>>>,
    db: Arc<Database>,
}

impl FailoverSwitchManager {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            pending_switches: Arc::new(RwLock::new(HashSet::new())),
            db,
        }
    }

    /// 尝试执行故障转移切换
    ///
    /// 如果相同的切换已在进行中，则跳过；否则执行切换逻辑。
    ///
    /// # Returns
    /// - `Ok(true)` - 切换成功执行
    /// - `Ok(false)` - 切换已在进行中，跳过
    /// - `Err(e)` - 切换过程中发生错误
    pub async fn try_switch(
        &self,
        app_handle: Option<&tauri::AppHandle>,
        app_type: &str,
        provider_id: &str,
        provider_name: &str,
    ) -> Result<bool, AppError> {
        let switch_key = format!("{app_type}:{provider_id}");

        // 去重检查：如果相同切换已在进行中，跳过
        {
            let mut pending = self.pending_switches.write().await;
            if pending.contains(&switch_key) {
                log::debug!("[Failover] 切换已在进行中，跳过: {app_type} -> {provider_id}");
                return Ok(false);
            }
            pending.insert(switch_key.clone());
        }

        // 执行切换（确保最后清理 pending 标记）
        let result = self
            .do_switch(app_handle, app_type, provider_id, provider_name)
            .await;

        // 清理 pending 标记
        {
            let mut pending = self.pending_switches.write().await;
            pending.remove(&switch_key);
        }

        result
    }

    async fn do_switch(
        &self,
        app_handle: Option<&tauri::AppHandle>,
        app_type: &str,
        provider_id: &str,
        provider_name: &str,
    ) -> Result<bool, AppError> {
        // 检查该应用是否已被代理接管（enabled=true）
        // 请求结束前用户可能关闭故障转移；再次检查开关，禁止迟到请求回写。
        let app_enabled = match self.db.get_proxy_config_for_app(app_type).await {
            Ok(config) => config.enabled && config.auto_failover_enabled,
            Err(e) => {
                log::warn!("[FO-002] 无法读取 {app_type} 配置: {e}，跳过切换");
                return Ok(false);
            }
        };

        if !app_enabled {
            log::debug!("[Failover] {app_type} 未启用代理或自动故障转移，跳过切换");
            return Ok(false);
        }

        // Explicit native account mode wins over late relay responses, even if
        // automatic failover was enabled before the user left gateway mode.
        if app_type == "claude-desktop"
            && self.db.get_current_provider(app_type)?.as_deref()
                == Some(crate::database::CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID)
        {
            return Ok(false);
        }

        log::info!("[FO-001] 切换: {app_type} → {provider_name}");

        let mut switched = false;

        if let Some(app) = app_handle {
            if let Some(app_state) = app.try_state::<crate::store::AppState>() {
                switched = app_state
                    .proxy_service
                    .hot_switch_provider(app_type, provider_id)
                    .await
                    .map_err(AppError::Message)?
                    .logical_target_changed;

                if !switched {
                    return Ok(false);
                }

                if let Ok(new_menu) = crate::tray::create_tray_menu(app, app_state.inner()) {
                    if let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) {
                        if let Err(e) = tray.set_menu(Some(new_menu)) {
                            log::error!("[Failover] 更新托盘菜单失败: {e}");
                        }
                    }
                }
            }

            // 发射事件到前端
            let event_data = serde_json::json!({
                "appType": app_type,
                "providerId": provider_id,
                "source": "failover"  // 标识来源是故障转移
            });
            if let Err(e) = app.emit("provider-switched", event_data) {
                log::error!("[Failover] 发射事件失败: {e}");
            }
        } else {
            // 独立 Core 没有 Tauri AppHandle，但仍必须提交真实的供应商切换。
            // ProxyService 在这里仅复用热切换事务，不持有或启动第二个 HTTP 服务。
            let service = crate::services::ProxyService::new(self.db.clone());
            switched = service
                .hot_switch_provider(app_type, provider_id)
                .await
                .map_err(AppError::Message)?
                .logical_target_changed;
        }

        Ok(switched)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn claude_official_mode_rejects_late_relay_failover() {
        let db = Arc::new(Database::memory().unwrap());
        let official = crate::database::CLAUDE_DESKTOP_OFFICIAL_PROVIDER_ID;
        db.ensure_official_seed_by_id(official, crate::app_config::AppType::ClaudeDesktop)
            .unwrap();
        db.set_current_provider("claude-desktop", official).unwrap();
        let mut config = db.get_proxy_config_for_app("claude-desktop").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();
        let manager = FailoverSwitchManager::new(db.clone());
        assert!(!manager
            .try_switch(None, "claude-desktop", "old-relay", "Old relay")
            .await
            .unwrap());
        assert_eq!(
            db.get_current_provider("claude-desktop")
                .unwrap()
                .as_deref(),
            Some(official)
        );
    }

    #[tokio::test]
    async fn disabled_failover_rejects_late_request_before_any_live_write() {
        let db = Arc::new(Database::memory().unwrap());
        let mut config = db.get_proxy_config_for_app("codex").await.unwrap();
        config.enabled = true;
        config.auto_failover_enabled = false;
        db.update_proxy_config_for_app(config).await.unwrap();
        let manager = FailoverSwitchManager::new(db.clone());
        // This target deliberately does not exist: reaching hot_switch would error.
        assert!(!manager
            .try_switch(None, "codex", "old-relay", "Old relay")
            .await
            .unwrap());
        let mut config = db.get_proxy_config_for_app("codex").await.unwrap();
        config.auto_failover_enabled = true;
        db.update_proxy_config_for_app(config).await.unwrap();
        // With failover enabled the same request reaches target validation.
        assert!(manager
            .try_switch(None, "codex", "old-relay", "Old relay")
            .await
            .is_err());
    }
}
