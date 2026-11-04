//! 把项目分组写成 DSH 的工作区：`$DSH_HOME/storages/workspace.json`。
//!
//! 格式与约束取自 DSH 0.2.1 自带的 `dsh-workspace` / `dsh-storage-json` 源码（2026-11-03）：
//! - 文件是 `{unit:{name:"workspace",version:2}, global:{...}, tables:{workspaces:{id:record}}}`，
//!   记录为 `{path, title, sessionIds, createdAt, updatedAt}`，`path` 必须是 realpath 后的目录。
//! - 启动校验（`validateStoredState`）：`workspaceIds` 不重复且都在表里；`initialized` 为真时
//!   表里的每条都要在 `workspaceIds` 里；同一路径只能有一个工作区；同一会话只能属于一个工作区。
//!   违反任何一条 DSH 会拒绝启动，因此写入前在内存里完整复核。
//! - 会话归属只认会话头里的 `cwd`：成员必须与工作区目录一致，否则 DSH 会过滤掉它。
//! - DSH 运行时把该文件常驻内存并整体重写，所以 **DSH 在运行时不写**，避免被覆盖或互相踩踏。
//! - 写法与 DSH 一致：同目录临时文件 → fsync → rename → fsync 目录。

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::{ProjectSyncOutcome, SourceProject};
use crate::session_manager::providers::dsh::{read_events, sessions_root, LOG_FILENAME};
use crate::session_sync::normalize_project_dir;

const UNIT_NAME: &str = "workspace";
const UNIT_VERSION: i64 = 2;

pub fn workspace_file() -> PathBuf {
    crate::commands::dsh_install::home()
        .join("storages")
        .join("workspace.json")
}

/// DSH 桌面版或其命令行是否在运行（任一宿主进程都会持有并改写工作区文件）。
pub fn dsh_running() -> bool {
    #[cfg(unix)]
    {
        let Ok(out) = std::process::Command::new("ps")
            .args(["-axo", "command"])
            .output()
        else {
            // 无法判断时按"正在运行"处理，宁可不写
            return true;
        };
        String::from_utf8_lossy(&out.stdout).lines().any(|line| {
            line.contains("DeepSeek Harness.app/Contents/MacOS/")
                || line.contains("dsh-desktop-host/lib/cli.js")
        })
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// 扫描 DSH 会话头，得到 会话 id → 规范化后的 cwd。
pub fn session_cwds(root: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(projects) = std::fs::read_dir(root) else {
        return out;
    };
    for project in projects.flatten() {
        let Ok(dirs) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for dir in dirs.flatten() {
            let log = dir.path().join(LOG_FILENAME);
            let Ok(events) = read_events(&log) else {
                continue;
            };
            let Some(header) = events.first() else {
                continue;
            };
            let (Some(id), Some(cwd)) = (
                header.get("id").and_then(Value::as_str),
                header.get("cwd").and_then(Value::as_str),
            ) else {
                continue;
            };
            out.insert(id.to_string(), normalize_project_dir(cwd));
        }
    }
    out
}

fn empty_document() -> Value {
    json!({
        "unit": {"name": UNIT_NAME, "version": UNIT_VERSION},
        "global": {"initialized": true, "workspaceIds": [], "archivedSessionIds": [], "pinnedSessionIds": []},
        "tables": {"workspaces": {}},
    })
}

fn load_document(path: &Path) -> Result<Value, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_document()),
        Err(e) => return Err(format!("读取 DSH 工作区失败: {e}")),
    };
    let doc: Value =
        serde_json::from_str(&text).map_err(|e| format!("DSH 工作区文件无法解析: {e}"))?;
    let unit = doc.get("unit");
    if unit.and_then(|u| u.get("name")).and_then(Value::as_str) != Some(UNIT_NAME)
        || unit.and_then(|u| u.get("version")).and_then(Value::as_i64) != Some(UNIT_VERSION)
    {
        return Err("DSH 工作区文件版本不是已知的 v2，为安全起见不改动".into());
    }
    if doc
        .get("global")
        .and_then(|g| g.get("pendingMutation"))
        .is_some_and(|p| !p.is_null())
    {
        return Err("DSH 有一次未完成的工作区修改，请先打开 DSH 让它自行恢复".into());
    }
    Ok(doc)
}

