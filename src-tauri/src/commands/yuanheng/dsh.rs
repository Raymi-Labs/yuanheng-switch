//! DSH desktop and local Web integration. Only owned profiles and credential references are replaced.
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
const CLAUDE_STREAM_IDLE_TIMEOUT_MS: u64 = 600_000;
const CLAUDE_MAX_RETRIES: u64 = 1;

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

// DSH migrates flat credentials into version/refs and writes browser-session
// records to the same file. Ownership belongs to our reference, not its YAML.
fn credentials_document(text: &str) -> Result<serde_yaml::Value, String> {
    let mut value = yaml(text)?;
    if value.is_null() {
        value = yaml("version: 1\nrefs: {}\n")?;
    }
    let fields = value.as_mapping().ok_or("DSH 凭据文件必须是 YAML 对象")?;
    if !fields.contains_key(serde_yaml::Value::from("version")) {
        if !fields
            .values()
            .all(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        {
            return Err("DSH 旧凭据格式无法安全迁移，原文件未更改".into());
        }
        return Ok(serde_yaml::to_value(json!({"version": 1, "refs": value}))
            .map_err(|_| "生成 DSH 凭据失败")?);
    }
    if value["version"].as_u64() != Some(1)
        || fields
            .keys()
            .any(|k| !matches!(k.as_str(), Some("version" | "refs" | "records")))
        || value.get("refs").is_some_and(|v| {
            !v.is_mapping()
                || !v
                    .as_mapping()
                    .unwrap()
                    .values()
                    .all(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        })
        || value.get("records").is_some_and(|v| !v.is_mapping())
    {
        return Err("DSH 凭据格式无法识别，原文件未更改".into());
    }
    if value.get("refs").is_none() {
        value["refs"] = serde_yaml::Value::Mapping(Default::default());
    }
    Ok(value)
}

fn credential_hash(value: &serde_yaml::Value) -> Option<String> {
    let token = value["refs"][KEY].as_str()?;
    // Retain the original fingerprint so existing installations migrate without
    // trusting a new credential or storing another copy of its plaintext.
    Some(digest(&block(&format!(
        "{KEY}: {}\n",
        serde_json::to_string(token).ok()?
    ))))
}

fn hash_matches(r: &Record, index: usize, hash: Option<&String>) -> bool {
    hash == r.hashes.get(index)
        || (r.pending
            && r.previous_hashes
                .get(index)
                .is_some_and(|old| old.as_ref() == hash))
}

fn empty_document_comments(original: &str) -> Result<String, String> {
    let parsed = yaml(original)?;
    if parsed.as_sequence().is_some_and(|v| v.is_empty())
        || parsed.as_mapping().is_some_and(|v| v.is_empty())
    {
        return Ok(original
            .lines()
            .map(|line| {
                if matches!(line.trim(), "[]" | "{}") {
                    format!("# {line}\n")
                } else {
                    format!("{line}\n")
                }
            })
            .collect());
    }
    Ok(original.into())
}

// DSH's own settings writer reformats YAML and appends settings before our end
// comment. Prove ownership by reconstructing our original writer output. Only a
// default-model change within the recorded catalog is allowed; endpoints,
// credentials, provider options and unknown models remain protected.
fn trusted_profile(
    text: &str,
    r: &Record,
    index: usize,
) -> Result<(String, Option<String>), String> {
    let (original, owned) = split(text)?;
    if hash_matches(r, index, owned.as_ref().map(|s| digest(s)).as_ref()) {
        return Ok((original, owned));
    }
    let error = "DSH 托管供应商或默认模型已被修改，已保留配置；请核对接口和模型设置";
    let value = yaml(owned.as_deref().ok_or(error)?)?;
    let rows = value.as_sequence().ok_or(error)?;
    let mut managed = Vec::new();
    let mut extra = Vec::new();
    for row in rows {
        match row["id"].as_str() {
            Some("llm-pi-ai" | "agent-default-model") => managed.push(row.clone()),
            Some("credentials") => return Err(error.into()),
            _ => extra.push(row.clone()),
        }
    }
    if managed.len() != 2
        || managed[0]["id"].as_str() != Some("llm-pi-ai")
        || managed[1]["id"].as_str() != Some("agent-default-model")
    {
        return Err(error.into());
    }
    let actual = block(&serde_yaml::to_string(&managed).map_err(|_| error)?);
    let mut expected = managed.clone();
    let default = &mut expected[1]["config"];
    let model = default["model"].as_str().ok_or(error)?;
    if !r.models.iter().any(|known| known == model)
        || default["provider"].as_str() != Some(route(model).0)
    {
        return Err(error.into());
    }
    default["model"] = serde_yaml::Value::from(r.model.clone());
    default["provider"] = serde_yaml::Value::from(route(&r.model).0);
    let canonical = block(&serde_yaml::to_string(&expected).map_err(|_| error)?);
    if !hash_matches(r, index, Some(&digest(&actual)))
        && !hash_matches(r, index, Some(&digest(&canonical)))
    {
        return Err(error.into());
    }
    let mut original = empty_document_comments(&original)?;
    if !extra.is_empty() {
        if !original.is_empty() && !original.ends_with('\n') {
            original.push('\n');
        }
        original.push_str(&serde_yaml::to_string(&extra).map_err(|_| error)?);
    }
    Ok((original, Some(actual)))
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
            let mut provider = json!({
                "displayName": format!("元亨 API · {protocol}"), "apiKeyEnv": KEY,
                "api": protocol, "baseURL": if protocol == "anthropic-messages" { BASE_URL } else { OPENAI_BASE_URL }, "models": catalog
            });
            if protocol == "anthropic-messages" {
                provider["streamIdleTimeoutMs"] = json!(CLAUDE_STREAM_IDLE_TIMEOUT_MS);
                provider["retryPolicy"] = json!({
                    "mode": "normal", "maxRetries": CLAUDE_MAX_RETRIES
                });
            }
            providers.insert(name.into(), provider);
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
        if index == 0 {
            let mut document = credentials_document(text)?;
            let hash = credential_hash(&document);
            if hash.as_ref() != previous.as_ref().and_then(|r| r.hashes.first()) {
                return Err("DSH 托管凭据已被修改或存在同名凭据，原文件未更改".into());
            }
            document["refs"][KEY] = serde_yaml::Value::from(token);
            hashes.push(credential_hash(&document).ok_or("生成 DSH 凭据失败")?);
            after.push(serde_yaml::to_string(&document).map_err(|_| "生成 DSH 凭据失败")?);
            continue;
        }
        let (original, owned) = if let Some(r) = &previous {
            trusted_profile(text, r, index)?
        } else {
            let parts = split(text)?;
            if parts.1.is_some() {
                return Err("DSH 已有来源不明的托管配置，原文件未更改".into());
            }
            parts
        };
        if owned
            .as_ref()
            .is_some_and(|s| !effective_matches(&paths[index], s))
        {
            return Err("DSH 配置存在外部覆盖，原文件未更改".into());
        }
        let original = empty_document_comments(&original)?;
        let body = profile_body(&original, model, &models)?;
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
            let Ok(text) = read(p) else { return false };
            if i == 0 {
                return credentials_document(&text)
                    .is_ok_and(|v| credential_hash(&v).as_ref() == r.hashes.first());
            }
            trusted_profile(&text, r, i)
                .ok()
                .and_then(|(_, owned)| owned)
                .is_some_and(|s| effective_matches(p, &s))
        })
}

