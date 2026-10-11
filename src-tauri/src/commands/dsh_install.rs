//! Private, pinned DSH runtime. Existing source trees and global runtimes are never changed.
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

pub(super) const VERSION: &str = "0.2.0-rc.2";
const CLI: &str = "package/node_modules/@deepseek-ai/dsh/lib/bin.js";
const INSTALL_ERROR: &str =
    "DSH 安装或验证失败，原安装未替换。请检查 nodejs.org 与 registry.npmjs.org 的网络连接、磁盘空间后重试。";

pub(super) fn root() -> PathBuf {
    crate::config::get_app_config_dir().join("tools/dsh")
}

pub(crate) fn home() -> PathBuf {
    #[cfg(test)]
    if std::env::var_os("YUANHENG_SWITCH_TEST_HOME").is_some() {
        return crate::config::get_home_dir().join(".dsh");
    }
    std::env::var_os("DSH_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::config::get_home_dir().join(".dsh"))
}

pub(super) fn node(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) {
        "runtime/node.exe"
    } else {
        "runtime/bin/node"
    })
}

pub(super) fn installed_at(base: &Path) -> Option<PathBuf> {
    let name = fs::read_to_string(base.join("current")).ok()?;
    // Only our UUID directory names are valid; never accept arbitrary paths from disk.
    let suffix = name.strip_prefix("install-")?;
    uuid::Uuid::parse_str(suffix).ok()?;
    let dir = base.join(&name);
    let canonical_base = base.canonicalize().ok()?;
    let canonical_dir = dir.canonicalize().ok()?;
    if canonical_dir.parent()? != canonical_base
        || !node(&dir).is_file()
        || !dir.join(CLI).is_file()
    {
        return None;
    }
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(dir.join("package/node_modules/@deepseek-ai/dsh/package.json")).ok()?,
    )
    .ok()?;
    (manifest["name"] == "@deepseek-ai/dsh" && manifest["version"] == VERSION).then_some(dir)
}

pub(super) fn installed() -> Option<PathBuf> {
    installed_at(&root())
}

/// Bounded read-only readiness check. File presence alone is not "can run".
pub(super) fn verify(dir: &Path) -> bool {
    let Ok(output) = tempfile::tempfile() else {
        return false;
    };
    let Ok(stdout) = output.try_clone() else {
        return false;
    };
    let Ok(test_home) = tempfile::tempdir() else {
        return false;
    };
    let mut command = std::process::Command::new(node(dir));
    command
        .arg(dir.join(CLI))
        .arg("--version")
        .env("DSH_HOME", test_home.path())
        .env("DSH_TELEMETRY_DISABLED", "1")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(std::process::Stdio::null())
        .stdout(stdout)
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    #[cfg(unix)]
    let process_group = child.id() as i32;
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Err(_) => break false,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(40))
            }
            Ok(None) => break false,
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    #[cfg(unix)]
    unsafe {
        libc::kill(-process_group, libc::SIGKILL);
    }
    use std::io::{Read, Seek};
    let mut output = output;
    let _ = output.rewind();
    let mut text = String::new();
    success && output.take(128).read_to_string(&mut text).is_ok() && text.trim() == VERSION
}

pub(super) async fn install(cancelled: Arc<AtomicBool>) -> Result<(), String> {
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(super::tool_install_process::CANCELLED.into());
    }
    let base = root();
    fs::create_dir_all(&base).map_err(|_| "无法创建 DSH 安装目录")?;
    // Reuse a verified installation; this entry point is installation, not an updater.
    if let Some(dir) = installed_at(&base) {
        if tokio::task::spawn_blocking(move || verify(&dir))
            .await
            .unwrap_or(false)
        {
            if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(super::tool_install_process::CANCELLED.into());
            }
            return Ok(());
        }
    }
    let stage = tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(&base)
        .map_err(|_| "无法创建 DSH 临时安装目录")?;
    #[cfg(not(windows))]
    let mut command = {
        let mut command = tokio::process::Command::new("bash");
        command.args(["-c", include_str!("../../scripts/install-dsh.sh")]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = tokio::process::Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &super::misc::powershell_encoded_command(include_str!("../../scripts/install-dsh.ps1")),
        ]);
        command
    };
    for (key, _) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if upper.starts_with("NPM_CONFIG_")
            || matches!(
                upper.as_str(),
                "NODE_OPTIONS" | "NODE_PATH" | "NPM_TOKEN" | "NODE_AUTH_TOKEN"
            )
        {
            command.env_remove(key);
        }
    }
    command
        .current_dir(stage.path())
        .env("YUANHENG_DSH_STAGE", stage.path());
    let output = match super::tool_install_process::run(
        command,
        cancelled.clone(),
        Duration::from_secs(600),
    )
    .await
    {
        Ok(output) => output,
        Err(error) => {
            if error.contains("[INSTALL_CLEANUP_FAILED]") {
                // Unknown live writers must not lose their working directory.
                let _ = stage.keep();
            }
            return Err(error);
        }
    };
    if !output.status.success() {
        let phase = fs::read_to_string(stage.path().join("phase")).unwrap_or_default();
        return Err(match phase.trim() {
            "download" => "DSH 的 Node.js 下载失败，请检查 nodejs.org 的连接后重试。",
            "checksum" => "DSH 的 Node.js 文件哈希不匹配，已拒绝解压和执行，请重新下载。",
            "extract" => "DSH 的 Node.js 解压失败，请检查磁盘空间和目录权限。",
            "package" => "DSH 官方 npm 包安装失败，请检查 registry.npmjs.org 的连接和磁盘空间。",
            "verify" => "DSH 已下载但无法通过运行检查，原安装未替换，请重新安装或反馈诊断。",
            _ => INSTALL_ERROR,
        }
        .into());
    }
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(super::tool_install_process::CANCELLED.into());
    }
    // Discard only disposable files from the supervisor-owned staging directory.
    for name in ["npm-cache", "verification-home", "unpack"] {
        let path = stage.path().join(name);
        if path.is_dir() {
            fs::remove_dir_all(path).map_err(|_| "DSH 安装临时文件清理失败")?;
        }
    }
    for name in ["runtime.tar.gz", "runtime.zip"] {
        let path = stage.path().join(name);
        if path.is_file() {
            fs::remove_file(path).map_err(|_| "DSH 安装临时文件清理失败")?;
        }
    }
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(super::tool_install_process::CANCELLED.into());
    }
    let name = format!("install-{}", uuid::Uuid::new_v4());
    let destination = base.join(&name);
    fs::rename(stage.path(), &destination).map_err(|_| "DSH 安装保存失败，原安装未替换")?;
    let mut marker = tempfile::NamedTempFile::new_in(&base).map_err(|_| "DSH 安装标记创建失败")?;
    marker
        .write_all(name.as_bytes())
        .map_err(|_| "DSH 安装标记写入失败")?;
    marker
        .persist(base.join("current"))
        .map_err(|_| "DSH 安装标记保存失败")?;
    Ok(())
}

