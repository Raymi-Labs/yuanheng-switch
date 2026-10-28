//! Desktop application discovery shared by installation checks and launching.
//!
//! Desktop apps are not CLI tools: Store/MSIX installs are often absent from
//! `PATH`, and classic installers may use a per-user or custom directory. Keep
//! discovery and launch resolution in one place so the UI never says an app is
//! missing while the launcher can actually find it (or the reverse).

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DesktopLaunchTarget {
    Path(PathBuf),
    #[cfg(target_os = "windows")]
    AppUserModelId(String),
}

#[derive(Debug, Clone)]
pub(crate) struct DesktopAppResolution {
    pub install_path: Option<String>,
    pub version: Option<String>,
    pub detection_source: &'static str,
    pub custom_path: Option<String>,
    pub custom_path_valid: bool,
    pub launch_target: Option<DesktopLaunchTarget>,
}

impl DesktopAppResolution {
    fn not_found(custom_path: Option<String>) -> Self {
        Self {
            install_path: None,
            version: None,
            detection_source: "not_found",
            custom_path_valid: custom_path.is_none(),
            custom_path,
            launch_target: None,
        }
    }
}

pub(crate) fn is_dsh_source(path: &Path) -> bool {
    (path.join("apps/desktop/package.json").is_file() || path.join("apps/cli/src/bin.ts").is_file())
        && std::fs::read_to_string(path.join("package.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .is_some_and(|v| v["name"] == "@deepseek-ai/dsh-root")
}

fn executable_names(tool: &str) -> &'static [&'static str] {
    match tool {
        "trae-cn" => {
            #[cfg(target_os = "macos")]
            {
                &["Trae CN.app"]
            }
            #[cfg(not(target_os = "macos"))]
            {
                &[]
            }
        }
        "trae" => {
            #[cfg(target_os = "macos")]
            {
                &["Trae.app"]
            }
            #[cfg(not(target_os = "macos"))]
            {
                &[]
            }
        }
        "accio-work" => {
            #[cfg(target_os = "macos")]
            {
                &["Accio.app"]
            }
            #[cfg(not(target_os = "macos"))]
            {
                &[]
            }
        }
        "chatgpt-desktop" => {
            #[cfg(target_os = "macos")]
            {
                &["ChatGPT.app", "Codex.app"]
            }
            #[cfg(not(target_os = "macos"))]
            {
                &["ChatGPT.exe", "Codex.exe"]
            }
        }
        "dsh" => {
            #[cfg(target_os = "macos")]
            {
                &["DeepSeek Harness.app"]
            }
            #[cfg(not(target_os = "macos"))]
            {
                &["DeepSeek Harness.exe"]
            }
        }
        "workbuddy" => {
            #[cfg(target_os = "macos")]
            {
                &["WorkBuddy.app"]
            }
            #[cfg(not(target_os = "macos"))]
            {
                &["WorkBuddy.exe"]
            }
        }
        "claude-desktop" => {
            #[cfg(target_os = "macos")]
            {
                &["Claude.app"]
            }
            #[cfg(not(target_os = "macos"))]
            {
                &["Claude.exe"]
            }
        }
        _ => &[],
    }
}

fn filename_matches(tool: &str, path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    executable_names(tool)
        .iter()
        .any(|expected| expected.eq_ignore_ascii_case(name))
}

fn is_windows_apps_path(path: &Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    normalized
        .split('/')
        .any(|component| matches!(component, "windowsapps" | "modifiablewindowsapps"))
}

fn direct_desktop_launch_path_allowed(path: &Path) -> bool {
    !is_windows_apps_path(path)
}

/// Resolve an executable below a user-selected directory.
///
/// Electron installers commonly keep the current executable below an
/// `app-*` version directory. A shallow bounded walk covers that layout
/// without turning every refresh into a full-disk search.
fn find_executable_in_directory(tool: &str, root: &Path, max_depth: usize) -> Option<PathBuf> {
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        let mut entries = entries.flatten().collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_file() && filename_matches(tool, &path) {
                return Some(path);
            }
            if file_type.is_dir() && depth < max_depth {
                pending.push((path, depth + 1));
            }
        }
    }
    None
}

