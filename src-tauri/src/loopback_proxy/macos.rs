use super::*;
use std::os::unix::fs::PermissionsExt;
use std::{fs, path::PathBuf, process::Command, sync::Mutex};
const LABEL: &str = "com.yuanheng.loopback-proxy-bypass";
const SCRIPT: &str = include_str!("login.sh");
static MUTATION: Mutex<()> = Mutex::new(());

fn paths() -> Result<(PathBuf, PathBuf), String> {
    let home = dirs::home_dir().ok_or("无法读取用户主目录")?;
    Ok((
        crate::config::get_app_config_dir().join("loopback-proxy-bypass"),
        home.join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist")),
    ))
}
fn launchctl(args: &[&str]) -> Result<String, String> {
    let output = Command::new("/bin/launchctl")
        .args(args)
        .output()
        .map_err(|_| "无法运行用户环境管理命令")?;
    if !output.status.success() {
        return Err("用户环境管理命令失败；请重新检查兼容状态".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end_matches('\n')
        .to_string())
}
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn plist(root: &std::path::Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>{LABEL}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>{}</string><string>{}</string></array><key>RunAtLoad</key><true/><key>LimitLoadToSessionType</key><string>Aqua</string></dict></plist>
"#,
        xml(&root.join("login.sh").to_string_lossy()),
        xml(&root.to_string_lossy())
    )
}
fn io_error(_: std::io::Error) -> String {
    "兼容配置文件无法读写；原配置未自动覆盖，请检查权限".into()
}
fn domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}
fn verify_owned(root: &std::path::Path, agent: &std::path::Path) -> Result<(), String> {
    if fs::symlink_metadata(root)
        .map_err(io_error)?
        .file_type()
        .is_symlink()
        || fs::symlink_metadata(agent)
            .map_err(io_error)?
            .file_type()
            .is_symlink()
        || fs::read_to_string(root.join("login.sh")).map_err(io_error)? != SCRIPT
        || fs::read_to_string(agent).map_err(io_error)? != plist(root)
    {
        return Err("兼容配置被外部修改，已保留；请先处理冲突再重试".into());
    }
    for entry in fs::read_dir(root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        if entry.file_type().map_err(io_error)?.is_symlink() {
            return Err("兼容目录包含外部符号链接，已保留配置".into());
        }
    }
    Ok(())
}

pub(super) fn set_enabled(enabled: bool) -> Result<(), String> {
    let _guard = MUTATION.lock().map_err(|_| "兼容配置锁不可用")?;
    let (root, agent) = paths()?;
    if enabled {
        if root.exists() || agent.exists() {
            verify_owned(&root, &agent)?;
        } else {
            fs::create_dir_all(root.parent().ok_or("配置目录不可用")?).map_err(io_error)?;
            fs::create_dir(&root).map_err(io_error)?;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
            let upper = launchctl(&["getenv", KEYS[0]])?;
            let lower = launchctl(&["getenv", KEYS[1]])?;
            // Preserve GUI entries as well as those inherited by Meta API.
            fs::write(
                root.join("baseline"),
                merge(&[&upper, &lower, &environment()[0].1]),
            )
            .map_err(io_error)?;
            fs::write(root.join("login.sh"), SCRIPT).map_err(io_error)?;
            fs::create_dir_all(agent.parent().ok_or("登录项目目录不可用")?).map_err(io_error)?;
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&agent)
                .map_err(io_error)?;
            file.write_all(plist(&root).as_bytes()).map_err(io_error)?;
        }
        let applied = Command::new("/bin/sh")
            .arg(root.join("login.sh"))
            .arg(&root)
            .status()
            .map_err(io_error)?;
        if !applied.success() {
            return Err("登录环境应用失败，保留恢复记录，请重试或撤销".into());
        }
        let service = format!("{}/{LABEL}", domain());
        if launchctl(&["print", &service]).is_err() {
            launchctl(&["bootstrap", &domain(), &agent.to_string_lossy()])?;
        }
        if !KEYS
            .iter()
            .all(|key| launchctl(&["getenv", key]).is_ok_and(|v| protected(&v)))
        {
            return Err("登录环境复验未通过，请检查兼容状态".into());
        }
    } else {
        if !root.exists() && !agent.exists() {
            return Ok(());
        }
        verify_owned(&root, &agent)?;
        let applied = fs::read_to_string(root.join("applied")).map_err(io_error)?;
        // Compare both before any mutation. Do not overwrite later user edits.
        for key in KEYS {
            if launchctl(&["getenv", key])? != applied {
                return Err(
                    "登录环境已被其他程序修改，未覆盖或撤销；请保留新配置并手动处理冲突".into(),
                );
            }
        }
        let service = format!("{}/{LABEL}", domain());
        if launchctl(&["print", &service]).is_ok() {
            launchctl(&["bootout", &service])?;
        }
        let restored = Command::new("/bin/sh")
            .arg(root.join("login.sh"))
            .arg(&root)
            .arg("restore")
            .status()
            .map_err(io_error)?;
        if !restored.success() {
            return Err("撤销未完成，恢复记录已保留；请检查环境冲突后重试".into());
        }
        fs::remove_file(agent).map_err(io_error)?;
        for name in [
            "login.sh",
            "baseline",
            "before-upper",
            "before-lower",
            "applied",
        ] {
            fs::remove_file(root.join(name)).map_err(io_error)?;
        }
        // Never recursively delete a directory that could contain user additions.
        fs::remove_dir(root).map_err(io_error)?;
    }
    Ok(())
}

