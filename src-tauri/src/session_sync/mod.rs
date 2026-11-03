//! 本机 AI 工具间会话同步
//!
//! 把任一客户端的本地会话（经现有 `session_manager` 读取）转换为通用的
//! [`CanonicalSession`]，再由目标客户端的 [`SessionWriter`] 落盘为该客户端
//! 可续聊的最小格式。任意源 → 任意目标都走同一条链；新增客户端只需实现
//! 一个 `SessionWriter`。
//!
//! 约束：只创建或重写由本模块生成的目标文件，永不修改客户端自己产生的
//! 文件；同步生成的会话不再作为源传递到第三个客户端。
//! 决定见 `.agents/notes/proposed/feature/2026-11-03-local-session-sync.md`。

pub mod canonical;
pub mod ledger;
pub mod prefs;
pub mod writers;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::database::Database;
use crate::session_manager::{self, SessionMeta};

pub use canonical::CanonicalSession;
#[cfg(test)]
pub use canonical::CanonicalTurn;
pub use ledger::{SessionSyncLink, SYNC_STATUS_DIVERGED, SYNC_STATUS_SYNCED};
pub use writers::{SessionWriter, TargetRef};

/// 固定命名空间：目标会话 ID 由 (源 provider, 源 id, 目标 provider) 派生，
/// 保证重复同步落到同一目标。
const SYNC_UUID_NAMESPACE: Uuid = Uuid::from_bytes([
    0x6d, 0x2f, 0x4a, 0x91, 0x3c, 0x0e, 0x4b, 0x7a, 0x9a, 0x1d, 0x5e, 0x8b, 0x2c, 0x7f, 0x11, 0x42,
]);

/// 默认范围：最近 90 天、每目录每来源最多 100 条、至少两轮对话。
pub const DEFAULT_MAX_AGE_DAYS: i64 = 90;
pub const DEFAULT_MAX_PER_DIRECTORY: usize = 100;
pub const DEFAULT_MIN_TURNS: usize = 2;

