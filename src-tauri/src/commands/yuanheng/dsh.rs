//! DSH desktop and local Web profile integration. Only owned blocks are replaced.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const RECORD: &str = "yuanheng_dsh_configuration";
const KEY: &str = "YUANHENG_DSH_API_KEY";
const BEGIN: &str = "# BEGIN YUANHENG DSH\n";
const END: &str = "# END YUANHENG DSH\n";

#[derive(serde::Serialize, serde::Deserialize)]
struct Record {
    home: PathBuf,
    model: String,
    group: String,
    models: Vec<String>,
    hashes: Vec<String>,
    #[serde(default)]
    pending: bool,
    #[serde(default)]
    previous_hashes: Vec<Option<String>>,
}

fn home() -> PathBuf {
    crate::commands::dsh_install::home()
}

fn paths(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".credentials.yaml"),
        home.join("profiles/desktop/cordis.patch.yml"),
        home.join("profiles/web/cordis.patch.yml"),
    ]
}

fn read(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(value) => Ok(value),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(_) => Err(format!("无法读取 DSH 配置：{}", path.display())),
    }
}

fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn split(text: &str) -> Result<(String, Option<String>), String> {
    if !text.contains(BEGIN) && !text.contains(END) {
        return Ok((text.to_string(), None));
    }
    if text.matches(BEGIN).count() != 1 || text.matches(END).count() != 1 {
        return Err("DSH 托管配置标记已变化，请先恢复原配置".into());
    }
    let start = text.find(BEGIN).unwrap();
    let end = text.find(END).unwrap() + END.len();
    if end < start + BEGIN.len() {
        return Err("DSH 配置标记顺序无效".into());
    }
    Ok((
        format!("{}{}", &text[..start], &text[end..]),
        Some(text[start..end].to_string()),
    ))
}

fn block(body: &str) -> String {
    format!("{BEGIN}{body}{END}")
}

// Errors deliberately omit YAML source snippets, which may contain credentials.
fn yaml(text: &str) -> Result<serde_yaml::Value, String> {
    serde_yaml::from_str(text).map_err(|_| "DSH 配置 YAML 无法解析，原文件未更改".into())
}

fn route(model: &str) -> (&'static str, &'static str) {
    match yuanheng_model_api_format(model) {
        "anthropic" => ("yuanheng-messages", "anthropic-messages"),
        "openai_responses" => ("yuanheng-responses", "openai-responses"),
        _ => ("yuanheng-chat", "openai-completions"),
    }
}

fn profile_body(original: &str, model: &str, models: &[String]) -> Result<String, String> {
    let value = yaml(original)?;
    let rows = match &value {
        serde_yaml::Value::Null => &[][..],
        serde_yaml::Value::Sequence(rows) => rows.as_slice(),
        _ => return Err("DSH profile 必须是 YAML 列表".into()),
    };
    let mut config = json!({});
    for row in rows {
        if matches!(
            row["id"].as_str(),
            Some("credentials" | "agent-default-model")
        ) && row.get("disabled").is_some()
        {
            return Err("DSH 默认模型或凭据插件使用了自定义启停配置，无法安全自动配置".into());
        }
        if row["id"].as_str() == Some("credentials") && row.get("config").is_some() {
            return Err("DSH 使用自定义凭据存储，请保留原配置并手动接入元亨".into());
        }
        if row["id"].as_str() == Some("llm-pi-ai") {
            if row.get("disabled").is_some() || row.get("insert").is_some() {
                return Err("DSH 模型插件使用了自定义启停配置，无法安全自动配置".into());
            }
            if row.get("config").is_some() {
                config =
                    serde_json::to_value(&row["config"]).map_err(|_| "DSH 供应商配置无法合并")?;
            }
        }
    }
    if !config.is_object() {
        return Err("DSH 供应商配置不是对象".into());
    }
    if config.get("providers").is_none() {
        config["providers"] = json!({});
    }
    let providers = config["providers"]
        .as_object_mut()
        .ok_or("DSH providers 不是对象")?;
    for (name, protocol) in [
        ("yuanheng-chat", "openai-completions"),
        ("yuanheng-responses", "openai-responses"),
        ("yuanheng-messages", "anthropic-messages"),
    ] {
        if providers.contains_key(name) {
            return Err("DSH 已有同名非托管元亨供应商，请先重命名以免覆盖".into());
        }
        let catalog = models
            .iter()
            .filter(|id| route(id).0 == name)
            .map(|id| json!({"id": id, "name": id, "input": ["text"]}))
            .collect::<Vec<_>>();
        if !catalog.is_empty() {
            providers.insert(
                name.into(),
                json!({
                    "displayName": format!("元亨 API · {protocol}"), "apiKeyEnv": KEY,
                    "api": protocol, "baseURL": if protocol == "anthropic-messages" { BASE_URL } else { OPENAI_BASE_URL }, "models": catalog
                }),
            );
        }
    }
    serde_yaml::to_string(&json!([
        {"id": "llm-pi-ai", "config": config},
        {"id": "agent-default-model", "config": {"provider": route(model).0, "model": model}}
    ]))
    .map_err(|_| "生成 DSH 配置失败".into())
}

struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn lock(path: PathBuf) -> Result<Lock, String> {
    fs::create_dir_all(path.parent().ok_or("无效 DSH 路径")?)
        .map_err(|_| "无法创建 DSH 配置目录")?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "DSH 正在修改配置或存在未释放的写入锁，请稍后重试")?;
    let guard = Lock(path);
    writeln!(file, "{}", std::process::id()).map_err(|_| "写入 DSH 配置锁失败")?;
    Ok(guard)
}
fn locks(home: &Path) -> Result<Vec<Lock>, String> {
    [
        home.join(".credentials.yaml.lock"),
        home.join("profiles/desktop/package.json.lock"),
        home.join("profiles/web/package.json.lock"),
    ]
    .into_iter()
    .map(lock)
    .collect()
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("无效 DSH 配置路径")?;
    fs::create_dir_all(parent).map_err(|_| "无法创建 DSH 配置目录")?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建 DSH 临时配置")?;
    // NamedTempFile starts owner-only on Unix; never expose a temporary key file.
    file.write_all(text.as_bytes())
        .map_err(|_| "写入 DSH 临时配置失败")?;
    file.as_file().sync_all().map_err(|_| "同步 DSH 配置失败")?;
    file.persist(path).map_err(|_| "原子替换 DSH 配置失败")?;
    Ok(())
}