pub(super) fn status() -> Result<CompatibilityStatus, String> {
    let (root, agent) = paths()?;
    let mut result = CompatibilityStatus {
        supported: true,
        installed: root.exists() || agent.exists(),
        login_environment_protected: KEYS
            .iter()
            .all(|key| launchctl(&["getenv", key]).is_ok_and(|v| protected(&v))),
        ..Default::default()
    };
    // ps output stays in memory. Never return command lines, paths, or env values.
    let output = Command::new("/bin/ps")
        .args(["-axo", "uid=,pid=,comm="])
        .output()
        .map_err(io_error)?;
    if !output.status.success() {
        return Err("无法检查 Codex 进程环境".into());
    }
    let uid = unsafe { libc::getuid() }.to_string();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        if fields.next() != Some(uid.as_str()) {
            continue;
        }
        let Some(pid) = fields.next() else {
            continue;
        };
        let path = fields.collect::<Vec<_>>().join(" ");
        let desktop = path.ends_with(".app/Contents/MacOS/Codex")
            || path.ends_with(".app/Contents/MacOS/ChatGPT");
        let backend = path.ends_with("/codex")
            || path.ends_with("/codex-aarch64-apple-darwin")
            || path.ends_with("/codex-x86_64-apple-darwin");
        if !desktop && !backend {
            continue;
        }
        if desktop {
            result.desktop_processes += 1;
        } else {
            result.backend_processes += 1;
        }
        if pid
            .parse::<i32>()
            .ok()
            .and_then(process_environment)
            .is_some_and(|env| environment_protected(&env))
        {
            result.protected_processes += 1;
        } else {
            result.unverified_processes += 1;
        }
    }
    Ok(result)
}

// Read the actual kernel environment, never command arguments that look like env.
fn process_environment(pid: i32) -> Option<Vec<String>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: usize = 1024 * 1024;
    let mut bytes = vec![0u8; size];
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            bytes.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size < 4 {
        return None;
    }
    bytes.truncate(size);
    let argc = i32::from_ne_bytes(bytes[..4].try_into().ok()?);
    if !(0..=65536).contains(&argc) {
        return None;
    }
    let mut cursor = 4;
    while cursor < size && bytes[cursor] != 0 {
        cursor += 1;
    }
    while cursor < size && bytes[cursor] == 0 {
        cursor += 1;
    }
    for _ in 0..argc {
        while cursor < size && bytes[cursor] != 0 {
            cursor += 1;
        }
        cursor += 1;
    }
    Some(
        bytes
            .get(cursor..)?
            .split(|b| *b == 0)
            .filter(|v| !v.is_empty())
            .map(|v| String::from_utf8_lossy(v).into_owned())
            .collect(),
    )
}
fn environment_protected(env: &[String]) -> bool {
    KEYS.iter().all(|key| {
        env.iter()
            .filter_map(|part| part.strip_prefix(&format!("{key}=")))
            .any(protected)
    })
}