/// 当前可作为同步目标的客户端。
pub fn writable_providers() -> &'static [&'static str] {
    writers::writable_providers()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScope {
    /// 为空时表示全部目录
    #[serde(default)]
    pub project_dir: Option<String>,
    /// 非空时只处理这些目录（启动弹窗把用户看到的目录原样传回）
    #[serde(default)]
    pub project_dirs: Vec<String>,
    /// 为空时表示所有可读来源
    #[serde(default)]
    pub source_providers: Vec<String>,
    #[serde(default)]
    pub max_age_days: Option<i64>,
    #[serde(default)]
    pub max_per_directory: Option<usize>,
    #[serde(default)]
    pub min_turns: Option<usize>,
}

impl Default for SyncScope {
    fn default() -> Self {
        Self {
            project_dir: None,
            project_dirs: Vec::new(),
            source_providers: Vec::new(),
            max_age_days: Some(DEFAULT_MAX_AGE_DAYS),
            max_per_directory: Some(DEFAULT_MAX_PER_DIRECTORY),
            min_turns: Some(DEFAULT_MIN_TURNS),
        }
    }
}

/// 启动前检测结果：按目录汇总，每个目录列出各来源的待同步数量。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingSummary {
    pub target_provider: String,
    pub directories: Vec<PendingDirectory>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingDirectory {
    pub project_dir: String,
    pub label: String,
    pub sources: Vec<PendingSource>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingSource {
    pub source_provider: String,
    pub pending: usize,
    pub diverged: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub target_provider: String,
    pub synced: usize,
    pub updated: usize,
    pub skipped_diverged: usize,
    pub skipped_unchanged: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

/// 为单条会话展示的同步状态（会话页角标）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSyncState {
    pub provider_id: String,
    pub session_id: String,
    /// 本会话是由哪个客户端同步而来（None 表示原生会话）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_session_id: Option<String>,
    /// 本会话已被同步到哪些客户端
    pub synced_to: Vec<SyncedTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedTarget {
    pub target_provider: String,
    pub target_session_id: String,
    pub status: String,
    pub synced_at: i64,
}

pub fn derive_target_session_id(
    source_provider: &str,
    source_session_id: &str,
    target_provider: &str,
) -> String {
    let name = format!("{source_provider}\u{1f}{source_session_id}\u{1f}{target_provider}");
    Uuid::new_v5(&SYNC_UUID_NAMESPACE, name.as_bytes()).to_string()
}

/// 规范化工作目录：解析符号链接（如 macOS 的 /tmp → /private/tmp）、去尾斜杠。
pub fn normalize_project_dir(dir: &str) -> String {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let path = Path::new(trimmed);
    let resolved = path
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(trimmed));
    let mut text = resolved.to_string_lossy().to_string();
    while text.len() > 1 && text.ends_with('/') {
        text.pop();
    }
    text
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn session_matches_scope(meta: &SessionMeta, scope: &SyncScope, now: i64) -> bool {
    if let Some(days) = scope.max_age_days {
        let cutoff = now - days * 24 * 60 * 60 * 1000;
        let ts = meta.last_active_at.or(meta.created_at).unwrap_or(0);
        if ts < cutoff {
            return false;
        }
    }
    if let Some(dir) = scope.project_dir.as_deref() {
        let wanted = normalize_project_dir(dir);
        let actual = meta
            .project_dir
            .as_deref()
            .map(normalize_project_dir)
            .unwrap_or_default();
        if wanted != actual {
            return false;
        }
    }
    if !scope.project_dirs.is_empty() {
        let actual = meta
            .project_dir
            .as_deref()
            .map(normalize_project_dir)
            .unwrap_or_default();
        if !scope
            .project_dirs
            .iter()
            .any(|dir| normalize_project_dir(dir) == actual)
        {
            return false;
        }
    }
    if !scope.source_providers.is_empty()
        && !scope
            .source_providers
            .iter()
            .any(|p| p == &meta.provider_id)
    {
        return false;
    }
    true
}

/// 候选源会话：排除目标自身、排除由同步生成的会话、排除无目录会话，
/// 按目录 + 来源限量。
fn collect_candidates(
    all: &[SessionMeta],
    target_provider: &str,
    scope: &SyncScope,
    generated: &HashSet<(String, String)>,
) -> Vec<SessionMeta> {
    let now = now_ms();
    let mut by_bucket: BTreeMap<(String, String), Vec<SessionMeta>> = BTreeMap::new();
    for meta in all {
        if meta.provider_id == target_provider {
            continue;
        }
        if !writers::is_readable_source(&meta.provider_id) {
            continue;
        }
        if generated.contains(&(meta.provider_id.clone(), meta.session_id.clone())) {
            continue;
        }
        let Some(dir) = meta.project_dir.as_deref() else {
            continue;
        };
        let dir = normalize_project_dir(dir);
        if dir.is_empty() {
            continue;
        }
        if !session_matches_scope(meta, scope, now) {
            continue;
        }
        by_bucket
            .entry((dir, meta.provider_id.clone()))
            .or_default()
            .push(meta.clone());
    }

    let limit = scope.max_per_directory.unwrap_or(usize::MAX);
    let mut out = Vec::new();
    for (_, mut bucket) in by_bucket {
        bucket.sort_by(|a, b| {
            let a_ts = a.last_active_at.or(a.created_at).unwrap_or(0);
            let b_ts = b.last_active_at.or(b.created_at).unwrap_or(0);
            b_ts.cmp(&a_ts)
        });
        bucket.truncate(limit);
        out.extend(bucket);
    }
    out
}

fn generated_set(links: &[SessionSyncLink]) -> HashSet<(String, String)> {
    links
        .iter()
        .map(|l| (l.target_provider.clone(), l.target_session_id.clone()))
        .collect()
}

fn link_map(links: &[SessionSyncLink]) -> HashMap<(String, String, String), SessionSyncLink> {
    links
        .iter()
        .map(|l| {
            (
                (
                    l.source_provider.clone(),
                    l.source_session_id.clone(),
                    l.target_provider.clone(),
                ),
                l.clone(),
            )
        })
        .collect()
}

/// 源会话指纹：文件大小 + 最后活跃时间。SQLite 源用 source_path 的
/// `sqlite:` 前缀，无文件可测，退化为最后活跃时间 + 会话 ID。
pub fn source_fingerprint(meta: &SessionMeta) -> String {
    let size = meta
        .source_path
        .as_deref()
        .filter(|p| !p.starts_with("sqlite:"))
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    let ts = meta.last_active_at.or(meta.created_at).unwrap_or(0);
    format!("{size}:{ts}")
}

/// 清洗后的轮次数，按 (provider, session, 源指纹) 缓存在进程内：
/// 启动前检测会反复调用，源未变时不再重读文件。读取失败返回 None。
fn cached_turn_count(meta: &SessionMeta, fingerprint: &str) -> Option<usize> {
    use std::sync::{Mutex, OnceLock};
    /// (provider, session) → (源指纹, 轮次数)
    type TurnCache = HashMap<(String, String), (String, usize)>;
    static CACHE: OnceLock<Mutex<TurnCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = (meta.provider_id.clone(), meta.session_id.clone());
    if let Ok(guard) = cache.lock() {
        if let Some((fp, turns)) = guard.get(&key) {
            if fp == fingerprint {
                return Some(*turns);
            }
        }
    }
    let path = meta.source_path.as_deref()?;
    let messages = session_manager::load_messages(&meta.provider_id, path).ok()?;
    let turns = canonical::from_messages(meta, &messages).turns.len();
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, (fingerprint.to_string(), turns));
    }
    Some(turns)
}

/// 检测某目标客户端的待同步会话（不写任何文件）。
pub fn check_pending(
    db: &Database,
    target_provider: &str,
    scope: &SyncScope,
) -> Result<PendingSummary, String> {
    writers::writer_for(target_provider)?;
    let all = session_manager::scan_sessions();
    let links = db.list_session_sync_links().map_err(|e| e.to_string())?;
    Ok(summarize_pending(&all, &links, target_provider, scope))
}

fn summarize_pending(
    all: &[SessionMeta],
    links: &[SessionSyncLink],
    target_provider: &str,
    scope: &SyncScope,
) -> PendingSummary {
    let generated = generated_set(links);
    let link_map = link_map(links);
    let candidates = collect_candidates(all, target_provider, scope, &generated);
    let min_turns = scope.min_turns.unwrap_or(DEFAULT_MIN_TURNS);

    let mut dirs: BTreeMap<String, BTreeMap<String, PendingSource>> = BTreeMap::new();
    for meta in candidates {
        let dir = normalize_project_dir(meta.project_dir.as_deref().unwrap_or_default());
        let key = (
            meta.provider_id.clone(),
            meta.session_id.clone(),
            target_provider.to_string(),
        );
        let fingerprint = source_fingerprint(&meta);
        let (pending, diverged) = match link_map.get(&key) {
            None => (1, 0),
            Some(link) if link.status == SYNC_STATUS_DIVERGED => (0, 1),
            Some(link) if link.source_fingerprint != fingerprint => (1, 0),
            Some(_) => (0, 0),
        };
        if pending == 0 && diverged == 0 {
            continue;
        }
        if pending == 1 && min_turns > 0 && meta.source_path.is_some() {
            match cached_turn_count(&meta, &fingerprint) {
                Some(turns) if turns >= min_turns => {}
                _ => continue,
            }
        }
        let entry = dirs
            .entry(dir)
            .or_default()
            .entry(meta.provider_id.clone())
            .or_insert_with(|| PendingSource {
                source_provider: meta.provider_id.clone(),
                pending: 0,
                diverged: 0,
            });
        entry.pending += pending;
        entry.diverged += diverged;
    }

    let mut directories = Vec::new();
    let mut total = 0;
    for (dir, sources) in dirs {
        let sources: Vec<PendingSource> = sources.into_values().collect();
        let dir_total: usize = sources.iter().map(|s| s.pending).sum();
        if dir_total == 0 && sources.iter().all(|s| s.diverged == 0) {
            continue;
        }
        total += dir_total;
        let label = Path::new(&dir)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.clone());
        directories.push(PendingDirectory {
            project_dir: dir,
            label,
            sources,
            total: dir_total,
        });
    }
    directories.sort_by(|a, b| b.total.cmp(&a.total).then(a.label.cmp(&b.label)));

    PendingSummary {
        target_provider: target_provider.to_string(),
        directories,
        total,
    }
}