#[cfg(not(windows))]
fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// Fixed Web arguments, explicit configuration home and telemetry opt-out.
pub(super) fn web_command(
    executable: &Path,
    args: &[String],
    runtime_bin: Option<&Path>,
) -> String {
    #[cfg(not(windows))]
    {
        let path = runtime_bin
            .map(|p| format!("PATH={}:\"$PATH\" ", posix_quote(&p.to_string_lossy())))
            .unwrap_or_default();
        format!(
            "{path}DSH_HOME={} DSH_TELEMETRY_DISABLED=1 env -u NODE_OPTIONS -u NODE_PATH {} {} --profile web --host 127.0.0.1 --port 0",
            posix_quote(&home().to_string_lossy()),
            posix_quote(&executable.to_string_lossy()),
            args.iter().map(|arg| posix_quote(arg)).collect::<Vec<_>>().join(" ")
        )
    }
    #[cfg(windows)]
    {
        let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let path = runtime_bin
            .map(|p| format!("$env:PATH={}+';'+$env:PATH;", quote(&p.to_string_lossy())))
            .unwrap_or_default();
        let script = format!(
            "{path}$env:DSH_HOME={};$env:DSH_TELEMETRY_DISABLED='1';$env:NODE_OPTIONS=$null;$env:NODE_PATH=$null;& {} {} --profile web --host 127.0.0.1 --port 0",
            quote(&home().to_string_lossy()), quote(&executable.to_string_lossy()),
            args.iter().map(|arg| quote(arg)).collect::<Vec<_>>().join(" ")
        );
        format!(
            "powershell.exe -NoProfile -EncodedCommand {}",
            super::misc::powershell_encoded_command(&script)
        )
    }
}

pub(super) fn managed_command(dir: &Path) -> String {
    let executable = node(dir);
    web_command(
        &executable,
        &[dir.join(CLI).to_string_lossy().into_owned()],
        executable.parent(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_unpublished_partial_install_and_path_escape() {
        let temp = tempfile::tempdir().unwrap();
        for marker in [
            "../other",
            "/tmp/other",
            "install-not-a-uuid",
            "install-00000000-0000-0000-0000-000000000000",
        ] {
            fs::write(temp.path().join("current"), marker).unwrap();
            assert!(installed_at(temp.path()).is_none());
        }
    }
    #[test]
    fn requires_exact_package_identity_and_complete_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let name = format!("install-{}", uuid::Uuid::new_v4());
        let dir = temp.path().join(&name);
        fs::create_dir_all(node(&dir).parent().unwrap()).unwrap();
        fs::create_dir_all(dir.join(CLI).parent().unwrap()).unwrap();
        fs::write(node(&dir), "synthetic-not-executable").unwrap();
        fs::write(dir.join(CLI), "").unwrap();
        let manifest = dir.join("package/node_modules/@deepseek-ai/dsh/package.json");
        fs::write(
            &manifest,
            format!(r#"{{"name":"@deepseek-ai/dsh","version":"{VERSION}"}}"#),
        )
        .unwrap();
        fs::write(temp.path().join("current"), &name).unwrap();
        assert_eq!(installed_at(temp.path()), Some(dir.clone()));
        assert!(!verify(&dir));
        fs::write(&manifest, r#"{"name":"other","version":"0.2.0-rc.2"}"#).unwrap();
        assert!(installed_at(temp.path()).is_none());
    }
    #[test]
    fn command_keeps_paths_as_arguments_and_web_loopback_only() {
        let command = web_command(
            Path::new("/tmp/test '$ x/node"),
            &["/tmp/test $ x/cli.js".into()],
            None,
        );
        assert!(command.contains("--profile web --host 127.0.0.1 --port 0") || cfg!(windows));
        #[cfg(not(windows))]
        {
            assert!(command.contains("'\"'\"'"));
            assert!(command.contains("DSH_TELEMETRY_DISABLED=1"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn shell_launch_preserves_literal_paths_and_clears_node_injection() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("node '$ (literal);");
        fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s\\n' \"$NODE_OPTIONS\" \"$NODE_PATH\" \"$@\"\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let arg = "$(echo unsafe) ' \"; literal";
        let command = web_command(&executable, &[arg.into()], None);
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .env("NODE_OPTIONS", "synthetic-injection")
            .env("NODE_PATH", "synthetic-other-runtime")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("\n\n{arg}\n--profile\nweb\n--host\n127.0.0.1\n--port\n0\n")
        );
    }
}
