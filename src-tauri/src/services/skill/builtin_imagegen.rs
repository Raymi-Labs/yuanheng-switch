//! One managed source, with isolated, target-bound copies in each client.
//! All mutations share the same lifecycle lock; unknown or edited files survive.
use super::*;
use std::sync::{Mutex, MutexGuard};

const LEGACY_INITIALIZED_KEY: &str = "builtin_imagegen_auto_initialized";
const UNINSTALLED_KEY: &str = "builtin_imagegen_uninstalled";
const BINDING_FILE: &str = "yuanheng-binding.json";
const EXPORT_FILES: [&str; 5] = [
    "SKILL.md",
    "agents/openai.yaml",
    "scripts/meta_api_imagegen.mjs",
    "scripts/run_imagegen.mjs",
    BINDING_FILE,
];
static LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn lock() -> Result<MutexGuard<'static, ()>> {
    LIFECYCLE_LOCK
        .lock()
        .map_err(|_| anyhow!("图像生成技能正在恢复，请重启元衡后重试"))
}

fn initialized_key(target: ImagegenTarget) -> String {
    format!("builtin_imagegen_initialized_{}", target.as_str())
}

fn remember_initialized(db: &Arc<Database>, target: ImagegenTarget) -> Result<()> {
    db.set_setting(&initialized_key(target), "true")?;
    Ok(())
}