/// 启动前检测：遵守总开关与"不再提醒"，只返回确有待同步内容的目录。
/// 目标客户端不支持写入时返回空结果而非报错，调用方可无条件调用。
pub fn check_before_launch(
    db: &Database,
    target_provider: &str,
    project_dir: Option<&str>,
) -> Result<PendingSummary, String> {
    let empty = PendingSummary {
        target_provider: target_provider.to_string(),
        directories: Vec::new(),
        total: 0,
    };
    if writers::writer_for(target_provider).is_err() {
        return Ok(empty);
    }
    let prefs = prefs::load(db);
    if !prefs.prompt_on_launch {
        return Ok(empty);
    }
    let scope = SyncScope {
        project_dir: project_dir
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_string),
        ..SyncScope::default()
    };
    let mut summary = check_pending(db, target_provider, &scope)?;
    summary
        .directories
        .retain(|dir| dir.total > 0 && !prefs.is_muted(target_provider, &dir.project_dir));
    summary.total = summary.directories.iter().map(|d| d.total).sum();
    Ok(summary)
}

/// 执行同步：把范围内的源会话写入目标客户端，并更新账本。
pub fn run_sync(
    db: &Database,
    target_provider: &str,
    scope: &SyncScope,
) -> Result<SyncOutcome, String> {
    let writer = writers::writer_for(target_provider)?;
    let all = session_manager::scan_sessions();
    let links = db.list_session_sync_links().map_err(|e| e.to_string())?;
    ledger::snapshot_ledger(&links)?;
    let generated = generated_set(&links);
    let link_map = link_map(&links);
    let candidates = collect_candidates(&all, target_provider, scope, &generated);
    let min_turns = scope.min_turns.unwrap_or(DEFAULT_MIN_TURNS);

    let mut outcome = SyncOutcome {
        target_provider: target_provider.to_string(),
        ..Default::default()
    };
    let mut written: Vec<TargetRef> = Vec::new();

    for meta in candidates {
        let key = (
            meta.provider_id.clone(),
            meta.session_id.clone(),
            target_provider.to_string(),
        );
        let fingerprint = source_fingerprint(&meta);
        let existing = link_map.get(&key);

        if let Some(link) = existing {
            if link.status == SYNC_STATUS_DIVERGED {
                outcome.skipped_diverged += 1;
                continue;
            }
            if link.source_fingerprint == fingerprint {
                outcome.skipped_unchanged += 1;
                continue;
            }
            // 源有更新：目标若已被续聊则标记分叉，不覆盖。
            let target_ref = TargetRef {
                session_id: link.target_session_id.clone(),
                path: link.target_ref.clone(),
            };
            let current = writer.fingerprint(&target_ref);
            if current.as_deref() != Some(link.target_fingerprint.as_str()) {
                if let Err(e) = db.mark_session_sync_link_diverged(
                    &link.source_provider,
                    &link.source_session_id,
                    &link.target_provider,
                ) {
                    outcome.errors.push(e.to_string());
                }
                outcome.skipped_diverged += 1;
                continue;
            }
        }

        let Some(path) = meta.source_path.as_deref() else {
            continue;
        };
        let messages = match session_manager::load_messages(&meta.provider_id, path) {
            Ok(m) => m,
            Err(e) => {
                outcome.failed += 1;
                outcome
                    .errors
                    .push(format!("{}:{}: {e}", meta.provider_id, meta.session_id));
                continue;
            }
        };
        let mut canonical = canonical::from_messages(&meta, &messages);
        if canonical.turns.len() < min_turns {
            continue;
        }
        canonical.project_dir = normalize_project_dir(&canonical.project_dir);
        let target_id =
            derive_target_session_id(&meta.provider_id, &meta.session_id, target_provider);

        match writer.write(&canonical, &target_id) {
            Ok(target_ref) => {
                let target_fingerprint = writer.fingerprint(&target_ref).unwrap_or_default();
                let link = SessionSyncLink {
                    source_provider: meta.provider_id.clone(),
                    source_session_id: meta.session_id.clone(),
                    target_provider: target_provider.to_string(),
                    target_session_id: target_ref.session_id.clone(),
                    target_ref: target_ref.path.clone(),
                    source_fingerprint: fingerprint,
                    target_fingerprint,
                    status: SYNC_STATUS_SYNCED.to_string(),
                    synced_at: now_ms(),
                };
                if let Err(e) = db.upsert_session_sync_link(&link) {
                    outcome.errors.push(e.to_string());
                    outcome.failed += 1;
                    continue;
                }
                if existing.is_some() {
                    outcome.updated += 1;
                } else {
                    outcome.synced += 1;
                }
                written.push(target_ref);
            }
            Err(e) => {
                outcome.failed += 1;
                outcome
                    .errors
                    .push(format!("{}:{}: {e}", meta.provider_id, meta.session_id));
            }
        }
    }

    if !written.is_empty() && !cfg!(test) {
        writer.after_batch(&written);
    }
    Ok(outcome)
}