fn iso_now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn str_array(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 复核 DSH 启动时会检查的全部不变量；返回第一条违反的描述。
pub fn validate(doc: &Value) -> Result<(), String> {
    let global = doc.get("global").ok_or("缺少 global")?;
    let table = doc
        .get("tables")
        .and_then(|t| t.get("workspaces"))
        .and_then(Value::as_object)
        .ok_or("缺少 workspaces 表")?;
    let order = str_array(global.get("workspaceIds"));
    let mut seen = HashSet::new();
    for id in &order {
        if !seen.insert(id.clone()) {
            return Err(format!("工作区顺序重复 {id}"));
        }
        if !table.contains_key(id) {
            return Err(format!("工作区顺序引用了不存在的 {id}"));
        }
    }
    if global.get("initialized").and_then(Value::as_bool) == Some(true) && seen.len() != table.len()
    {
        return Err("有工作区不在显示顺序里".into());
    }
    let mut paths = HashSet::new();
    let mut accounted = HashSet::new();
    for record in table.values() {
        let path = record
            .get("path")
            .and_then(Value::as_str)
            .ok_or("工作区缺少 path")?;
        if !paths.insert(path.to_string()) {
            return Err(format!("目录 {path} 被多个工作区占用"));
        }
        for sid in str_array(record.get("sessionIds")) {
            if !accounted.insert(sid.clone()) {
                return Err(format!("会话 {sid} 同时属于多个工作区"));
            }
        }
        for key in ["title", "createdAt", "updatedAt"] {
            if record.get(key).and_then(Value::as_str).is_none() {
                return Err(format!("工作区缺少 {key}"));
            }
        }
    }
    Ok(())
}

/// 纯函数：把来源项目合并进 DSH 工作区文档。
///
/// - 每个来源项目的每个根目录对应一个 DSH 工作区（DSH 一个工作区只能对应一个目录）。
///   多根项目的工作区命名为"项目名 · 目录名"，单根项目直接用项目名。
/// - 目录已有工作区：保留它，只补上该目录下尚未归属任何工作区的会话；用户在 DSH 里改过名字不覆盖，
///   仍是 DSH 默认名（目录名）时改成 Codex 的项目名。
/// - 目录在本机不存在则跳过（DSH 要求工作区目录存在）。
/// - 新建的工作区按 Codex 项目顺序排在已有工作区前面。
pub fn merge(
    doc: &mut Value,
    projects: &[SourceProject],
    session_cwd: &HashMap<String, String>,
    dir_exists: &dyn Fn(&str) -> bool,
    new_id: &mut dyn FnMut() -> String,
) -> ProjectSyncOutcome {
    let mut outcome = ProjectSyncOutcome {
        target_provider: "dsh".into(),
        ..Default::default()
    };
    let now = iso_now();
    let doc_obj = doc.as_object_mut().expect("document object");
    let tables = doc_obj
        .entry("tables")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("tables object");
    let table = tables
        .entry("workspaces")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("workspaces object")
        .clone();
    let mut table: Map<String, Value> = table;

    let mut by_path: HashMap<String, String> = HashMap::new();
    let mut accounted: HashSet<String> = HashSet::new();
    for (id, record) in &table {
        if let Some(p) = record.get("path").and_then(Value::as_str) {
            by_path.insert(p.to_string(), id.clone());
        }
        accounted.extend(str_array(record.get("sessionIds")));
    }

    let mut created_ids: Vec<String> = Vec::new();
    // 本轮已命名过的目录：同一目录被多个项目引用时，只由第一个处理它的项目命名。
    let mut named: HashSet<String> = HashSet::new();
    // 先处理每个项目的主目录，再处理附加目录：某目录若是某个项目自己的主目录，就用那个项目的名字，
    // 不会因为另一个项目把它列为附加目录而变成"别的项目 · 目录名"。
    let mut slots: Vec<(&SourceProject, &String)> = projects
        .iter()
        .filter_map(|p| p.roots.first().map(|root| (p, root)))
        .collect();
    for project in projects {
        slots.extend(project.roots.iter().skip(1).map(|root| (project, root)));
    }
    for (project, root) in slots {
        let multi_root = project.roots.len() > 1;
        {
            let dir_name = Path::new(root)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| root.clone());
            if !dir_exists(root) {
                outcome.skipped.push(project.name.clone());
                continue;
            }
            let title = if multi_root && dir_name != project.name {
                format!("{} · {dir_name}", project.name)
            } else {
                project.name.clone()
            };
            let mut members: Vec<String> = session_cwd
                .iter()
                .filter(|(sid, cwd)| *cwd == root && !accounted.contains(*sid))
                .map(|(sid, _)| sid.clone())
                .collect();
            members.sort();

            let first_claim = named.insert(root.clone());
            match by_path.get(root).cloned() {
                Some(id) => {
                    let record = table
                        .get_mut(&id)
                        .and_then(Value::as_object_mut)
                        .expect("record");
                    let mut changed = false;
                    let current_title = record.get("title").and_then(Value::as_str).unwrap_or("");
                    if first_claim && current_title == dir_name && title != dir_name {
                        record.insert("title".into(), json!(title));
                        changed = true;
                    }
                    if !members.is_empty() {
                        let mut ids = str_array(record.get("sessionIds"));
                        ids.extend(members.iter().cloned());
                        record.insert("sessionIds".into(), json!(ids));
                        outcome.sessions_attached += members.len();
                        changed = true;
                    }
                    if changed {
                        record.insert("updatedAt".into(), json!(now));
                        outcome.updated += 1;
                    }
                }
                None => {
                    let id = new_id();
                    table.insert(
                        id.clone(),
                        json!({
                            "path": root,
                            "title": title,
                            "sessionIds": members,
                            "createdAt": now,
                            "updatedAt": now,
                        }),
                    );
                    by_path.insert(root.clone(), id.clone());
                    outcome.sessions_attached += members.len();
                    outcome.created += 1;
                    created_ids.push(id);
                }
            }
            accounted.extend(members);
        }
    }
    // 再补一遍：任何已有工作区，都收下目录相同、尚未归属的会话（与 DSH 首次启动时的归组规则一致），
    // 这样同步过来的聊天即使不属于 Codex 项目，也会进入 DSH 里同目录的工作区。
    let mut extra: Vec<(String, Vec<String>)> = Vec::new();
    for (id, record) in &table {
        let Some(path) = record.get("path").and_then(Value::as_str) else {
            continue;
        };
        let mut loose: Vec<String> = session_cwd
            .iter()
            .filter(|(sid, cwd)| cwd.as_str() == path && !accounted.contains(*sid))
            .map(|(sid, _)| sid.clone())
            .collect();
        if loose.is_empty() {
            continue;
        }
        loose.sort();
        accounted.extend(loose.iter().cloned());
        extra.push((id.clone(), loose));
    }
    for (id, loose) in extra {
        if let Some(record) = table.get_mut(&id).and_then(Value::as_object_mut) {
            let mut ids = str_array(record.get("sessionIds"));
            outcome.sessions_attached += loose.len();
            ids.extend(loose);
            record.insert("sessionIds".into(), json!(ids));
            record.insert("updatedAt".into(), json!(now));
            if !created_ids.contains(&id) {
                outcome.updated += 1;
            }
        }
    }

    outcome.skipped.sort();
    outcome.skipped.dedup();

    tables.insert("workspaces".into(), Value::Object(table));
    let global = doc_obj
        .entry("global")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("global object");
    let mut order = created_ids;
    order.extend(str_array(global.get("workspaceIds")));
    global.insert("workspaceIds".into(), json!(order));
    global.insert("initialized".into(), json!(true));
    for key in ["archivedSessionIds", "pinnedSessionIds"] {
        global.entry(key).or_insert_with(|| json!([]));
    }
    outcome
}

