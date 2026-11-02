//! Fresh macOS authentication never depends on access to an older login item.
//! SQLite stores only an opaque selector and public account metadata; a failed
//! system-store write keeps the newly authenticated session in this process.
use super::{
    YuanhengConnectionStatus, API_TOKEN_GROUP_KEY, API_TOKEN_ID_KEY, API_TOKEN_KEY, CACHE_KEY,
    SESSION_COOKIE_KEY, USER_ID_KEY, YUANHENG_SECURE_KEYS,
};
use crate::{secure_storage, store::AppState};
use serde::{Deserialize, Serialize};

const SELECTOR: &str = "yuanheng_login_session_selector";
const MEMORY: &str = "memory-only";
const SIGNED_OUT: &str = "signed-out";

#[derive(Clone, Serialize, Deserialize)]
struct Secrets {
    session_cookie: String,
    user_id: String,
    api_token: String,
}

#[derive(Default)]
pub(crate) struct CredentialSession {
    active: Option<(String, Secrets)>,
    pub(super) pending: Option<String>,
}

fn item_key(selector: &str) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(selector).map_err(|_| "本机登录索引无效，请重新登录")?;
    Ok(format!("yuanheng_login_session_{id}"))
}

fn selector(state: &AppState) -> Result<Option<String>, String> {
    state.db.get_setting(SELECTOR).map_err(|e| e.to_string())
}

pub(super) fn has_session(state: &AppState) -> Result<bool, String> {
    Ok(selector(state)?.is_some())
}

fn load(state: &AppState, runtime: &mut CredentialSession) -> Result<Option<bool>, String> {
    let Some(selected) = selector(state)? else {
        return Ok(None); // Only unmigrated installations use the legacy path.
    };
    if selected == SIGNED_OUT {
        return Ok(Some(false));
    }
    if runtime.active.as_ref().map(|(id, _)| id) != Some(&selected) {
        if selected == MEMORY {
            return Ok(Some(false)); // A process restart must not resurrect an old account.
        }
        let Some(value) = secure_storage::get_secret(&item_key(&selected)?)? else {
            return Ok(Some(false));
        };
        let secrets = serde_json::from_str(&value).map_err(|_| "本机登录信息无效，请重新登录")?;
        runtime.active = Some((selected, secrets));
    }
    Ok(Some(true))
}

pub(super) fn get(state: &AppState, key: &str) -> Result<Option<Option<String>>, String> {
    let mut runtime = state
        .yuanheng_login
        .lock()
        .map_err(|_| "本机登录状态不可用")?;
    match load(state, &mut runtime)? {
        None => return Ok(None),
        Some(false) => return Ok(Some(None)),
        Some(true) => {}
    }
    let secrets = &runtime.active.as_ref().ok_or("本机登录状态不可用")?.1;
    let value = match key {
        SESSION_COOKIE_KEY => Some(secrets.session_cookie.clone()),
        USER_ID_KEY => Some(secrets.user_id.clone()),
        API_TOKEN_KEY => Some(secrets.api_token.clone()),
        _ => None,
    };
    Ok(Some(value))
}

pub(super) fn cached_status(state: &AppState) -> Result<Option<YuanhengConnectionStatus>, String> {
    // Hold one lock for credentials AND public metadata so account switching
    // cannot combine one account's secrets with another account's display data.
    let mut runtime = state
        .yuanheng_login
        .lock()
        .map_err(|_| "本机登录状态不可用")?;
    match load(state, &mut runtime)? {
        None => return Ok(None),
        Some(false) => return Ok(Some(YuanhengConnectionStatus::default())),
        Some(true) => {}
    }
    let secrets = &runtime.active.as_ref().ok_or("本机登录状态不可用")?.1;
    let cached = state.db.get_setting(CACHE_KEY).map_err(|e| e.to_string())?;
    let Some(cached) = cached else {
        return Ok(Some(YuanhengConnectionStatus::default()));
    };
    let status: YuanhengConnectionStatus =
        serde_json::from_str(&cached).map_err(|_| "本机账号状态无效，请重新登录")?;
    if status.user_id.as_deref() != Some(secrets.user_id.as_str()) {
        return Err("本机账号状态不一致，请重新登录".into());
    }
    Ok(Some(status))
}

