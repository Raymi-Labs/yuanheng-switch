//! Lifecycle for the bundled image skill. All callers serialize with user toggles
//! and uninstalls; automatic maintenance never adopts an unknown directory.

use super::*;
use std::sync::{Mutex, MutexGuard};

const INITIALIZED_KEY: &str = "builtin_imagegen_auto_initialized";
static LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn lock() -> Result<MutexGuard<'static, ()>> {
    LIFECYCLE_LOCK
        .lock()
        .map_err(|_| anyhow!("图像生成技能正在恢复，请重启元衡后重试"))
}

pub(super) fn remember_initialized(db: &Arc<Database>) -> Result<()> {
    if db.get_setting(INITIALIZED_KEY)?.as_deref() != Some("true") {
        db.set_setting(INITIALIZED_KEY, "true")?;
    }
    Ok(())
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn owned_record(db: &Arc<Database>) -> Result<Option<InstalledSkill>> {
    let skills = db.get_all_installed_skills()?;
    let mut matching = skills.into_values().filter(|skill| {
        skill.id == BUILTIN_IMAGEGEN_ID
            || skill
                .directory
                .eq_ignore_ascii_case(BUILTIN_IMAGEGEN_DIRECTORY)
    });
    let existing = matching.next();
    if matching.next().is_some()
        || existing.as_ref().is_some_and(|skill| {
            skill.id != BUILTIN_IMAGEGEN_ID
                || skill.directory != BUILTIN_IMAGEGEN_DIRECTORY
                || skill.repo_owner.is_some()
                || skill.repo_name.is_some()
                || skill.repo_branch.is_some()
        })
    {
        return Err(anyhow!(
            "存在同名的非元衡内置技能，已保留，请先在技能管理中处理冲突"
        ));
    }
    Ok(existing)
}

// The shared legacy hash excludes dot files and follows symlinks. Reject those
// additions before using that hash as proof that this bundled tree is unchanged.
fn validate_tree(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(anyhow!("图像生成技能目录已被外部修改，已保留"));
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || entry.file_name().to_string_lossy().starts_with('.')
        {
            return Err(anyhow!("图像生成技能包含外部文件或链接，已保留"));
        }
        if metadata.is_dir() {
            validate_tree(&entry.path())?;
        } else if !metadata.is_file() {
            return Err(anyhow!("图像生成技能包含未知文件类型，已保留"));
        }
    }
    Ok(())
}

fn validate_hash(path: &Path, expected: Option<&str>) -> Result<()> {
    validate_tree(path)?;
    if expected != Some(SkillService::compute_dir_hash(path)?.as_str()) {
        return Err(anyhow!(
            "图像生成技能内容已被本地修改，已保留；请备份后在技能管理中重新安装"
        ));
    }
    Ok(())
}

fn validate_projection(path: &Path, source: &Path, expected: Option<&str>) -> Result<()> {
    if !exists(path) {
        return Ok(());
    }
    if SkillService::is_symlink(path) {
        let target = fs::read_link(path)?;
        let target = if target.is_absolute() {
            target
        } else {
            path.parent().unwrap_or(Path::new(".")).join(target)
        };
        if target == source
            || (target.canonicalize().ok().is_some()
                && target.canonicalize().ok() == source.canonicalize().ok())
        {
            return Ok(());
        }
        return Err(anyhow!("Codex 中存在外部图像生成技能链接，已保留"));
    }
    validate_hash(path, expected)
}

pub(super) fn validate_current_projection(skill: &InstalledSkill, app: &AppType) -> Result<()> {
    let source = SkillService::get_ssot_dir()?.join(BUILTIN_IMAGEGEN_DIRECTORY);
    validate_hash(&source, skill.content_hash.as_deref())?;
    let path = SkillService::get_app_skills_dir(app)?.join(BUILTIN_IMAGEGEN_DIRECTORY);
    validate_projection(&path, &source, skill.content_hash.as_deref())
}

fn write_bundle(path: &Path) -> Result<()> {
    fs::create_dir_all(path.join("agents"))?;
    fs::create_dir_all(path.join("scripts"))?;
    fs::write(path.join("SKILL.md"), BUILTIN_IMAGEGEN_SKILL_MD)?;
    fs::write(
        path.join("agents/openai.yaml"),
        BUILTIN_IMAGEGEN_OPENAI_YAML,
    )?;
    fs::write(
        path.join("scripts/meta_api_imagegen.mjs"),
        BUILTIN_IMAGEGEN_SCRIPT,
    )?;
    Ok(())
}

