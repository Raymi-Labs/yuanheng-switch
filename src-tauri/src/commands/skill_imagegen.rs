//! Tool-scoped image capability commands, separate from provider AppType APIs.
use super::yuanheng::{imagegen_tool_status, sync_yuanheng_imagegen_tool, ImagegenToolStatus};
use crate::services::skill::{ImagegenTarget, SkillService};
use crate::store::AppState;
use std::io::Write;
use std::path::Path;
use tauri::State;

#[tauri::command]
pub async fn get_imagegen_tool_status(
    tool: String,
    app_state: State<'_, AppState>,
) -> Result<ImagegenToolStatus, String> {
    imagegen_tool_status(&app_state, &tool).await
}

#[tauri::command]
pub async fn install_imagegen_for_tool(
    tool: String,
    app_state: State<'_, AppState>,
) -> Result<ImagegenToolStatus, String> {
    let target = ImagegenTarget::parse(&tool).map_err(|e| e.to_string())?;
    SkillService::install_builtin_imagegen_for(&app_state.db, target).map_err(|e| e.to_string())?;
    sync_yuanheng_imagegen_tool(&app_state, &tool, false)
        .await
        .map_err(|error| format!("技能已安装，但图像连接同步未完成：{error}"))?;
    imagegen_tool_status(&app_state, &tool).await
}

#[tauri::command]
pub async fn set_imagegen_tool_enabled(
    tool: String,
    enabled: bool,
    app_state: State<'_, AppState>,
) -> Result<ImagegenToolStatus, String> {
    let target = ImagegenTarget::parse(&tool).map_err(|e| e.to_string())?;
    SkillService::toggle_builtin_imagegen_for(&app_state.db, target, enabled)
        .map_err(|e| e.to_string())?;
    sync_yuanheng_imagegen_tool(&app_state, &tool, false)
        .await
        .map_err(|error| format!("技能开关已保存，但图像连接同步未完成：{error}"))?;
    imagegen_tool_status(&app_state, &tool).await
}

const EXPORT_FILES: [&str; 5] = [
    "SKILL.md",
    "agents/openai.yaml",
    "scripts/meta_api_imagegen.mjs",
    "scripts/run_imagegen.mjs",
    "yuanheng-binding.json",
];

fn write_import_zip(
    source: &Path,
    files: &[(String, Vec<u8>)],
    destination: &Path,
) -> Result<(), String> {
    let names: std::collections::HashSet<_> = files.iter().map(|(name, _)| name.as_str()).collect();
    if files.len() != EXPORT_FILES.len()
        || names.len() != EXPORT_FILES.len()
        || files.iter().any(|(name, bytes)| {
            !EXPORT_FILES.contains(&name.as_str()) || bytes.len() > 1024 * 1024
        })
    {
        return Err("图像技能导出内容异常".into());
    }
    if !destination.is_absolute()
        || destination
            .extension()
            .and_then(|s| s.to_str())
            .is_none_or(|ext| !ext.eq_ignore_ascii_case("zip"))
    {
        return Err("请选择本机的 ZIP 文件保存路径".into());
    }
    match std::fs::symlink_metadata(destination) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err("导出目标不是普通文件，已保留".into())
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
        _ => {}
    }
    let parent = destination.parent().ok_or("导出目录无效")?;
    if parent
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(source.canonicalize().map_err(|e| e.to_string())?)
    {
        return Err("请将导入包保存在图像技能目录之外".into());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    {
        let mut writer = zip::ZipWriter::new(temporary.as_file_mut());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for (name, bytes) in files {
            writer
                .start_file(name, options)
                .map_err(|e| e.to_string())?;
            writer.write_all(bytes).map_err(|e| e.to_string())?;
        }
        writer.finish().map_err(|e| e.to_string())?;
    }
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary
        .persist(destination)
        .map_err(|e| e.error.to_string())?;
    Ok(())
}

/// Office mode imports this computer's binding, never a copy of an API key.
#[tauri::command]
pub async fn export_imagegen_skill(
    tool: String,
    file_path: String,
    app_state: State<'_, AppState>,
) -> Result<String, String> {
    let target = ImagegenTarget::parse(&tool).map_err(|e| e.to_string())?;
    if target != ImagegenTarget::WorkBuddy {
        return Err("导入包用于 WorkBuddy 办公模式".into());
    }
    sync_yuanheng_imagegen_tool(&app_state, &tool, false).await?;
    let files = SkillService::builtin_imagegen_export_snapshot(&app_state.db, target)
        .map_err(|e| e.to_string())?;
    write_import_zip(
        &target.projection_path().map_err(|e| e.to_string())?,
        &files,
        Path::new(&file_path),
    )?;
    Ok(file_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn import_zip_contains_only_bundle_and_local_binding() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("skill");
        std::fs::create_dir_all(&source).unwrap();
        let files: Vec<_> = EXPORT_FILES
            .iter()
            .map(|name| (name.to_string(), name.as_bytes().to_vec()))
            .collect();
        let output = dir.path().join("skill.zip");
        write_import_zip(&source, &files, &output).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(output).unwrap()).unwrap();
        assert_eq!(zip.len(), EXPORT_FILES.len());
        for name in EXPORT_FILES {
            let mut text = String::new();
            zip.by_name(name)
                .unwrap()
                .read_to_string(&mut text)
                .unwrap();
            assert_eq!(text, name);
        }
    }

    #[cfg(unix)]
    #[test]
    fn import_zip_preserves_symlink_destination_and_rejects_unexpected_files() {
        let dir = tempfile::tempdir().unwrap();
        let external = dir.path().join("external");
        std::fs::write(&external, "untouched").unwrap();
        let output = dir.path().join("skill.zip");
        std::os::unix::fs::symlink(&external, &output).unwrap();
        let mut files: Vec<_> = EXPORT_FILES
            .iter()
            .map(|name| (name.to_string(), name.as_bytes().to_vec()))
            .collect();
        assert!(write_import_zip(dir.path(), &files, &output).is_err());
        assert_eq!(std::fs::read_to_string(&external).unwrap(), "untouched");
        std::fs::remove_file(&output).unwrap();
        files.push(("../credentials.json".into(), vec![1]));
        assert!(write_import_zip(dir.path(), &files, &output).is_err());
        assert!(!output.exists());
    }
}