/// 与 DSH `writeAtomic` 一致的整文件替换。
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("无效的工作区路径")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建 DSH 存储目录失败: {e}"))?;
    let tmp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(|e: String| format!("写入 DSH 工作区失败: {e}"))
}

/// 把来源项目写成 DSH 工作区。DSH 运行时不写，直接返回原因。
pub fn sync_projects(projects: &[SourceProject]) -> Result<ProjectSyncOutcome, String> {
    if dsh_running() {
        return Ok(ProjectSyncOutcome {
            target_provider: "dsh".into(),
            blocked_reason: Some("DSH 正在运行，请先退出 DSH 再同步项目分组".into()),
            ..Default::default()
        });
    }
    sync_projects_unchecked(&workspace_file(), &sessions_root(), projects)
}

pub fn sync_projects_unchecked(
    file: &Path,
    sessions: &Path,
    projects: &[SourceProject],
) -> Result<ProjectSyncOutcome, String> {
    let mut doc = load_document(file)?;
    validate(&doc).map_err(|e| format!("DSH 现有工作区数据不一致，为安全起见不改动: {e}"))?;
    let original = doc.clone();
    let cwds = session_cwds(sessions);
    let exists = |p: &str| Path::new(p).is_dir();
    let mut ids = || uuid::Uuid::new_v4().to_string();
    let outcome = merge(&mut doc, projects, &cwds, &exists, &mut ids);
    validate(&doc).map_err(|e| format!("生成的 DSH 工作区未通过校验，已放弃写入: {e}"))?;
    if doc != original {
        backup(file)?;
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?
        );
        write_atomic(file, &text)?;
    }
    Ok(outcome)
}

