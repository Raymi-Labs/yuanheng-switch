//! Ephemeral image credentials supplied by Desktop over the authenticated local
//! control channel. Core never reads Desktop's system-store items.
use crate::database::Database;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
#[cfg(not(test))]
use std::sync::{Mutex, OnceLock};

pub(crate) const MAX_BODY: usize = 64 * 1024;

// Deliberately no Debug: this type carries an API credential in memory only.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CredentialEntry {
    pub surface: String,
    pub connection_ref: String,
    pub api_token: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CredentialSnapshot {
    pub entries: Vec<CredentialEntry>,
}

type Memory = BTreeMap<String, CredentialEntry>;

#[cfg(not(test))]
fn with_cache<T>(operation: impl FnOnce(&mut Memory) -> T) -> Result<T, String> {
    static CACHE: OnceLock<Mutex<Memory>> = OnceLock::new();
    let mut entries = CACHE
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| "图像凭据内存锁不可用")?;
    Ok(operation(&mut entries))
}

// Unit tests use independent in-memory databases on independent test threads.
// Their default current-thread Tokio runtimes keep spawned HTTP handlers here,
// without letting unrelated proxy tests erase another test's credential state.
#[cfg(test)]
fn with_cache<T>(operation: impl FnOnce(&mut Memory) -> T) -> Result<T, String> {
    thread_local! {
        static CACHE: std::cell::RefCell<Memory> = const { std::cell::RefCell::new(BTreeMap::new()) };
    }
    CACHE.with(|cache| {
        let mut entries = cache.try_borrow_mut().map_err(|_| "图像凭据内存锁不可用")?;
        Ok(operation(&mut entries))
    })
}

pub(crate) fn refs() -> BTreeMap<String, String> {
    with_cache(|entries| {
        entries
            .iter()
            .map(|(surface, entry)| (surface.clone(), entry.connection_ref.clone()))
            .collect()
    })
    .unwrap_or_default()
}

pub(crate) fn credential(surface: &str, connection_ref: &str) -> Option<String> {
    with_cache(|entries| {
        entries
            .get(surface)
            .filter(|entry| entry.connection_ref == connection_ref)
            .map(|entry| entry.api_token.clone())
    })
    .ok()
    .flatten()
}