struct Projection {
    app: AppType,
    path: PathBuf,
}

/// A rename snapshot preserves directory contents and the original symlink form.
struct Snapshot {
    path: PathBuf,
    previous: Option<PathBuf>,
}

impl Snapshot {
    fn take(path: &Path) -> Result<Self> {
        let previous = if exists(path) {
            let previous = path.with_file_name(format!(
                ".{BUILTIN_IMAGEGEN_DIRECTORY}.previous-{}",
                uuid::Uuid::new_v4()
            ));
            fs::rename(path, &previous)?;
            Some(previous)
        } else {
            None
        };
        Ok(Self {
            path: path.to_owned(),
            previous,
        })
    }

    fn restore(&self) -> Result<()> {
        SkillService::remove_path(&self.path)?;
        if let Some(previous) = &self.previous {
            fs::rename(previous, &self.path)?;
        }
        Ok(())
    }

    fn finish(self) {
        if let Some(previous) = self.previous {
            if let Err(error) = SkillService::remove_path(&previous) {
                log::warn!("图像技能更新完成，但旧版本备份清理失败: {error}");
            }
        }
    }
}

impl SkillService {
    /// Returns the enabled installed skill, including an unchanged installation.
    /// None means the user disabled/uninstalled it. Errors are non-fatal warnings
    /// for the configuration/startup caller; never turn them into success.
    pub fn ensure_builtin_imagegen(db: &Arc<Database>) -> Result<Option<InstalledSkill>> {
        let _guard = lock()?;
        Self::maintain_builtin_imagegen(db, &AppType::Codex, false)
    }

    /// Explicit install/update can re-enable a disabled or uninstalled bundle;
    /// existing local edits and externally owned names still require resolution.
    pub fn install_builtin_imagegen(
        db: &Arc<Database>,
        current_app: &AppType,
    ) -> Result<InstalledSkill> {
        let _guard = lock()?;
        Self::maintain_builtin_imagegen(db, current_app, true)?
            .ok_or_else(|| anyhow!("图像生成技能未安装"))
    }

