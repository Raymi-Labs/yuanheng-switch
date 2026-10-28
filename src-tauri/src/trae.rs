//! Official TRAE launcher for assisted setup, not a model configuration adapter.

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

fn validate_launch_options(restart: bool, cwd: Option<&str>) -> Result<(), String> {
    if restart || cwd.is_some() {
        return Err("TRAE 辅助入口不支持强制重启或更改工作目录".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn bundle_identity(tool: &str) -> Result<(&'static str, &'static str), String> {
    match tool {
        "trae" => Ok(("Trae.app", "=anchor apple generic and identifier \"com.trae.app\" and certificate leaf[subject.OU] = \"79M8227NKH\"")),
        "trae-cn" => Ok(("Trae CN.app", "=anchor apple generic and identifier \"cn.trae.app\" and certificate leaf[subject.OU] = \"CG2SCM6AV5\"")),
        _ => Err("请选择受支持的 TRAE 版本".into()),
    }
}

#[cfg(target_os = "macos")]
fn validate_bundle_path(path: &Path, tool: &str) -> Result<(), String> {
    let (bundle, _) = bundle_identity(tool)?;
    let valid = path.is_absolute()
        && path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(bundle))
        && path
            .to_str()
            .is_some_and(|s| !s.chars().any(char::is_control));
    if valid {
        Ok(())
    } else {
        Err(format!("请选择所选版本的完整官方 {bundle} 应用"))
    }
}

#[cfg(target_os = "macos")]
async fn run_bounded(command: &mut tokio::process::Command) -> Result<bool, String> {
    use std::{process::Stdio, time::Duration};
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "TRAE 本地校验或启动命令无法执行")?;
    match tokio::time::timeout(Duration::from_secs(15), child.wait()).await {
        Ok(Ok(status)) => Ok(status.success()),
        Ok(Err(_)) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err("TRAE 本地校验或启动命令执行失败".into())
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err("TRAE 本地校验或启动超时，请重新检测".into())
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) async fn verify(path: &Path, tool: &str) -> Result<PathBuf, String> {
    validate_bundle_path(path, tool)?;
    let path = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::fs::canonicalize(path),
    )
    .await
    .map_err(|_| "TRAE 路径检查超时")?
    .map_err(|_| "TRAE 路径已失效，请重新选择应用")?;
    validate_bundle_path(&path, tool)?;
    let (_, requirement) = bundle_identity(tool)?;
    let mut command = tokio::process::Command::new("/usr/bin/codesign");
    command
        .args(["--verify", "--deep", "--strict", "-R", requirement])
        .arg(&path);
    if !run_bounded(&mut command).await? {
        return Err("TRAE 官方身份或签名校验失败，请安装所选版本的官方应用；未启动应用".into());
    }
    Ok(path)
}

#[cfg(target_os = "macos")]
fn launch_path(
    found: crate::desktop_app_detection::DesktopAppResolution,
) -> Result<PathBuf, String> {
    if found.custom_path.is_some() && !found.custom_path_valid {
        return Err("TRAE 自选路径已失效，请重新选择或清除后检测".into());
    }
    match found.launch_target {
        Some(crate::desktop_app_detection::DesktopLaunchTarget::Path(path)) => Ok(path),
        _ => Err("未检测到 TRAE，请先安装或选择官方应用路径".into()),
    }
}

pub(crate) async fn launch(
    app: &tauri::AppHandle,
    tool: &str,
    restart: bool,
    cwd: Option<&str>,
) -> Result<(), String> {
    validate_launch_options(restart, cwd)?;
    #[cfg(target_os = "macos")]
    {
        use crate::desktop_app_detection::discover_desktop_app;
        bundle_identity(tool)?;
        let custom = crate::app_store::get_desktop_app_path_from_store(app, tool);
        let target = tool.to_owned();
        let found =
            tokio::task::spawn_blocking(move || discover_desktop_app(&target, custom.as_deref()))
                .await
                .map_err(|_| "TRAE 应用检测失败，请重试")?;
        let path = verify(&launch_path(found)?, tool).await?;
        // No shell, model/API-key arguments, process termination or app patching.
        // LaunchServices brings an existing instance forward if one is running.
        let mut open = tokio::process::Command::new("/usr/bin/open");
        open.arg("-a").arg(path);
        if !run_bounded(&mut open).await? {
            return Err("TRAE 启动失败，请手动打开检查系统提示".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, tool);
        Err("当前系统的 TRAE 自动启动尚未验证，请手动打开官方应用".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assisted_launch_cannot_restart_or_choose_a_workspace() {
        assert!(validate_launch_options(false, None).is_ok());
        assert!(validate_launch_options(true, None).is_err());
        assert!(validate_launch_options(false, Some("/tmp/project")).is_err());
        assert!(validate_launch_options(false, Some("")).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn paths_must_name_the_complete_international_app() {
        assert!(validate_bundle_path(Path::new("/Applications/Trae.app"), "trae").is_ok());
        for path in [
            "Trae.app",
            "/Applications/Trae CN.app",
            "/Applications/TraeWork.app",
            "/Applications/TraeCode.app",
            "/Applications/Trae.app/Contents/MacOS/Electron",
            "/Applications/Trae.app\n",
        ] {
            assert!(
                validate_bundle_path(Path::new(path), "trae").is_err(),
                "{path:?}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stale_custom_path_cannot_silently_launch_another_installation() {
        let found = crate::desktop_app_detection::DesktopAppResolution {
            install_path: Some("/Applications/Trae.app".into()),
            version: None,
            detection_source: "automatic",
            custom_path: Some("/missing/Trae.app".into()),
            custom_path_valid: false,
            launch_target: Some(crate::desktop_app_detection::DesktopLaunchTarget::Path(
                PathBuf::from("/Applications/Trae.app"),
            )),
        };
        assert!(launch_path(found).unwrap_err().contains("自选路径"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn unsigned_same_name_bundle_cannot_launch() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("Trae.app");
        std::fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
        std::fs::write(path.join("Contents/Info.plist"), r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.trae.app</string></dict></plist>"#).unwrap();
        assert!(verify(&path, "trae").await.unwrap_err().contains("签名"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn symlink_to_another_app_is_rejected_after_canonicalization() {
        let root = tempfile::tempdir().unwrap();
        let other = root.path().join("Other.app");
        std::fs::create_dir_all(&other).unwrap();
        let path = root.path().join("Trae.app");
        std::os::unix::fs::symlink(other, &path).unwrap();
        assert!(verify(&path, "trae").await.unwrap_err().contains("完整"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn china_launch_rejects_unsigned_bundles_and_cross_edition_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let cn = root.path().join("Trae CN.app");
        std::fs::create_dir_all(cn.join("Contents/MacOS")).unwrap();
        std::fs::write(cn.join("Contents/Info.plist"), r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cn.trae.app</string></dict></plist>"#).unwrap();
        assert!(verify(&cn, "trae-cn").await.unwrap_err().contains("签名"));
        assert!(verify(&cn, "trae").await.unwrap_err().contains("完整"));
        let alias = root.path().join("Trae.app");
        std::os::unix::fs::symlink(&cn, &alias).unwrap();
        assert!(verify(&alias, "trae").await.unwrap_err().contains("完整"));
        assert!(verify(&cn, "unknown").await.is_err());
    }
}