/// 撤销一次同步：目标未被续聊则删除目标文件；已续聊只解除链接。
pub fn undo_sync(
    db: &Database,
    target_provider: &str,
    target_session_id: &str,
) -> Result<bool, String> {
    let writer = writers::writer_for(target_provider)?;
    let links = db.list_session_sync_links().map_err(|e| e.to_string())?;
    let Some(link) = links
        .iter()
        .find(|l| l.target_provider == target_provider && l.target_session_id == target_session_id)
    else {
        return Err("No sync record found for this session".to_string());
    };
    ledger::snapshot_ledger(&links)?;
    let target_ref = TargetRef {
        session_id: link.target_session_id.clone(),
        path: link.target_ref.clone(),
    };
    let mut removed = false;
    if writer.fingerprint(&target_ref).as_deref() == Some(link.target_fingerprint.as_str()) {
        writer.remove(&target_ref)?;
        removed = true;
    }
    db.delete_session_sync_link(
        &link.source_provider,
        &link.source_session_id,
        &link.target_provider,
    )
    .map_err(|e| e.to_string())?;
    Ok(removed)
}

/// 会话页用：每条会话的来源与已同步目标。
pub fn list_states(db: &Database) -> Result<Vec<SessionSyncState>, String> {
    let links = db.list_session_sync_links().map_err(|e| e.to_string())?;
    let mut by_source: BTreeMap<(String, String), SessionSyncState> = BTreeMap::new();
    let mut by_target: BTreeMap<(String, String), SessionSyncState> = BTreeMap::new();
    for link in &links {
        by_source
            .entry((link.source_provider.clone(), link.source_session_id.clone()))
            .or_insert_with(|| SessionSyncState {
                provider_id: link.source_provider.clone(),
                session_id: link.source_session_id.clone(),
                origin_provider: None,
                origin_session_id: None,
                synced_to: Vec::new(),
            })
            .synced_to
            .push(SyncedTarget {
                target_provider: link.target_provider.clone(),
                target_session_id: link.target_session_id.clone(),
                status: link.status.clone(),
                synced_at: link.synced_at,
            });
        by_target.insert(
            (link.target_provider.clone(), link.target_session_id.clone()),
            SessionSyncState {
                provider_id: link.target_provider.clone(),
                session_id: link.target_session_id.clone(),
                origin_provider: Some(link.source_provider.clone()),
                origin_session_id: Some(link.source_session_id.clone()),
                synced_to: Vec::new(),
            },
        );
    }
    let mut out: Vec<SessionSyncState> = by_source.into_values().collect();
    out.extend(by_target.into_values());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(provider: &str, id: &str, dir: &str, ts: i64) -> SessionMeta {
        SessionMeta {
            provider_id: provider.to_string(),
            session_id: id.to_string(),
            title: None,
            summary: None,
            project_dir: Some(dir.to_string()),
            created_at: Some(ts),
            last_active_at: Some(ts),
            source_path: None,
            resume_command: None,
        }
    }

    #[test]
    fn target_id_is_deterministic_and_direction_specific() {
        let a = derive_target_session_id("codex", "s1", "claude");
        let b = derive_target_session_id("codex", "s1", "claude");
        let c = derive_target_session_id("codex", "s1", "gemini");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(Uuid::parse_str(&a).is_ok());
    }

    #[test]
    fn normalize_strips_trailing_slash() {
        assert_eq!(
            normalize_project_dir("/nonexistent/dir/"),
            "/nonexistent/dir"
        );
        assert_eq!(normalize_project_dir("/"), "/");
        assert_eq!(normalize_project_dir("  "), "");
    }

    #[test]
    fn candidates_exclude_target_generated_and_dirless() {
        let now = now_ms();
        let all = vec![
            meta("codex", "c1", "/p/a", now),
            meta("claude", "k1", "/p/a", now),
            meta("codex", "gen", "/p/a", now),
            SessionMeta {
                project_dir: None,
                ..meta("codex", "nodir", "/p/a", now)
            },
            meta("codex", "old", "/p/a", now - 400 * 24 * 3600 * 1000),
        ];
        let mut generated = HashSet::new();
        generated.insert(("codex".to_string(), "gen".to_string()));
        let out = collect_candidates(&all, "claude", &SyncScope::default(), &generated);
        let ids: Vec<&str> = out.iter().map(|m| m.session_id.as_str()).collect();
        assert_eq!(ids, vec!["c1"]);
    }

    #[test]
    fn pending_summary_counts_new_changed_and_diverged() {
        let now = now_ms();
        let all = vec![
            meta("codex", "new", "/p/a", now),
            meta("codex", "same", "/p/a", now),
            meta("codex", "changed", "/p/a", now),
            meta("codex", "div", "/p/b", now),
        ];
        let links = vec![
            SessionSyncLink {
                source_provider: "codex".into(),
                source_session_id: "same".into(),
                target_provider: "claude".into(),
                target_session_id: "t".into(),
                target_ref: String::new(),
                source_fingerprint: source_fingerprint(&all[1]),
                target_fingerprint: String::new(),
                status: SYNC_STATUS_SYNCED.into(),
                synced_at: now,
            },
            SessionSyncLink {
                source_provider: "codex".into(),
                source_session_id: "changed".into(),
                target_provider: "claude".into(),
                target_session_id: "t2".into(),
                target_ref: String::new(),
                source_fingerprint: "0:0".into(),
                target_fingerprint: String::new(),
                status: SYNC_STATUS_SYNCED.into(),
                synced_at: now,
            },
            SessionSyncLink {
                source_provider: "codex".into(),
                source_session_id: "div".into(),
                target_provider: "claude".into(),
                target_session_id: "t3".into(),
                target_ref: String::new(),
                source_fingerprint: "0:0".into(),
                target_fingerprint: String::new(),
                status: SYNC_STATUS_DIVERGED.into(),
                synced_at: now,
            },
        ];
        let scope = SyncScope {
            min_turns: Some(0),
            ..SyncScope::default()
        };
        let summary = summarize_pending(&all, &links, "claude", &scope);
        assert_eq!(summary.total, 2);
        let a = summary
            .directories
            .iter()
            .find(|d| d.project_dir == "/p/a")
            .unwrap();
        assert_eq!(a.sources[0].pending, 2);
        let b = summary
            .directories
            .iter()
            .find(|d| d.project_dir == "/p/b")
            .unwrap();
        assert_eq!(b.total, 0);
        assert_eq!(b.sources[0].diverged, 1);
    }
}