    fn maintain_builtin_imagegen(
        db: &Arc<Database>,
        current_app: &AppType,
        explicit: bool,
    ) -> Result<Option<InstalledSkill>> {
        if matches!(current_app, AppType::ClaudeDesktop | AppType::OpenClaw) {
            return Err(anyhow!("This application does not support Skills"));
        }
        let existing = owned_record(db)?;
        if should_skip(db, existing.as_ref(), explicit)? {
            return Ok(None);
        }
        let mut apps = existing
            .as_ref()
            .map(|s| s.apps.clone())
            .unwrap_or_default();
        apps.set_enabled_for(current_app, true);
        let projections = apps
            .enabled_apps()
            .into_iter()
            .map(|app| {
                Ok(Projection {
                    path: Self::get_app_skills_dir(&app)?.join(BUILTIN_IMAGEGEN_DIRECTORY),
                    app,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        install_at(
            db,
            existing.as_ref(),
            apps,
            &Self::get_ssot_dir()?,
            &projections,
            |projection, was_copy| {
                if was_copy && Self::get_sync_method() == SyncMethod::Auto {
                    Self::replace_dest_with_copy(
                        &Self::get_ssot_dir()?.join(BUILTIN_IMAGEGEN_DIRECTORY),
                        &projection.path,
                        BUILTIN_IMAGEGEN_DIRECTORY,
                    )
                } else {
                    Self::sync_to_app_dir(BUILTIN_IMAGEGEN_DIRECTORY, &projection.app)
                }
            },
        )
        .map(Some)
    }
}

fn should_skip(
    db: &Arc<Database>,
    existing: Option<&InstalledSkill>,
    explicit: bool,
) -> Result<bool> {
    if explicit {
        return Ok(false);
    }
    if let Some(skill) = existing {
        if !skill.apps.codex {
            remember_initialized(db)?;
            return Ok(true);
        }
    } else if db.get_setting(INITIALIZED_KEY)?.as_deref() == Some("true") {
        return Ok(true);
    }
    Ok(false)
}

fn install_at(
    db: &Arc<Database>,
    existing: Option<&InstalledSkill>,
    apps: SkillApps,
    ssot_dir: &Path,
    projections: &[Projection],
    sync: impl Fn(&Projection, bool) -> Result<()>,
) -> Result<InstalledSkill> {
    let source = ssot_dir.join(BUILTIN_IMAGEGEN_DIRECTORY);
    // Override directories may alias each other. Moving the same path twice
    // would invalidate the transaction's snapshots, so reject that layout.
    let mut destinations = HashSet::new();
    destinations.insert(source.canonicalize().unwrap_or_else(|_| source.clone()));
    for projection in projections {
        let path = projection
            .path
            .canonicalize()
            .unwrap_or_else(|_| projection.path.clone());
        // A managed symlink deliberately resolves to SSOT; its link location is
        // distinct and is the path that the snapshot renames.
        let path = if SkillService::is_symlink(&projection.path) {
            projection.path.clone()
        } else {
            path
        };
        if !destinations.insert(path) {
            return Err(anyhow!(
                "图像技能的源目录与工具目录重叠，已保留，请检查自定义目录设置"
            ));
        }
    }
    let old_hash = existing.and_then(|skill| skill.content_hash.as_deref());
    if exists(&source) {
        if existing.is_none() {
            return Err(anyhow!("存在未托管的同名图像生成技能目录，已保留"));
        }
        validate_hash(&source, old_hash)?;
    }
    for projection in projections {
        // No record means there is no proof of ownership, even if bytes match.
        if existing.is_none() && exists(&projection.path) {
            return Err(anyhow!("Codex 中存在未托管的同名图像生成技能，已保留"));
        }
        validate_projection(&projection.path, &source, old_hash)?;
    }

    let previous_marker = db.get_setting(INITIALIZED_KEY)?;
    let staging = ssot_dir.join(format!(
        ".{BUILTIN_IMAGEGEN_DIRECTORY}.staging-{}",
        uuid::Uuid::new_v4()
    ));
    if let Err(error) = write_bundle(&staging) {
        let _ = SkillService::remove_path(&staging);
        return Err(error);
    }
    let hash = match SkillService::compute_dir_hash(&staging) {
        Ok(hash) => hash,
        Err(error) => {
            let _ = SkillService::remove_path(&staging);
            return Err(error);
        }
    };
    let now = Utc::now().timestamp();
    let skill = InstalledSkill {
        id: BUILTIN_IMAGEGEN_ID.to_string(),
        name: "YuanHeng ImageGen".to_string(),
        description: Some(
            "Generate and edit images using the latest available YuanHeng image model.".to_string(),
        ),
        directory: BUILTIN_IMAGEGEN_DIRECTORY.to_string(),
        repo_owner: None,
        repo_name: None,
        repo_branch: None,
        readme_url: None,
        apps,
        installed_at: existing.map(|s| s.installed_at).unwrap_or(now),
        content_hash: Some(hash.clone()),
        updated_at: now,
    };
    if let Some(existing) = existing {
        if exists(&source)
            && old_hash == Some(hash.as_str())
            && existing.apps == skill.apps
            && existing.description == skill.description
            && projections.iter().all(|p| exists(&p.path))
        {
            SkillService::remove_path(&staging)?;
            remember_initialized(db)?;
            return Ok(existing.clone());
        }
    }

    let mut snapshots = Vec::new();
    let result = (|| -> Result<()> {
        snapshots.push(Snapshot::take(&source)?);
        fs::rename(&staging, &source)?;
        for projection in projections {
            let was_copy = projection.path.is_dir() && !SkillService::is_symlink(&projection.path);
            snapshots.push(Snapshot::take(&projection.path)?);
            sync(projection, was_copy)?;
        }
        db.save_skill(&skill)?;
        remember_initialized(db)?;
        Ok(())
    })();
    if let Err(error) = result {
        let mut rollback_errors = Vec::new();
        for snapshot in snapshots.iter().rev() {
            if let Err(error) = snapshot.restore() {
                rollback_errors.push(error.to_string());
            }
        }
        let restore_record = if let Some(existing) = existing {
            db.save_skill(existing)
        } else {
            db.delete_skill(BUILTIN_IMAGEGEN_ID).map(|_| ())
        };
        if let Err(error) = restore_record {
            rollback_errors.push(error.to_string());
        }
        let restore_marker = if let Some(value) = previous_marker {
            db.set_setting(INITIALIZED_KEY, &value)
        } else {
            db.delete_setting(INITIALIZED_KEY)
        };
        if let Err(error) = restore_marker {
            rollback_errors.push(error.to_string());
        }
        if let Err(error) = SkillService::remove_path(&staging) {
            rollback_errors.push(error.to_string());
        }
        return if rollback_errors.is_empty() {
            Err(error)
        } else {
            Err(anyhow!(
                "{error}; 图像技能恢复不完整，旧备份已保留: {}",
                rollback_errors.join("; ")
            ))
        };
    }
    for snapshot in snapshots {
        snapshot.finish();
    }
    Ok(skill)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{tempdir, TempDir};

    struct Fixture {
        _temp: TempDir,
        db: Arc<Database>,
        ssot: PathBuf,
        projections: Vec<Projection>,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempdir().unwrap();
            let ssot = temp.path().join("ssot");
            let projections = vec![Projection {
                app: AppType::Codex,
                path: temp.path().join("codex/meta-api-imagegen"),
            }];
            Self {
                _temp: temp,
                db: Arc::new(Database::memory().unwrap()),
                ssot,
                projections,
            }
        }

        fn source(&self) -> PathBuf {
            self.ssot.join(BUILTIN_IMAGEGEN_DIRECTORY)
        }

        fn install(&self, existing: Option<&InstalledSkill>) -> Result<InstalledSkill> {
            install_at(
                &self.db,
                existing,
                SkillApps::only(&AppType::Codex),
                &self.ssot,
                &self.projections,
                |p, _| {
                    SkillService::replace_dest_with_copy(
                        &self.source(),
                        &p.path,
                        BUILTIN_IMAGEGEN_DIRECTORY,
                    )
                },
            )
        }

        fn seed_old_bundle(&self) -> InstalledSkill {
            let mut skill = self.install(None).unwrap();
            fs::write(self.source().join("SKILL.md"), "old bundled instructions").unwrap();
            fs::write(
                self.projections[0].path.join("SKILL.md"),
                "old bundled instructions",
            )
            .unwrap();
            skill.content_hash = Some(SkillService::compute_dir_hash(&self.source()).unwrap());
            skill.updated_at = 1;
            self.db.save_skill(&skill).unwrap();
            skill
        }
    }

    #[test]
    fn fresh_install_refresh_and_repeated_ensure_preserve_enabled_state() {
        let f = Fixture::new();
        assert!(!should_skip(&f.db, None, false).unwrap());
        let old = f.seed_old_bundle();
        let updated = f.install(Some(&old)).unwrap();
        assert_eq!(updated.installed_at, old.installed_at);
        assert_ne!(updated.content_hash, old.content_hash);
        assert!(updated.apps.codex);
        assert_eq!(
            fs::read_to_string(f.projections[0].path.join("SKILL.md")).unwrap(),
            BUILTIN_IMAGEGEN_SKILL_MD
        );
        let unchanged = f.install(Some(&updated)).unwrap();
        assert_eq!(unchanged.updated_at, updated.updated_at);
        assert_eq!(
            f.db.get_setting(INITIALIZED_KEY).unwrap().as_deref(),
            Some("true")
        );
    }

    #[test]
    fn user_disabled_and_uninstalled_bundles_are_not_reenabled() {
        let f = Fixture::new();
        let mut skill = f.install(None).unwrap();
        skill.apps.codex = false;
        f.db.save_skill(&skill).unwrap();
        assert!(should_skip(&f.db, Some(&skill), false).unwrap());
        f.db.delete_skill(&skill.id).unwrap();
        assert!(should_skip(&f.db, None, false).unwrap());
        assert!(!should_skip(&f.db, None, true).unwrap());
    }

    #[test]
    fn unknown_same_name_record_or_directory_is_never_adopted() {
        let f = Fixture::new();
        fs::create_dir_all(f.source()).unwrap();
        fs::write(f.source().join("SKILL.md"), "external skill").unwrap();
        assert!(f.install(None).unwrap_err().to_string().contains("未托管"));
        assert_eq!(
            fs::read_to_string(f.source().join("SKILL.md")).unwrap(),
            "external skill"
        );
        fs::remove_dir_all(f.source()).unwrap();
        let mut skill = f.install(None).unwrap();
        f.db.delete_skill(&skill.id).unwrap();
        skill.id = "local:meta-api-imagegen".to_string();
        f.db.save_skill(&skill).unwrap();
        assert!(owned_record(&f.db)
            .unwrap_err()
            .to_string()
            .contains("非元衡"));
    }

    #[test]
    fn changed_ssot_and_copied_projection_are_preserved() {
        for change_source in [true, false] {
            let f = Fixture::new();
            let skill = f.seed_old_bundle();
            let changed = if change_source {
                f.source()
            } else {
                f.projections[0].path.clone()
            };
            fs::write(changed.join("SKILL.md"), "my customized skill").unwrap();
            assert!(f
                .install(Some(&skill))
                .unwrap_err()
                .to_string()
                .contains("本地修改"));
            assert_eq!(
                fs::read_to_string(changed.join("SKILL.md")).unwrap(),
                "my customized skill"
            );
            assert_eq!(
                f.db.get_installed_skill(&skill.id)
                    .unwrap()
                    .unwrap()
                    .content_hash,
                skill.content_hash
            );
        }
    }

    #[test]
    fn hidden_additions_are_not_lost_through_legacy_hash() {
        let f = Fixture::new();
        let skill = f.install(None).unwrap();
        fs::write(f.source().join(".personal-config"), "keep me").unwrap();
        assert_eq!(
            SkillService::compute_dir_hash(&f.source()).unwrap(),
            skill.content_hash.clone().unwrap()
        );
        assert!(f.install(Some(&skill)).is_err());
        assert_eq!(
            fs::read_to_string(f.source().join(".personal-config")).unwrap(),
            "keep me"
        );
    }

    #[test]
    fn projection_failure_restores_all_files_record_and_marker() {
        let mut f = Fixture::new();
        let mut old = f.seed_old_bundle();
        old.apps.gemini = true;
        f.db.save_skill(&old).unwrap();
        let second = Projection {
            app: AppType::Gemini,
            path: f._temp.path().join("gemini/meta-api-imagegen"),
        };
        SkillService::replace_dest_with_copy(&f.source(), &second.path, BUILTIN_IMAGEGEN_DIRECTORY)
            .unwrap();
        f.projections.push(second);
        f.db.delete_setting(INITIALIZED_KEY).unwrap();
        let result = install_at(
            &f.db,
            Some(&old),
            old.apps.clone(),
            &f.ssot,
            &f.projections,
            |p, was_copy| {
                assert!(
                    was_copy,
                    "existing copied projections retain their sync form"
                );
                SkillService::replace_dest_with_copy(
                    &f.source(),
                    &p.path,
                    BUILTIN_IMAGEGEN_DIRECTORY,
                )?;
                if matches!(p.app, AppType::Gemini) {
                    return Err(anyhow!("simulated projection failure"));
                }
                Ok(())
            },
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("simulated projection failure"));
        assert_eq!(
            SkillService::compute_dir_hash(&f.source()).unwrap(),
            old.content_hash.clone().unwrap()
        );
        for p in &f.projections {
            assert_eq!(
                SkillService::compute_dir_hash(&p.path).unwrap(),
                old.content_hash.clone().unwrap()
            );
        }
        assert_eq!(
            f.db.get_installed_skill(&old.id)
                .unwrap()
                .unwrap()
                .updated_at,
            1
        );
        assert!(f.db.get_setting(INITIALIZED_KEY).unwrap().is_none());
    }

    #[test]
    fn first_install_failure_leaves_no_record_or_auto_install_marker() {
        let f = Fixture::new();
        let result = install_at(
            &f.db,
            None,
            SkillApps::only(&AppType::Codex),
            &f.ssot,
            &f.projections,
            |_, _| Err(anyhow!("read-only projection")),
        );
        assert!(result.is_err());
        assert!(!exists(&f.source()));
        assert!(!exists(&f.projections[0].path));
        assert!(f
            .db
            .get_installed_skill(BUILTIN_IMAGEGEN_ID)
            .unwrap()
            .is_none());
        assert!(!should_skip(&f.db, None, false).unwrap());
    }

    #[test]
    fn missing_owned_source_and_projection_can_be_repaired() {
        let f = Fixture::new();
        let skill = f.install(None).unwrap();
        fs::remove_dir_all(f.source()).unwrap();
        fs::remove_dir_all(&f.projections[0].path).unwrap();
        let repaired = f.install(Some(&skill)).unwrap();
        assert_eq!(repaired.installed_at, skill.installed_at);
        assert!(f.source().join("SKILL.md").exists());
        assert!(f.projections[0].path.join("SKILL.md").exists());
    }
}
