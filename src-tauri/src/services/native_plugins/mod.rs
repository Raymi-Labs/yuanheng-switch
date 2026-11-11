//! Native Codex plugin management: no renderer injection, no model requests.
mod package;
mod rpc;
#[cfg(test)]
mod tests;
use package::{inspect, no_links, stage, PackageInfo};
use rpc::Rpc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PLANS: OnceLock<Mutex<HashMap<String, Plan>>> = OnceLock::new();
#[derive(Clone)]
struct Target {
    home: PathBuf,
    binary: PathBuf,
    root: PathBuf,
    id: String,
}
#[derive(Clone)]
struct Plan {
    target: Target,
    source: PathBuf,
    info: PackageInfo,
    config: String,
    at: Instant,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub token: String,
    pub target_id: String,
    pub info: PackageInfo,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    info: PackageInfoRecord,
    market: String,
    pending: Option<String>,
}
// Keep the on-disk schema explicit and separate from untrusted native output.
#[derive(Clone, Serialize, Deserialize)]
struct PackageInfoRecord {
    name: String,
    version: String,
    digest: String,
    description: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub installed: bool,
    pub enabled: bool,
    pub pending: bool,
    pub changed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    pub target_id: String,
    pub engine: String,
    pub plugins: Vec<PluginRow>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub installed: bool,
    pub enabled: bool,
    pub discovered_skills: usize,
    pub declared_mcp: usize,
    pub declared_apps: usize,
    pub execution_verified: bool,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn config_hash(t: &Target) -> Result<String, String> {
    let p = t.home.join("config.toml");
    no_links(&p)?;
    match fs::read(p) {
        Ok(v) => Ok(hash(&v)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(hash(b"")),
        Err(_) => Err("无法读取 Codex 配置状态".into()),
    }
}
fn engine_from_entry(entry: &Path) -> Option<PathBuf> {
    let real = entry.canonicalize().ok()?;
    let ext = real.extension().and_then(|s| s.to_str()).unwrap_or("");
    if ext != "js" && ext != "cmd" && ext != "bat" {
        return real.is_file().then_some(real);
    }
    let (package, triple) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => ("codex-darwin-arm64", "aarch64-apple-darwin"),
        ("macos", "x86_64") => ("codex-darwin-x64", "x86_64-apple-darwin"),
        ("windows", "x86_64") => ("codex-win32-x64", "x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => ("codex-win32-arm64", "aarch64-pc-windows-msvc"),
        ("linux", "x86_64") => ("codex-linux-x64", "x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => ("codex-linux-arm64", "aarch64-unknown-linux-musl"),
        _ => return None,
    };
    let root = if ext == "js" {
        real.parent()?.parent()?.to_path_buf()
    } else {
        real.parent()?.join("node_modules/@openai/codex")
    };
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    [
        root.join("node_modules/@openai")
            .join(package)
            .join("vendor"),
        root.join("vendor"),
    ]
    .into_iter()
    .map(|p| p.join(triple).join("bin").join(name))
    .find(|p| p.is_file())
}
fn target(tool: &str, custom_path: Option<&str>) -> Result<Target, String> {
    let home = crate::codex_config::get_codex_config_dir();
    no_links(&home)?;
    if !home.is_dir() {
        return Err("请先安装并打开 Codex，再管理插件".into());
    }
    let home = home.canonicalize().map_err(|_| "Codex 目录不可用")?;
    let mut binaries = vec![];
    if tool == "chatgpt-desktop" {
        let app = crate::desktop_app_detection::discover_desktop_app(tool, custom_path);
        if let Some(path) = app.install_path {
            let p = PathBuf::from(path);
            #[cfg(target_os = "macos")]
            for rel in [
                "Contents/Resources/codex-cli/bin/codex",
                "Contents/Resources/codex",
            ] {
                binaries.push(p.join(rel));
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(parent) = p.parent() {
                for rel in [
                    "resources/codex.exe",
                    "resources/codex-cli/bin/codex.exe",
                    "codex.exe",
                ] {
                    binaries.push(parent.join(rel));
                }
            }
        }
    } else if tool == "codex" {
        if let Some(paths) = std::env::var_os("PATH") {
            for p in std::env::split_paths(&paths) {
                binaries.push(p.join(if cfg!(windows) { "codex.exe" } else { "codex" }));
                #[cfg(windows)]
                binaries.push(p.join("codex.cmd"));
            }
        }
        if let Some(h) = dirs::home_dir() {
            binaries.push(h.join(".local/bin/codex"));
        }
    } else {
        return Err("此入口仅管理 Codex 原生插件，其他工具请使用 Skills 或 MCP".into());
    }
    let binary = binaries
        .into_iter()
        .filter(|p| p.is_file())
        .find_map(|p| engine_from_entry(&p))
        .ok_or("未找到此目标的 Codex 原生引擎，请先安装或更新；不会自动改用其他目标")?;
    let meta = fs::metadata(&binary).map_err(|_| "Codex 引擎不可读")?;
    let stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let id = hash(
        format!(
            "{}\0{}\0{tool}\0{}\0{stamp}",
            home.display(),
            binary.display(),
            meta.len()
        )
        .as_bytes(),
    );
    let root = home.join("yuanheng-native-plugins");
    no_links(&root)?;
    Ok(Target {
        home,
        binary,
        root,
        id,
    })
}
fn expected(tool: &str, id: &str, custom_path: Option<&str>) -> Result<Target, String> {
    let t = target(tool, custom_path)?;
    if t.id != id {
        return Err("目标已变化，请刷新后重试".into());
    }
    Ok(t)
}
fn load(t: &Target) -> Result<Vec<Entry>, String> {
    let p = t.root.join("registry.json");
    no_links(&p)?;
    if !p.exists() {
        return Ok(vec![]);
    }
    let data = fs::read(p).map_err(|_| "无法读取插件记录")?;
    if data.len() > 1024 * 1024 {
        return Err("插件记录过大".into());
    }
    let entries: Vec<Entry> =
        serde_json::from_slice(&data).map_err(|_| "插件记录损坏，请保留文件并联系支持")?;
    for e in &entries {
        if !package::identifier(&e.info.name)
            || e.info.version.is_empty()
            || e.info.version == "."
            || e.info.version == ".."
            || !e
                .info
                .version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_+".contains(&b))
            || e.info.digest.len() != 64
            || !e.info.digest.bytes().all(|b| b.is_ascii_hexdigit())
            || e.market != market(&e.info.digest)
        {
            return Err("插件记录身份无效".into());
        }
    }
    Ok(entries)
}
fn save(t: &Target, entries: &[Entry]) -> Result<(), String> {
    no_links(&t.root)?;
    fs::create_dir_all(&t.root).map_err(|_| "无法保存插件状态")?;
    let path = t.root.join("registry.json");
    no_links(&path)?;
    let mut f = tempfile::NamedTempFile::new_in(&t.root).map_err(|_| "无法保存插件状态")?;
    use std::io::Write;
    f.write_all(&serde_json::to_vec_pretty(entries).map_err(|_| "状态编码失败")?)
        .map_err(|_| "无法保存插件状态")?;
    f.as_file().sync_all().map_err(|_| "无法刷新插件状态")?;
    f.persist(path).map_err(|_| "无法提交插件状态")?;
    Ok(())
}
fn market(digest: &str) -> String {
    format!("yuanheng-{}", &digest[..24])
}
fn root_for(t: &Target, e: &Entry) -> PathBuf {
    t.root.join("sources").join(&e.info.digest)
}
fn catalog_path(t: &Target, e: &Entry) -> PathBuf {
    root_for(t, e).join(".agents/plugins/marketplace.json")
}
fn native_id(e: &Entry) -> String {
    format!("{}@{}", e.info.name, e.market)
}
fn catalog(e: &Entry) -> Value {
    json!({"name":e.market,"interface":{"displayName":"Meta API"},"plugins":[{"name":e.info.name,"source":{"source":"local","path":"./package"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}]})
}
fn trusted_snapshot(t: &Target, e: &Entry) -> bool {
    let path = catalog_path(t, e);
    no_links(&path).is_ok()
        && fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .is_some_and(|v| v == catalog(e))
        && inspect(&root_for(t, e).join("package")).is_ok_and(|p| p.info.digest == e.info.digest)
}
fn cached_content_unchanged(t: &Target, e: &Entry) -> Result<(), String> {
    let cache = t
        .home
        .join("plugins/cache")
        .join(&e.market)
        .join(&e.info.name)
        .join(&e.info.version);
    no_links(&cache)?;
    if cache.exists() && !inspect(&cache).is_ok_and(|p| p.info.digest == e.info.digest) {
        return Err("已安装插件内容被修改，已停止操作以保留修改；请在 Codex 中检查".into());
    }
    Ok(())
}
async fn open(t: &Target) -> Result<Rpc, String> {
    Rpc::start(&t.binary, &t.home, &t.root).await
}
fn prepare_root(t: &Target) -> Result<(), String> {
    no_links(&t.root)?;
    fs::create_dir_all(&t.root).map_err(|_| "无法准备插件管理目录".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&t.root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护插件管理目录")?;
    }
    Ok(())
}
async fn native_read(r: &mut Rpc, t: &Target, e: &Entry) -> Result<Value, String> {
    r.call(
        "plugin/read",
        json!({"pluginName":e.info.name,"marketplacePath":catalog_path(t,e)}),
    )
    .await
}
fn summary(value: &Value) -> Result<&Value, String> {
    value
        .pointer("/plugin/summary")
        .ok_or("原生插件详情格式不兼容".into())
}
async fn check_owner(
    r: &mut Rpc,
    t: &Target,
    e: &Entry,
    allow_missing: bool,
) -> Result<Value, String> {
    let cfg = r.call("config/read", json!({"includeLayers":true})).await?;
    let value = cfg
        .pointer("/config/marketplaces")
        .and_then(|v| v.get(&e.market));
    match value {
        Some(v)
            if v["source_type"] == "local" && v["source"].as_str() == root_for(t, e).to_str() => {}
        None if allow_missing => {}
        _ => return Err("插件市场配置已被修改，请先核对；未覆盖现有配置".into()),
    }
    Ok(cfg)
}
async fn config_write(
    r: &mut Rpc,
    t: &Target,
    key: String,
    value: Value,
    cfg: &Value,
) -> Result<(), String> {
    let version = cfg["origins"]
        .as_object()
        .and_then(|o| {
            o.values().find(|v| {
                v.pointer("/name/type").and_then(Value::as_str) == Some("user")
                    && v.pointer("/name/file").and_then(Value::as_str)
                        == t.home.join("config.toml").to_str()
            })
        })
        .and_then(|v| v.get("version"))
        .or_else(|| {
            cfg["layers"]
                .as_array()
                .and_then(|layers| {
                    layers.iter().find(|layer| {
                        layer.pointer("/name/type").and_then(Value::as_str) == Some("user")
                            && layer.pointer("/name/file").and_then(Value::as_str)
                                == t.home.join("config.toml").to_str()
                    })
                })
                .and_then(|layer| layer.get("version"))
        })
        .cloned()
        .unwrap_or(Value::Null);
    if t.home.join("config.toml").exists() && version.is_null() {
        return Err("无法确认配置版本，已停止写入；请更新 Codex 后重试".into());
    }
    r.call("config/value/write",json!({"keyPath":key,"value":value,"mergeStrategy":"replace","expectedVersion":version,"filePath":t.home.join("config.toml")})).await?;
    Ok(())
}
pub async fn status(tool: String, custom_path: Option<String>) -> Result<PluginStatus, String> {
    let _lock = LOCK
        .try_lock()
        .map_err(|_| "插件操作正在进行，请稍后刷新")?;
    let t = target(&tool, custom_path.as_deref())?;
    prepare_root(&t)?;
    let mut r = open(&t).await?;
    let result = tokio::time::timeout(Duration::from_secs(90), async {
        let mut entries = load(&t)?;
        let mut rows = vec![];
        for e in &mut entries {
            let changed = !trusted_snapshot(&t, e);
            if changed {
                rows.push(PluginRow {
                    id: e.info.digest.clone(),
                    name: e.info.name.clone(),
                    version: e.info.version.clone(),
                    description: e.info.description.clone(),
                    installed: false,
                    enabled: false,
                    pending: e.pending.is_some(),
                    changed: true,
                });
                continue;
            }
            check_owner(&mut r, &t, e, true).await?;
            let v = native_read(&mut r, &t, e).await?;
            let s = summary(&v)?;
            let installed = s["installed"].as_bool().ok_or("原生插件状态缺失")?;
            let enabled = s["enabled"].as_bool().ok_or("原生插件状态缺失")?;
            if (e.pending.as_deref() == Some("install") && installed)
                || (e.pending.as_deref() == Some("remove") && !installed)
            {
                e.pending = None;
            }
            rows.push(PluginRow {
                id: e.info.digest.clone(),
                name: e.info.name.clone(),
                version: e.info.version.clone(),
                description: e.info.description.clone(),
                installed,
                enabled,
                pending: e.pending.is_some(),
                changed: changed || cached_content_unchanged(&t, e).is_err(),
            });
        }
        if !entries.is_empty() {
            save(&t, &entries)?;
        }
        Ok(PluginStatus {
            target_id: t.id.clone(),
            engine: if tool == "chatgpt-desktop" {
                "desktop"
            } else {
                "cli"
            }
            .into(),
            plugins: rows,
        })
    })
    .await
    .unwrap_or_else(|_| Err("插件操作超时，结果待核对，请刷新；未自动重试".into()));
    r.close().await;
    result
}
fn builtin(root: &Path, id: &str) -> Result<PathBuf, String> {
    let data: &[(&str, &str)] = match id {
        "review" => &[
            (
                ".codex-plugin/plugin.json",
                include_str!(
                    "../../resources/builtin_plugins/workspace-review/.codex-plugin/plugin.json"
                ),
            ),
            (
                "skills/review/SKILL.md",
                include_str!(
                    "../../resources/builtin_plugins/workspace-review/skills/review/SKILL.md"
                ),
            ),
            (
                "LICENSE",
                include_str!("../../resources/builtin_plugins/workspace-review/LICENSE"),
            ),
        ],
        "docs" => &[
            (
                ".codex-plugin/plugin.json",
                include_str!(
                    "../../resources/builtin_plugins/openai-docs/.codex-plugin/plugin.json"
                ),
            ),
            (
                "skills/docs/SKILL.md",
                include_str!("../../resources/builtin_plugins/openai-docs/skills/docs/SKILL.md"),
            ),
            (
                ".mcp.json",
                include_str!("../../resources/builtin_plugins/openai-docs/.mcp.json"),
            ),
            (
                "LICENSE",
                include_str!("../../resources/builtin_plugins/openai-docs/LICENSE"),
            ),
        ],
        _ => return Err("未知内置插件".into()),
    };
    let dst = root.join("builtin").join(id);
    no_links(&dst)?;
    for (rel, body) in data {
        let path = dst.join(rel);
        no_links(&path)?;
        fs::create_dir_all(path.parent().ok_or("内置插件路径无效")?)
            .map_err(|_| "无法准备内置插件")?;
        fs::write(path, body).map_err(|_| "无法准备内置插件")?;
    }
    Ok(dst)
}
pub async fn plan(
    tool: String,
    custom_path: Option<String>,
    target_id: String,
    source: Option<String>,
    builtin_id: Option<String>,
) -> Result<InstallPlan, String> {
    let _lock = LOCK.try_lock().map_err(|_| "插件操作正在进行")?;
    let t = expected(&tool, &target_id, custom_path.as_deref())?;
    prepare_root(&t)?;
    let path = match (source, builtin_id) {
        (Some(p), None) => PathBuf::from(p),
        (None, Some(id)) => builtin(&t.root, &id)?,
        _ => return Err("请选择一种插件来源".into()),
    };
    let package = inspect(&path)?;
    let plan = Plan {
        config: config_hash(&t)?,
        target: t.clone(),
        source: path,
        info: package.info.clone(),
        at: Instant::now(),
    };
    let token = uuid::Uuid::new_v4().to_string();
    let mut cache = PLANS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "计划锁不可用")?;
    cache.retain(|_, p| p.at.elapsed() < Duration::from_secs(600));
    if cache.len() >= 16 {
        return Err("待确认计划过多，请稍后重试".into());
    }
    cache.insert(token.clone(), plan);
    Ok(InstallPlan {
        token,
        target_id: t.id,
        info: package.info,
    })
}
pub async fn install(
    tool: String,
    custom_path: Option<String>,
    target_id: String,
    token: String,
) -> Result<(), String> {
    let _lock = LOCK.try_lock().map_err(|_| "插件操作正在进行")?;
    let t = expected(&tool, &target_id, custom_path.as_deref())?;
    let plan = PLANS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "计划锁不可用")?
        .remove(&token)
        .ok_or("安装计划已使用或过期，请重新检查")?;
    if plan.at.elapsed() > Duration::from_secs(600)
        || plan.target.id != t.id
        || plan.config != config_hash(&t)?
    {
        return Err("目标或配置已变化，请重新检查插件后安装".into());
    }
    let package = inspect(&plan.source)?;
    if package.info.digest != plan.info.digest {
        return Err("插件内容在确认后发生变化，请重新检查".into());
    }
    let mut entries = load(&t)?;
    if entries.iter().any(|e| e.info.digest == package.info.digest) {
        return Err("此版本已有管理记录，请刷新并使用原记录；不会重复安装".into());
    }
    let e = Entry {
        info: PackageInfoRecord {
            name: package.info.name.clone(),
            version: package.info.version.clone(),
            description: package.info.description.clone(),
            digest: package.info.digest.clone(),
        },
        market: market(&package.info.digest),
        pending: Some("install".into()),
    };
    let root = root_for(&t, &e);
    stage(&package, &root.join("package"))?;
    let path = catalog_path(&t, &e);
    no_links(&path)?;
    fs::create_dir_all(path.parent().ok_or("市场路径无效")?).map_err(|_| "无法创建插件市场")?;
    let catalog = catalog(&e);
    fs::write(
        &path,
        serde_json::to_vec_pretty(&catalog).map_err(|_| "市场编码失败")?,
    )
    .map_err(|_| "无法保存插件市场")?;
    let mut r = open(&t).await?;
    let result = tokio::time::timeout(Duration::from_secs(90), async {
        let cfg = check_owner(&mut r, &t, &e, true).await?;
        if plan.config != config_hash(&t)? {
            return Err("配置在确认后发生变化，请重新检查插件".into());
        }
        // Log intent before the first native write; failures remain recoverable, never replayed.
        entries.push(e.clone());
        save(&t, &entries)?;
        config_write(
            &mut r,
            &t,
            format!("marketplaces.{}", e.market),
            json!({"source_type":"local","source":root}),
            &cfg,
        )
        .await?;
        r.call(
            "plugin/install",
            json!({"pluginName":e.info.name,"marketplacePath":path,"installAttemptId":token}),
        )
        .await?;
        let v = native_read(&mut r, &t, &e).await?;
        if summary(&v)?["installed"] != true {
            return Err("安装结果未确认，请刷新核对；未自动重试".into());
        }
        if let Some(last) = entries.last_mut() {
            last.pending = None;
        }
        save(&t, &entries)?;
        Ok(())
    })
    .await
    .unwrap_or_else(|_| Err("插件操作超时，结果待核对，请刷新；未自动重试".into()));
    r.close().await;
    result
}
pub async fn action(
    tool: String,
    custom_path: Option<String>,
    target_id: String,
    id: String,
    action: String,
) -> Result<Verification, String> {
    let _lock = LOCK.try_lock().map_err(|_| "插件操作正在进行")?;
    let t = expected(&tool, &target_id, custom_path.as_deref())?;
    let mut entries = load(&t)?;
    let index = entries
        .iter()
        .position(|e| e.info.digest == id)
        .ok_or("插件记录不存在，请刷新")?;
    let e = entries[index].clone();
    if !["enable", "disable", "remove", "verify", "reinstall"].contains(&action.as_str()) {
        return Err("不支持的插件操作".into());
    }
    if !trusted_snapshot(&t, &e) && action != "remove" {
        return Err("插件快照已变化，请移除后重新导入".into());
    }
    if e.pending.is_some() && action != "remove" && action != "verify" {
        return Err("上次结果未确认，请刷新或移除原安装；不会自动重试".into());
    }
    cached_content_unchanged(&t, &e)?;
    let mut r = open(&t).await?;
    let result = tokio::time::timeout(Duration::from_secs(90), async {
        let cfg = check_owner(&mut r, &t, &e, action == "remove").await?;
        if action == "enable" || action == "disable" {
            config_write(
                &mut r,
                &t,
                format!("plugins.\"{}\".enabled", native_id(&e)),
                json!(action == "enable"),
                &cfg,
            )
            .await?;
        } else if action == "remove" || action == "reinstall" {
            if action == "reinstall" {
                let current = native_read(&mut r, &t, &e).await?;
                if summary(&current)?["installed"] == true {
                    return Err("插件已安装，请刷新状态".into());
                }
            }
            entries[index].pending = Some(
                if action == "remove" {
                    "remove"
                } else {
                    "install"
                }
                .into(),
            );
            save(&t, &entries)?;
            if action == "remove" {
                r.call("plugin/uninstall", json!({"pluginId": native_id(&e)}))
                    .await?;
            } else {
                r.call(
                    "plugin/install",
                    json!({
                        "pluginName": e.info.name,
                        "marketplacePath": catalog_path(&t, &e),
                        "installAttemptId": uuid::Uuid::new_v4().to_string()
                    }),
                )
                .await?;
            }
        }
        // After explicit removal do not parse a source whose integrity is no longer known.
        if action == "remove" && !trusted_snapshot(&t, &e) {
            entries[index].pending = None;
            save(&t, &entries)?;
            return Ok(Verification {
                installed: false,
                enabled: false,
                discovered_skills: 0,
                declared_mcp: 0,
                declared_apps: 0,
                execution_verified: false,
            });
        }
        let detail = native_read(&mut r, &t, &e).await?;
        let native = summary(&detail)?;
        let installed = native["installed"].as_bool().ok_or("原生状态缺失")?;
        let enabled = native["enabled"].as_bool().ok_or("原生状态缺失")?;
        if (action == "remove" && installed)
            || (action == "reinstall" && !installed)
            || (action == "enable" && !enabled)
            || (action == "disable" && enabled)
        {
            return Err("原生结果与操作不一致，请刷新检查".into());
        }
        if action == "remove" || action == "reinstall" {
            entries[index].pending = None;
            save(&t, &entries)?;
        }
        let mut count = 0;
        if action == "verify" && installed && enabled {
            let skills = r
                .call("skills/list", json!({"cwds":[t.root], "forceReload":true}))
                .await?;
            for row in skills["data"].as_array().ok_or("技能检查格式不兼容")? {
                count += row["skills"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter(|skill| {
                                skill["pluginId"].as_str() == Some(&native_id(&e))
                                    && skill["enabled"] == true
                            })
                            .count()
                    })
                    .unwrap_or(0);
            }
        }
        Ok(Verification {
            installed,
            enabled,
            discovered_skills: count,
            declared_mcp: detail
                .pointer("/plugin/mcpServers")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
            declared_apps: detail
                .pointer("/plugin/apps")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
            execution_verified: false,
        })
    })
    .await
    .unwrap_or_else(|_| Err("插件操作超时，结果待核对，请刷新；未自动重试".into()));
    r.close().await;
    result
}
