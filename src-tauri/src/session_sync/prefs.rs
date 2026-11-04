//! 会话同步偏好：启动前是否询问、按（目标客户端, 目录）的"不再提醒"。
//! 存在主库 settings 表的单个 JSON 键里，随设备保存。

use serde::{Deserialize, Serialize};

use crate::database::Database;

const PREFS_KEY: &str = "session_sync_prefs";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSyncPrefs {
    /// 启动客户端前检测并询问；默认开
    #[serde(default = "default_true")]
    pub prompt_on_launch: bool,
    /// 不再提醒的 (目标客户端, 规范化目录)
    #[serde(default)]
    pub muted: Vec<MutedDirectory>,
    /// 启动时不再询问项目分组同步的目标客户端
    #[serde(default)]
    pub muted_project_targets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutedDirectory {
    pub target_provider: String,
    pub project_dir: String,
}

fn default_true() -> bool {
    true
}

impl Default for SessionSyncPrefs {
    fn default() -> Self {
        Self {
            prompt_on_launch: true,
            muted: Vec::new(),
            muted_project_targets: Vec::new(),
        }
    }
}

impl SessionSyncPrefs {
    pub fn is_muted(&self, target_provider: &str, project_dir: &str) -> bool {
        let dir = super::normalize_project_dir(project_dir);
        self.muted
            .iter()
            .any(|m| m.target_provider == target_provider && m.project_dir == dir)
    }
}

pub fn load(db: &Database) -> SessionSyncPrefs {
    db.get_setting(PREFS_KEY)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(db: &Database, prefs: &SessionSyncPrefs) -> Result<(), String> {
    let mut prefs = prefs.clone();
    for m in &mut prefs.muted {
        m.project_dir = super::normalize_project_dir(&m.project_dir);
    }
    prefs.muted.sort_by(|a, b| {
        (a.target_provider.as_str(), a.project_dir.as_str())
            .cmp(&(b.target_provider.as_str(), b.project_dir.as_str()))
    });
    prefs.muted.dedup();
    prefs.muted_project_targets.sort();
    prefs.muted_project_targets.dedup();
    let text = serde_json::to_string(&prefs).map_err(|e| e.to_string())?;
    db.set_setting(PREFS_KEY, &text).map_err(|e| e.to_string())
}

/// 把若干目录加入"不再提醒"。
pub fn mute(
    db: &Database,
    target_provider: &str,
    project_dirs: &[String],
) -> Result<SessionSyncPrefs, String> {
    let mut prefs = load(db);
    for dir in project_dirs {
        prefs.muted.push(MutedDirectory {
            target_provider: target_provider.to_string(),
            project_dir: dir.clone(),
        });
    }
    save(db, &prefs)?;
    Ok(load(db))
}

/// 启动时不再询问某个目标客户端的项目分组同步。
pub fn mute_project_target(
    db: &Database,
    target_provider: &str,
) -> Result<SessionSyncPrefs, String> {
    let mut prefs = load(db);
    prefs
        .muted_project_targets
        .push(target_provider.to_string());
    save(db, &prefs)?;
    Ok(load(db))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_prompting_and_roundtrips_mutes() {
        let db = Database::memory().unwrap();
        assert!(load(&db).prompt_on_launch);
        let prefs = mute(
            &db,
            "claude",
            &["/nonexistent/a/".to_string(), "/nonexistent/a".to_string()],
        )
        .unwrap();
        assert_eq!(prefs.muted.len(), 1);
        assert!(prefs.is_muted("claude", "/nonexistent/a"));
        assert!(!prefs.is_muted("codex", "/nonexistent/a"));
        mute_project_target(&db, "dsh").unwrap();
        let prefs = mute_project_target(&db, "dsh").unwrap();
        assert_eq!(prefs.muted_project_targets, vec!["dsh".to_string()]);
        save(
            &db,
            &SessionSyncPrefs {
                prompt_on_launch: false,
                ..prefs
            },
        )
        .unwrap();
        assert!(!load(&db).prompt_on_launch);
    }

    #[test]
    fn malformed_value_falls_back_to_defaults() {
        let db = Database::memory().unwrap();
        db.set_setting(PREFS_KEY, "not json").unwrap();
        assert_eq!(load(&db), SessionSyncPrefs::default());
    }
}