fn resolve_file_candidate(tool: &str, path: &Path) -> Option<PathBuf> {
    if path.is_file() && filename_matches(tool, path) {
        return Some(path.to_path_buf());
    }
    #[cfg(target_os = "macos")]
    if path.is_dir() && filename_matches(tool, path) {
        return Some(path.to_path_buf());
    }
    if !path.is_dir() {
        return None;
    }

    for name in executable_names(tool) {
        for candidate in [path.join(name), path.join("bin").join(name)] {
            #[cfg(target_os = "macos")]
            let exists = candidate.is_dir() || candidate.is_file();
            #[cfg(not(target_os = "macos"))]
            let exists = candidate.is_file();
            if exists {
                return Some(candidate);
            }
        }
    }
    find_executable_in_directory(tool, path, 4)
}

pub(crate) fn validate_custom_desktop_app_path(
    tool: &str,
    raw_path: &str,
) -> Result<PathBuf, String> {
    if executable_names(tool).is_empty() {
        return Err(format!("不支持为 {tool} 设置桌面应用路径"));
    }
    let trimmed = raw_path.trim();
    if trimmed.is_empty() || trimmed.contains('\n') || trimmed.contains('\r') {
        return Err("应用路径为空或包含非法换行符".to_string());
    }
    let path = PathBuf::from(trimmed);
    if tool == "dsh" && is_dsh_source(&path) {
        return std::fs::canonicalize(path).map_err(|_| "无法解析 DSH 源码目录".into());
    }
    let resolved = resolve_file_candidate(tool, &path)
        .ok_or_else(|| format!("所选路径中未找到 {}", executable_names(tool).join(" / ")))?;
    let canonical =
        std::fs::canonicalize(&resolved).map_err(|error| format!("解析应用路径失败: {error}"))?;
    if matches!(tool, "trae" | "trae-cn") && !filename_matches(tool, &canonical) {
        return Err("所选 TRAE 路径指向其他版本，请重新选择".into());
    }
    if !direct_desktop_launch_path_allowed(&resolved)
        || !direct_desktop_launch_path_allowed(&canonical)
    {
        return Err(
            "Microsoft Store 应用不能通过 WindowsApps 内的 EXE 直接启动，请重新检测应用"
                .to_string(),
        );
    }
    Ok(canonical)
}

fn custom_resolution(tool: &str, custom_path: Option<&str>) -> Option<DesktopAppResolution> {
    let raw = custom_path?.trim();
    if raw.is_empty() {
        return None;
    }
    let canonical = validate_custom_desktop_app_path(tool, raw).ok()?;
    let display = canonical.to_string_lossy().to_string();
    Some(DesktopAppResolution {
        install_path: Some(display.clone()),
        version: None,
        detection_source: "custom",
        custom_path: Some(raw.to_string()),
        custom_path_valid: true,
        launch_target: Some(DesktopLaunchTarget::Path(canonical)),
    })
}

#[cfg(target_os = "windows")]
fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !path.as_os_str().is_empty() && !paths.contains(&path) {
        paths.push(path);
    }
}

