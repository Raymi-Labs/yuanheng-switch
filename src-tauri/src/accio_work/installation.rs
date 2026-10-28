//! One compatibility rule for configuration, discovery hints and Core launch.
use std::path::{Path, PathBuf};

pub(crate) const SUPPORTED_VERSIONS: &[&str] = &["0.34.5", "0.35.3"];

pub(crate) fn require_supported_version(version: &str) -> Result<(), String> {
    if SUPPORTED_VERSIONS.contains(&version) {
        Ok(())
    } else {
        Err(format!(
            "此 Accio 版本尚未完成兼容验证，当前支持 {}。请等待元衡适配更新；原配置未更改。",
            SUPPORTED_VERSIONS.join("、")
        ))
    }
}

pub(crate) fn validate_path(path: &Path) -> Result<(), String> {
    let value = path.to_str().ok_or("Accio 应用路径无效")?;
    if !path.is_absolute()
        || path.extension().is_none_or(|extension| extension != "app")
        || value.len() > 4096
        || value.chars().any(char::is_control)
    {
        return Err("Accio 应用路径无效，请选择官方 Accio.app".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) async fn version_at(path: &Path) -> Result<String, String> {
    validate_path(path)?;
    let mut version = tokio::process::Command::new("/usr/libexec/PlistBuddy");
    version
        .args(["-c", "Print :CFBundleShortVersionString"])
        .arg(path.join("Contents/Info.plist"));
    let output = super::bounded_output(&mut version).await?;
    let version = String::from_utf8(output.stdout)
        .map_err(|_| "无法识别 Accio 版本，请检查官方应用是否完整")?;
    let version = version.trim();
    if !output.status.success()
        || version.is_empty()
        || version.len() > 40
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        return Err("无法识别 Accio 版本，请检查官方应用是否完整".into());
    }
    Ok(version.to_string())
}

#[cfg(target_os = "macos")]
pub(crate) async fn verify(path: &Path) -> Result<PathBuf, String> {
    validate_path(path)?;
    let path = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::fs::canonicalize(path),
    )
    .await
    .map_err(|_| "Accio 应用路径检查超时")?
    .map_err(|_| "Accio 应用路径不可用，请重新检测或选择官方应用")?;
    validate_path(&path)?;
    // Never cache a signature decision across configure/launch. Version hints
    // shown in the UI do not authorize starting an executable.
    let mut signature = tokio::process::Command::new("/usr/bin/codesign");
    signature.args(["--verify", "--deep", "--strict", "-R",
        "=anchor apple generic and identifier \"com.accio.desktop\" and certificate leaf[subject.OU] = \"P75YXKHHMH\""]).arg(&path);
    if !super::bounded_output(&mut signature)
        .await?
        .status
        .success()
    {
        return Err("Accio 官方身份或签名校验失败，请重新安装官方应用；原配置未更改".into());
    }
    require_supported_version(&version_at(&path).await?)?;
    Ok(path)
}

pub(crate) async fn resolve(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if !super::EXPERIMENTAL_ENABLED || !cfg!(target_os = "macos") {
        return Err("当前构建或系统尚未启用 Accio 主模型接入".into());
    }
    let custom = crate::app_store::get_desktop_app_path_from_store(app, super::SCOPE);
    let resolution = tokio::task::spawn_blocking(move || {
        crate::desktop_app_detection::discover_desktop_app(super::SCOPE, custom.as_deref())
    })
    .await
    .map_err(|_| "Accio 应用检测失败，请重试")?;
    if resolution.custom_path.is_some() && !resolution.custom_path_valid {
        return Err("原 Accio 自定义路径已失效，请重新选择或清除后自动检测".into());
    }
    match resolution.launch_target {
        Some(crate::desktop_app_detection::DesktopLaunchTarget::Path(path)) => Ok(path),
        _ => Err("请先安装 Accio Work，或在工具管理中选择官方应用路径".into()),
    }
}

pub(crate) async fn preflight(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = resolve(app).await?;
    #[cfg(target_os = "macos")]
    {
        verify(&path).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("当前系统的 Accio 主模型接入尚未验收".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_versions_reject_unverified_updates_and_lookalikes() {
        for version in ["0.34.5", "0.35.3"] {
            assert!(require_supported_version(version).is_ok());
        }
        for version in [
            "0.35.2",
            "0.35.4",
            "0.35.3-beta",
            "0.35.30",
            " 0.35.3",
            "0.35.3\n",
            "",
        ] {
            assert!(require_supported_version(version).is_err(), "{version:?}");
        }
    }

    #[test]
    fn application_path_cannot_be_a_relative_path_or_command() {
        assert!(validate_path(Path::new("/Applications/Accio.app")).is_ok());
        for path in [
            "Accio.app",
            "/Applications/Accio.app/Contents/MacOS/Accio",
            "/Applications/Accio.app\n",
        ] {
            assert!(validate_path(Path::new(path)).is_err());
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn unsigned_same_name_application_cannot_pass_preflight() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("Accio.app");
        std::fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
        std::fs::write(path.join("Contents/Info.plist"), "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleShortVersionString</key><string>0.35.3</string><key>CFBundleIdentifier</key><string>com.accio.desktop</string></dict></plist>").unwrap();
        assert_eq!(version_at(&path).await.unwrap(), "0.35.3");
        assert!(verify(&path).await.unwrap_err().contains("签名"));
    }
}
