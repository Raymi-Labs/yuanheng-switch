//! 项目（工作区）分组的跨客户端同步。
//!
//! 会话同步只搬聊天内容；这里搬"这些聊天属于哪个项目、项目叫什么、排在第几"。
//! 来源目前是 Codex Desktop 的项目，目标目前是 DSH 的工作区。两边都以"项目目录"为身份：
//! Codex 的项目对应一个或多个根目录，DSH 的工作区对应一个目录。

pub mod codex_source;
pub mod dsh_target;

use serde::{Deserialize, Serialize};

/// 一个来源项目：名称、排序与它覆盖的根目录（已规范化）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceProject {
    pub source_provider: String,
    pub name: String,
    pub position: i64,
    pub roots: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSyncOutcome {
    pub target_provider: String,
    /// 新建的项目分组数
    pub created: usize,
    /// 已存在、只补上会话或改了名称的分组数
    pub updated: usize,
    /// 归入分组的会话数
    pub sessions_attached: usize,
    /// 因目录不存在等原因跳过的项目名
    pub skipped: Vec<String>,
    /// 未执行时的原因（例如目标客户端正在运行）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
}

/// 当前支持的项目分组同步方向：(来源客户端, 目标客户端)。
pub fn supported(source: &str, target: &str) -> bool {
    matches!((source, target), ("codex", "dsh"))
}

/// 读取来源客户端的项目分组。
pub fn read_source_projects(source: &str) -> Vec<SourceProject> {
    match source {
        "codex" => codex_source::read_projects(),
        _ => Vec::new(),
    }
}

/// 预览：来源有多少项目、目标里还缺多少（不写任何文件）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSyncPreview {
    pub source_provider: String,
    pub target_provider: String,
    pub source_projects: usize,
    /// 目标里还没有对应分组、或分组名仍是默认目录名的项目数
    pub missing: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
}

pub fn preview(source: &str, target: &str) -> Result<ProjectSyncPreview, String> {
    if !supported(source, target) {
        return Err(format!("暂不支持把 {source} 的项目同步到 {target}"));
    }
    let projects = read_source_projects(source);
    let mut preview = ProjectSyncPreview {
        source_provider: source.into(),
        target_provider: target.into(),
        source_projects: projects.len(),
        ..Default::default()
    };
    if projects.is_empty() {
        return Ok(preview);
    }
    let file = dsh_target::workspace_file();
    let mut doc = match std::fs::read_to_string(&file) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("DSH 工作区文件无法解析: {e}"))?
        }
        Err(_) => serde_json::json!({
            "unit": {"name": "workspace", "version": 2},
            "global": {"initialized": true, "workspaceIds": []},
            "tables": {"workspaces": {}},
        }),
    };
    let exists = |p: &str| std::path::Path::new(p).is_dir();
    let mut ids = || String::from("preview");
    let outcome = dsh_target::merge(
        &mut doc,
        &projects,
        &std::collections::HashMap::new(),
        &exists,
        &mut ids,
    );
    preview.missing = outcome.created + outcome.updated;
    if dsh_target::dsh_running() {
        preview.blocked_reason = Some("DSH 正在运行，请先退出 DSH 再同步项目分组".into());
    }
    Ok(preview)
}

/// 执行项目分组同步。
pub fn sync(source: &str, target: &str) -> Result<ProjectSyncOutcome, String> {
    if !supported(source, target) {
        return Err(format!("暂不支持把 {source} 的项目同步到 {target}"));
    }
    let projects = read_source_projects(source);
    dsh_target::sync_projects(&projects)
}

/// 启动目标客户端前检查是否有项目分组要带过去：遵守总开关与"不再提醒"，
/// 目标客户端正在运行（写不进去）时也不打扰。任何错误都当作"没有"。
pub fn preview_before_launch(
    db: &crate::database::Database,
    target: &str,
) -> Option<ProjectSyncPreview> {
    let source = match target {
        "dsh" => "codex",
        _ => return None,
    };
    let prefs = crate::session_sync::prefs::load(db);
    if !prefs.prompt_on_launch || prefs.muted_project_targets.iter().any(|t| t == target) {
        return None;
    }
    let preview = preview(source, target).ok()?;
    (preview.missing > 0 && preview.blocked_reason.is_none()).then_some(preview)
}