#[cfg(test)]
mod e2e_tests {
    //! 在隔离 HOME 下验证 Codex → Claude Code 与 Claude Code → Codex 的完整链路。
    use super::*;
    use serial_test::serial;

    struct Home {
        dir: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
    }

    impl Home {
        fn path(&self) -> &Path {
            self.dir.path()
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            match &self.previous {
                Some(v) => std::env::set_var("YUANHENG_SWITCH_TEST_HOME", v),
                None => std::env::remove_var("YUANHENG_SWITCH_TEST_HOME"),
            }
        }
    }

    fn setup_home() -> Home {
        let previous = std::env::var_os("YUANHENG_SWITCH_TEST_HOME");
        let dir = tempfile::tempdir().expect("home");
        std::env::set_var("YUANHENG_SWITCH_TEST_HOME", dir.path());
        Home { dir, previous }
    }

    fn write_codex_source(home: &Path, project: &Path) -> PathBuf {
        let dir = home.join(".codex/sessions/2026/11/01");
        std::fs::create_dir_all(&dir).unwrap();
        let path =
            dir.join("rollout-2026-11-01T10-00-00-0199aaaa-0000-7000-8000-000000000001.jsonl");
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
        std::fs::write(
            &path,
            format!(
                "{{\"timestamp\":\"{now}\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"0199aaaa-0000-7000-8000-000000000001\",\"cwd\":\"{}\"}}}}\n\
                 {{\"timestamp\":\"{now}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions for x\"}}]}}}}\n\
                 {{\"timestamp\":\"{now}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"暗号是蓝色大象\"}}]}}}}\n\
                 {{\"timestamp\":\"{now}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"记住了\"}}]}}}}\n",
                project.display()
            ),
        )
        .unwrap();
        path
    }