// A trusted legacy block can still supply credentials or be restored. Only
// tool status requires the current policy, so reapplying can migrate it safely.
fn claude_policy_current(r: &Record) -> bool {
    if !r
        .models
        .iter()
        .any(|model| route(model).0 == "yuanheng-messages")
    {
        return true;
    }
    paths(&r.home).iter().skip(1).all(|path| {
        let Ok(text) = read(path) else { return false };
        let Ok((_, Some(owned))) = split(&text) else {
            return false;
        };
        let Ok(value) = yaml(&owned) else {
            return false;
        };
        let Some(rows) = value.as_sequence() else {
            return false;
        };
        let Some(entry) = rows
            .iter()
            .find(|row| row["id"].as_str() == Some("llm-pi-ai"))
        else {
            return false;
        };
        let provider = &entry["config"]["providers"]["yuanheng-messages"];
        provider["streamIdleTimeoutMs"].as_u64() == Some(CLAUDE_STREAM_IDLE_TIMEOUT_MS)
            && provider["retryPolicy"]["mode"].as_str() == Some("normal")
            && provider["retryPolicy"]["maxRetries"].as_u64() == Some(CLAUDE_MAX_RETRIES)
    })
}

// A later user patch can override an unchanged managed block. Inspect the final
// config rows too; matching marker bytes alone is not proof of effective state.
fn effective_matches(path: &Path, owned: &str) -> bool {
    let Ok(text) = read(path) else { return false };
    let (Ok(full), Ok(managed)) = (yaml(&text), yaml(owned)) else {
        return false;
    };
    let (Some(rows), Some(expected)) = (full.as_sequence(), managed.as_sequence()) else {
        return false;
    };
    if rows.iter().any(|row| {
        row["id"].as_str() == Some("credentials")
            && (row.get("config").is_some() || row.get("disabled").is_some())
    }) {
        return false;
    }
    expected.iter().all(|entry| {
        if rows.iter().any(|row| {
            row.get("id") == entry.get("id")
                && (row.get("disabled").is_some() || row.get("insert").is_some())
        }) {
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
    Ok(
        credentials_document(&read(&paths(&r.home)[0])?)?["refs"][KEY]
            .as_str()
            .map(str::to_owned),
    )
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
            && claude_policy_current(r)
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
        if i == 0 {
            let mut document = credentials_document(&before[i])?;
            if !hash_matches(&r, i, credential_hash(&document).as_ref()) {
                return Err("DSH 凭据已被外部修改，保留配置及凭据，请手动核对".into());
            }
            document["refs"]
                .as_mapping_mut()
                .ok_or("DSH 凭据格式无效")?
                .remove(serde_yaml::Value::from(KEY));
            originals.push(serde_yaml::to_string(&document).map_err(|_| "生成 DSH 凭据失败")?);
            continue;
        }
        let (original, owned) = trusted_profile(&before[i], &r, i)?;
        if owned.as_ref().is_some_and(|s| !effective_matches(path, s)) {
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
    fn fixture() -> (tempfile::TempDir, Record) {
        let home = tempfile::tempdir().unwrap();
        let model = "gpt-6.1-sol".to_string();
        let models = vec![model.clone(), "gpt-6-astra".into()];
        let profile = block(&profile_body("", &model, &models).unwrap());
        let credential = block(&format!("{KEY}: \"synthetic-key\"\n"));
        let hashes = vec![digest(&credential), digest(&profile), digest(&profile)];
        for (path, text) in paths(home.path())
            .iter()
            .zip([credential, profile.clone(), profile])
        {
            write(path, &text).unwrap();
        }
        let r = Record {
            home: home.path().into(),
            model,
            group: "default".into(),
            models,
            hashes,
            pending: false,
            previous_hashes: vec![],
        };
        (home, r)
    }

    #[test]
    fn runtime_migration_and_settings_preserve_ownership() {
        let (_home, r) = fixture();
        assert!(intact(&r));
        let files = paths(&r.home);
        // The official writer migrates the key, reformats YAML, and stores a
        // browser session. Its model UI also saves unrelated welcome settings.
        write(&files[0], &format!("version: 1\nrefs:\n  {KEY}: synthetic-key\nrecords:\n  client-connection/browser-session:\n    kind: opaque\n    payload: {{version: 1, secret: synthetic-browser-session}}\n")).unwrap();
        let mut rows = yaml(&read(&files[2]).unwrap()).unwrap();
        rows[1]["config"]["model"] = serde_yaml::Value::from("gpt-6-astra");
        rows.as_sequence_mut().unwrap().push(
            yaml("id: ui-settings-general\nconfig: {welcomeNoticeVersion: '2026-09-28.1'}\n")
                .unwrap(),
        );
        // JSON is valid YAML, and deliberately uses a different representation.
        write(
            &files[2],
            &block(&format!(
                "{}\n",
                serde_json::to_string_pretty(&rows).unwrap()
            )),
        )
        .unwrap();
        assert!(intact(&r));
        let (original, owned) = trusted_profile(&read(&files[2]).unwrap(), &r, 2).unwrap();
        assert!(original.contains("welcomeNoticeVersion"));
        assert!(!owned.unwrap().contains("welcomeNoticeVersion"));
        // Actual exported runtime fixtures can be checked without exposing keys.
        if let Ok(dir) = std::env::var("YUANHENG_DSH_OWNERSHIP_EXPORT") {
            let dir = Path::new(&dir);
            for (i, path) in files.iter().enumerate() {
                write(&dir.join(format!("{i}.yaml")), &read(path).unwrap()).unwrap();
            }
            write(
                &dir.join("record.json"),
                &serde_json::to_string(&r).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn runtime_normalization_never_trusts_modified_sensitive_fields() {
        let (_home, r) = fixture();
        let files = paths(&r.home);
        let original = read(&files[2]).unwrap();
        for (before, after) in [
            (OPENAI_BASE_URL, "https://example.invalid/v1"),
            (KEY, "OTHER_KEY"),
            ("gpt-6.1-sol", "unknown-model"),
        ] {
            write(&files[2], &original.replace(before, after)).unwrap();
            assert!(!intact(&r));
        }
        write(&files[2], &original).unwrap();
        write(
            &files[0],
            &format!("version: 1\nrefs:\n  {KEY}: changed-key\n"),
        )
        .unwrap();
        assert!(!intact(&r));
        write(
            &files[0],
            &format!("version: 2\nrefs:\n  {KEY}: synthetic-key\n"),
        )
        .unwrap();
        assert!(!intact(&r));
        assert!(credentials_document("version: 1\nrefs: {KEY: a, KEY: b}\n").is_err());
    }

    #[test]
    fn sanitized_runtime_fixture_is_read_only_and_trusted() {
        // Optional fixtures are generated from redacted on-disk comparisons or
        // an isolated official DSH run, never automatically from the user's home.
        let Ok(dir) = std::env::var("YUANHENG_DSH_OWNERSHIP_FIXTURE") else {
            return;
        };
        let dir = Path::new(&dir);
        let (_home, mut r) = fixture();
        let record: Record =
            serde_json::from_str(&read(&dir.join("record.json")).unwrap()).unwrap();
        r.model = record.model;
        r.models = record.models;
        r.hashes = record.hashes;
        for (i, path) in paths(&r.home).iter().enumerate() {
            write(path, &read(&dir.join(format!("{i}.yaml"))).unwrap()).unwrap();
        }
        assert!(
            intact(&r),
            "saved runtime fixture failed ownership validation"
        );
    }

    #[test]
    fn preserves_other_provider_and_rejects_collision() {
        let text =
            "- id: llm-pi-ai\n  config:\n    providers:\n      custom: {api: openai-completions, streamIdleTimeoutMs: 450000, retryPolicy: {mode: normal, maxRetries: 7}}\n";
        let body = profile_body(text, "model", &["model".into(), "second".into()]).unwrap();
        let parsed = yaml(&body).unwrap();
        assert_eq!(
            parsed[0]["config"]["providers"]["custom"],
            yaml(text).unwrap()[0]["config"]["providers"]["custom"]
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
        assert_eq!(
            providers["yuanheng-messages"]["streamIdleTimeoutMs"].as_u64(),
            Some(600_000)
        );
        assert_eq!(
            providers["yuanheng-messages"]["retryPolicy"]["mode"].as_str(),
            Some("normal")
        );
        assert_eq!(
            providers["yuanheng-messages"]["retryPolicy"]["maxRetries"].as_u64(),
            Some(1)
        );
        for name in ["yuanheng-chat", "yuanheng-responses"] {
            assert!(providers[name].get("streamIdleTimeoutMs").is_none());
            assert!(providers[name].get("retryPolicy").is_none());
        }
    }

    #[test]
    fn claude_policy_requires_both_profiles_without_affecting_gpt_only() {
        let home = tempfile::tempdir().unwrap();
        let mut record = Record {
            home: home.path().into(),
            model: "claude-opus-5-5".into(),
            group: "default".into(),
            models: vec!["claude-opus-5-5".into(), "gpt-6.1-sol".into()],
            hashes: vec![],
            pending: false,
            previous_hashes: vec![],
        };
        let body = profile_body("", &record.model, &record.models).unwrap();
        let profiles = paths(home.path());
        for path in profiles.iter().skip(1) {
            write(path, &block(&body)).unwrap();
        }
        assert!(claude_policy_current(&record));

        let mut legacy = yaml(&body).unwrap();
        let provider = legacy[0]["config"]["providers"]["yuanheng-messages"]
            .as_mapping_mut()
            .unwrap();
        provider.remove(serde_yaml::Value::from("streamIdleTimeoutMs"));
        provider.remove(serde_yaml::Value::from("retryPolicy"));
        write(
            &profiles[2],
            &block(&serde_yaml::to_string(&legacy).unwrap()),
        )
        .unwrap();
        assert!(!claude_policy_current(&record));

        write(&profiles[2], &block(&body)).unwrap();
        assert!(claude_policy_current(&record));
        let mut unlimited = yaml(&body).unwrap();
        unlimited[0]["config"]["providers"]["yuanheng-messages"]["retryPolicy"]["mode"] =
            serde_yaml::Value::from("always");
        write(
            &profiles[1],
            &block(&serde_yaml::to_string(&unlimited).unwrap()),
        )
        .unwrap();
        assert!(!claude_policy_current(&record));

        record.model = "gpt-6.1-sol".into();
        record.models = vec![record.model.clone()];
        assert!(claude_policy_current(&record));
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