pub(crate) fn replace(db: &Database, entries: &[CredentialEntry]) -> Result<(), String> {
    if entries.len() > 9 {
        return Err("图像凭据同步数量无效".into());
    }
    let mut surfaces = HashSet::new();
    let mut next = BTreeMap::new();
    for entry in entries {
        if entry.surface.len() > 32
            || entry.connection_ref.len() > 256
            || entry.connection_ref.is_empty()
            || entry.api_token.len() > 4096
            || !surfaces.insert(entry.surface.as_str())
        {
            return Err("图像凭据同步格式无效".into());
        }
        crate::commands::validate_imagegen_core_entry(
            db,
            &entry.surface,
            &entry.connection_ref,
            &entry.api_token,
        )?;
        next.insert(entry.surface.clone(), entry.clone());
    }
    let expected: BTreeMap<_, _> = next
        .iter()
        .map(|(surface, entry)| (surface.clone(), entry.connection_ref.clone()))
        .collect();
    with_cache(|current| {
        // Full snapshots, including an empty reset, must still describe the current
        // DB. A delayed account-A snapshot must not clear account B's credentials.
        if crate::commands::imagegen_credential_refs(db)? != expected {
            return Err("图像连接已变化，请重新同步".into());
        }
        for entry in entries {
            crate::commands::validate_imagegen_core_entry(
                db,
                &entry.surface,
                &entry.connection_ref,
                &entry.api_token,
            )?;
        }
        *current = next;
        Ok(())
    })?
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            with_cache(|entries| entries.clear()).unwrap();
            crate::secure_storage::clear_for_tests();
        }
    }

    pub fn fixture() -> (Cleanup, Database, Vec<CredentialEntry>) {
        let cleanup = Cleanup;
        with_cache(|entries| entries.clear()).unwrap();
        crate::secure_storage::clear_for_tests();
        let db = Database::memory().unwrap();
        crate::commands::imagegen_connection_test_support::account(&db, "synthetic-A", false);
        let skill = serde_json::from_value(serde_json::json!({
            "id": "builtin:meta-api-imagegen", "name": "imagegen",
            "directory": "meta-api-imagegen", "apps": {"dsh": true},
            "installedAt": 0
        }))
        .unwrap();
        db.save_skill(&skill).unwrap();
        crate::commands::imagegen_connection_test_support::install(
            &db,
            "dsh",
            "images",
            "sk-synthetic-image-core",
        );
        let entries = crate::commands::imagegen_credential_snapshot(&db).unwrap();
        (cleanup, db, entries)
    }

    pub fn simulate_restart() {
        with_cache(|entries| entries.clear()).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::imagegen_connection_test_support as connection;

    #[test]
    #[serial_test::serial]
    fn core_uses_memory_without_system_store_and_rechecks_disabled_skill() {
        let (_cleanup, db, entries) = test_support::fixture();
        crate::secure_storage::block_access_for_tests(Some(vec![]));
        replace(&db, &entries).unwrap();
        assert!(crate::commands::imagegen_core_provider(&db, "dsh")
            .unwrap()
            .is_some());
        assert_eq!(crate::secure_storage::denied_calls_for_tests(), 0);
        let public = serde_json::to_string(&refs()).unwrap();
        assert!(!public.contains("sk-synthetic"));
        assert!(credential("dsh", "outdated-reference").is_none());

        let mut skill = db
            .get_installed_skill("builtin:meta-api-imagegen")
            .unwrap()
            .unwrap();
        skill.apps.dsh = false;
        db.save_skill(&skill).unwrap();
        assert!(crate::commands::imagegen_core_provider(&db, "dsh").is_err());
        assert!(replace(&db, &entries).is_err());
        replace(&db, &[]).unwrap();
        assert!(refs().is_empty());
        assert_eq!(crate::secure_storage::denied_calls_for_tests(), 0);
    }

    #[test]
    #[serial_test::serial]
    fn stale_account_snapshots_cannot_replace_or_clear_current_credentials() {
        let (_cleanup, db, old_entries) = test_support::fixture();
        replace(&db, &old_entries).unwrap();
        connection::revoke(&db);
        connection::account(&db, "synthetic-B", false);
        connection::install(&db, "dsh", "new-images", "sk-synthetic-image-B");
        let current = crate::commands::imagegen_credential_snapshot(&db).unwrap();
        replace(&db, &current).unwrap();
        let expected = refs();
        assert!(replace(&db, &old_entries).is_err());
        assert!(replace(&db, &[]).is_err());
        assert_eq!(refs(), expected);
        assert!(credential("dsh", &old_entries[0].connection_ref).is_none());
        assert!(credential("dsh", &current[0].connection_ref).is_some());
        connection::revoke(&db);
        assert!(crate::commands::imagegen_core_provider(&db, "dsh")
            .unwrap()
            .is_none());
        replace(&db, &[]).unwrap();
        assert!(refs().is_empty());
    }

    #[test]
    #[serial_test::serial]
    fn invalid_or_partial_snapshots_leave_memory_unchanged() {
        let (_cleanup, db, entries) = test_support::fixture();
        replace(&db, &entries).unwrap();
        let expected = refs();
        assert!(replace(&db, &vec![entries[0].clone(); 10]).is_err());
        assert!(replace(&db, &[entries[0].clone(), entries[0].clone()]).is_err());
        for (surface, reference, token) in [
            (
                "unknown",
                entries[0].connection_ref.as_str(),
                "sk-synthetic",
            ),
            ("dsh", "", "sk-synthetic"),
            ("dsh", entries[0].connection_ref.as_str(), "invalid token"),
        ] {
            assert!(replace(
                &db,
                &[CredentialEntry {
                    surface: surface.into(),
                    connection_ref: reference.into(),
                    api_token: token.into(),
                }]
            )
            .is_err());
        }
        assert_eq!(refs(), expected);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn desktop_sync_skips_store_when_current_and_recovers_lost_core_memory() {
        let (_cleanup, db, entries) = test_support::fixture();
        let db = std::sync::Arc::new(db);
        let service = crate::services::ProxyService::new(db.clone());
        service.sync_imagegen_credentials().await.unwrap();
        assert_eq!(
            refs(),
            crate::commands::imagegen_credential_refs(&db).unwrap()
        );
        crate::secure_storage::block_access_for_tests(Some(vec![]));
        service.sync_imagegen_credentials().await.unwrap();
        assert_eq!(crate::secure_storage::denied_calls_for_tests(), 0);
        test_support::simulate_restart();
        assert!(service.sync_imagegen_credentials().await.is_err());
        assert!(refs().is_empty());
        crate::secure_storage::block_access_for_tests(None);
        service.sync_imagegen_credentials().await.unwrap();
        assert_eq!(refs().get("dsh"), Some(&entries[0].connection_ref));
    }
}