#[cfg(target_os = "windows")]
fn windows_desktop_directory_names(tool: &str) -> &'static [&'static str] {
    match tool {
        "chatgpt-desktop" => &[
            "ChatGPT",
            "ChatGPT Desktop",
            "Codex",
            "OpenAI",
            "OpenAI ChatGPT",
            "OpenAI Codex",
        ],
        "claude-desktop" => &[
            "Claude",
            "Claude Desktop",
            "claude-desktop",
            "Anthropic",
            "AnthropicClaude",
        ],
        "dsh" => &["DeepSeek Harness", "deepseek-harness"],
        "workbuddy" => &["WorkBuddy", "CodeBuddy", "Tencent", "CodeBuddy Work"],
        _ => &[],
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn classic_candidates(tool: &str) -> Vec<(PathBuf, &'static str)> {
    let mut candidates = Vec::new();

    #[cfg(target_os = "macos")]
    {
        for name in executable_names(tool) {
            candidates.push((PathBuf::from("/Applications").join(name), "automatic"));
            candidates.push((
                crate::config::get_home_dir()
                    .join("Applications")
                    .join(name),
                "automatic",
            ));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut roots = Vec::new();
        for key in [
            "LOCALAPPDATA",
            "APPDATA",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "ProgramData",
            "USERPROFILE",
        ] {
            if let Some(value) = std::env::var_os(key) {
                push_unique(&mut roots, PathBuf::from(value));
            }
        }
        let directory_names = windows_desktop_directory_names(tool);
        for root in roots {
            for name in executable_names(tool) {
                let stem = name.trim_end_matches(".exe");
                for path in [
                    root.join("Programs").join(stem).join(name),
                    root.join(stem).join(name),
                    root.join("OpenAI").join(stem).join(name),
                ] {
                    candidates.push((path, "automatic"));
                }
            }

            // Cover per-user installers, custom install roots and Electron's
            // app-* version directories without scanning the whole drive.
            for base in [
                root.clone(),
                root.join("Programs"),
                root.join("OpenAI"),
                root.join("Anthropic"),
                root.join("Tencent"),
            ] {
                for directory_name in directory_names {
                    candidates.push((base.join(directory_name), "automatic"));
                }
            }
        }
        candidates.extend(windows_registry_candidates(tool));
    }

    candidates
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn classic_candidates(_tool: &str) -> Vec<(PathBuf, &'static str)> {
    Vec::new()
}

fn automatic_classic_resolution(tool: &str) -> Option<DesktopAppResolution> {
    let mut seen = Vec::new();
    for (candidate, source) in classic_candidates(tool) {
        let Some(resolved) = resolve_file_candidate(tool, &candidate) else {
            continue;
        };
        let canonical = std::fs::canonicalize(&resolved).unwrap_or(resolved);
        if !direct_desktop_launch_path_allowed(&canonical) {
            continue;
        }
        if seen.contains(&canonical) {
            continue;
        }
        seen.push(canonical.clone());
        let display = canonical.to_string_lossy().to_string();
        return Some(DesktopAppResolution {
            install_path: Some(display),
            version: None,
            detection_source: source,
            custom_path: None,
            custom_path_valid: true,
            launch_target: Some(DesktopLaunchTarget::Path(canonical)),
        });
    }
    None
}

#[cfg(target_os = "windows")]
fn windows_registry_candidates(tool: &str) -> Vec<(PathBuf, &'static str)> {
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    fn clean_executable_path(raw: &str) -> Option<PathBuf> {
        let value = raw.trim();
        if value.is_empty() {
            return None;
        }

        let value = if value.starts_with('"') {
            value
                .get(1..)
                .and_then(|value| value.find('"').map(|end| &value[..end]))
                .unwrap_or(value)
        } else {
            let lower = value.to_ascii_lowercase();
            lower
                .find(".exe")
                .map(|end| &value[..end + ".exe".len()])
                .unwrap_or(value)
        };
        let value = value
            .trim()
            .trim_matches('"')
            .rsplit_once(',')
            .filter(|(_, suffix)| suffix.trim().parse::<i32>().is_ok())
            .map(|(path, _)| path)
            .unwrap_or(value)
            .trim();
        (!value.is_empty()).then(|| PathBuf::from(value))
    }

    fn display_name_matches(tool: &str, name: &str) -> bool {
        let name = name.to_ascii_lowercase();
        match tool {
            "chatgpt-desktop" => name.contains("chatgpt") || name == "codex",
            "claude-desktop" => name.contains("claude"),
            "workbuddy" => name.contains("workbuddy"),
            "dsh" => name.contains("deepseek harness"),
            _ => false,
        }
    }

    let roots = [
        RegKey::predef(HKEY_CURRENT_USER),
        RegKey::predef(HKEY_LOCAL_MACHINE),
        RegKey::predef(HKEY_CLASSES_ROOT),
    ];
    let mut results = Vec::new();
    for root in roots {
        for name in executable_names(tool) {
            for key_path in [
                format!(r"Software\Microsoft\Windows\CurrentVersion\App Paths\{name}"),
                format!(r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\{name}"),
            ] {
                if let Ok(key) = root.open_subkey_with_flags(key_path, KEY_READ) {
                    if let Ok(value) = key.get_value::<String, _>("") {
                        if let Some(path) = clean_executable_path(&value) {
                            results.push((path, "registry"));
                        }
                    }
                }

                // Some installers register only a shell verb rather than an
                // App Paths entry. The merged HKCR view covers both user and
                // machine registrations.
                for command_key in [
                    format!(r"Software\Classes\Applications\{name}\shell\open\command"),
                    format!(r"Applications\{name}\shell\open\command"),
                ] {
                    if let Ok(key) = root.open_subkey_with_flags(command_key, KEY_READ) {
                        if let Ok(value) = key.get_value::<String, _>("") {
                            if let Some(path) = clean_executable_path(&value) {
                                results.push((path, "registry"));
                            }
                        }
                    }
                }
            }
        }

        for uninstall_root in [
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ] {
            let Ok(key) = root.open_subkey_with_flags(uninstall_root, KEY_READ) else {
                continue;
            };
            for subkey_name in key.enum_keys().flatten() {
                let Ok(subkey) = key.open_subkey_with_flags(&subkey_name, KEY_READ) else {
                    continue;
                };
                let display_name = subkey
                    .get_value::<String, _>("DisplayName")
                    .unwrap_or_default();
                if !display_name_matches(tool, &display_name) {
                    continue;
                }
                if let Ok(icon) = subkey.get_value::<String, _>("DisplayIcon") {
                    if let Some(path) = clean_executable_path(&icon) {
                        results.push((path, "registry"));
                    }
                }
                for value_name in [
                    "InstallLocation",
                    "InstallSource",
                    "AppPath",
                    "ExecutablePath",
                    "TargetPath",
                ] {
                    if let Ok(value) = subkey.get_value::<String, _>(value_name) {
                        if let Some(path) = clean_executable_path(&value) {
                            results.push((path, "registry"));
                        }
                        results.push((PathBuf::from(value), "registry"));
                    }
                }
            }
        }
    }
    results
}

#[cfg(target_os = "windows")]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreAppInfo {
    app_user_model_id: Option<String>,
    install_location: Option<String>,
    version: Option<String>,
}

#[cfg(any(target_os = "windows", test))]
const CLAUDE_STORE_PACKAGE_FAMILY: &str = "claude_pzs8sxrjxfjjc";

#[cfg(any(target_os = "windows", test))]
fn is_trusted_store_aumid(tool: &str, value: &str) -> bool {
    let Some((package_family, app_id)) = value.trim().split_once('!') else {
        return false;
    };
    if package_family.contains('!') || app_id.is_empty() || app_id.contains('!') {
        return false;
    }

    let family = package_family.to_ascii_lowercase();
    let family_is_valid = family
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'));
    let family_is_trusted = match tool {
        "chatgpt-desktop" => {
            family.starts_with("openai.")
                && (family.contains("chatgpt") || family.contains("codex"))
        }
        "claude-desktop" => {
            // New official MSIX identity observed with Anthropic's signature.
            // Match the full family (including publisher ID), never "Claude_*".
            family == CLAUDE_STORE_PACKAGE_FAMILY
        }
        _ => false,
    };
    family_is_valid
        && family_is_trusted
        && app_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

#[cfg(target_os = "windows")]
fn powershell_encoded_command(script: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    STANDARD.encode(bytes)
}

#[cfg(target_os = "windows")]
fn windows_store_resolution(tool: &str) -> Option<DesktopAppResolution> {
    use std::os::windows::process::CommandExt;

    let claude_family_pattern = format!("(?i)^{}!", regex::escape(CLAUDE_STORE_PACKAGE_FAMILY));
    let (package_pattern, publisher_pattern, start_name_pattern, start_family_pattern) = match tool
    {
        "chatgpt-desktop" => (
            "(?i)(chatgpt|codex)",
            "(?i)openai",
            "(?i)^(chatgpt|codex)(\\s+desktop)?$",
            "(?i)^openai\\.",
        ),
        "claude-desktop" => (
            "(?i)claude",
            "(?i)anthropic",
            "(?i)^claude(\\s+desktop)?$",
            claude_family_pattern.as_str(),
        ),
        _ => return None,
    };

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
$packagePattern = '__PACKAGE_PATTERN__'
$publisherPattern = '__PUBLISHER_PATTERN__'
$startNamePattern = '__START_NAME_PATTERN__'
$startFamilyPattern = '__START_FAMILY_PATTERN__'
$requiredFamily = '__REQUIRED_FAMILY__'
$packages = @(Get-AppxPackage -PackageTypeFilter Main -ErrorAction SilentlyContinue) |
  Where-Object {
    ($requiredFamily -eq '' -or $_.PackageFamilyName -ieq $requiredFamily) -and
    ($_.Name -match $packagePattern -or $_.PackageFamilyName -match $packagePattern) -and
    ($_.Publisher -match $publisherPattern -or $_.PublisherDisplayName -match $publisherPattern)
  } | Sort-Object @{ Expression = { [version]$_.Version }; Descending = $true }
$startApps = @(Get-StartApps -ErrorAction SilentlyContinue) |
  Where-Object {
    $_.Name -match $startNamePattern -and
    $_.AppID -match $startFamilyPattern
  }

foreach ($pkg in $packages) {
  $manifest = Get-AppxPackageManifest $pkg
  $appIds = @(
    $manifest.Package.Applications.Application.Id |
      Where-Object { $_ } |
      ForEach-Object { $_.ToString() }
  )
  if ($appIds.Count -eq 0) { continue }
  $familyPrefix = "$($pkg.PackageFamilyName)!"
  $registeredAumid = $startApps | Where-Object {
    $candidateAumid = $_.AppID
    if (-not $candidateAumid.StartsWith(
      $familyPrefix,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      $false
    } else {
      $candidateAppId = $candidateAumid.Substring($familyPrefix.Length)
      $appIds -contains $candidateAppId
    }
  } | Select-Object -ExpandProperty AppID -First 1
  $aumid = if ($registeredAumid) {
    $registeredAumid
  } else {
    "$familyPrefix$($appIds[0])"
  }
  [PSCustomObject]@{
    appUserModelId = $aumid
    installLocation = $pkg.InstallLocation
    version = $pkg.Version.ToString()
  } | ConvertTo-Json -Compress
  exit 0
}

# Get-AppxPackage may omit a package registered for the current user on some
# Windows builds. A Start menu AUMID still launches it without touching the
# protected WindowsApps directory; Rust validates its publisher family.
foreach ($start in $startApps) {
  if ($start.AppID -match '!') {
    [PSCustomObject]@{
      appUserModelId = $start.AppID
      installLocation = $null
      version = $null
    } | ConvertTo-Json -Compress
    break
  }
}
"#
    .replace("__PACKAGE_PATTERN__", package_pattern)
    .replace("__PUBLISHER_PATTERN__", publisher_pattern)
    .replace(
        "__REQUIRED_FAMILY__",
        if tool == "claude-desktop" {
            CLAUDE_STORE_PACKAGE_FAMILY
        } else {
            ""
        },
    )
    .replace("__START_NAME_PATTERN__", start_name_pattern)
    .replace("__START_FAMILY_PATTERN__", start_family_pattern);

    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &powershell_encoded_command(&script),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let info: StoreAppInfo = serde_json::from_slice(&output.stdout).ok()?;
    let aumid = info.app_user_model_id?.trim().to_string();
    if !is_trusted_store_aumid(tool, &aumid) {
        return None;
    }
    let install_path = info
        .install_location
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| format!(r"shell:AppsFolder\{aumid}"));
    Some(DesktopAppResolution {
        install_path: Some(install_path),
        version: info.version,
        detection_source: "microsoft_store",
        custom_path: None,
        custom_path_valid: true,
        launch_target: Some(DesktopLaunchTarget::AppUserModelId(aumid)),
    })
}

#[cfg(target_os = "windows")]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsPathInfo {
    target_path: Option<String>,
}

#[cfg(target_os = "windows")]
fn path_resolution(
    tool: &str,
    raw_path: Option<String>,
    source: &'static str,
) -> Option<DesktopAppResolution> {
    let raw_path = raw_path?.trim().to_string();
    if raw_path.is_empty() {
        return None;
    }
    let resolved = resolve_file_candidate(tool, Path::new(&raw_path))?;
    let canonical = std::fs::canonicalize(&resolved).unwrap_or(resolved);
    if !direct_desktop_launch_path_allowed(&canonical) {
        return None;
    }
    let display = canonical.to_string_lossy().to_string();
    Some(DesktopAppResolution {
        install_path: Some(display),
        version: None,
        detection_source: source,
        custom_path: None,
        custom_path_valid: true,
        launch_target: Some(DesktopLaunchTarget::Path(canonical)),
    })
}

#[cfg(target_os = "windows")]
fn windows_shortcut_resolution(tool: &str) -> Option<DesktopAppResolution> {
    use std::os::windows::process::CommandExt;

    let shortcut_pattern = match tool {
        "chatgpt-desktop" => "(?i)chatgpt|codex",
        "claude-desktop" => "(?i)claude",
        "workbuddy" => "(?i)workbuddy|codebuddy",
        "dsh" => "(?i)deepseek harness",
        _ => return None,
    };
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
$shortcutPattern = '__SHORTCUT_PATTERN__'
$roots = @(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
  "$env:USERPROFILE\Desktop"
)
$shell = New-Object -ComObject WScript.Shell
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  foreach ($item in @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)) {
    if ($item.BaseName -notmatch $shortcutPattern) { continue }
    $target = $shell.CreateShortcut($item.FullName).TargetPath
    if ($target) {
      [PSCustomObject]@{ targetPath = $target } | ConvertTo-Json -Compress
      exit 0
    }
  }
}
"#
    .replace("__SHORTCUT_PATTERN__", shortcut_pattern);
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &powershell_encoded_command(&script),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let info: WindowsPathInfo = serde_json::from_slice(&output.stdout).ok()?;
    path_resolution(tool, info.target_path, "shortcut")
}

#[cfg(target_os = "windows")]
fn windows_running_resolution(tool: &str) -> Option<DesktopAppResolution> {
    use std::os::windows::process::CommandExt;

    let process_names = match tool {
        "chatgpt-desktop" => "@('ChatGPT.exe', 'Codex.exe')",
        "claude-desktop" => "@('Claude.exe')",
        "workbuddy" => "@('WorkBuddy.exe')",
        "dsh" => "@('DeepSeek Harness.exe')",
        _ => return None,
    };
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
$processNames = {process_names}
foreach ($name in $processNames) {{
  $process = Get-CimInstance Win32_Process -Filter "Name = '$name'" |
    Select-Object -First 1 -ExpandProperty ExecutablePath
  if ($process) {{
    [PSCustomObject]@{{ targetPath = $process }} | ConvertTo-Json -Compress
    exit 0
  }}
  $process = Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($name)) |
    Select-Object -First 1 -ExpandProperty Path
  if ($process) {{
    [PSCustomObject]@{{ targetPath = $process }} | ConvertTo-Json -Compress
    exit 0
  }}
}}
"#
    );
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &powershell_encoded_command(&script),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let info: WindowsPathInfo = serde_json::from_slice(&output.stdout).ok()?;
    path_resolution(tool, info.target_path, "running")
}

