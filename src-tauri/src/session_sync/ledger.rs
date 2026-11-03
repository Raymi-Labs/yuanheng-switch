//! 同步账本：主库 `session_sync_links` 表的 DAO 与快照备份。

use std::path::PathBuf;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::database::{lock_conn, Database};
use crate::error::AppError;

pub const SYNC_STATUS_SYNCED: &str = "synced";
pub const SYNC_STATUS_DIVERGED: &str = "diverged";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSyncLink {
    pub source_provider: String,
    pub source_session_id: String,
    pub target_provider: String,
    pub target_session_id: String,
    /// 目标文件路径或 SQLite 定位串
    pub target_ref: String,
    pub source_fingerprint: String,
    pub target_fingerprint: String,
    pub status: String,
    pub synced_at: i64,
}

impl Database {
    pub fn list_session_sync_links(&self) -> Result<Vec<SessionSyncLink>, AppError> {
        let conn = lock_conn!(self.conn);
        let mut stmt = conn
            .prepare(
                "SELECT source_provider, source_session_id, target_provider, target_session_id,
                        target_ref, source_fingerprint, target_fingerprint, status, synced_at
                 FROM session_sync_links",
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SessionSyncLink {
                    source_provider: row.get(0)?,
                    source_session_id: row.get(1)?,
                    target_provider: row.get(2)?,
                    target_session_id: row.get(3)?,
                    target_ref: row.get(4)?,
                    source_fingerprint: row.get(5)?,
                    target_fingerprint: row.get(6)?,
                    status: row.get(7)?,
                    synced_at: row.get(8)?,
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::Database(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn upsert_session_sync_link(&self, link: &SessionSyncLink) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "INSERT OR REPLACE INTO session_sync_links
             (source_provider, source_session_id, target_provider, target_session_id,
              target_ref, source_fingerprint, target_fingerprint, status, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                link.source_provider,
                link.source_session_id,
                link.target_provider,
                link.target_session_id,
                link.target_ref,
                link.source_fingerprint,
                link.target_fingerprint,
                link.status,
                link.synced_at,
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn mark_session_sync_link_diverged(
        &self,
        source_provider: &str,
        source_session_id: &str,
        target_provider: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "UPDATE session_sync_links SET status = ?4
             WHERE source_provider = ?1 AND source_session_id = ?2 AND target_provider = ?3",
            params![
                source_provider,
                source_session_id,
                target_provider,
                SYNC_STATUS_DIVERGED
            ],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }

    pub fn delete_session_sync_link(
        &self,
        source_provider: &str,
        source_session_id: &str,
        target_provider: &str,
    ) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        conn.execute(
            "DELETE FROM session_sync_links
             WHERE source_provider = ?1 AND source_session_id = ?2 AND target_provider = ?3",
            params![source_provider, source_session_id, target_provider],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(())
    }
}

fn snapshot_dir() -> PathBuf {
    crate::config::get_app_config_dir()
        .join("backups")
        .join("session-sync")
}

/// 每次写入前把账本快照落盘，保留最近 20 份。
pub fn snapshot_ledger(links: &[SessionSyncLink]) -> Result<(), String> {
    let dir = snapshot_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create backup dir: {e}"))?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let path = dir.join(format!("ledger-{stamp}.json"));
    let text = serde_json::to_string_pretty(links).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Failed to write ledger snapshot: {e}"))?;

    let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    entries.sort();
    while entries.len() > 20 {
        let oldest = entries.remove(0);
        let _ = std::fs::remove_file(oldest);
    }
    Ok(())
}
