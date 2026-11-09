//! Explicit recovery of local sidebar metadata saved under an inactive login.
//! Never restore account atoms, credentials, cloud projects or conversation content.
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::Write, path::Path, sync::Mutex};
static REPAIR_LOCK: Mutex<()> = Mutex::new(());
const PROJECTS: &str = "local-projects";
const ASSIGNMENTS: &str = "thread-project-assignments";
const ORDER: &str = "project-order";
const HOSTS: &str = "thread-project-membership-host-ids";
const MIGRATION: &str = "app-server-project-id-by-legacy-project-id-by-host";
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProjectMapRepairResult {
    pub projects_found: usize,
    pub projects_restored: usize,
    pub assignments_restored: usize,
    pub backup_path: Option<String>,
    pub blocked_reason: Option<String>,
    pub fingerprint: String,
    pub applied: bool,
}
pub fn codex_desktop_running() -> bool {
    #[cfg(unix)]
    {
        let Ok(out) = std::process::Command::new("ps")
            .args(["-axo", "comm"])
            .output()
        else {
            return true;
        };
        if !out.status.success() {
            return true;
        }
        String::from_utf8_lossy(&out.stdout).lines().any(|line| {
            let name = Path::new(line.trim())
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            matches!(name, "ChatGPT" | "Codex" | "codex" | "chatgpt")
                || name.starts_with("Codex (")
                || name.starts_with("Codex Helper")
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let Ok(out) = std::process::Command::new("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .creation_flags(0x08000000)
            .output()
        else {
            return true;
        };
        if !out.status.success() {
            return true;
        }
        String::from_utf8_lossy(&out.stdout).lines().any(|line| {
            let name = line
                .split(',')
                .next()
                .unwrap_or("")
                .trim_matches('"')
                .to_ascii_lowercase();
            matches!(name.as_str(), "chatgpt.exe" | "codex.exe")
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}
fn object<'a>(v: &'a Value, key: &str) -> Result<&'a Map<String, Value>, String> {
    v.get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Codex {key} 格式不受支持，未修改文件"))
}
fn map_mut<'a>(v: &'a mut Value, key: &str) -> Result<&'a mut Map<String, Value>, String> {
    v.as_object_mut()
        .ok_or("Codex 状态不是对象")?
        .entry(key)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("Codex {key} 格式异常"))
}
fn roots(v: &Value) -> Result<Vec<String>, String> {
    let values = v
        .get("rootPaths")
        .and_then(Value::as_array)
        .ok_or("项目目录格式异常")?;
    if values.is_empty() {
        return Err("项目没有目录".into());
    }
    let mut result = Vec::new();
    for value in values {
        let path = value.as_str().ok_or("项目目录不是字符串")?;
        if !Path::new(path).is_absolute() {
            return Err("项目目录不是绝对路径".into());
        }
        result.push(path.to_owned());
    }
    result.sort();
    result.dedup();
    Ok(result)
}
fn merge(state: &Value) -> Result<(Value, CodexProjectMapRepairResult), String> {
    let current = object(state, PROJECTS)?;
    object(state, ASSIGNMENTS)?;
    for key in [HOSTS, MIGRATION] {
        if state.get(key).is_some_and(|v| !v.is_object()) {
            return Err(format!("当前 {key} 格式异常"));
        }
    }
    if state
        .get("projectless-thread-ids")
        .is_some_and(|v| !v.is_array())
    {
        return Err("未分配会话列表格式异常".into());
    }

    let inactive = state
        .pointer("/electron-account-renderer-state-v1/inactive")
        .and_then(Value::as_object)
        .ok_or("没有找到历史登录保存的本地项目，请先确认使用原账号；未修改文件")?;
    let sources: Vec<&Value> = inactive
        .values()
        .filter_map(|v| v.get("globals"))
        .filter(|g| {
            g.get(PROJECTS)
                .and_then(Value::as_object)
                .is_some_and(|p| !p.is_empty())
        })
        .collect();
    if sources.len() != 1 {
        return Err(
            "历史登录的本地项目来源不唯一或不存在，无法自动选择；请使用原账号查看项目".into(),
        );
    }
    let source = sources[0];
    let saved = object(source, PROJECTS)?;
    let mut output = state.clone();
    let mut aliases = HashMap::new();
    let mut result = CodexProjectMapRepairResult {
        projects_found: saved.len(),
        ..Default::default()
    };
    for (id, project) in saved {
        if project.get("id").and_then(Value::as_str) != Some(id)
            || !project.get("name").is_some_and(Value::is_string)
        {
            return Err("历史项目格式异常".into());
        }
        let saved_roots = roots(project)?;
        if let Some(existing) = current.get(id) {
            if roots(existing)? != saved_roots {
                return Err("同一项目 ID 对应不同目录，停止恢复".into());
            }
            aliases.insert(id.clone(), id.clone());
            continue;
        }
        // Same folder does not imply same project: preserve core IDs and chat ownership.
        map_mut(&mut output, PROJECTS)?.insert(id.clone(), project.clone());
        aliases.insert(id.clone(), id.clone());
        result.projects_restored += 1;
    }

    let source_order = source
        .get(ORDER)
        .and_then(Value::as_array)
        .ok_or("历史项目顺序格式异常")?;
    let order = output
        .get_mut(ORDER)
        .and_then(Value::as_array_mut)
        .ok_or("当前项目顺序格式异常")?;
    for id in source_order {
        let target = aliases
            .get(id.as_str().ok_or("项目顺序 ID 无效")?)
            .ok_or("历史项目顺序引用不存在的项目")?;
        let value = Value::String(target.clone());
        if !order.contains(&value) {
            order.push(value);
        }
    }
    for id in saved.keys() {
        let value = Value::String(aliases[id].clone());
        if !order.contains(&value) {
            order.push(value);
        }
    }
    let projectless = state
        .get("projectless-thread-ids")
        .and_then(Value::as_array);
    let source_hosts = source.get(HOSTS).and_then(Value::as_object);
    for (thread, assignment) in object(source, ASSIGNMENTS)? {
        if assignment.get("projectKind").and_then(Value::as_str) != Some("local") {
            continue;
        }
        if source_hosts
            .and_then(|h| h.get(thread))
            .and_then(Value::as_str)
            .is_some_and(|h| h != "local")
        {
            continue;
        }
        if state
            .get(HOSTS)
            .and_then(Value::as_object)
            .and_then(|h| h.get(thread))
            .and_then(Value::as_str)
            .is_some_and(|h| h != "local")
        {
            continue;
        }
        if projectless.is_some_and(|ids| ids.contains(&Value::String(thread.clone()))) {
            continue;
        }
        if map_mut(&mut output, ASSIGNMENTS)?.contains_key(thread) {
            continue;
        }
        let Some(target) = assignment
            .get("projectId")
            .and_then(Value::as_str)
            .and_then(|id| aliases.get(id))
        else {
            continue;
        };
        let mut restored = assignment.clone();
        restored["projectId"] = json!(target);
        map_mut(&mut output, ASSIGNMENTS)?.insert(thread.clone(), restored);
        if let Some(host) = source_hosts.and_then(|h| h.get(thread)) {
            map_mut(&mut output, HOSTS)?
                .entry(thread.clone())
                .or_insert_with(|| host.clone());
        }
        result.assignments_restored += 1;
    }
    // Preserve core IDs and migration flags, avoiding duplicate DB projects.
    if let Some(host_maps) = source.get(MIGRATION).and_then(Value::as_object) {
        for (host, mapping) in host_maps {
            if !host.starts_with("local:") {
                continue;
            }
            let entries = mapping.as_object().ok_or("项目迁移映射格式异常")?;
            let destination = map_mut(&mut output, MIGRATION)?
                .entry(host.clone())
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("当前迁移映射格式异常")?;
            for (id, core_id) in entries {
                if let Some(target) = aliases.get(id) {
                    destination
                        .entry(target.clone())
                        .or_insert_with(|| core_id.clone());
                }
            }
        }
    }
    Ok((output, result))
}
pub fn repair_codex_project_map(
    expected: Option<String>,
) -> Result<CodexProjectMapRepairResult, String> {
    let _guard = REPAIR_LOCK.lock().map_err(|_| "项目恢复锁不可用")?;
    repair_at(
        &crate::codex_config::get_codex_config_dir().join(".codex-global-state.json"),
        expected.as_deref(),
        codex_desktop_running,
    )
}
fn repair_at(
    file: &Path,
    expected: Option<&str>,
    running: impl Fn() -> bool,
) -> Result<CodexProjectMapRepairResult, String> {
    let metadata = std::fs::symlink_metadata(file).map_err(|e| format!("读取项目状态失败: {e}"))?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
        return Err("项目状态文件类型或大小不受支持".into());
    }
    let original = std::fs::read(file).map_err(|e| e.to_string())?;
    let state: Value =
        serde_json::from_slice(&original).map_err(|_| "项目状态 JSON 损坏，未修改文件")?;
    let (merged, mut result) = merge(&state)?;
    result.fingerprint = format!("{:x}", Sha256::digest(&original));
    if running() {
        result.blocked_reason =
            Some("请先完全退出 ChatGPT/Codex 及 Codex CLI，再恢复本地项目列表".into());
    }
    let Some(expected) = expected else {
        return Ok(result);
    };
    if result.blocked_reason.is_some() {
        return Ok(result);
    }
    if expected != result.fingerprint {
        return Err("项目状态已变化，请重新检查后恢复".into());
    }
    if merged == state {
        return Ok(result);
    }
    let parent = file.parent().ok_or("项目状态目录无效")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut temporary, &merged).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    if running() || std::fs::read(file).map_err(|e| e.to_string())? != original {
        return Err("客户端已启动或项目状态已变化，未写入；请重新检查".into());
    }
    let backup = file.with_file_name(format!(
        ".codex-global-state.json.yuanheng-backup-{}.bak",
        uuid::Uuid::new_v4()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut backup_file = options.open(&backup).map_err(|e| e.to_string())?;
    backup_file
        .write_all(&original)
        .and_then(|_| backup_file.sync_all())
        .map_err(|e| e.to_string())?;
    temporary
        .persist(file)
        .map_err(|e| format!("恢复写入失败，备份位于 {}: {e}", backup.display()))?;
    #[cfg(unix)]
    if let Ok(directory) = std::fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    result.backup_path = Some(backup.display().to_string());
    result.applied = true;
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        let mut fixture = json!({
        "local-projects":{"current":{"id":"current","name":"current","rootPaths":["/a"]}},
        "project-order":["current"], "thread-project-assignments":{"keep":{"projectKind":"cloud","projectId":"cloud"}},
        "projectless-thread-ids":["unassigned"], "unrelated":{"kept":true},
        "electron-account-renderer-state-v1":{"owner":null,"inactive":{"old":{"globals":{
            "local-projects":{"a":{"id":"a","name":"A","rootPaths":["/a"]},"b":{"id":"b","name":"B","rootPaths":["/b"]}},
            "project-order":["a","b"],
            "thread-project-assignments":{"keep":{"projectKind":"local","projectId":"a"},"restore":{"projectKind":"local","projectId":"a"},"unassigned":{"projectKind":"local","projectId":"b"},"remote":{"projectKind":"local","projectId":"b"}},
            "thread-project-membership-host-ids":{"remote":"ssh-host","restore":"local"},
            "app-server-project-id-by-legacy-project-id-by-host":{"local:/home":{"a":"core-a","b":"core-b"}}
        },"atoms":{"onboarding":true}}}}});
        let root = std::env::temp_dir();
        fixture[PROJECTS]["current"]["rootPaths"] = json!([root.join("a")]);
        let saved =
            &mut fixture["electron-account-renderer-state-v1"]["inactive"]["old"]["globals"];
        saved[PROJECTS]["a"]["rootPaths"] = json!([root.join("a")]);
        saved[PROJECTS]["b"]["rootPaths"] = json!([root.join("b")]);
        fixture
    }
    #[test]
    fn preserves_current_and_saved_account_and_restores_exact_membership() {
        let state = fixture();
        let (merged, r) = merge(&state).unwrap();
        assert_eq!(r.projects_restored, 2);
        assert_eq!(r.assignments_restored, 1);
        assert_eq!(merged[ASSIGNMENTS]["restore"]["projectId"], "a");
        assert_eq!(merged[ASSIGNMENTS]["keep"], state[ASSIGNMENTS]["keep"]);
        assert!(merged[ASSIGNMENTS].get("remote").is_none());
        assert!(merged[ASSIGNMENTS].get("unassigned").is_none());
        assert_eq!(
            merged["electron-account-renderer-state-v1"],
            state["electron-account-renderer-state-v1"]
        );
        assert_eq!(merged["unrelated"], state["unrelated"]);
        assert_eq!(merge(&merged).unwrap().0, merged);
    }
    #[test]
    fn refuses_changed_file_and_late_start_without_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let original = serde_json::to_vec(&fixture()).unwrap();
        std::fs::write(&path, &original).unwrap();
        let preview = repair_at(&path, None, || false).unwrap();
        let calls = std::cell::Cell::new(0);
        let error = repair_at(&path, Some(&preview.fingerprint), || {
            calls.set(calls.get() + 1);
            calls.get() > 1
        });
        assert!(error.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        let calls = std::cell::Cell::new(0);
        let error = repair_at(&path, Some(&preview.fingerprint), || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                std::fs::write(&path, b"external change").unwrap();
            }
            false
        });
        assert!(error.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"external change");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn refuses_ambiguous_source_and_malformed_state() {
        let mut state = fixture();
        state["electron-account-renderer-state-v1"]["inactive"]["other"] =
            state["electron-account-renderer-state-v1"]["inactive"]["old"].clone();
        assert!(merge(&state).is_err());
        let mut state = fixture();
        state[ORDER] = Value::Null;
        assert!(merge(&state).is_err());
    }
    #[test]
    fn preview_running_and_stale_requests_do_not_write_then_backup_and_restore() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let original = serde_json::to_vec(&fixture()).unwrap();
        std::fs::write(&path, &original).unwrap();
        let preview = repair_at(&path, None, || true).unwrap();
        assert!(preview.blocked_reason.is_some());
        assert!(
            !repair_at(&path, Some(&preview.fingerprint), || true)
                .unwrap()
                .applied
        );
        assert!(repair_at(&path, Some("stale"), || false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        let result = repair_at(&path, Some(&preview.fingerprint), || false).unwrap();
        assert!(result.applied);
        assert_eq!(
            std::fs::read(result.backup_path.unwrap()).unwrap(),
            original
        );
        let preview = repair_at(&path, None, || false).unwrap();
        assert!(
            !repair_at(&path, Some(&preview.fingerprint), || false)
                .unwrap()
                .applied
        );
    }
}