#[cfg(not(target_os = "windows"))]
fn windows_store_resolution(_tool: &str) -> Option<DesktopAppResolution> {
    None
}

#[cfg(not(target_os = "windows"))]
fn windows_shortcut_resolution(_tool: &str) -> Option<DesktopAppResolution> {
    None
}

#[cfg(not(target_os = "windows"))]
fn windows_running_resolution(_tool: &str) -> Option<DesktopAppResolution> {
    None
}

pub(crate) fn discover_desktop_app(tool: &str, custom_path: Option<&str>) -> DesktopAppResolution {
    let configured_custom = custom_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string);

    if let Some(mut found) = custom_resolution(tool, custom_path) {
        found.custom_path = configured_custom;
        return found;
    }
    // Store/MSIX applications must be launched through their package identity.
    // Resolve that identity before registry candidates, which can expose a
    // protected WindowsApps executable that exists but cannot be spawned.
    if let Some(mut found) = windows_store_resolution(tool) {
        found.custom_path_valid = configured_custom.is_none();
        found.custom_path = configured_custom;
        return found;
    }
    if let Some(mut found) = windows_shortcut_resolution(tool) {
        found.custom_path_valid = configured_custom.is_none();
        found.custom_path = configured_custom;
        return found;
    }
    if let Some(mut found) = windows_running_resolution(tool) {
        found.custom_path_valid = configured_custom.is_none();
        found.custom_path = configured_custom;
        return found;
    }
    if let Some(mut found) = automatic_classic_resolution(tool) {
        found.custom_path_valid = configured_custom.is_none();
        found.custom_path = configured_custom;
        return found;
    }
    DesktopAppResolution::not_found(configured_custom)
}