fn record(state: &AppState) -> Option<Record> {
    state
        .db
        .get_setting(RECORD)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn check_global(home: &Path) -> Result<(), String> {
    let value = yaml(&read(&home.join("cordis.patch.yml"))?)?;
    if value.as_sequence().is_some_and(|rows| {
        rows.iter().any(|row| {
            matches!(
                row["id"].as_str(),
                Some("llm-pi-ai" | "agent-default-model" | "credentials")
            )
        })
    }) {
        return Err("DSH 全局配置覆盖了模型或凭据，请先移除相关覆盖，再使用一键配置".into());
    }
    if std::env::var_os(KEY).is_some() {
        return Err("环境变量覆盖了 DSH 托管凭据，请先移除 YUANHENG_DSH_API_KEY 环境变量".into());
    }
    Ok(())
}

pub(super) fn configure(
    state: &AppState,
    token: &str,
    model: &str,
    models: &[String],
    group: &str,
) -> Result<YuanhengToolConfigureResult, String> {
    let home = home();
    if !home.is_absolute() {
        return Err("DSH_HOME 必须是绝对路径".into());
    }
    check_global(&home)?;
    let _locks = locks(&home)?;
    let paths = paths(&home);
    let previous = record(state);
    if previous.as_ref().is_some_and(|r| r.pending) {
        return Err("上次 DSH 配置未完成，请先恢复工具配置后重试".into());
    }
    if previous.as_ref().is_some_and(|r| r.home != home) {
        return Err("DSH 配置目录已变化，请先恢复旧目录的配置".into());
    }
    let models = terminal_catalog_models(model, models);
    let before = paths
        .iter()
        .map(|p| read(p))
        .collect::<Result<Vec<_>, _>>()?;
    let mut after = Vec::new();
    let mut hashes = Vec::new();
    for (index, text) in before.iter().enumerate() {
        let (mut original, owned) = split(text)?;
        if owned.as_ref().map(|s| digest(s))
            != previous.as_ref().and_then(|r| r.hashes.get(index)).cloned()
        {
            return Err("DSH 托管配置已被外部修改，已保留原文件；请先核对并恢复配置".into());
        }
        // Empty flow documents cannot be followed by block YAML. Preserve comments.
        let parsed_original = yaml(&original)?;
        if parsed_original.as_sequence().is_some_and(|v| v.is_empty())
            || parsed_original.as_mapping().is_some_and(|v| v.is_empty())
        {
            original = original
                .lines()
                .map(|line| {
                    if matches!(line.trim(), "[]" | "{}") {
                        format!("# {line}\n")
                    } else {
                        format!("{line}\n")
                    }
                })
                .collect();
        }
        let body = if index == 0 {
            let existing = yaml(&original)?;
            if !existing.is_null() && !existing.is_mapping() {
                return Err("DSH 凭据文件必须是 YAML 对象".into());
            }
            if existing.get(KEY).is_some() {
                return Err("DSH 已有同名非托管凭据，原文件未更改".into());
            }
            format!(
                "{KEY}: {}\n",
                serde_json::to_string(token).map_err(|_| "无效凭据")?
            )
        } else {
            profile_body(&original, model, &models)?
        };
        let managed = block(&body);
        hashes.push(digest(&managed));
        let separator = if original.is_empty() || original.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        let next = format!("{original}{separator}{managed}");
        yaml(&next)?;
        after.push(next);
    }
    let mut next_record = Record {
        home,
        model: model.into(),
        group: group.into(),
        models,
        hashes,
        pending: true,
        previous_hashes: (0..3)
            .map(|i| previous.as_ref().and_then(|r| r.hashes.get(i)).cloned())
            .collect(),
    };
    // Save ownership before writes so interrupted writes remain visible and recoverable.
    let encoded = serde_json::to_string(&next_record).map_err(|_| "保存 DSH 配置状态失败")?;
    let old_record = state.db.get_setting(RECORD).map_err(|e| e.to_string())?;
    state
        .db
        .set_setting(RECORD, &encoded)
        .map_err(|e| e.to_string())?;
    for (index, path) in paths.iter().enumerate() {
        if let Err(error) = write(path, &after[index]) {
            let mut rollback_failed = false;
            for j in 0..index {
                rollback_failed |= write(&paths[j], &before[j]).is_err();
            }
            if !rollback_failed {
                let _ = state
                    .db
                    .set_setting(RECORD, old_record.as_deref().unwrap_or(""));
            }
            return Err(if rollback_failed {
                format!("{error}；部分配置恢复失败，请检查 DSH 配置")
            } else {
                error
            });
        }
    }
    next_record.pending = false;
    next_record.previous_hashes.clear();
    state
        .db
        .set_setting(
            RECORD,
            &serde_json::to_string(&next_record).map_err(|_| "保存 DSH 状态失败")?,
        )
        .map_err(|e| e.to_string())?;
    Ok(YuanhengToolConfigureResult { app: "dsh".into(), configured: true, model: Some(model.into()),
        warnings: vec!["已同步 DSH 桌面端和本机 Web 的模型目录；默认模型用于新会话，已打开的 DSH 请重新加载。自定义 profile 或远程 Web 不在本次配置范围。".into()], error: None })
}

fn intact(r: &Record) -> bool {
    !r.pending
        && check_global(&r.home).is_ok()
        && r.hashes.len() == 3
        && paths(&r.home).iter().enumerate().all(|(i, p)| {
            read(p)
                .ok()
                .and_then(|s| split(&s).ok())
                .and_then(|(_, block)| block)
                .is_some_and(|s| digest(&s) == r.hashes[i] && effective_matches(p, &s, i))
        })
}

// A later user patch can override an unchanged managed block. Inspect the final
// config rows too; matching marker bytes alone is not proof of effective state.
fn effective_matches(path: &Path, owned: &str, index: usize) -> bool {
    let Ok(text) = read(path) else { return false };
    let (Ok(full), Ok(managed)) = (yaml(&text), yaml(owned)) else {
        return false;
    };
    if index == 0 {
        return full.get(KEY) == managed.get(KEY);
    }
    let (Some(rows), Some(expected)) = (full.as_sequence(), managed.as_sequence()) else {
        return false;
    };
    expected.iter().all(|entry| {
        if rows
            .iter()
            .any(|row| row.get("id") == entry.get("id") && row.get("disabled").is_some())
        {
            return false;
        }
        rows.iter()
            .rev()
            .find(|row| row.get("id") == entry.get("id"))
            .is_some_and(|row| {
                row.get("config") == entry.get("config") && row.get("disabled").is_none()
            })
    })
}

pub(super) fn credential(state: &AppState, group: &str) -> Result<Option<String>, String> {
    let Some(r) = record(state) else {
        return Ok(None);
    };
    if r.group != group {
        return Ok(None);
    }
    if !intact(&r) {
        return Err("DSH 配置已变化，请核对后重新配置".into());
    }
    Ok(yaml(&read(&paths(&r.home)[0])?)?[KEY]
        .as_str()
        .map(str::to_owned))
}

pub(super) fn status(
    state: &AppState,
    connection: &YuanhengConnectionStatus,
) -> YuanhengToolStatus {
    let r = record(state);
    let recommended = recommended_model(&AppType::OpenCode, &connection.models);
    let configured = r.as_ref().is_some_and(|r| {
        r.home == home()
            && intact(r)
            && connection.models.contains(&r.model)
            && cached_models_for_group(connection, Some(&r.group), Some(r.model.clone()))
                .iter()
                .all(|m| r.models.contains(m))
    });
    YuanhengToolStatus {
        app: "dsh".into(),
        supported: recommended.is_some(),
        configured,
        needs_update: r.is_some() && !configured,
        model: r.as_ref().map(|r| r.model.clone()),
        group: r.as_ref().map(|r| r.group.clone()),
        reasoning: Some("auto".into()),
        recommended_model: recommended,
        message: Some(
            if configured {
                "DSH 桌面端与本机 Web 配置已保存；可检查连接并打开客户端"
            } else {
                "配置 DSH 桌面端与本机 Web 的元亨模型"
            }
            .into(),
        ),
        runtime_warning: None,
        runtime_status: None,
    }
}

pub(super) fn restore(state: &AppState) -> Result<bool, String> {
    let Some(r) = record(state) else {
        return Ok(false);
    };
    let _locks = locks(&r.home)?;
    let paths = paths(&r.home);
    let before = paths
        .iter()
        .map(|p| read(p))
        .collect::<Result<Vec<_>, _>>()?;
    let mut originals = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let (original, owned) = split(&read(path)?)?;
        let hash = owned.as_ref().map(|s| digest(s));
        let matches_new = hash == r.hashes.get(i).cloned();
        let matches_old = r.pending && r.previous_hashes.get(i).is_some_and(|old| *old == hash);
        if !(matches_new || matches_old)
            || owned
                .as_ref()
                .is_some_and(|s| !effective_matches(path, s, i))
        {
            return Err("DSH 配置已被外部修改，保留配置及凭据，请手动核对".into());
        }
        let original = if i > 0 && yaml(&original)?.is_null() {
            format!("{original}[]\n")
        } else {
            original
        };
        originals.push(original);
    }
    // Remove references first, credentials last.
    for (step, i) in [2, 1, 0].into_iter().enumerate() {
        if let Err(error) = write(&paths[i], &originals[i]) {
            for j in [2, 1, 0].into_iter().take(step) {
                let _ = write(&paths[j], &before[j]);
            }
            return Err(error);
        }
    }
    state
        .db
        .set_setting(RECORD, "")
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_other_provider_and_rejects_collision() {
        let text =
            "- id: llm-pi-ai\n  config:\n    providers:\n      custom: {api: openai-completions}\n";
        let body = profile_body(text, "model", &["model".into(), "second".into()]).unwrap();
        let parsed = yaml(&body).unwrap();
        assert_eq!(
            parsed[0]["config"]["providers"]["custom"]["api"].as_str(),
            Some("openai-completions")
        );
        assert_eq!(
            parsed[0]["config"]["providers"]["yuanheng-chat"]["models"]
                .as_sequence()
                .unwrap()
                .len(),
            2
        );
        assert!(profile_body(&body, "model", &[]).is_err());
    }
    #[test]
    fn messages_sdk_uses_origin_while_openai_sdks_use_v1_root() {
        let body = profile_body(
            "",
            "claude-sonnet-4-6",
            &[
                "claude-sonnet-4-6".into(),
                "gpt-5.6".into(),
                "test-model".into(),
            ],
        )
        .unwrap();
        let parsed = yaml(&body).unwrap();
        let providers = &parsed[0]["config"]["providers"];
        assert_eq!(
            providers["yuanheng-messages"]["baseURL"].as_str(),
            Some(BASE_URL)
        );
        assert_eq!(
            providers["yuanheng-chat"]["baseURL"].as_str(),
            Some(OPENAI_BASE_URL)
        );
        assert_eq!(
            providers["yuanheng-responses"]["baseURL"].as_str(),
            Some(OPENAI_BASE_URL)
        );
    }

    #[test]
    fn removes_only_owned_block_and_detects_damage() {
        let original = "# user comment\n";
        let managed = block("key: value\n");
        let (rest, owned) = split(&format!("{original}{managed}# later edit\n")).unwrap();
        assert_eq!(rest, "# user comment\n# later edit\n");
        assert_eq!(owned.unwrap(), managed);
        assert!(split(BEGIN).is_err());
    }
}