pub(crate) fn desktop_environment() -> Result<[(String, String); 2], String> {
    let upper = launchctl(&["getenv", KEYS[0]])?;
    let lower = launchctl(&["getenv", KEYS[1]])?;
    let value = merge(&[&upper, &lower, &environment()[0].1]);
    Ok(KEYS.map(|key| (key.into(), value.clone())))
}
fn app_processes(app: &std::path::Path) -> Result<Vec<i32>, String> {
    let app = fs::canonicalize(app).map_err(io_error)?;
    let output = Command::new("/bin/ps")
        .args(["-axo", "uid=,pid=,comm="])
        .output()
        .map_err(io_error)?;
    if !output.status.success() {
        return Err("无法检查桌面进程".into());
    }
    let uid = unsafe { libc::getuid() }.to_string();
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            if fields.next()? != uid {
                return None;
            }
            let pid = fields.next()?.parse::<i32>().ok()?;
            let path = fields.collect::<Vec<_>>().join(" ");
            // Main app and model backend, not renderer/helpers with sanitized environments.
            let name = std::path::Path::new(&path).file_name()?.to_str()?;
            (std::path::Path::new(&path).starts_with(&app)
                && matches!(
                    name,
                    "Codex"
                        | "ChatGPT"
                        | "codex"
                        | "codex-aarch64-apple-darwin"
                        | "codex-x86_64-apple-darwin"
                ))
            .then_some(pid)
        })
        .collect())
}
pub(crate) fn macos_app_needs_restart(app: &std::path::Path) -> Result<bool, String> {
    Ok(app_processes(app)?
        .iter()
        .any(|pid| !process_environment(*pid).is_some_and(|env| environment_protected(&env))))
}
pub(crate) fn restart_macos_app(app: &std::path::Path) -> Result<(), String> {
    // Limit termination to this user's selected bundle and its model backend.
    for pid in app_processes(app)? {
        if unsafe { libc::kill(pid, libc::SIGTERM) } != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            return Err("Codex 未能安全退出，请保存任务后手动退出重试".into());
        }
    }
    for _ in 0..40 {
        if app_processes(app)?.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(350));
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    Err("Codex 仍在运行，未强制结束任务；请手动退出后重试".into())
}

pub(crate) fn verify_macos_app(app: &std::path::Path) -> Result<(), String> {
    for _ in 0..20 {
        let processes = app_processes(app)?;
        if !processes.is_empty()
            && processes
                .iter()
                .all(|pid| process_environment(*pid).is_some_and(|env| environment_protected(&env)))
        {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    Err("应用已打开，但实际进程的本机绕过环境尚未确认。请保存任务后完全退出并重启，再运行智能体检。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_actual_child_environment_not_arguments() {
        // SIP hides environments of Apple platform executables such as /bin/sleep.
        // Use our own binary so this tests the same boundary as a third-party tool.
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "loopback_proxy::macos::tests::environment_fixture",
                "--ignored",
            ])
            .envs(environment())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let env = process_environment(child.id() as i32);
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(env.is_some_and(|env| environment_protected(&env)));
    }
    #[test]
    #[ignore = "explicit native QA: temporarily applies and restores the current user's login environment"]
    fn native_launchservices_acceptance() {
        assert_eq!(
            std::env::var("YUANHENG_NATIVE_PROXY_QA").as_deref(),
            Ok("1")
        );
        let (root, agent) = paths().unwrap();
        assert!(
            !root.exists() && !agent.exists(),
            "existing compatibility installation must not be touched by QA"
        );
        let before: Vec<_> = KEYS
            .iter()
            .map(|key| launchctl(&["getenv", key]).unwrap())
            .collect();
        let tmp = tempfile::tempdir().unwrap();
        let app = tmp.path().join("Proxy QA.app");
        let contents = app.join("Contents");
        fs::create_dir_all(contents.join("MacOS")).unwrap();
        fs::write(contents.join("Info.plist"), r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.yuanheng.loopback-qa</string><key>CFBundleExecutable</key><string>Codex</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>"#).unwrap();
        let source = tmp.path().join("fixture.c");
        fs::write(
            &source,
            "#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n",
        )
        .unwrap();
        assert!(Command::new("/usr/bin/cc")
            .arg(&source)
            .arg("-o")
            .arg(contents.join("MacOS/Codex"))
            .status()
            .unwrap()
            .success());
        struct Restore;
        impl Drop for Restore {
            fn drop(&mut self) {
                if set_enabled(false).is_err() {
                    eprintln!("Native QA rollback failed: inspect compatibility status");
                }
            }
        }
        let guard = Restore;
        // Managed launch injection, then a plain LaunchServices launch (Finder/Dock path).
        let mut open = Command::new("/usr/bin/open");
        open.arg("-n");
        for (key, value) in desktop_environment().unwrap() {
            open.args(["--env", &format!("{key}={value}")]);
        }
        assert!(open.arg(&app).status().unwrap().success());
        let verified = verify_macos_app(&app);
        restart_macos_app(&app).unwrap();
        verified.unwrap();
        set_enabled(true).unwrap();
        assert!(Command::new("/usr/bin/open")
            .args(["-n"])
            .arg(&app)
            .status()
            .unwrap()
            .success());
        let verified = verify_macos_app(&app);
        restart_macos_app(&app).unwrap();
        verified.unwrap();
        set_enabled(false).unwrap();
        drop(guard);
        assert!(!root.exists() && !agent.exists());
        for (key, original) in KEYS.iter().zip(before) {
            assert!(
                launchctl(&["getenv", key]).unwrap() == original,
                "original login environment must be restored"
            );
        }
    }

    #[test]
    #[ignore = "subprocess fixture for environment verification"]
    fn environment_fixture() {
        use std::io::Read;
        let _ = std::io::stdin().read(&mut [0u8]);
    }
}