pub(super) fn persist(
    state: &AppState,
    session_cookie: &str,
    user_id: &str,
    api_token: &str,
    api_token_id: i64,
    status: &YuanhengConnectionStatus,
    group: &str,
) -> Result<(), String> {
    if [session_cookie, user_id]
        .iter()
        .any(|value| value.is_empty())
    {
        return Err("登录响应不完整，请重新登录".into());
    }
    let mut runtime = state
        .yuanheng_login
        .lock()
        .map_err(|_| "本机登录状态不可用")?;
    let previous = selector(state)?;
    let next = uuid::Uuid::new_v4().to_string();
    let key = item_key(&next)?;
    let secrets = Secrets {
        session_cookie: session_cookie.into(),
        user_id: user_id.into(),
        api_token: api_token.into(),
    };
    let encoded = serde_json::to_string(&secrets).map_err(|_| "无法保存本机登录")?;
    let persisted = secure_storage::set_secret(&key, &encoded)
        .and_then(|_| secure_storage::verify_secret(&key, &encoded))
        .unwrap_or(false);
    let selected = if persisted { next.as_str() } else { MEMORY };
    let mut status = status.clone();
    status.connected = true;
    status.user_id = Some(user_id.into());
    status.session_only = !persisted;
    let cached = serde_json::to_string(&status).map_err(|_| "无法保存账号状态")?;
    let token_id = api_token_id.to_string();
    let mut changes = vec![
        (SELECTOR, Some(selected)),
        (CACHE_KEY, Some(cached.as_str())),
        (API_TOKEN_GROUP_KEY, Some(group)),
        (API_TOKEN_ID_KEY, Some(token_id.as_str())),
    ];
    // A successfully reauthenticated account supersedes legacy SQLite secrets.
    changes.extend(YUANHENG_SECURE_KEYS.into_iter().map(|key| (key, None)));
    if let Err(error) = state.db.set_settings_atomically(&changes) {
        let _ = secure_storage::delete_secret(&key);
        return Err(error.to_string());
    }
    runtime.active = Some((selected.into(), secrets));
    runtime.pending = None;
    if !persisted {
        let _ = secure_storage::delete_secret(&key);
        log::info!("系统凭据保存不可用，当前元衡登录仅在本次运行中保留");
    }
    // Cleanup is best effort AFTER publication. It never gates authentication
    // and never touches the inaccessible fixed legacy items.
    if let Some(old) = previous.and_then(|value| item_key(&value).ok()) {
        let _ = secure_storage::delete_secret(&old);
    }
    Ok(())
}

pub(super) fn clear(state: &AppState) -> Result<(), String> {
    let mut runtime = state
        .yuanheng_login
        .lock()
        .map_err(|_| "本机登录状态不可用")?;
    let previous = selector(state)?;
    let mut changes = vec![
        (SELECTOR, Some(SIGNED_OUT)),
        (CACHE_KEY, None),
        (API_TOKEN_GROUP_KEY, None),
        (API_TOKEN_ID_KEY, None),
    ];
    changes.extend(YUANHENG_SECURE_KEYS.into_iter().map(|key| (key, None)));
    state
        .db
        .set_settings_atomically(&changes)
        .map_err(|e| e.to_string())?;
    runtime.active = None;
    runtime.pending = None;
    if let Some(old) = previous.and_then(|value| item_key(&value).ok()) {
        let _ = secure_storage::delete_secret(&old);
    }
    Ok(())
}