#[cfg(target_os = "windows")]
pub(crate) fn discover_windows_store_app(tool: &str) -> Option<DesktopAppResolution> {
    windows_store_resolution(tool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(target_os = "macos")]
    #[test]
    fn trae_detection_is_limited_to_the_international_desktop_bundle() {
        let dir = tempdir().unwrap();
        for name in ["TraeWork.app", "TraeCode.app", "Trae CN.app"] {
            std::fs::create_dir_all(dir.path().join(name)).unwrap();
            assert!(validate_custom_desktop_app_path(
                "trae",
                dir.path().join(name).to_str().unwrap()
            )
            .is_err());
        }
        let app = dir.path().join("Trae.app");
        std::fs::create_dir_all(&app).unwrap();
        let result = custom_resolution("trae", app.to_str()).unwrap();
        assert_eq!(
            result.launch_target,
            Some(DesktopLaunchTarget::Path(app.canonicalize().unwrap()))
        );
        assert!(result.custom_path_valid);
        // Detection locates a candidate only; the launch verifier owns identity.
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn trae_china_paths_are_separate_from_international_paths() {
        let dir = tempdir().unwrap();
        for (tool, name, other_tool) in [
            ("trae-cn", "Trae CN.app", "trae"),
            ("trae", "Trae.app", "trae-cn"),
        ] {
            let app = dir.path().join(name);
            std::fs::create_dir_all(&app).unwrap();
            let result = custom_resolution(tool, app.to_str()).unwrap();
            assert!(result.custom_path_valid);
            assert_eq!(
                result.install_path,
                Some(app.canonicalize().unwrap().to_string_lossy().into())
            );
            assert!(validate_custom_desktop_app_path(other_tool, app.to_str().unwrap()).is_err());
        }
        let link = dir.path().join("other/Trae CN.app");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(dir.path().join("Trae.app"), &link).unwrap();
        assert!(validate_custom_desktop_app_path("trae-cn", link.to_str().unwrap()).is_err());
    }

    #[test]
    fn dsh_source_directory_is_discovered_without_running_code() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("apps/desktop")).unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"name":"@deepseek-ai/dsh-root"}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("apps/desktop/package.json"), "{}").unwrap();
        let resolution = discover_desktop_app("dsh", dir.path().to_str());
        assert!(resolution.launch_target.is_some());
        assert_eq!(resolution.detection_source, "custom");
        assert!(
            validate_custom_desktop_app_path("workbuddy", dir.path().to_str().unwrap()).is_err()
        );
    }

    #[test]
    fn dsh_cli_web_source_does_not_require_a_removed_desktop_directory() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("apps/cli/src")).unwrap();
        std::fs::write(
            dir.path().join("apps/cli/src/bin.ts"),
            "throw new Error('must not execute')",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"name":"@deepseek-ai/dsh-root"}"#,
        )
        .unwrap();
        assert!(is_dsh_source(dir.path()));
        assert!(validate_custom_desktop_app_path("dsh", dir.path().to_str().unwrap()).is_ok());
        std::fs::write(dir.path().join("package.json"), r#"{"name":"unrelated"}"#).unwrap();
        assert!(!is_dsh_source(dir.path()));
    }

    #[test]
    fn custom_directory_resolves_supported_executable() {
        let dir = tempdir().expect("tempdir");
        let executable = dir.path().join(executable_names("chatgpt-desktop")[0]);
        #[cfg(target_os = "macos")]
        std::fs::create_dir_all(&executable).expect("create app bundle");
        #[cfg(not(target_os = "macos"))]
        std::fs::write(&executable, b"test").expect("write executable");

        let resolved = validate_custom_desktop_app_path(
            "chatgpt-desktop",
            dir.path().to_string_lossy().as_ref(),
        )
        .expect("resolve custom app");
        assert_eq!(resolved, std::fs::canonicalize(executable).unwrap());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn custom_directory_resolves_executable_inside_version_directory() {
        let dir = tempdir().expect("tempdir");
        let executable = dir
            .path()
            .join("app-1.2.3")
            .join("resources")
            .join(executable_names("chatgpt-desktop")[0]);
        std::fs::create_dir_all(executable.parent().unwrap()).expect("create app directory");
        std::fs::write(&executable, b"test").expect("write executable");

        let resolved = validate_custom_desktop_app_path(
            "chatgpt-desktop",
            dir.path().to_string_lossy().as_ref(),
        )
        .expect("resolve nested custom app");
        assert_eq!(resolved, std::fs::canonicalize(executable).unwrap());
    }

    #[test]
    fn custom_path_rejects_unrelated_file() {
        let dir = tempdir().expect("tempdir");
        let unrelated = dir.path().join("Other.exe");
        std::fs::write(&unrelated, b"test").expect("write unrelated file");
        assert!(validate_custom_desktop_app_path(
            "chatgpt-desktop",
            unrelated.to_string_lossy().as_ref()
        )
        .is_err());
    }

    #[test]
    fn stale_custom_path_is_reported_without_hiding_auto_state() {
        let resolution = discover_desktop_app("unknown", Some("/missing/app"));
        assert_eq!(resolution.detection_source, "not_found");
        assert!(!resolution.custom_path_valid);
        assert_eq!(resolution.custom_path.as_deref(), Some("/missing/app"));
    }

    #[test]
    fn windows_apps_executables_are_never_direct_launch_targets() {
        assert!(!direct_desktop_launch_path_allowed(Path::new(
            r"C:\Program Files\WindowsApps\OpenAI.Codex_1.2.3.0_x64__publisher\Codex.exe"
        )));
        assert!(!direct_desktop_launch_path_allowed(Path::new(
            r"\\?\C:\Program Files\WindowsApps\OpenAI.ChatGPT-Desktop_1.2.3.0_x64__publisher\ChatGPT.exe"
        )));
        assert!(direct_desktop_launch_path_allowed(Path::new(
            r"C:\Users\Alice\AppData\Local\Programs\Codex\Codex.exe"
        )));
    }

    #[test]
    fn trusted_store_aumid_rejects_same_name_shortcuts_and_paths() {
        assert!(is_trusted_store_aumid(
            "claude-desktop",
            "Claude_pzs8sxrjxfjjc!Claude"
        ));
        for value in [
            "Claude_otherpublisher!Claude",
            "Claude_pzs8sxrjxfjjc.evil!App",
            "Claude_pzs8sxrjxfjjc!",
            "Claude_pzs8sxrjxfjjc!App!Extra",
            "Claude_pzs8sxrjxfjjc!../App",
            "Untrusted.Claude_pzs8sxrjxfjjc!App",
            "Anthropic.Claude_1234567890abc!Claude",
            "Anthropic.FakeClaude_pzs8sxrjxfjjc!App",
            "Anthropic.Claude_pzs8sxrjxfjjc!Claude",
        ] {
            assert!(!is_trusted_store_aumid("claude-desktop", value), "{value}");
        }
        assert!(is_trusted_store_aumid(
            "chatgpt-desktop",
            "OpenAI.Codex_2p2nqsd0c76g0!App"
        ));
        assert!(is_trusted_store_aumid(
            "chatgpt-desktop",
            "OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!App"
        ));
        assert!(!is_trusted_store_aumid(
            "chatgpt-desktop",
            r"C:\Users\Alice\Documents\Codex With Monitor.cmd"
        ));
        assert!(!is_trusted_store_aumid("chatgpt-desktop", "Codex"));
        assert!(!is_trusted_store_aumid(
            "chatgpt-desktop",
            "SomeoneElse.Codex_2p2nqsd0c76g0!App"
        ));
        assert!(!is_trusted_store_aumid(
            "chatgpt-desktop",
            "OpenAI.Codex_2p2nqsd0c76g0!../../evil"
        ));
        assert!(!is_trusted_store_aumid(
            "claude-desktop",
            "OpenAI.Claude_1234567890abc!Claude"
        ));
    }
}