fn migrate_legacy_marker(db: &Arc<Database>, existing: Option<&InstalledSkill>) -> Result<()> {
    if db.get_setting(LEGACY_INITIALIZED_KEY)?.as_deref() == Some("true")
        && db
            .get_setting(&initialized_key(ImagegenTarget::Codex))?
            .is_none()
    {
        remember_initialized(db, ImagegenTarget::Codex)?;
        // The old global uninstall removed the record. New clients must not
        // resurrect that explicit choice during their first automatic ensure.
        if existing.is_none() {
            db.set_setting(UNINSTALLED_KEY, "true")?;
        }
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

// The legacy source hash ignores dot files and follows symlinks. Check their
// absence before accepting a hash; only the exact validated root binding differs.
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

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    owner: String,
    version: u32,
    target: String,
    runtime_path: PathBuf,
}

#[derive(Debug, Clone)]
struct Projection {
    target: ImagegenTarget,
    path: PathBuf,
    runtime_path: PathBuf,
}

impl Projection {
    fn new(target: ImagegenTarget) -> Result<Self> {
        Ok(Self {
            target,
            path: target.projection_path()?,
            runtime_path: target.runtime_path()?,
        })
    }
    fn binding(&self) -> Binding {
        Binding {
            owner: "yuanheng-imagegen".into(),
            version: 1,
            target: self.target.as_str().into(),
            runtime_path: self.runtime_path.clone(),
        }
    }
    fn validate_binding(&self) -> Result<bool> {
        let path = self.path.join(BINDING_FILE);
        if !exists(&path) {
            return Ok(false);
        }
        if !fs::symlink_metadata(&path)?.is_file() || SkillService::is_symlink(&path) {
            return Err(anyhow!("图像技能绑定文件已被修改，已保留"));
        }
        let binding: Binding =
            serde_json::from_slice(&fs::read(&path)?).context("图像技能绑定文件无效，已保留")?;
        if binding != self.binding() {
            return Err(anyhow!("图像技能绑定与目标客户端不匹配，已保留"));
        }
        Ok(true)
    }
    fn write_binding(&self) -> Result<()> {
        fs::write(
            self.path.join(BINDING_FILE),
            serde_json::to_vec_pretty(&self.binding())?,
        )?;
        Ok(())
    }
}

fn projection_hash(projection: &Projection) -> Result<String> {
    use sha2::{Digest, Sha256};
    validate_tree(&projection.path)?;
    let bound = projection.validate_binding()?;
    let mut files = Vec::new();
    SkillService::collect_files_for_hash(&projection.path, &projection.path, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for file in files {
        let relative = file.strip_prefix(&projection.path)?;
        if bound && relative == Path::new(BINDING_FILE) {
            continue;
        }
        hasher.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        hasher.update(b"\0");
        hasher.update(fs::read(file)?);
        hasher.update(b"\0");
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_projection(
    projection: &Projection,
    source: &Path,
    expected: Option<&str>,
    owned: bool,
) -> Result<()> {
    if !exists(&projection.path) {
        return Ok(());
    }
    if !owned {
        return Err(anyhow!(
            "{} 中存在未托管的同名图像生成技能，已保留",
            projection.target.as_str()
        ));
    }
    if SkillService::is_symlink(&projection.path) {
        let target = fs::read_link(&projection.path)?;
        let target = if target.is_absolute() {
            target
        } else {
            projection
                .path
                .parent()
                .unwrap_or(Path::new("."))
                .join(target)
        };
        if target == source
            || (target.canonicalize().ok().is_some()
                && target.canonicalize().ok() == source.canonicalize().ok())
        {
            return Ok(());
        }
        return Err(anyhow!("客户端中存在外部图像生成技能链接，已保留"));
    }
    if expected != Some(projection_hash(projection)?.as_str()) {
        return Err(anyhow!("客户端中的图像生成技能已被本地修改，已保留"));
    }
    Ok(())
}

fn write_bundle(path: &Path) -> Result<()> {
    fs::create_dir_all(path.join("agents"))?;
    fs::create_dir_all(path.join("scripts"))?;
    for (name, content) in [
        ("SKILL.md", BUILTIN_IMAGEGEN_SKILL_MD),
        ("agents/openai.yaml", BUILTIN_IMAGEGEN_OPENAI_YAML),
        ("scripts/meta_api_imagegen.mjs", BUILTIN_IMAGEGEN_SCRIPT),
        ("scripts/run_imagegen.mjs", BUILTIN_IMAGEGEN_LAUNCHER),
    ] {
        fs::write(path.join(name), content)?;
    }
    Ok(())
}

fn copy_projection(source: &Path, projection: &Projection) -> Result<()> {
    SkillService::replace_dest_with_copy(source, &projection.path, BUILTIN_IMAGEGEN_DIRECTORY)?;
    projection.write_binding()
}

// Compare physical parents, without resolving the last component (legacy
// projections may still be symlinks to the source).
fn location(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or(Path::new("."));
    parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf())
        .join(path.file_name().unwrap_or_default())
}

fn validate_locations(source: &Path, projections: &[Projection]) -> Result<()> {
    let mut paths = vec![location(source)];
    for projection in projections {
        let path = location(&projection.path);
        if paths
            .iter()
            .any(|prior| path.starts_with(prior) || prior.starts_with(&path))
        {
            return Err(anyhow!(
                "图像技能的客户端目录重叠，请为每个客户端设置独立技能目录"
            ));
        }
        paths.push(path);
    }
    Ok(())
}

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

struct StateSnapshot {
    skill: Option<InstalledSkill>,
    settings: Vec<(String, Option<String>)>,
}
impl StateSnapshot {
    fn take(db: &Arc<Database>, skill: Option<&InstalledSkill>) -> Result<Self> {
        let mut keys: Vec<_> = ImagegenTarget::all()
            .into_iter()
            .map(initialized_key)
            .collect();
        keys.push(UNINSTALLED_KEY.into());
        keys.push(LEGACY_INITIALIZED_KEY.into());
        let settings = keys
            .into_iter()
            .map(|key| Ok((key.clone(), db.get_setting(&key)?)))
            .collect::<Result<_>>()?;
        Ok(Self {
            skill: skill.cloned(),
            settings,
        })
    }
    fn restore(&self, db: &Arc<Database>) -> Result<()> {
        let mut errors = Vec::new();
        let record_result = if let Some(skill) = &self.skill {
            db.save_skill(skill)
        } else {
            db.delete_skill(BUILTIN_IMAGEGEN_ID).map(|_| ())
        };
        if let Err(error) = record_result {
            errors.push(error.to_string());
        }
        for (key, value) in &self.settings {
            let result = if let Some(value) = value {
                db.set_setting(key, value)
            } else {
                db.delete_setting(key)
            };
            if let Err(error) = result {
                errors.push(error.to_string());
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(anyhow!(errors.join("; ")))
        }
    }
}

fn finish_transaction(
    db: &Arc<Database>,
    state: StateSnapshot,
    snapshots: Vec<Snapshot>,
    result: Result<()>,
) -> Result<()> {
    if let Err(error) = result {
        let mut errors = Vec::new();
        for snapshot in snapshots.iter().rev() {
            if let Err(error) = snapshot.restore() {
                errors.push(error.to_string());
            }
        }
        if let Err(error) = state.restore(db) {
            errors.push(error.to_string());
        }
        return if errors.is_empty() {
            Err(error)
        } else {
            Err(anyhow!("{error}; 恢复失败: {}", errors.join("; ")))
        };
    }
    for snapshot in snapshots {
        snapshot.finish();
    }
    Ok(())
}

fn should_skip(
    db: &Arc<Database>,
    existing: Option<&InstalledSkill>,
    target: ImagegenTarget,
    explicit: bool,
) -> Result<bool> {
    migrate_legacy_marker(db, existing)?;
    if explicit {
        return Ok(false);
    }
    if db.get_setting(UNINSTALLED_KEY)?.as_deref() == Some("true") {
        return Ok(true);
    }
    Ok(
        !existing.is_some_and(|skill| target.is_enabled(&skill.apps))
            && db.get_setting(&initialized_key(target))?.as_deref() == Some("true"),
    )
}

impl SkillService {
    pub fn ensure_builtin_imagegen(db: &Arc<Database>) -> Result<Option<InstalledSkill>> {
        Self::ensure_builtin_imagegen_for(db, ImagegenTarget::Codex)
    }
    pub fn ensure_builtin_imagegen_for(
        db: &Arc<Database>,
        target: ImagegenTarget,
    ) -> Result<Option<InstalledSkill>> {
        let _guard = lock()?;
        maintain_locked(db, target, false)
    }
    pub fn install_builtin_imagegen(db: &Arc<Database>, app: &AppType) -> Result<InstalledSkill> {
        Self::install_builtin_imagegen_for(db, ImagegenTarget::parse(app.as_str())?)
    }
    pub fn install_builtin_imagegen_for(
        db: &Arc<Database>,
        target: ImagegenTarget,
    ) -> Result<InstalledSkill> {
        let _guard = lock()?;
        maintain_locked(db, target, true)?.ok_or_else(|| anyhow!("图像生成技能未安装"))
    }
    pub fn toggle_builtin_imagegen_for(
        db: &Arc<Database>,
        target: ImagegenTarget,
        enabled: bool,
    ) -> Result<()> {
        let _guard = lock()?;
        if enabled {
            maintain_locked(db, target, true)?;
            return Ok(());
        }
        let skill = owned_record(db)?.ok_or_else(|| anyhow!("图像生成技能未安装"))?;
        let projection = Projection::new(target)?;
        if !target.is_enabled(&skill.apps) {
            remember_initialized(db, target)?;
            return Ok(());
        }
        let source = Self::get_ssot_dir()?.join(BUILTIN_IMAGEGEN_DIRECTORY);
        validate_projection(&projection, &source, skill.content_hash.as_deref(), true)?;
        disable_at(db, &skill, &projection)
    }
    pub fn validate_builtin_imagegen_projection(
        db: &Arc<Database>,
        target: ImagegenTarget,
    ) -> Result<()> {
        let _guard = lock()?;
        validated_projection(db, target).map(|_| ())
    }

    /// A read-only, coherent bundle snapshot. The ZIP writer need not hold the
    /// lifecycle lock while compressing or writing the user's chosen file.
    pub fn builtin_imagegen_export_snapshot(
        db: &Arc<Database>,
        target: ImagegenTarget,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        let _guard = lock()?;
        let (skill, projection) = validated_projection(db, target)?;
        export_snapshot_at(&skill, &projection)
    }
}

fn validated_projection(
    db: &Arc<Database>,
    target: ImagegenTarget,
) -> Result<(InstalledSkill, Projection)> {
    let skill = owned_record(db)?.ok_or_else(|| anyhow!("图像生成技能未安装"))?;
    if !target.is_enabled(&skill.apps) {
        return Err(anyhow!("此客户端尚未启用图像生成技能"));
    }
    validate_current_projection_for(&skill, target)?;
    let projection = Projection::new(target)?;
    if !exists(&projection.path)
        || SkillService::is_symlink(&projection.path)
        || !projection.validate_binding()?
    {
        return Err(anyhow!("图像技能绑定尚未就绪，请先重新安装或同步"));
    }
    Ok((skill, projection))
}

fn export_snapshot_at(
    skill: &InstalledSkill,
    projection: &Projection,
) -> Result<Vec<(String, Vec<u8>)>> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    const MAX_FILE_BYTES: u64 = 1024 * 1024;
    let mut files = Vec::new();
    for name in EXPORT_FILES {
        let path = projection.path.join(name);
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() || metadata.len() > MAX_FILE_BYTES {
            return Err(anyhow!("图像技能文件异常，请重新安装后导出"));
        }
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(anyhow!("图像技能文件过大，无法导出"));
        }
        files.push((name.to_string(), bytes));
    }
    // The lifecycle lock prevents our own refresh/uninstall racing the reads.
    // Recheck the returned bytes as well, so external writes cannot produce a
    // mixed-version or redirected snapshot between validation and reading.
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    for (name, bytes) in &files {
        if name == BINDING_FILE {
            let binding: Binding = serde_json::from_slice(bytes)?;
            if binding != projection.binding() {
                return Err(anyhow!("导出期间图像技能绑定已改变，请重试"));
            }
        } else {
            hasher.update(name.as_bytes());
            hasher.update(b"\0");
            hasher.update(bytes);
            hasher.update(b"\0");
        }
    }
    if skill.content_hash.as_deref() != Some(format!("{:x}", hasher.finalize()).as_str()) {
        return Err(anyhow!("导出期间图像技能内容已改变，请重试"));
    }
    Ok(files)
}

fn maintain_locked(
    db: &Arc<Database>,
    target: ImagegenTarget,
    explicit: bool,
) -> Result<Option<InstalledSkill>> {
    let existing = owned_record(db)?;
    if should_skip(db, existing.as_ref(), target, explicit)? {
        return Ok(None);
    }
    let mut apps = existing
        .as_ref()
        .map(|skill| skill.apps.clone())
        .unwrap_or_default();
    target.set_enabled(&mut apps, true);
    let projections = ImagegenTarget::enabled_targets(&apps)
        .into_iter()
        .map(Projection::new)
        .collect::<Result<Vec<_>>>()?;
    let ssot = SkillService::get_ssot_dir()?;
    install_at(
        db,
        existing.as_ref(),
        apps,
        &ssot,
        &projections,
        target,
        |projection| copy_projection(&ssot.join(BUILTIN_IMAGEGEN_DIRECTORY), projection),
    )
    .map(Some)
}

pub(super) fn refresh_locked(db: &Arc<Database>) -> Result<InstalledSkill> {
    let existing = owned_record(db)?.ok_or_else(|| anyhow!("图像生成技能未安装"))?;
    let targets = ImagegenTarget::enabled_targets(&existing.apps);
    let target = targets.first().copied().unwrap_or(ImagegenTarget::Codex);
    let projections = targets
        .into_iter()
        .map(Projection::new)
        .collect::<Result<Vec<_>>>()?;
    let ssot = SkillService::get_ssot_dir()?;
    install_at(
        db,
        Some(&existing),
        existing.apps.clone(),
        &ssot,
        &projections,
        target,
        |projection| copy_projection(&ssot.join(BUILTIN_IMAGEGEN_DIRECTORY), projection),
    )
}

fn install_at(
    db: &Arc<Database>,
    existing: Option<&InstalledSkill>,
    apps: SkillApps,
    ssot: &Path,
    projections: &[Projection],
    target: ImagegenTarget,
    sync: impl Fn(&Projection) -> Result<()>,
) -> Result<InstalledSkill> {
    fs::create_dir_all(ssot)?;
    let source = ssot.join(BUILTIN_IMAGEGEN_DIRECTORY);
    validate_locations(&source, projections)?;
    let old_hash = existing.and_then(|skill| skill.content_hash.as_deref());
    if exists(&source) {
        if existing.is_none() {
            return Err(anyhow!("存在未托管的同名图像生成技能目录，已保留"));
        }
        validate_hash(&source, old_hash)?;
    }
    for projection in projections {
        validate_projection(
            projection,
            &source,
            old_hash,
            existing.is_some_and(|skill| projection.target.is_enabled(&skill.apps)),
        )?;
    }
    let staging = ssot.join(format!(
        ".{BUILTIN_IMAGEGEN_DIRECTORY}.staging-{}",
        uuid::Uuid::new_v4()
    ));
    let staged = (|| {
        write_bundle(&staging)?;
        SkillService::compute_dir_hash(&staging)
    })();
    let hash = match staged {
        Ok(hash) => hash,
        Err(error) => {
            let _ = SkillService::remove_path(&staging);
            return Err(error);
        }
    };
    let now = Utc::now().timestamp();
    let skill = InstalledSkill {
        id: BUILTIN_IMAGEGEN_ID.into(),
        name: "YuanHeng ImageGen".into(),
        description: Some(
            "Generate and edit images using the latest available YuanHeng image model.".into(),
        ),
        directory: BUILTIN_IMAGEGEN_DIRECTORY.into(),
        repo_owner: None,
        repo_name: None,
        repo_branch: None,
        readme_url: None,
        apps,
        installed_at: existing.map(|skill| skill.installed_at).unwrap_or(now),
        content_hash: Some(hash.clone()),
        updated_at: now,
    };
    let state = match StateSnapshot::take(db, existing) {
        Ok(state) => state,
        Err(error) => {
            let _ = SkillService::remove_path(&staging);
            return Err(error);
        }
    };
    let mut snapshots = Vec::new();
    let result = (|| {
        let unchanged = existing.is_some_and(|old| {
            exists(&source)
                && old_hash == Some(hash.as_str())
                && old.apps == skill.apps
                && old.description == skill.description
        }) && projections.iter().all(|projection| {
            exists(&projection.path)
                && !SkillService::is_symlink(&projection.path)
                && projection.validate_binding().unwrap_or(false)
        });
        if unchanged {
            SkillService::remove_path(&staging)?;
        } else {
            snapshots.push(Snapshot::take(&source)?);
            fs::rename(&staging, &source)?;
            for projection in projections {
                snapshots.push(Snapshot::take(&projection.path)?);
                sync(projection)?;
            }
            db.save_skill(&skill)?;
        }
        remember_initialized(db, target)?;
        db.delete_setting(UNINSTALLED_KEY)?;
        Ok(())
    })();
    let unchanged = snapshots.is_empty() && result.is_ok();
    let finished = finish_transaction(db, state, snapshots, result);
    let _ = SkillService::remove_path(&staging);
    finished?;
    Ok(if unchanged {
        existing.cloned().unwrap_or(skill)
    } else {
        skill
    })
}

pub(super) fn validate_current_projection(skill: &InstalledSkill, app: &AppType) -> Result<()> {
    validate_current_projection_for(skill, ImagegenTarget::parse(app.as_str())?)
}

pub(super) fn validate_current_projection_for(
    skill: &InstalledSkill,
    target: ImagegenTarget,
) -> Result<()> {
    let source = SkillService::get_ssot_dir()?.join(BUILTIN_IMAGEGEN_DIRECTORY);
    validate_hash(&source, skill.content_hash.as_deref())?;
    validate_projection(
        &Projection::new(target)?,
        &source,
        skill.content_hash.as_deref(),
        target.is_enabled(&skill.apps),
    )
}

// Called only from the common sync path after its caller validates ownership.
// Always copy: one target's binding must never modify the shared source.
pub(super) fn sync_projection(target: ImagegenTarget) -> Result<()> {
    let source = SkillService::get_ssot_dir()?.join(BUILTIN_IMAGEGEN_DIRECTORY);
    let projection = Projection::new(target)?;
    validate_locations(&source, std::slice::from_ref(&projection))?;
    let snapshot = Snapshot::take(&projection.path)?;
    if let Err(error) = copy_projection(&source, &projection) {
        snapshot.restore().context("恢复图像技能投影失败")?;
        return Err(error);
    }
    snapshot.finish();
    Ok(())
}

pub(super) fn uninstall_locked(db: &Arc<Database>, skill: &InstalledSkill) -> Result<()> {
    let source = SkillService::get_ssot_dir()?.join(BUILTIN_IMAGEGEN_DIRECTORY);
    let projections = ImagegenTarget::enabled_targets(&skill.apps)
        .into_iter()
        .map(Projection::new)
        .collect::<Result<Vec<_>>>()?;
    uninstall_at(db, skill, &source, &projections)
}

fn disable_at(db: &Arc<Database>, skill: &InstalledSkill, projection: &Projection) -> Result<()> {
    let state = StateSnapshot::take(db, Some(skill))?;
    let snapshots = vec![Snapshot::take(&projection.path)?];
    let result = (|| {
        let mut apps = skill.apps.clone();
        projection.target.set_enabled(&mut apps, false);
        db.update_skill_apps(&skill.id, &apps)?;
        remember_initialized(db, projection.target)
    })();
    finish_transaction(db, state, snapshots, result)
}

fn uninstall_at(
    db: &Arc<Database>,
    skill: &InstalledSkill,
    source: &Path,
    projections: &[Projection],
) -> Result<()> {
    validate_locations(source, projections)?;
    for projection in projections {
        validate_projection(projection, source, skill.content_hash.as_deref(), true)?;
    }
    let state = StateSnapshot::take(db, Some(skill))?;
    let mut snapshots = Vec::new();
    let result = (|| {
        for projection in projections {
            snapshots.push(Snapshot::take(&projection.path)?);
        }
        snapshots.push(Snapshot::take(source)?);
        db.delete_skill(&skill.id)?;
        db.set_setting(UNINSTALLED_KEY, "true")?;
        for target in ImagegenTarget::all() {
            remember_initialized(db, target)?;
        }
        Ok(())
    })();
    finish_transaction(db, state, snapshots, result)
}

pub(super) fn restore_locked(
    db: &Arc<Database>,
    skill: InstalledSkill,
    backup_source: &Path,
    target: ImagegenTarget,
) -> Result<InstalledSkill> {
    let source = SkillService::get_ssot_dir()?.join(BUILTIN_IMAGEGEN_DIRECTORY);
    let projection = Projection::new(target)?;
    restore_at(db, skill, backup_source, &source, &projection)
}

fn restore_at(
    db: &Arc<Database>,
    mut skill: InstalledSkill,
    backup_source: &Path,
    source: &Path,
    projection: &Projection,
) -> Result<InstalledSkill> {
    validate_locations(source, std::slice::from_ref(projection))?;
    if exists(source) || exists(&projection.path) {
        return Err(anyhow!("图像技能恢复目录已存在，已保留"));
    }
    validate_tree(backup_source)?;
    if exists(&backup_source.join(BINDING_FILE)) {
        return Err(anyhow!("图像技能备份含有非源文件绑定，无法恢复"));
    }
    skill.apps = SkillApps::default();
    projection.target.set_enabled(&mut skill.apps, true);
    skill.installed_at = Utc::now().timestamp();
    skill.updated_at = 0;
    skill.content_hash = Some(SkillService::compute_dir_hash(backup_source)?);
    let state = StateSnapshot::take(db, None)?;
    let mut snapshots = Vec::new();
    let result = (|| {
        snapshots.push(Snapshot::take(source)?);
        SkillService::copy_dir_recursive(backup_source, source)?;
        snapshots.push(Snapshot::take(&projection.path)?);
        copy_projection(source, projection)?;
        db.save_skill(&skill)?;
        remember_initialized(db, projection.target)?;
        db.delete_setting(UNINSTALLED_KEY)?;
        Ok(())
    })();
    finish_transaction(db, state, snapshots, result)?;
    Ok(skill)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{tempdir, TempDir};

    struct Fixture {
        temp: TempDir,
        db: Arc<Database>,
        ssot: PathBuf,
        projections: Vec<Projection>,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempdir().unwrap();
            let ssot = temp.path().join("ssot");
            let projections = [
                ImagegenTarget::Codex,
                ImagegenTarget::Dsh,
                ImagegenTarget::WorkBuddy,
            ]
            .into_iter()
            .map(|target| Projection {
                target,
                path: temp
                    .path()
                    .join(target.as_str())
                    .join(BUILTIN_IMAGEGEN_DIRECTORY),
                runtime_path: temp
                    .path()
                    .join("imagegen")
                    .join(format!("{}.json", target.as_str())),
            })
            .collect();
            Self {
                temp,
                db: Arc::new(Database::memory().unwrap()),
                ssot,
                projections,
            }
        }
        fn source(&self) -> PathBuf {
            self.ssot.join(BUILTIN_IMAGEGEN_DIRECTORY)
        }
        fn projection(&self, target: ImagegenTarget) -> &Projection {
            self.projections
                .iter()
                .find(|p| p.target == target)
                .unwrap()
        }
        fn active(&self, apps: &SkillApps) -> Vec<Projection> {
            self.projections
                .iter()
                .filter(|p| p.target.is_enabled(apps))
                .cloned()
                .collect()
        }
        fn install(
            &self,
            existing: Option<&InstalledSkill>,
            target: ImagegenTarget,
        ) -> Result<InstalledSkill> {
            let mut apps = existing.map(|skill| skill.apps.clone()).unwrap_or_default();
            target.set_enabled(&mut apps, true);
            install_at(
                &self.db,
                existing,
                apps.clone(),
                &self.ssot,
                &self.active(&apps),
                target,
                |p| copy_projection(&self.source(), p),
            )
        }
        fn seed_old(&self) -> InstalledSkill {
            let mut skill = self.install(None, ImagegenTarget::Codex).unwrap();
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
    fn fresh_install_refresh_and_binding_isolation() {
        let f = Fixture::new();
        let old = f.seed_old();
        let updated = f.install(Some(&old), ImagegenTarget::Dsh).unwrap();
        assert_eq!(updated.installed_at, old.installed_at);
        assert_ne!(updated.content_hash, old.content_hash);
        assert!(updated.apps.codex && updated.apps.dsh);
        assert!(!exists(&f.source().join(BINDING_FILE)));
        assert!(f.source().join("scripts/run_imagegen.mjs").exists());
        for p in f.active(&updated.apps) {
            assert!(!SkillService::is_symlink(&p.path));
            assert!(p.validate_binding().unwrap());
            assert_eq!(
                projection_hash(&p).unwrap(),
                updated.content_hash.clone().unwrap()
            );
        }
        assert_ne!(f.projections[0].binding(), f.projections[1].binding());
        let unchanged = f.install(Some(&updated), ImagegenTarget::Dsh).unwrap();
        assert_eq!(unchanged.updated_at, updated.updated_at);
        let saved =
            f.db.get_installed_skill(BUILTIN_IMAGEGEN_ID)
                .unwrap()
                .unwrap();
        assert!(saved.apps.codex && saved.apps.dsh && !saved.apps.workbuddy);
    }

    #[test]
    fn per_target_disable_does_not_disable_other_or_new_clients() {
        let f = Fixture::new();
        let codex = f.install(None, ImagegenTarget::Codex).unwrap();
        let both = f.install(Some(&codex), ImagegenTarget::Dsh).unwrap();
        disable_at(&f.db, &both, f.projection(ImagegenTarget::Dsh)).unwrap();
        let disabled =
            f.db.get_installed_skill(BUILTIN_IMAGEGEN_ID)
                .unwrap()
                .unwrap();
        assert!(disabled.apps.codex && !disabled.apps.dsh);
        assert!(!exists(&f.projection(ImagegenTarget::Dsh).path));
        assert!(exists(&f.projection(ImagegenTarget::Codex).path));
        assert!(should_skip(&f.db, Some(&disabled), ImagegenTarget::Dsh, false).unwrap());
        assert!(!should_skip(&f.db, Some(&disabled), ImagegenTarget::WorkBuddy, false).unwrap());
        assert!(!should_skip(&f.db, Some(&disabled), ImagegenTarget::Codex, false).unwrap());
    }

    #[test]
    fn global_uninstall_and_restore_keep_other_targets_opted_out() {
        let f = Fixture::new();
        let codex = f.install(None, ImagegenTarget::Codex).unwrap();
        let skill = f.install(Some(&codex), ImagegenTarget::Dsh).unwrap();
        let backup = f.temp.path().join("backup");
        SkillService::copy_dir_recursive(&f.source(), &backup).unwrap();
        uninstall_at(&f.db, &skill, &f.source(), &f.active(&skill.apps)).unwrap();
        assert!(f
            .db
            .get_installed_skill(BUILTIN_IMAGEGEN_ID)
            .unwrap()
            .is_none());
        assert!(!exists(&f.source()));
        for target in ImagegenTarget::all() {
            assert!(should_skip(&f.db, None, target, false).unwrap());
        }
        let restored = restore_at(
            &f.db,
            skill,
            &backup,
            &f.source(),
            f.projection(ImagegenTarget::WorkBuddy),
        )
        .unwrap();
        assert!(restored.apps.workbuddy && !restored.apps.codex && !restored.apps.dsh);
        assert!(f
            .projection(ImagegenTarget::WorkBuddy)
            .validate_binding()
            .unwrap());
        assert!(!should_skip(&f.db, Some(&restored), ImagegenTarget::WorkBuddy, false).unwrap());
        assert!(should_skip(&f.db, Some(&restored), ImagegenTarget::Codex, false).unwrap());
    }

    #[test]
    fn legacy_deleted_record_is_global_optout_but_disabled_codex_is_local() {
        let f = Fixture::new();
        f.db.set_setting(LEGACY_INITIALIZED_KEY, "true").unwrap();
        assert!(should_skip(&f.db, None, ImagegenTarget::Dsh, false).unwrap());
        assert!(should_skip(&f.db, None, ImagegenTarget::WorkBuddy, false).unwrap());
        assert!(!should_skip(&f.db, None, ImagegenTarget::Dsh, true).unwrap());
        let g = Fixture::new();
        let mut skill = g.install(None, ImagegenTarget::Codex).unwrap();
        skill.apps.codex = false;
        g.db.save_skill(&skill).unwrap();
        g.db.delete_setting(&initialized_key(ImagegenTarget::Codex))
            .unwrap();
        g.db.set_setting(LEGACY_INITIALIZED_KEY, "true").unwrap();
        assert!(should_skip(&g.db, Some(&skill), ImagegenTarget::Codex, false).unwrap());
        assert!(!should_skip(&g.db, Some(&skill), ImagegenTarget::Dsh, false).unwrap());
    }

    #[test]
    fn new_target_never_adopts_unknown_same_name_even_matching_bytes() {
        let f = Fixture::new();
        let skill = f.install(None, ImagegenTarget::Codex).unwrap();
        let dsh = f.projection(ImagegenTarget::Dsh);
        copy_projection(&f.source(), dsh).unwrap();
        assert_eq!(
            projection_hash(dsh).unwrap(),
            skill.content_hash.clone().unwrap()
        );
        assert!(f.install(Some(&skill), ImagegenTarget::Dsh).is_err());
        assert!(exists(&dsh.path));
        assert!(
            !f.db
                .get_installed_skill(&skill.id)
                .unwrap()
                .unwrap()
                .apps
                .dsh
        );
        let mut external = skill;
        external.id = "local:meta-api-imagegen".into();
        f.db.delete_skill(BUILTIN_IMAGEGEN_ID).unwrap();
        f.db.save_skill(&external).unwrap();
        assert!(owned_record(&f.db).is_err());
    }

    #[test]
    fn binding_tampering_and_other_extra_files_are_not_ignored_by_hash() {
        for mutation in ["binding", "unknown-field", "extra", "hidden"] {
            let f = Fixture::new();
            let skill = f.install(None, ImagegenTarget::Codex).unwrap();
            let p = &f.projections[0];
            match mutation {
                "binding" => {
                    let mut binding = p.binding();
                    binding.target = "dsh".into();
                    fs::write(
                        p.path.join(BINDING_FILE),
                        serde_json::to_vec(&binding).unwrap(),
                    )
                    .unwrap();
                }
                "unknown-field" => {
                    let mut binding = serde_json::to_value(p.binding()).unwrap();
                    binding["extra"] = true.into();
                    fs::write(
                        p.path.join(BINDING_FILE),
                        serde_json::to_vec(&binding).unwrap(),
                    )
                    .unwrap();
                }
                "extra" => {
                    fs::write(p.path.join("personal.txt"), "keep").unwrap();
                }
                _ => {
                    fs::write(p.path.join(".personal"), "keep").unwrap();
                }
            }
            assert!(
                f.install(Some(&skill), ImagegenTarget::Codex).is_err(),
                "{mutation}"
            );
            assert!(exists(&p.path));
        }
    }

    #[test]
    fn projection_failure_rolls_back_files_record_and_all_markers() {
        let f = Fixture::new();
        let old = f.seed_old();
        let old_binding = fs::read(f.projections[0].path.join(BINDING_FILE)).unwrap();
        let mut apps = old.apps.clone();
        apps.dsh = true;
        let result = install_at(
            &f.db,
            Some(&old),
            apps.clone(),
            &f.ssot,
            &f.active(&apps),
            ImagegenTarget::Dsh,
            |p| {
                copy_projection(&f.source(), p)?;
                if p.target == ImagegenTarget::Dsh {
                    return Err(anyhow!("simulated failure"));
                }
                Ok(())
            },
        );
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("simulated failure"));
        assert_eq!(
            SkillService::compute_dir_hash(&f.source()).unwrap(),
            old.content_hash.clone().unwrap()
        );
        assert_eq!(
            projection_hash(&f.projections[0]).unwrap(),
            old.content_hash.clone().unwrap()
        );
        assert_eq!(
            fs::read(f.projections[0].path.join(BINDING_FILE)).unwrap(),
            old_binding
        );
        assert!(!exists(&f.projections[1].path));
        let saved = f.db.get_installed_skill(&old.id).unwrap().unwrap();
        assert_eq!(saved.updated_at, 1);
        assert!(!saved.apps.dsh);
        assert!(f
            .db
            .get_setting(&initialized_key(ImagegenTarget::Dsh))
            .unwrap()
            .is_none());
    }

    #[test]
    fn first_install_failure_leaves_no_record_or_marker_and_can_retry() {
        let f = Fixture::new();
        let apps = SkillApps::only(&AppType::Codex);
        assert!(install_at(
            &f.db,
            None,
            apps.clone(),
            &f.ssot,
            &f.active(&apps),
            ImagegenTarget::Codex,
            |_| Err(anyhow!("read only"))
        )
        .is_err());
        assert!(!exists(&f.source()));
        assert!(!exists(&f.projections[0].path));
        assert!(f
            .db
            .get_installed_skill(BUILTIN_IMAGEGEN_ID)
            .unwrap()
            .is_none());
        assert!(!should_skip(&f.db, None, ImagegenTarget::Codex, false).unwrap());
        f.install(None, ImagegenTarget::Codex).unwrap();
    }

    #[test]
    fn global_uninstall_rolls_back_when_optout_cannot_be_saved() {
        let f = Fixture::new();
        let first = f.install(None, ImagegenTarget::Codex).unwrap();
        let skill = f.install(Some(&first), ImagegenTarget::Dsh).unwrap();
        f.db.conn.lock().unwrap().execute_batch(
            "CREATE TRIGGER reject_imagegen_optout BEFORE INSERT ON settings
             WHEN NEW.key = 'builtin_imagegen_uninstalled' BEGIN SELECT RAISE(ABORT, 'read only'); END;"
        ).unwrap();
        assert!(uninstall_at(&f.db, &skill, &f.source(), &f.active(&skill.apps)).is_err());
        let saved = f.db.get_installed_skill(&skill.id).unwrap().unwrap();
        assert_eq!(saved.apps, skill.apps);
        assert_eq!(
            SkillService::compute_dir_hash(&f.source()).unwrap(),
            skill.content_hash.clone().unwrap()
        );
        for projection in f.active(&skill.apps) {
            assert_eq!(
                projection_hash(&projection).unwrap(),
                skill.content_hash.clone().unwrap()
            );
        }
        assert!(f.db.get_setting(UNINSTALLED_KEY).unwrap().is_none());
    }

    #[test]
    fn hidden_source_additions_are_rejected_even_when_legacy_hash_matches() {
        let f = Fixture::new();
        let skill = f.install(None, ImagegenTarget::Codex).unwrap();
        fs::write(f.source().join(".personal"), "keep").unwrap();
        assert_eq!(
            SkillService::compute_dir_hash(&f.source()).unwrap(),
            skill.content_hash.clone().unwrap()
        );
        assert!(f.install(Some(&skill), ImagegenTarget::Dsh).is_err());
        assert_eq!(
            fs::read_to_string(f.source().join(".personal")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn export_snapshot_is_bound_and_independent_of_later_refresh() {
        let f = Fixture::new();
        let skill = f.install(None, ImagegenTarget::WorkBuddy).unwrap();
        let projection = f.projection(ImagegenTarget::WorkBuddy);
        let snapshot = export_snapshot_at(&skill, projection).unwrap();
        assert_eq!(snapshot.len(), 5);
        assert!(snapshot
            .iter()
            .all(|(name, _)| EXPORT_FILES.contains(&name.as_str())));
        let binding: Binding = serde_json::from_slice(
            &snapshot
                .iter()
                .find(|(name, _)| name == BINDING_FILE)
                .unwrap()
                .1,
        )
        .unwrap();
        assert_eq!(binding, projection.binding());
        fs::write(projection.path.join("SKILL.md"), "external edit").unwrap();
        assert!(export_snapshot_at(&skill, projection).is_err());
        assert_eq!(
            snapshot
                .iter()
                .find(|(name, _)| name == "SKILL.md")
                .unwrap()
                .1,
            BUILTIN_IMAGEGEN_SKILL_MD.as_bytes()
        );
    }

    #[test]
    fn shared_target_paths_are_rejected_before_any_write() {
        let f = Fixture::new();
        let mut second = f.projections[0].clone();
        second.target = ImagegenTarget::Dsh;
        let projections = vec![f.projections[0].clone(), second];
        let mut apps = SkillApps::only(&AppType::Codex);
        apps.dsh = true;
        assert!(install_at(
            &f.db,
            None,
            apps,
            &f.ssot,
            &projections,
            ImagegenTarget::Dsh,
            |_| Ok(())
        )
        .is_err());
        assert!(!exists(&f.source()));
    }

    #[cfg(unix)]
    #[test]
    fn owned_legacy_symlink_migrates_to_copy_without_binding_the_source() {
        let f = Fixture::new();
        let skill = f.install(None, ImagegenTarget::Codex).unwrap();
        SkillService::remove_path(&f.projections[0].path).unwrap();
        std::os::unix::fs::symlink(f.source(), &f.projections[0].path).unwrap();
        f.install(Some(&skill), ImagegenTarget::Codex).unwrap();
        assert!(!SkillService::is_symlink(&f.projections[0].path));
        assert!(f.projections[0].validate_binding().unwrap());
        assert!(!exists(&f.source().join(BINDING_FILE)));
    }

    #[test]
    fn owned_legacy_copy_without_binding_migrates_and_missing_files_repair() {
        let f = Fixture::new();
        let skill = f.install(None, ImagegenTarget::Codex).unwrap();
        fs::remove_file(f.projections[0].path.join(BINDING_FILE)).unwrap();
        f.install(Some(&skill), ImagegenTarget::Codex).unwrap();
        assert!(f.projections[0].validate_binding().unwrap());
        fs::remove_dir_all(f.source()).unwrap();
        fs::remove_dir_all(&f.projections[0].path).unwrap();
        f.install(Some(&skill), ImagegenTarget::Codex).unwrap();
        assert!(f.projections[0].validate_binding().unwrap());
    }
}