/// 改动前把原文件备份到 Meta API 的备份目录，保留最近 20 份。
fn backup(file: &Path) -> Result<(), String> {
    if !file.exists() {
        return Ok(());
    }
    let dir = crate::config::get_app_config_dir()
        .join("backups")
        .join("dsh-workspace");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    std::fs::copy(file, dir.join(format!("workspace-{stamp}.json")))
        .map_err(|e| format!("备份 DSH 工作区失败: {e}"))?;
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    entries.sort();
    while entries.len() > 20 {
        let _ = std::fs::remove_file(entries.remove(0));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, pos: i64, roots: &[&str]) -> SourceProject {
        SourceProject {
            source_provider: "codex".into(),
            name: name.into(),
            position: pos,
            roots: roots.iter().map(|r| r.to_string()).collect(),
        }
    }

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("ws-{n}")
        }
    }

    #[test]
    fn creates_workspaces_in_project_order_and_attaches_matching_sessions() {
        let mut doc = empty_document();
        let cwds: HashMap<String, String> = [
            ("s1".to_string(), "/w/api".to_string()),
            ("s2".to_string(), "/w/web".to_string()),
            ("s3".to_string(), "/w/other".to_string()),
        ]
        .into();
        let projects = vec![
            project("前端", 0, &["/w/web"]),
            project("后端", 1, &["/w/api"]),
        ];
        let out = merge(&mut doc, &projects, &cwds, &|_| true, &mut ids());
        assert_eq!(out.created, 2);
        assert_eq!(out.sessions_attached, 2);
        validate(&doc).unwrap();
        assert_eq!(doc["global"]["workspaceIds"], json!(["ws-1", "ws-2"]));
        assert_eq!(doc["tables"]["workspaces"]["ws-1"]["title"], "前端");
        assert_eq!(
            doc["tables"]["workspaces"]["ws-1"]["sessionIds"],
            json!(["s2"])
        );
        assert_eq!(
            doc["tables"]["workspaces"]["ws-2"]["sessionIds"],
            json!(["s1"])
        );
    }

    #[test]
    fn keeps_existing_workspace_and_user_titles_and_never_double_accounts() {
        let mut doc = empty_document();
        doc["tables"]["workspaces"]["old"] = json!({
            "path": "/w/api", "title": "我改过的名字", "sessionIds": ["s1"],
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"
        });
        doc["tables"]["workspaces"]["dflt"] = json!({
            "path": "/w/web", "title": "web", "sessionIds": [],
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"
        });
        doc["global"]["workspaceIds"] = json!(["old", "dflt"]);
        let cwds: HashMap<String, String> = [
            ("s1".to_string(), "/w/api".to_string()),
            ("s9".to_string(), "/w/api".to_string()),
        ]
        .into();
        let projects = vec![
            project("后端", 0, &["/w/api"]),
            project("前端", 1, &["/w/web"]),
        ];
        let out = merge(&mut doc, &projects, &cwds, &|_| true, &mut ids());
        validate(&doc).unwrap();
        assert_eq!(out.created, 0);
        assert_eq!(out.updated, 2);
        let old = &doc["tables"]["workspaces"]["old"];
        assert_eq!(old["title"], "我改过的名字");
        assert_eq!(old["sessionIds"], json!(["s1", "s9"]));
        assert_eq!(doc["tables"]["workspaces"]["dflt"]["title"], "前端");
        // 再跑一次不应有任何变化
        let before = doc.clone();
        let again = merge(&mut doc, &projects, &cwds, &|_| true, &mut ids());
        assert_eq!(again.created + again.updated, 0);
        assert_eq!(doc["tables"], before["tables"]);
    }

    #[test]
    fn multi_root_projects_get_one_workspace_per_directory_and_missing_dirs_are_skipped() {
        let mut doc = empty_document();
        let projects = vec![project(
            "Xboard",
            0,
            &["/w/Xboard", "/w/yuanheng", "/w/gone"],
        )];
        let out = merge(
            &mut doc,
            &projects,
            &HashMap::new(),
            &|p| p != "/w/gone",
            &mut ids(),
        );
        validate(&doc).unwrap();
        assert_eq!(out.created, 2);
        assert_eq!(out.skipped, vec!["Xboard".to_string()]);
        assert_eq!(doc["tables"]["workspaces"]["ws-1"]["title"], "Xboard");
        assert_eq!(
            doc["tables"]["workspaces"]["ws-2"]["title"],
            "Xboard · yuanheng"
        );
    }

    #[test]
    fn a_directory_claimed_by_two_projects_maps_to_one_workspace() {
        let mut doc = empty_document();
        let projects = vec![
            project("yuanheng", 0, &["/w/y"]),
            project("Xboard", 1, &["/w/x", "/w/y"]),
        ];
        let out = merge(&mut doc, &projects, &HashMap::new(), &|_| true, &mut ids());
        validate(&doc).unwrap();
        assert_eq!(out.created, 2);
        let titles: Vec<&str> = doc["tables"]["workspaces"]
            .as_object()
            .unwrap()
            .values()
            .map(|r| r["title"].as_str().unwrap())
            .collect();
        // 共享目录 /w/y 是 yuanheng 的主目录，沿用 yuanheng；
        // Xboard 有两个目录，它独占的 /w/x 与项目名不同，命名为"Xboard · x"
        assert!(titles.contains(&"yuanheng"));
        assert!(titles.contains(&"Xboard · x"));
    }

    #[test]
    fn loose_sessions_join_an_existing_workspace_for_their_directory() {
        let mut doc = empty_document();
        doc["tables"]["workspaces"]["mine"] = json!({
            "path": "/w/notes", "title": "笔记", "sessionIds": [],
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"
        });
        doc["global"]["workspaceIds"] = json!(["mine"]);
        let cwds: HashMap<String, String> = [("synced".to_string(), "/w/notes".to_string())].into();
        let out = merge(&mut doc, &[], &cwds, &|_| true, &mut ids());
        validate(&doc).unwrap();
        assert_eq!(out.sessions_attached, 1);
        assert_eq!(
            doc["tables"]["workspaces"]["mine"]["sessionIds"],
            json!(["synced"])
        );
    }

    #[test]
    fn a_projects_own_main_folder_keeps_that_projects_name() {
        // 真实情况：Xboard 排在前面且把 yuanheng 列为附加目录，yuanheng 自己也是一个项目
        let mut doc = empty_document();
        let projects = vec![
            project("Xboard", 0, &["/w/Xboard", "/w/yuanheng"]),
            project("yuanheng", 1, &["/w/yuanheng"]),
        ];
        let out = merge(&mut doc, &projects, &HashMap::new(), &|_| true, &mut ids());
        validate(&doc).unwrap();
        assert_eq!(out.created, 2);
        let mut titles: Vec<String> = doc["tables"]["workspaces"]
            .as_object()
            .unwrap()
            .values()
            .map(|r| r["title"].as_str().unwrap().to_string())
            .collect();
        titles.sort();
        assert_eq!(titles, vec!["Xboard".to_string(), "yuanheng".to_string()]);
        let again = merge(&mut doc, &projects, &HashMap::new(), &|_| true, &mut ids());
        assert_eq!(again.created + again.updated, 0);
    }

    #[test]
    fn rejects_unknown_versions_and_pending_mutations() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("workspace.json");
        std::fs::write(
            &file,
            r#"{"unit":{"name":"workspace","version":3},"global":{},"tables":{}}"#,
        )
        .unwrap();
        assert!(load_document(&file).is_err());
        std::fs::write(
            &file,
            r#"{"unit":{"name":"workspace","version":2},"global":{"initialized":true,"workspaceIds":[],"pendingMutation":{"operation":"create","workspaceId":"x"}},"tables":{"workspaces":{}}}"#,
        )
        .unwrap();
        assert!(load_document(&file).is_err());
    }

    #[test]
    fn writes_atomically_and_is_idempotent_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("storages/workspace.json");
        let work = dir.path().join("proj");
        std::fs::create_dir_all(&work).unwrap();
        let work = work.canonicalize().unwrap().to_string_lossy().to_string();
        let projects = vec![project("我的项目", 0, &[&work])];
        let sessions = dir.path().join("sessions");
        let first = sync_projects_unchecked(&file, &sessions, &projects).unwrap();
        assert_eq!(first.created, 1);
        let text = std::fs::read_to_string(&file).unwrap();
        let doc: Value = serde_json::from_str(&text).unwrap();
        validate(&doc).unwrap();
        let second = sync_projects_unchecked(&file, &sessions, &projects).unwrap();
        assert_eq!(second.created + second.updated, 0);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        let leftovers: Vec<_> = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