    #[test]
    #[serial]
    fn codex_to_claude_roundtrip_is_idempotent_and_undoable() {
        let home = setup_home();
        let project = home.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let source = write_codex_source(home.path(), &project);
        let db = Database::memory().expect("db");

        let pending = check_pending(&db, "claude", &SyncScope::default()).unwrap();
        assert_eq!(pending.total, 1, "{pending:?}");
        assert_eq!(pending.directories[0].sources[0].source_provider, "codex");

        let out = run_sync(&db, "claude", &SyncScope::default()).unwrap();
        assert_eq!(out.synced, 1, "{out:?}");
        let links = db.list_session_sync_links().unwrap();
        let target = PathBuf::from(&links[0].target_ref);
        assert!(target.starts_with(home.path().join(".claude/projects")));
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(text.contains("暗号是蓝色大象"));
        assert!(!text.contains("AGENTS.md"));

        // 同步结果被 Claude 扫描器识别，且不会被当成源回传
        let claude_sessions: Vec<_> = crate::session_manager::scan_sessions()
            .into_iter()
            .filter(|s| s.provider_id == "claude")
            .collect();
        assert_eq!(claude_sessions.len(), 1);
        assert_eq!(
            claude_sessions[0].title.as_deref().unwrap_or(""),
            "[Codex] 暗号是蓝色大象"
        );
        assert_eq!(
            check_pending(&db, "codex", &SyncScope::default())
                .unwrap()
                .total,
            0
        );

        // 幂等
        assert_eq!(
            check_pending(&db, "claude", &SyncScope::default())
                .unwrap()
                .total,
            0
        );
        let again = run_sync(&db, "claude", &SyncScope::default()).unwrap();
        assert_eq!(again.synced + again.updated, 0);

        // 源文件从未被修改
        assert!(std::fs::read_to_string(&source)
            .unwrap()
            .contains("# AGENTS.md"));

        // 目标被续聊 → 源更新后标记分叉而非覆盖
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&target)
            .unwrap();
        use std::io::Write;
        writeln!(
            f,
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"续聊\"}}}}"
        )
        .unwrap();
        let mut s = std::fs::OpenOptions::new()
            .append(true)
            .open(&source)
            .unwrap();
        writeln!(s, "{{\"timestamp\":\"2099-01-01T00:00:00Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"新问题\"}}]}}}}").unwrap();
        let diverged = run_sync(&db, "claude", &SyncScope::default()).unwrap();
        assert_eq!(diverged.skipped_diverged, 1, "{diverged:?}");
        assert!(std::fs::read_to_string(&target).unwrap().contains("续聊"));

