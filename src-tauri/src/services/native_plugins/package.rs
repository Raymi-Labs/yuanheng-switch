use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
const MAX_FILES: usize = 2000;
const MAX_BYTES: usize = 32 * 1024 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub name: String,
    pub version: String,
    pub description: String,
    pub license: String,
    pub digest: String,
    pub file_count: usize,
    pub bytes: usize,
    pub skills: usize,
    pub has_mcp: bool,
    pub has_hooks: bool,
    pub executable_files: usize,
    pub has_apps: bool,
    pub connections: Vec<String>,
}
pub(super) struct Package {
    pub info: PackageInfo,
    pub files: Vec<(PathBuf, Vec<u8>)>,
    pub executable_paths: Vec<PathBuf>,
}
pub(super) fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}
pub(super) fn no_links(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if let Ok(meta) = fs::symlink_metadata(ancestor) {
            if meta.file_type().is_symlink() {
                return Err("路径包含符号链接，请选择真实目录".into());
            }
        }
    }
    Ok(())
}
fn walk(
    root: &Path,
    dir: &Path,
    files: &mut Vec<(PathBuf, Vec<u8>)>,
    total: &mut usize,
    depth: usize,
    visited: &mut usize,
) -> Result<(), String> {
    if depth > 24 {
        return Err("插件目录层级过深".into());
    }
    for item in fs::read_dir(dir).map_err(|_| "无法读取插件目录")? {
        *visited += 1;
        if *visited > MAX_FILES {
            return Err("插件目录项目过多".into());
        }
        let p = item.map_err(|_| "无法读取插件文件")?.path();
        let meta = fs::symlink_metadata(&p).map_err(|_| "无法检查插件文件")?;
        if meta.file_type().is_symlink() {
            return Err("插件包含符号链接，已拒绝导入".into());
        }
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("插件文件名无效")?;
        if name.contains('\\') || name.contains(':') {
            return Err("插件文件名不兼容，请使用普通文件名".into());
        }
        if name == ".git" {
            return Err("请选择插件子目录，不要导入包含 .git 的整个仓库".into());
        }
        if [
            "auth.json",
            "credentials.json",
            ".npmrc",
            ".netrc",
            "id_rsa",
            "id_ed25519",
        ]
        .contains(&name)
            || name == ".env"
            || name.starts_with(".env.")
        {
            return Err("插件目录包含可能的凭据文件，请移除后重新检查".into());
        }
        if meta.is_dir() {
            walk(root, &p, files, total, depth + 1, visited)?;
        } else if meta.is_file() {
            if files.len() >= MAX_FILES || meta.len() > MAX_BYTES as u64 {
                return Err("插件超过本地导入安全大小".into());
            }
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x00200000);
            }
            let file = options.open(&p).map_err(|_| "无法安全读取插件文件")?;
            let opened = file.metadata().map_err(|_| "无法检查已打开文件")?;
            if !opened.is_file() || opened.file_type().is_symlink() {
                return Err("插件文件类型已变化".into());
            }
            use std::io::Read;
            let mut data = Vec::new();
            file.take((MAX_BYTES + 1) as u64)
                .read_to_end(&mut data)
                .map_err(|_| "无法读取插件文件")?;
            *total += data.len();
            if *total > MAX_BYTES {
                return Err("插件超过本地导入安全大小".into());
            }
            files.push((
                p.strip_prefix(root)
                    .map_err(|_| "插件路径越界")?
                    .to_path_buf(),
                data,
            ));
        } else {
            return Err("插件包含特殊文件，已拒绝导入".into());
        }
    }
    Ok(())
}
fn local_reference(root: &Path, v: &Value) -> Result<(), String> {
    match v {
        Value::String(s) if s.starts_with("./") => {
            let rel = Path::new(s);
            if rel.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            }) {
                return Err("插件清单引用越界".into());
            }
            let p = root.join(rel);
            no_links(&p)?;
            if !p.exists() {
                return Err("插件清单引用的文件不存在".into());
            }
        }
        Value::Array(a) => {
            for item in a {
                local_reference(root, item)?;
            }
        }
        Value::Object(o) => {
            for (k, item) in o {
                if ["skills", "mcpServers", "apps", "hooks", "onboardingSkill"]
                    .contains(&k.as_str())
                {
                    if let Some(s) = item.as_str() {
                        if !s.starts_with("./") || s.contains('\\') {
                            return Err("插件组件必须使用包内相对路径".into());
                        }
                    }
                    local_reference(root, item)?;
                }
                if k == "extensions" || k == "com.openai" {
                    local_reference(root, item)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn inspect(root: &Path) -> Result<Package, String> {
    if !root.is_absolute() || !root.is_dir() {
        return Err("请选择插件目录的绝对路径".into());
    }
    no_links(root)?;
    let mut files = vec![];
    let mut bytes = 0;
    walk(root, root, &mut files, &mut bytes, 0, &mut 0)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let portable = files.iter().find(|(p, _)| p == Path::new("plugin.json"));
    let manifest = portable
        .or_else(|| {
            files
                .iter()
                .find(|(p, _)| p == Path::new(".codex-plugin/plugin.json"))
        })
        .ok_or("目录中没有 plugin.json 或 .codex-plugin/plugin.json")?;
    if manifest.1.len() > 128 * 1024 {
        return Err("插件清单过大".into());
    }
    let v: Value = serde_json::from_slice(&manifest.1).map_err(|_| "插件清单不是有效 JSON")?;
    let name = v["name"]
        .as_str()
        .filter(|s| identifier(s))
        .ok_or("插件名称必须为小写字母、数字、短横线或下划线")?
        .to_string();
    let version = v["version"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && *s != "."
                && *s != ".."
                && s.len() < 80
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-_+".contains(&b))
        })
        .ok_or("插件缺少有效版本")?
        .to_string();
    local_reference(root, &v)?;
    // Validate compatibility overlay even when a portable identity is present.
    for (p, data) in &files {
        if p == Path::new(".codex-plugin/plugin.json") {
            let overlay: Value = serde_json::from_slice(data).map_err(|_| "兼容清单无效")?;
            local_reference(root, &overlay)?;
            if overlay
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| n != name)
            {
                return Err("插件两份清单名称不一致".into());
            }
        }
    }
    let text_field = |key: &str, max: usize| {
        v[key]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(max)
            .collect::<String>()
    };
    let mut hash = Sha256::new();
    for (p, b) in &files {
        hash.update(p.to_string_lossy().as_bytes());
        hash.update([0]);
        hash.update((b.len() as u64).to_le_bytes());
        hash.update(b);
    }
    let overlay = files
        .iter()
        .find(|(p, _)| p == Path::new(".codex-plugin/plugin.json"))
        .and_then(|(_, b)| serde_json::from_slice::<Value>(b).ok());
    let components = v
        .get("extensions")
        .and_then(|e| e.get("com.openai"))
        .or(overlay.as_ref())
        .unwrap_or(&v);
    let has_mcp = components.get("mcpServers").is_some()
        || files
            .iter()
            .any(|(p, _)| p == Path::new("mcp.json") || p == Path::new(".mcp.json"));
    let has_hooks =
        components.get("hooks").is_some() || files.iter().any(|(p, _)| p.starts_with("hooks"));
    let has_apps =
        components.get("apps").is_some() || files.iter().any(|(p, _)| p == Path::new(".app.json"));
    let skills = files
        .iter()
        .filter(|(p, _)| p.file_name().is_some_and(|n| n == "SKILL.md"))
        .count();
    let executable_paths: Vec<PathBuf> = files
        .iter()
        .filter(|(p, b)| {
            let format = b.starts_with(b"#!")
                || b.starts_with(b"MZ")
                || b.starts_with(b"\x7fELF")
                || p.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                    [
                        "sh", "bash", "zsh", "ps1", "cmd", "bat", "exe", "dll", "py", "js", "mjs",
                        "cjs", "wasm",
                    ]
                    .contains(&e)
                });
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                format
                    || fs::metadata(root.join(p)).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
            }
            #[cfg(not(unix))]
            {
                format
            }
        })
        .map(|(p, _)| p.clone())
        .collect();
    let executable_files = executable_paths.len();
    for p in &executable_paths {
        hash.update(b"executable:");
        hash.update(p.to_string_lossy().as_bytes());
    }
    let mut connections = Vec::new();
    let mut mcp_files = vec!["mcp.json".to_string(), ".mcp.json".to_string()];
    if let Some(path) = components.get("mcpServers").and_then(Value::as_str) {
        mcp_files.push(path.trim_start_matches("./").to_string());
    }
    let mut configs = vec![];
    for (p, b) in &files {
        if mcp_files.iter().any(|f| p == Path::new(f)) {
            configs.push(serde_json::from_slice::<Value>(b).map_err(|_| "MCP 清单无效")?);
        }
    }
    if let Some(inline) = components.get("mcpServers").filter(|v| v.is_object()) {
        configs.push(inline.clone());
    }
    for cfg in configs {
        if let Some(servers) = cfg.get("mcpServers").unwrap_or(&cfg).as_object() {
            for server in servers.values() {
                if let Some(raw) = server.get("url").and_then(Value::as_str) {
                    let url = url::Url::parse(raw).map_err(|_| "MCP 地址无效")?;
                    if !url.username().is_empty() || url.password().is_some() {
                        return Err("MCP 地址包含凭据，请通过原生授权配置".into());
                    }
                    connections.push(url.origin().ascii_serialization());
                }
                if let Some(command) = server.get("command").and_then(Value::as_str) {
                    connections.push(format!(
                        "程序：{}",
                        Path::new(command)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                    ));
                }
            }
        }
    }
    connections.sort();
    connections.dedup();
    let info = PackageInfo {
        name,
        version,
        description: text_field("description", 500),
        license: text_field("license", 120),
        digest: format!("{:x}", hash.finalize()),
        file_count: files.len(),
        bytes,
        skills,
        has_mcp,
        has_hooks,
        executable_files,
        has_apps,
        connections,
    };
    Ok(Package {
        info,
        files,
        executable_paths,
    })
}
pub(super) fn stage(package: &Package, dst: &Path) -> Result<(), String> {
    no_links(dst)?;
    if dst.exists() {
        let old = inspect(dst)?;
        if old.info.digest == package.info.digest {
            return Ok(());
        }
        return Err("已暂存的插件内容已变化，请勿覆盖".into());
    }
    let parent = dst.parent().ok_or("暂存路径无效")?;
    fs::create_dir_all(parent).map_err(|_| "无法创建插件暂存目录")?;
    let temp = tempfile::tempdir_in(parent).map_err(|_| "无法暂存插件")?;
    for (p, b) in &package.files {
        let out = temp.path().join(p);
        fs::create_dir_all(out.parent().ok_or("插件路径无效")?).map_err(|_| "无法创建插件目录")?;
        fs::write(&out, b).map_err(|_| "无法保存插件内容")?;
        #[cfg(unix)]
        if package.executable_paths.contains(p) {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&out, fs::Permissions::from_mode(0o755))
                .map_err(|_| "无法保存插件执行权限")?;
        }
    }
    fs::rename(temp.path(), dst).map_err(|_| "无法提交插件快照")?;
    Ok(())
}
