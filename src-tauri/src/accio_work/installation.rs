//! One compatibility rule for configuration, discovery hints and Core launch.
#[cfg(any(target_os = "macos", test))]
use std::path::Path;
use std::path::PathBuf;

pub(crate) const SUPPORTED_VERSIONS: &[&str] = &["0.34.5", "0.35.3", "0.37.1"];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Compatibility {
    pub installed_version: Option<String>,
    pub supported_versions: Vec<String>,
    /// verified_version is a version hint, never proof of a trusted executable.
    pub state: String,
}

impl Compatibility {
    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn from_version(version: Option<String>) -> Self {
        let state = match version.as_deref() {
            Some(v) if SUPPORTED_VERSIONS.contains(&v) => "verified_version",
            Some(_) => "unverified_version",
            None => "unavailable",
        };
        Self {
            installed_version: version,
            supported_versions: SUPPORTED_VERSIONS.iter().map(|v| (*v).into()).collect(),
            state: state.into(),
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) async fn require_not_running() -> Result<(), String> {
    let mut running = tokio::process::Command::new("/usr/bin/pgrep");
    running.args(["-x", "Accio"]);
    match super::bounded_output(&mut running).await?.status.code() {
        Some(1) => Ok(()),
        Some(0) => Err("请先保存工作并完整退出 Accio，再从元衡启动".into()),
        _ => Err("无法确认 Accio 是否正在运行，已停止启动".into()),
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn require_supported_version(version: &str) -> Result<(), String> {
    if SUPPORTED_VERSIONS.contains(&version) {
        Ok(())
    } else {
        Err(format!(
            "检测到 Accio {version}，此版本尚未完成兼容验证，当前支持 {}。请等待元衡适配更新；原配置未更改。",
            SUPPORTED_VERSIONS.join("、")
        ))
    }
}

#[cfg(any(target_os = "macos", test))]
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
    fn accio_compatibility_hints_distinguish_missing_unknown_and_verified() {
        assert_eq!(Compatibility::from_version(None).state, "unavailable");
        assert_eq!(
            Compatibility::from_version(Some("0.37.1".into())).state,
            "verified_version"
        );
        let unknown = Compatibility::from_version(Some("99.0.0".into()));
        assert_eq!(unknown.state, "unverified_version");
        assert_eq!(unknown.installed_version.as_deref(), Some("99.0.0"));
        assert!(unknown.supported_versions.contains(&"0.37.1".into()));
    }

    #[test]
    fn exact_versions_reject_unverified_updates_and_lookalikes() {
        for version in ["0.34.5", "0.35.3", "0.37.1"] {
            assert!(require_supported_version(version).is_ok());
        }
        for version in [
            "0.35.2",
            "0.35.4",
            "0.35.3-beta",
            "0.35.30",
            "0.37.0",
            "0.37.2",
            "0.37.1-beta",
            "0.37.10",
            " 0.35.3",
            "0.35.3\n",
            "",
        ] {
            assert!(require_supported_version(version).is_err(), "{version:?}");
        }
    }

    #[test]
    fn unsupported_version_error_identifies_the_detected_version() {
        let error = require_supported_version("0.37.2").unwrap_err();
        assert!(error.contains("检测到 Accio 0.37.2"));
        assert!(error.contains("0.37.1"));
        assert!(error.contains("原配置未更改"));
    }

    #[test]
    fn application_path_cannot_be_a_relative_path_or_command() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("Accio.app");
        assert!(validate_path(&app).is_ok());
        for path in [
            PathBuf::from("Accio.app"),
            app.join("Contents/MacOS/Accio"),
            root.path().join("Accio.app\n"),
        ] {
            assert!(validate_path(&path).is_err());
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