pub(super) fn recovery_keys(state: &AppState) -> Result<Vec<String>, String> {
    match selector(state)? {
        None => Ok(YUANHENG_SECURE_KEYS
            .iter()
            .map(|key| (*key).into())
            .collect()),
        Some(value) if value == MEMORY || value == SIGNED_OUT => Ok(Vec::new()),
        Some(value) => Ok(vec![item_key(&value)?]),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        get_yuanheng_secret, invalidate_yuanheng_session, migrate_legacy_yuanheng_secrets,
        persist_connection, read_cached_status, set_pending_yuanheng_session,
        PENDING_SESSION_COOKIE_KEY,
    };
    use super::*;
    use crate::database::Database;
    use serial_test::serial;
    use std::sync::Arc;

    fn state() -> AppState {
        secure_storage::clear_for_tests();
        AppState::new(Arc::new(Database::memory().unwrap()))
    }

    fn login(state: &AppState, user: &str) -> Result<(), String> {
        let status = YuanhengConnectionStatus {
            connected: true,
            user_id: Some(user.into()),
            ..Default::default()
        };
        persist_connection(
            state,
            &format!("session={user}-synthetic"),
            user,
            &format!("sk-{user}-synthetic"),
            12,
            &status,
        )
    }

    fn seed_legacy(state: &AppState) {
        for key in YUANHENG_SECURE_KEYS {
            secure_storage::set_secret(key, "old-synthetic-secret").unwrap();
            state.db.set_setting(key, "old-synthetic-secret").unwrap();
        }
    }

    fn assert_no_sqlite_secrets(state: &AppState) {
        for key in YUANHENG_SECURE_KEYS {
            assert!(state.db.get_setting(key).unwrap().is_none());
        }
        let conn = state.db.conn.lock().unwrap();
        let mut query = conn.prepare("SELECT value FROM settings").unwrap();
        for value in query.query_map([], |row| row.get::<_, String>(0)).unwrap() {
            let value = value.unwrap();
            assert!(
                !value.contains("synthetic"),
                "secrets must never reach SQLite"
            );
        }
    }

    #[test]
    #[serial]
    fn fresh_login_never_reads_denied_legacy_items_and_survives_restart() {
        let state = state();
        seed_legacy(&state);
        secure_storage::block_access_for_tests(Some(
            YUANHENG_SECURE_KEYS.iter().map(|k| (*k).into()).collect(),
        ));
        login(&state, "new-user").unwrap();
        assert_eq!(secure_storage::denied_calls_for_tests(), 0);
        assert_no_sqlite_secrets(&state);
        let keys = recovery_keys(&state).unwrap();
        assert_eq!(keys.len(), 1);
        assert!(keys[0].starts_with("yuanheng_login_session_"));
        let restarted = AppState::new(state.db.clone());
        migrate_legacy_yuanheng_secrets(&restarted).unwrap();
        let status = read_cached_status(&restarted).unwrap();
        assert!(status.connected && !status.session_only);
        assert_eq!(status.user_id.as_deref(), Some("new-user"));
        assert_eq!(
            get_yuanheng_secret(&restarted, SESSION_COOKIE_KEY)
                .unwrap()
                .as_deref(),
            Some("session=new-user-synthetic")
        );
        assert_eq!(secure_storage::denied_calls_for_tests(), 0);
        secure_storage::clear_for_tests();
    }

    #[test]
    #[serial]
    fn unavailable_store_allows_two_factor_login_and_refresh_only_for_this_process() {
        let state = state();
        seed_legacy(&state);
        secure_storage::block_access_for_tests(Some(Vec::new()));
        set_pending_yuanheng_session(&state, "pending-synthetic").unwrap();
        assert_eq!(
            get_yuanheng_secret(&state, PENDING_SESSION_COOKIE_KEY)
                .unwrap()
                .as_deref(),
            Some("pending-synthetic")
        );
        assert_eq!(secure_storage::denied_calls_for_tests(), 0);
        login(&state, "fresh").unwrap();
        assert!(get_yuanheng_secret(&state, PENDING_SESSION_COOKIE_KEY)
            .unwrap()
            .is_none());
        let status = read_cached_status(&state).unwrap();
        assert!(status.connected && status.session_only);
        assert_eq!(status.user_id.as_deref(), Some("fresh"));
        login(&state, "refreshed").unwrap();
        assert_eq!(
            get_yuanheng_secret(&state, API_TOKEN_KEY)
                .unwrap()
                .as_deref(),
            Some("sk-refreshed-synthetic")
        );
        assert_no_sqlite_secrets(&state);
        assert!(recovery_keys(&state).unwrap().is_empty());
        let restarted = AppState::new(state.db.clone());
        assert!(!read_cached_status(&restarted).unwrap().connected);
        invalidate_yuanheng_session(&state).unwrap();
        assert!(!read_cached_status(&state).unwrap().connected);
        secure_storage::block_access_for_tests(None);
        assert!(
            !read_cached_status(&AppState::new(state.db.clone()))
                .unwrap()
                .connected
        );
        assert_eq!(
            secure_storage::get_secret(SESSION_COOKIE_KEY)
                .unwrap()
                .as_deref(),
            Some("old-synthetic-secret")
        );
        secure_storage::clear_for_tests();
    }

    #[test]
    #[serial]
    fn failed_readback_uses_memory_and_never_claims_the_session_was_saved() {
        let state = state();
        secure_storage::block_verification_for_tests(true);
        login(&state, "fresh").unwrap();
        assert_eq!(selector(&state).unwrap().as_deref(), Some(MEMORY));
        assert!(read_cached_status(&state).unwrap().session_only);
        assert!(
            !read_cached_status(&AppState::new(state.db.clone()))
                .unwrap()
                .connected
        );
        assert_no_sqlite_secrets(&state);
        secure_storage::clear_for_tests();
    }

    #[test]
    #[serial]
    fn sqlite_failure_keeps_the_previous_account_and_selector_together() {
        let state = state();
        login(&state, "previous").unwrap();
        let previous = selector(&state).unwrap();
        state.db.conn.lock().unwrap().execute_batch(
            "CREATE TRIGGER reject_account_cache BEFORE INSERT ON settings WHEN NEW.key = 'yuanheng_connection_cache' BEGIN SELECT RAISE(ABORT, 'test account cache failure'); END;"
        ).unwrap();
        assert!(login(&state, "replacement").is_err());
        assert_eq!(selector(&state).unwrap(), previous);
        for current in [&state, &AppState::new(state.db.clone())] {
            assert_eq!(
                read_cached_status(current).unwrap().user_id.as_deref(),
                Some("previous")
            );
            assert_eq!(
                get_yuanheng_secret(current, SESSION_COOKIE_KEY)
                    .unwrap()
                    .as_deref(),
                Some("session=previous-synthetic")
            );
        }
        assert_no_sqlite_secrets(&state);
        secure_storage::clear_for_tests();
    }

    #[test]
    #[serial]
    fn missing_new_item_does_not_fall_back_to_an_older_account() {
        let state = state();
        seed_legacy(&state);
        login(&state, "fresh").unwrap();
        secure_storage::delete_secret(&recovery_keys(&state).unwrap()[0]).unwrap();
        assert!(
            !read_cached_status(&AppState::new(state.db.clone()))
                .unwrap()
                .connected
        );
        state
            .db
            .set_setting(SELECTOR, "Claude Code-credentials")
            .unwrap();
        assert!(recovery_keys(&state).is_err());
        secure_storage::clear_for_tests();
    }
}