        // 已续聊的撤销只解除链接，不删文件
        let removed = undo_sync(&db, "claude", &links[0].target_session_id).unwrap();
        assert!(!removed);
        assert!(target.exists());
        assert!(db.list_session_sync_links().unwrap().is_empty());
    }

    #[test]
    #[serial]
    fn launch_check_respects_prompt_switch_mutes_and_directory() {
        let home = setup_home();
        let project = home.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        write_codex_source(home.path(), &project);
        let db = Database::memory().expect("db");
        let dir = project.to_string_lossy().to_string();

        let found = check_before_launch(&db, "claude", Some(&dir)).unwrap();
        assert_eq!(found.total, 1);
        assert_eq!(
            check_before_launch(&db, "claude", Some("/elsewhere"))
                .unwrap()
                .total,
            0
        );
        assert_eq!(check_before_launch(&db, "claude", None).unwrap().total, 1);
        // 不支持写入的目标静默返回空
        assert_eq!(
            check_before_launch(&db, "openclaw", Some(&dir))
                .unwrap()
                .total,
            0
        );

        // 只同步弹窗里列出的目录
        let scoped = run_sync(
            &db,
            "claude",
            &SyncScope {
                project_dirs: vec!["/elsewhere".into()],
                ..SyncScope::default()
            },
        )
        .unwrap();
        assert_eq!(scoped.synced, 0);

        prefs::mute(&db, "claude", &[dir.clone()]).unwrap();
        assert_eq!(
            check_before_launch(&db, "claude", Some(&dir))
                .unwrap()
                .total,
            0
        );
        assert_eq!(
            check_before_launch(&db, "codex", Some(&dir)).unwrap().total,
            0
        );

        let mut p = prefs::load(&db);
        p.muted.clear();
        p.prompt_on_launch = false;
        prefs::save(&db, &p).unwrap();
        assert_eq!(
            check_before_launch(&db, "claude", Some(&dir))
                .unwrap()
                .total,
            0
        );
        // 关闭询问后手动检测仍然可用
        assert_eq!(
            check_pending(&db, "claude", &SyncScope::default())
                .unwrap()
                .total,
            1
        );
    }

    #[test]
    #[serial]
    fn codex_to_gemini_is_scanned_back_as_a_gemini_session() {
        let home = setup_home();
        let project = home.path().join("proj-g");
        std::fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        write_codex_source(home.path(), &project);
        let db = Database::memory().expect("db");

        let out = run_sync(&db, "gemini", &SyncScope::default()).unwrap();
        assert_eq!(out.synced, 1, "{out:?}");
        let gemini: Vec<_> = crate::session_manager::scan_sessions()
            .into_iter()
            .filter(|s| s.provider_id == "gemini")
            .collect();
        assert_eq!(gemini.len(), 1);
        assert_eq!(
            gemini[0].project_dir.as_deref().map(str::trim),
            Some(project.to_string_lossy().as_ref())
        );
        let marker = home.path().join(".gemini/tmp/proj-g/.project_root");
        assert!(marker.exists());
        // 生成的 Gemini 会话不回传给其他客户端
        assert_eq!(
            check_pending(&db, "claude", &SyncScope::default())
                .unwrap()
                .total,
            1
        );
        assert!(undo_sync(&db, "gemini", &gemini[0].session_id).unwrap());
        assert!(crate::session_manager::scan_sessions()
            .iter()
            .all(|s| s.provider_id != "gemini"));
    }

    #[test]
    #[serial]
    fn claude_to_codex_writes_resumable_rollout_and_undo_deletes() {
        let home = setup_home();
        let project = home.path().join("proj2");
        std::fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let dir = home
            .path()
            .join(".claude/projects")
            .join(writers::claude::encode_project_dir(
                &project.to_string_lossy(),
            ));
        std::fs::create_dir_all(&dir).unwrap();
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
        std::fs::write(
            dir.join("5b1f0000-0000-4000-8000-000000000002.jsonl"),
            format!(
                "{{\"type\":\"user\",\"sessionId\":\"5b1f0000-0000-4000-8000-000000000002\",\"cwd\":\"{p}\",\"timestamp\":\"{now}\",\"message\":{{\"role\":\"user\",\"content\":\"红色狐狸\"}}}}\n\
                 {{\"type\":\"assistant\",\"sessionId\":\"5b1f0000-0000-4000-8000-000000000002\",\"cwd\":\"{p}\",\"timestamp\":\"{now}\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"好\"}}]}}}}\n",
                p = project.display()
            ),
        )
        .unwrap();
        let db = Database::memory().expect("db");
        let out = run_sync(&db, "codex", &SyncScope::default()).unwrap();
        assert_eq!(out.synced, 1, "{out:?}");
        let codex: Vec<_> = crate::session_manager::scan_sessions()
            .into_iter()
            .filter(|s| s.provider_id == "codex")
            .collect();
        assert_eq!(codex.len(), 1);
        assert_eq!(
            codex[0].project_dir.as_deref(),
            Some(project.to_string_lossy().as_ref())
        );
        let target_id = codex[0].session_id.clone();
        assert!(undo_sync(&db, "codex", &target_id).unwrap());
        assert!(crate::session_manager::scan_sessions()
            .iter()
            .all(|s| s.provider_id != "codex"));
    }
}

#[cfg(test)]
mod live_probe {
    //! 手动探针：`SYNC_PROBE_OUT=<dir> SYNC_PROBE_CWD=<cwd> cargo test --lib live_probe -- --ignored`
    //! 把两个写适配器的真实输出写到指定目录，供人工用真实客户端 resume 验证。
    use super::*;

    #[test]
    #[ignore]
    fn render_probe_files() {
        let out = PathBuf::from(std::env::var("SYNC_PROBE_OUT").expect("SYNC_PROBE_OUT"));
        let cwd = std::env::var("SYNC_PROBE_CWD").expect("SYNC_PROBE_CWD");
        let session = |origin: &str, secret: &str| CanonicalSession {
            origin_provider: origin.into(),
            origin_session_id: "probe".into(),
            project_dir: cwd.clone(),
            title: "同步探针".into(),
            created_at: chrono::Utc::now().timestamp_millis() - 60_000,
            updated_at: chrono::Utc::now().timestamp_millis(),
            turns: vec![
                CanonicalTurn {
                    role: "user".into(),
                    text: format!("我们的暗号是：{secret}。记住它。"),
                    ts: None,
                },
                CanonicalTurn {
                    role: "assistant".into(),
                    text: format!("好的，暗号「{secret}」已记住。"),
                    ts: None,
                },
            ],
        };
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(
            out.join("claude.jsonl"),
            writers::claude::render(
                &session("codex", "紫色企鹅"),
                "0d9c5a7e-1111-5222-8333-444455556666",
            ),
        )
        .unwrap();
        let gemini_session = session("codex", "蓝色鲸鱼");
        let gemini_dir =
            writers::gemini::resolve_project_dir(&out.join("gemini-tmp"), &cwd).unwrap();
        std::fs::create_dir_all(gemini_dir.join("chats")).unwrap();
        std::fs::write(
            gemini_dir.join("chats").join(writers::gemini::file_name(
                gemini_session.created_at,
                "0d9c5a7e-2222-5333-8444-555566667777",
            )),
            writers::gemini::render(&gemini_session, "0d9c5a7e-2222-5333-8444-555566667777"),
        )
        .unwrap();
        std::fs::write(
            out.join("codex.jsonl"),
            writers::codex::render(
                &session("claude", "绿色海豚"),
                "0d9c5a7e-aaaa-5bbb-8ccc-ddddeeeeffff",
                &writers::codex::active_model_provider(),
            ),
        )
        .unwrap();
    }
}

#[cfg(test)]
mod perf_probe {
    //! 手动测量：`cargo test --release --lib perf_probe -- --ignored --nocapture`
    //! 只读真实 HOME，内存账本，不写任何文件。
    use super::*;

    #[test]
    #[ignore]
    fn measure_check_pending_on_real_home() {
        let db = Database::memory().expect("db");
        for target in ["claude", "codex"] {
            let start = std::time::Instant::now();
            let summary = check_pending(&db, target, &SyncScope::default()).unwrap();
            println!(
                "target={target} total={} dirs={} elapsed={:?}",
                summary.total,
                summary.directories.len(),
                start.elapsed()
            );
        }
        let start = std::time::Instant::now();
        let warm = check_pending(&db, "claude", &SyncScope::default()).unwrap();
        println!(
            "warm claude total={} elapsed={:?}",
            warm.total,
            start.elapsed()
        );
        let start = std::time::Instant::now();
        let all = session_manager::scan_sessions();
        println!("scan_sessions={} elapsed={:?}", all.len(), start.elapsed());
    }
}

#[cfg(test)]
mod install_probe {
    //! 手动验收：`SYNC_E2E_HOME=<隔离HOME> SYNC_E2E_CWD=<项目> cargo test --lib install_probe -- --ignored`
    //! 在隔离 HOME 里放一份 Codex 会话，用真实 `run_sync` 同步到 Gemini 与 Grok Build，
    //! 之后由脚本调用已安装的 gemini / grok 续聊验收。
    use super::*;

    #[test]
    #[ignore]
    fn sync_codex_session_into_installed_clients() {
        let home = PathBuf::from(std::env::var("SYNC_E2E_HOME").expect("SYNC_E2E_HOME"));
        let cwd = std::env::var("SYNC_E2E_CWD").expect("SYNC_E2E_CWD");
        std::env::set_var("YUANHENG_SWITCH_TEST_HOME", &home);
        let dir = home.join(".codex/sessions/2026/11/03");
        std::fs::create_dir_all(&dir).unwrap();
        let id = "0199bbbb-0000-7000-8000-0000000000e2";
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
        std::fs::write(
            dir.join(format!("rollout-2026-11-03T10-00-00-{id}.jsonl")),
            format!(
                "{{\"timestamp\":\"{now}\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"{cwd}\"}}}}\n\
                 {{\"timestamp\":\"{now}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions for x\"}}]}}}}\n\
                 {{\"timestamp\":\"{now}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"我们的暗号是：紫色山峰。记住它。\"}}]}}}}\n\
                 {{\"timestamp\":\"{now}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"好的，已记住。\"}}]}}}}\n"
            ),
        )
        .unwrap();
        // 先放一份 Claude Code 会话，供同步到 Codex
        let claude_dir = home
            .join(".claude/projects")
            .join(writers::claude::encode_project_dir(&cwd));
        std::fs::create_dir_all(&claude_dir).unwrap();
        let cid = "5b1f0000-0000-4000-8000-0000000000e3";
        std::fs::write(
            claude_dir.join(format!("{cid}.jsonl")),
            format!(
                "{{\"type\":\"user\",\"sessionId\":\"{cid}\",\"cwd\":\"{cwd}\",\"timestamp\":\"{now}\",\"message\":{{\"role\":\"user\",\"content\":\"我们的暗号是：黄色彩虹。记住它。\"}}}}\n\
                 {{\"type\":\"assistant\",\"sessionId\":\"{cid}\",\"cwd\":\"{cwd}\",\"timestamp\":\"{now}\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"好的，已记住。\"}}]}}}}\n"
            ),
        )
        .unwrap();
        let db = Database::memory().unwrap();
        let targets: Vec<String> = std::env::var("SYNC_E2E_TARGETS")
            .unwrap_or_else(|_| "gemini,grokbuild".into())
            .split(',')
            .map(str::to_string)
            .collect();
        for target in &targets {
            let out = run_sync(&db, target, &SyncScope::default()).unwrap();
            println!(
                "{target}: synced={} failed={} errors={:?}",
                out.synced, out.failed, out.errors
            );
            if target == "codex" {
                let ids: Vec<String> = db
                    .list_session_sync_links()
                    .unwrap()
                    .into_iter()
                    .filter(|l| l.target_provider == "codex")
                    .map(|l| l.target_session_id)
                    .collect();
                println!(
                    "codex registered={}",
                    writers::codex::register_threads(&ids)
                );
            }
        }
        for link in db.list_session_sync_links().unwrap() {
            println!(
                "TARGET {} {} {}",
                link.target_provider, link.target_session_id, link.target_ref
            );
        }
    }
}
