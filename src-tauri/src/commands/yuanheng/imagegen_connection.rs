//! Explicit, per-surface image connections. SQLite contains only public binding
//! metadata; the credential is an immutable, randomly named system-store item.
use super::*;
use crate::{database::Database, services::skill::ImagegenTarget};
use std::sync::Mutex;

const PREFIX: &str = "yuanheng_imagegen_connection_";
const EPOCH: &str = "yuanheng_imagegen_account_epoch";
const CHANGED: &str = "图像连接的账号已变化，请重新选择图像分组";
static MUTATION: Mutex<()> = Mutex::new(());
static CONFIGURE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Binding {
    account: String,
    epoch: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Connection {
    surface: String,
    group: String,
    binding: Binding,
    secret: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredSecret {
    connection: Connection,
    token: String,
}

fn record_reference(record: &Connection) -> String {
    use sha2::{Digest, Sha256};
    // Include every public field. Mutating a group/account in SQLite without
    // rotating the random secret selector must also invalidate Core's cache.
    let bytes = serde_json::to_vec(record).expect("connection metadata is serializable");
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_surface(surface: &str) -> Result<(), String> {
    ImagegenTarget::parse(surface).map_err(|e| e.to_string())?;
    Ok(())
}

fn key(surface: &str) -> Result<String, String> {
    validate_surface(surface)?;
    Ok(format!("{PREFIX}{surface}"))
}

fn secret_key(id: &str) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(id).map_err(|_| "图像连接凭据索引无效")?;
    Ok(format!("yuanheng_imagegen_secret_{id}"))
}

fn account_binding(db: &Database) -> Result<Binding, String> {
    let raw = db
        .get_setting(CACHE_KEY)
        .map_err(|_| CHANGED)?
        .ok_or(CHANGED)?;
    let status: YuanhengConnectionStatus = serde_json::from_str(&raw).map_err(|_| CHANGED)?;
    if status.session_only {
        return Err("当前仅会话登录，请先保存登录后选择独立图片分组".into());
    }
    if !status.connected {
        return Err(CHANGED.into());
    }
    let account = status
        .user_id
        .filter(|id| !id.trim().is_empty())
        .ok_or(CHANGED)?;
    let epoch = db.get_setting(EPOCH).map_err(|_| CHANGED)?.ok_or(CHANGED)?;
    uuid::Uuid::parse_str(&epoch).map_err(|_| CHANGED)?;
    Ok(Binding { account, epoch })
}

fn connection(db: &Database, surface: &str) -> Result<Option<Connection>, String> {
    db.get_setting(&key(surface)?)
        .map_err(|_| "无法读取图像连接".to_string())?
        .map(|raw| {
            let value: Connection = serde_json::from_str(&raw).map_err(|_| "图像连接格式无效")?;
            if value.surface != surface || value.group.trim().is_empty() || value.group.len() > 256
            {
                return Err("图像连接与当前工具不匹配".into());
            }
            secret_key(&value.secret)?;
            Ok(value)
        })
        .transpose()
}

pub(super) fn group(db: &Database, surface: &str) -> Result<Option<String>, String> {
    Ok(connection(db, surface)?.map(|record| record.group))
}

pub(crate) fn has_connection(db: &Database, surface: &str) -> Result<bool, String> {
    Ok(connection(db, surface)?.is_some())
}

pub(super) fn active_reference(db: &Database, surface: &str) -> Result<Option<String>, String> {
    let Some(record) = connection(db, surface)? else {
        return Ok(None);
    };
    if record.binding != account_binding(db)? {
        return Err(CHANGED.into());
    }
    Ok(Some(record_reference(&record)))
}

pub(crate) fn explicit_provider(db: &Database, surface: &str) -> Result<Option<Provider>, String> {
    let Some(record) = connection(db, surface)? else {
        return Ok(None);
    };
    if account_binding(db)? != record.binding {
        return Err(CHANGED.into());
    }
    let raw = crate::secure_storage::get_secret(&secret_key(&record.secret)?)
        .map_err(|_| "无法读取图像连接的系统凭据，请重新连接图像分组")?
        .ok_or("图像连接凭据已失效，请重新连接图像分组")?;
    let stored: StoredSecret = serde_json::from_str(&raw).map_err(|_| "图像连接凭据格式无效")?;
    if stored.connection != record
        || connection(db, surface)?.as_ref() != Some(&record)
        || account_binding(db)? != record.binding
    {
        return Err(CHANGED.into());
    }
    super::imagegen_credentials::provider_from_key(stored.token).map(Some)
}

fn skill_enabled(db: &Database, surface: &str) -> Result<bool, String> {
    let target = ImagegenTarget::parse(surface).map_err(|e| e.to_string())?;
    Ok(db
        .get_installed_skill("builtin:meta-api-imagegen")
        .map_err(|_| "无法读取图像技能状态")?
        .is_some_and(|skill| target.is_enabled(&skill.apps)))
}

/// Public references are sufficient to discover whether a restarted Core needs
/// a credential seed. This function never touches a platform credential store.
pub(crate) fn credential_refs(
    db: &Database,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut refs = std::collections::BTreeMap::new();
    let Ok(binding) = account_binding(db) else {
        return Ok(refs);
    };
    for surface in surfaces() {
        if !skill_enabled(db, surface)? {
            continue;
        }
        if let Ok(Some(record)) = connection(db, surface) {
            if record.binding == binding {
                refs.insert(surface.into(), record_reference(&record));
            }
        }
    }
    Ok(refs)
}

/// Called only in Desktop. Secrets travel over the authenticated loopback
/// management channel and remain in Core memory; Core never opens Keychain.
pub(crate) fn credential_snapshot(
    db: &Database,
) -> Result<Vec<crate::imagegen_core::CredentialEntry>, String> {
    let refs = credential_refs(db)?;
    let mut entries = Vec::new();
    for (surface, reference) in &refs {
        let provider = explicit_provider(db, surface)?.ok_or(CHANGED)?;
        let token = provider.settings_config["auth"]["OPENAI_API_KEY"]
            .as_str()
            .ok_or(CHANGED)?
            .to_owned();
        validate_core_entry(db, surface, reference, &token)?;
        entries.push(crate::imagegen_core::CredentialEntry {
            surface: surface.clone(),
            connection_ref: reference.clone(),
            api_token: token,
        });
    }
    if credential_refs(db)? != refs {
        return Err(CHANGED.into());
    }
    Ok(entries)
}

pub(crate) fn validate_core_entry(
    db: &Database,
    surface: &str,
    reference: &str,
    token: &str,
) -> Result<(), String> {
    let record = connection(db, surface)?.ok_or(CHANGED)?;
    if record_reference(&record) != reference
        || record.binding != account_binding(db)?
        || !skill_enabled(db, surface)?
        || !super::imagegen_credentials::valid_platform_key(token)
    {
        return Err(CHANGED.into());
    }
    Ok(())
}

pub(crate) fn core_provider(db: &Database, surface: &str) -> Result<Option<Provider>, String> {
    let Some(record) = connection(db, surface)? else {
        return Ok(None);
    };
    let reference = record_reference(&record);
    let token = crate::imagegen_core::credential(surface, &reference)
        .ok_or("Core 的图像凭据尚未同步，请打开元衡客户端后重试")?;
    validate_core_entry(db, surface, &reference, &token)?;
    super::imagegen_credentials::provider_from_key(token).map(Some)
}

fn cleanup(record: &Connection) {
    // An edited selector must not delete another target's system-store item.
    // Failure is harmless after the database reference has been revoked.
    let Ok(key) = secret_key(&record.secret) else {
        return;
    };
    let matches = crate::secure_storage::get_secret(&key)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<StoredSecret>(&raw).ok())
        .is_some_and(|stored| stored.connection == *record);
    if matches {
        let _ = crate::secure_storage::delete_secret(&key);
    }
}

/// Revoke references before best-effort key cleanup. Core cannot reuse its old
/// per-process key cache after logout, account switch, or a connection replacement.
pub(super) fn invalidate(db: &Database) -> Result<(), String> {
    let _guard = MUTATION.lock().map_err(|_| "图像连接锁不可用")?;
    let surfaces = surfaces();
    let old: Vec<_> = surfaces
        .iter()
        .filter_map(|s| connection(db, s).ok().flatten())
        .collect();
    let keys: Vec<_> = surfaces.iter().map(|s| key(s)).collect::<Result<_, _>>()?;
    let epoch = uuid::Uuid::new_v4().to_string();
    let mut changes = vec![(EPOCH, Some(epoch.as_str()))];
    changes.extend(keys.iter().map(|key| (key.as_str(), None)));
    db.set_settings_atomically(&changes)
        .map_err(|_| "无法撤销图像连接")?;
    for old in old {
        cleanup(&old);
    }
    Ok(())
}

pub(super) fn account_will_change(db: &Database, user_id: &str) -> Result<(), String> {
    let current = db
        .get_setting(CACHE_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|raw| serde_json::from_str::<YuanhengConnectionStatus>(&raw).ok());
    if current.as_ref().and_then(|s| s.user_id.as_deref()) != Some(user_id)
        || !current.is_some_and(|s| s.connected)
    {
        invalidate(db)?;
    }
    Ok(())
}

fn surfaces() -> Vec<&'static str> {
    let mut names: Vec<_> = ImagegenTarget::all()
        .into_iter()
        .map(|t| t.as_str())
        .collect();
    names.push(CHATGPT_DESKTOP_NAMESPACE);
    names
}

fn login(state: &AppState) -> Result<(Binding, String), String> {
    let status = read_cached_status(state)?;
    if !status.connected {
        return Err("请先登录元衡，再选择图像分组".into());
    }
    // Older installations acquire the public epoch only on an explicit action.
    {
        let _guard = MUTATION.lock().map_err(|_| "图像连接锁不可用")?;
        if state
            .db
            .get_setting(EPOCH)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            state
                .db
                .set_setting(EPOCH, &uuid::Uuid::new_v4().to_string())
                .map_err(|e| e.to_string())?;
        }
    }
    let binding = account_binding(&state.db)?;
    let user = get_yuanheng_secret(state, USER_ID_KEY)?.ok_or(CHANGED)?;
    let cookie = get_yuanheng_secret(state, SESSION_COOKIE_KEY)?.ok_or(CHANGED)?;
    if user != binding.account || status.user_id.as_deref() != Some(user.as_str()) {
        return Err(CHANGED.into());
    }
    Ok((binding, cookie))
}

async fn account_json(
    client: &reqwest::Client,
    url: &str,
    binding: &Binding,
    cookie: &str,
    group: Option<&str>,
) -> Result<Value, String> {
    let mut request = client.get(url);
    if let Some(group) = group {
        request = request.query(&[("group", group)]);
    }
    let response = with_session(request, Some(cookie), Some(&binding.account))
        .send()
        .await
        .map_err(|_| "读取账号目录失败，请检查网络")?;
    bounded_json(response).await
}

async fn groups_for(
    client: &reqwest::Client,
    binding: &Binding,
    cookie: &str,
) -> Result<Vec<YuanhengGroupOption>, String> {
    let value = account_json(
        client,
        &format!("{BASE_URL}/api/user/self/groups"),
        binding,
        cookie,
        None,
    )
    .await?;
    let groups = parse_user_groups(&value).map_err(|_| "账号分组响应格式异常")?;
    Ok(groups
        .into_iter()
        .filter(|g| !g.id.trim().is_empty() && g.id.len() <= 256)
        .collect())
}

async fn bounded_json(response: reqwest::Response) -> Result<Value, String> {
    use futures::StreamExt;
    if !response.status().is_success() {
        return Err(format!(
            "读取账号目录失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "读取账号目录失败")?;
        if bytes.len().saturating_add(chunk.len()) > 2 * 1024 * 1024 {
            return Err("账号目录响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "账号分组响应格式异常".into())
}

pub(crate) async fn list_groups(
    state: &AppState,
    surface: &str,
) -> Result<Vec<YuanhengGroupOption>, String> {
    validate_surface(surface)?;
    let status = read_cached_status(state)?;
    if !status.connected {
        return Err("请先登录元衡，再查看图像分组".into());
    }
    let user = get_yuanheng_secret(state, USER_ID_KEY)?.ok_or(CHANGED)?;
    let cookie = get_yuanheng_secret(state, SESSION_COOKIE_KEY)?.ok_or(CHANGED)?;
    let epoch = state.db.get_setting(EPOCH).map_err(|e| e.to_string())?;
    if status.user_id.as_deref() != Some(user.as_str()) {
        return Err(CHANGED.into());
    }
    let groups = groups_for(
        &yuanheng_client()?,
        &Binding {
            account: user.clone(),
            epoch: String::new(),
        },
        &cookie,
    )
    .await?;
    if get_yuanheng_secret(state, USER_ID_KEY)?.as_deref() != Some(user.as_str())
        || get_yuanheng_secret(state, SESSION_COOKIE_KEY)?.as_deref() != Some(cookie.as_str())
        || state.db.get_setting(EPOCH).map_err(|e| e.to_string())? != epoch
    {
        return Err(CHANGED.into());
    }
    Ok(groups)
}

fn save(
    db: &Database,
    surface: &str,
    group: &str,
    binding: &Binding,
    token: String,
) -> Result<(), String> {
    let _guard = MUTATION.lock().map_err(|_| "图像连接锁不可用")?;
    if account_binding(db)? != *binding {
        return Err(CHANGED.into());
    }
    let record = Connection {
        surface: surface.into(),
        group: group.into(),
        binding: binding.clone(),
        secret: uuid::Uuid::new_v4().to_string(),
    };
    let secret = secret_key(&record.secret)?;
    let old = connection(db, surface).ok().flatten();
    let value = serde_json::to_string(&StoredSecret {
        connection: record.clone(),
        token,
    })
    .map_err(|_| "无法保存图像连接")?;
    crate::secure_storage::set_secret(&secret, &value)
        .map_err(|_| "无法保存图像凭据到系统凭据库，请恢复凭据访问后重试")?;
    if !crate::secure_storage::verify_secret(&secret, &value).unwrap_or(false) {
        let _ = crate::secure_storage::delete_secret(&secret);
        return Err("图像凭据保存校验失败，原连接已保留".into());
    }
    let result = (|| {
        if account_binding(db)? != *binding {
            return Err(CHANGED.into());
        }
        db.set_setting(
            &key(surface)?,
            &serde_json::to_string(&record).map_err(|_| "无法保存图像连接")?,
        )
        .map_err(|_| "无法保存图像连接".to_string())
    })();
    if result.is_err() {
        let _ = crate::secure_storage::delete_secret(&secret);
    } else if let Some(old) = old {
        cleanup(&old);
    }
    result
}

fn clear(db: &Database, surface: &str, revision: &AccountRevision) -> Result<(), String> {
    let _guard = MUTATION.lock().map_err(|_| "图像连接锁不可用")?;
    if account_revision(db)? != *revision {
        return Err(CHANGED.into());
    }
    let old = connection(db, surface).ok().flatten();
    db.delete_setting(&key(surface)?)
        .map_err(|_| "无法清除图像连接")?;
    if let Some(old) = old {
        cleanup(&old);
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct AccountRevision {
    epoch: Option<String>,
    account: Option<String>,
    connected: bool,
    session_only: bool,
}

fn account_revision(db: &Database) -> Result<AccountRevision, String> {
    // Balances, models and lastSyncedAt refresh independently of identity.
    // Only login/account lifecycle fields may invalidate an in-flight setup.
    let status = db
        .get_setting(CACHE_KEY)
        .map_err(|e| e.to_string())?
        .map(|raw| serde_json::from_str::<YuanhengConnectionStatus>(&raw).map_err(|_| CHANGED))
        .transpose()?
        .unwrap_or_default();
    Ok(AccountRevision {
        epoch: db.get_setting(EPOCH).map_err(|e| e.to_string())?,
        account: status.user_id,
        connected: status.connected,
        session_only: status.session_only,
    })
}

pub(crate) async fn configure(
    state: &AppState,
    surface: &str,
    group: Option<String>,
) -> Result<ImagegenToolStatus, String> {
    validate_surface(surface)?;
    // Capture identity before queueing: a request submitted by account A must
    // never acquire account B's credentials after waiting for another setup.
    let revision = account_revision(&state.db)?;
    let authenticated = if group.is_some() {
        Some(login(state)?)
    } else {
        None
    };
    let revision = if authenticated.is_some() {
        account_revision(&state.db)?
    } else {
        revision
    };
    let _guard = CONFIGURE.lock().await;
    if account_revision(&state.db)? != revision {
        return Err(CHANGED.into());
    }
    if let Some(group) = group {
        if group.trim().is_empty() || group.len() > 256 {
            return Err("请选择有效的图像分组".into());
        }
        let (binding, cookie) = authenticated.ok_or(CHANGED)?;
        if account_binding(&state.db)? != binding {
            return Err(CHANGED.into());
        }
        let client = yuanheng_client()?;
        let groups = groups_for(&client, &binding, &cookie).await?;
        if !groups.iter().any(|g| g.id == group) {
            return Err("当前账号不可使用此图像分组".into());
        }
        if account_binding(&state.db)? != binding {
            return Err(CHANGED.into());
        }
        // Avoid creating an unused device token when the account's own group
        // catalog already proves that this group has no versioned GPT Image.
        // A failed advisory read does not replace the authoritative token check.
        if let Ok(value) = account_json(
            &client,
            &format!("{BASE_URL}/api/user/models"),
            &binding,
            &cookie,
            Some(&group),
        )
        .await
        {
            if let Ok(models) = parse_user_models(&value) {
                if select_model(&models).is_none() {
                    return Err("所选分组未授权带版本号的 GPT Image 模型，请选择支持图像生成的分组；聊天配置未改变".into());
                }
            }
        }
        if account_binding(&state.db)? != binding {
            return Err(CHANGED.into());
        }
        let (token, _) = ensure_device_api_token(&client, &cookie, &binding.account, &group)
            .await
            .map_err(|_| "读取或创建所选分组的工具凭据失败，请检查登录和分组权限")?;
        let provider = super::imagegen_credentials::provider_from_key(token.clone())?;
        let models = crate::proxy::images::image_model_ids(&provider).await?;
        if select_model(&models).is_none() {
            return Err(
                "所选分组未授权带版本号的 GPT Image 模型，请选择支持图像生成的分组；聊天配置未改变"
                    .into(),
            );
        }
        save(&state.db, surface, &group, &binding, token)?;
    } else {
        clear(&state.db, surface, &revision)?;
    }
    // The public status reports a failed Core/projection sync without losing the
    // newly verified selection; the caller can refresh/re-enable the same skill.
    let sync_error = imagegen::sync_tool(state, surface, false).await.err();
    let mut status = imagegen::tool_status(state, surface).await?;
    if account_revision(&state.db)? != revision {
        return Err(CHANGED.into());
    }
    if let Some(error) = sync_error {
        status.set_error(error);
    }
    Ok(status)
}

pub(super) fn select_model(models: &[String]) -> Option<String> {
    static MODEL: OnceLock<regex::Regex> = OnceLock::new();
    let regex = MODEL.get_or_init(|| {
        regex::Regex::new(r"(?i)^gpt-image-(\d+(?:\.\d+)*)(?:-([a-z0-9-]+))?$").unwrap()
    });
    let mut ranked: Vec<_> = models
        .iter()
        .filter_map(|id| {
            if id.is_empty()
                || id.len() > 256
                || id.trim() != id
                || id.chars().any(char::is_control)
            {
                return None;
            }
            let captures = regex.captures(id.rsplit('/').next()?)?;
            let mut version = captures[1]
                .split('.')
                .map(str::parse::<u64>)
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            while version.last() == Some(&0) {
                version.pop();
            }
            let variant = captures
                .get(2)
                .map(|s| s.as_str().to_ascii_lowercase())
                .unwrap_or_default();
            let quality = if variant == "sunburst" {
                4
            } else if variant.is_empty() {
                3
            } else if ["flare", "mini", "fast"]
                .iter()
                .any(|s| variant.contains(s))
            {
                1
            } else {
                2
            };
            Some((version, quality, id))
        })
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(b.2)));
    ranked.first().map(|(_, _, id)| (*id).clone())
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    pub fn account(db: &Database, user: &str, session_only: bool) {
        let status = YuanhengConnectionStatus {
            connected: true,
            user_id: Some(user.into()),
            session_only,
            ..Default::default()
        };
        db.set_setting(CACHE_KEY, &serde_json::to_string(&status).unwrap())
            .unwrap();
        if db.get_setting(EPOCH).unwrap().is_none() {
            db.set_setting(EPOCH, &uuid::Uuid::new_v4().to_string())
                .unwrap();
        }
    }
    pub fn install(db: &Database, surface: &str, group: &str, token: &str) {
        save(
            db,
            surface,
            group,
            &account_binding(db).unwrap(),
            token.into(),
        )
        .unwrap();
    }
    pub fn revoke(db: &Database) {
        invalidate(db).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_storage;
    use serial_test::serial;
    use std::sync::Arc;

    fn db() -> Database {
        secure_storage::clear_for_tests();
        let db = Database::memory().unwrap();
        test_support::account(&db, "account-A", false);
        db
    }

    fn token(db: &Database, surface: &str) -> String {
        explicit_provider(db, surface)
            .unwrap()
            .unwrap()
            .settings_config["auth"]["OPENAI_API_KEY"]
            .as_str()
            .unwrap()
            .into()
    }

    #[test]
    #[serial]
    fn explicit_connections_are_per_surface_verified_and_never_store_sqlite_secrets() {
        let db = db();
        for surface in surfaces() {
            test_support::install(
                &db,
                surface,
                "OpenAI · image",
                &format!("sk-synthetic-{surface}"),
            );
        }
        for surface in surfaces() {
            assert_eq!(token(&db, surface), format!("sk-synthetic-{surface}"));
        }
        assert!(explicit_provider(&db, "unknown").is_err());
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM settings").unwrap();
        for row in stmt.query_map([], |r| r.get::<_, String>(0)).unwrap() {
            let raw = row.unwrap();
            assert!(!raw.contains("synthetic"));
            assert!(!raw.contains("OPENAI_API_KEY"));
        }
        secure_storage::clear_for_tests();
    }

    #[test]
    #[serial]
    fn store_failure_keeps_previous_connection_and_rotation_revokes_old_reference() {
        let db = db();
        test_support::install(&db, "dsh", "old", "sk-synthetic-old");
        let old = connection(&db, "dsh").unwrap().unwrap();
        secure_storage::block_verification_for_tests(true);
        assert!(save(
            &db,
            "dsh",
            "new",
            &account_binding(&db).unwrap(),
            "sk-synthetic-new".into()
        )
        .is_err());
        assert_eq!(token(&db, "dsh"), "sk-synthetic-old");
        secure_storage::block_verification_for_tests(false);
        test_support::install(&db, "dsh", "new", "sk-synthetic-new");
        assert_eq!(token(&db, "dsh"), "sk-synthetic-new");
        assert!(
            secure_storage::get_secret(&secret_key(&old.secret).unwrap())
                .unwrap()
                .is_none()
        );
        secure_storage::clear_for_tests();
    }

    #[test]
    #[serial]
    fn account_switch_logout_and_memory_only_cannot_resurrect_an_image_key() {
        let db = db();
        test_support::install(&db, "dsh", "images", "sk-synthetic-A");
        let stale = connection(&db, "dsh").unwrap().unwrap();
        let stale_binding = stale.binding.clone();
        test_support::account(&db, "account-A", true);
        assert!(explicit_provider(&db, "dsh")
            .unwrap_err()
            .contains("仅会话登录"));
        test_support::account(&db, "account-B", false);
        assert!(explicit_provider(&db, "dsh").is_err());
        assert!(save(&db, "dsh", "stale", &stale_binding, "sk-stale".into()).is_err());
        invalidate(&db).unwrap();
        assert!(explicit_provider(&db, "dsh").unwrap().is_none());
        test_support::account(&db, "account-A", false);
        // Even restoring public metadata cannot resurrect the deleted key or epoch.
        db.set_setting(
            &key("dsh").unwrap(),
            &serde_json::to_string(&stale).unwrap(),
        )
        .unwrap();
        assert!(explicit_provider(&db, "dsh").is_err());
        secure_storage::clear_for_tests();
    }

    #[test]
    #[serial]
    fn copied_secret_reference_cannot_cross_surface_or_account() {
        let db = db();
        test_support::install(&db, "dsh", "images", "sk-dsh-synthetic");
        let mut altered = connection(&db, "dsh").unwrap().unwrap();
        altered.surface = "workbuddy".into();
        db.set_setting(
            &key("workbuddy").unwrap(),
            &serde_json::to_string(&altered).unwrap(),
        )
        .unwrap();
        assert!(explicit_provider(&db, "workbuddy").is_err());
        clear(&db, "workbuddy", &account_revision(&db).unwrap()).unwrap();
        assert_eq!(token(&db, "dsh"), "sk-dsh-synthetic");
        db.set_setting(&key("workbuddy").unwrap(), "{invalid")
            .unwrap();
        test_support::install(&db, "workbuddy", "repaired", "sk-workbuddy-repaired");
        assert_eq!(token(&db, "workbuddy"), "sk-workbuddy-repaired");
        secure_storage::clear_for_tests();
    }

    #[test]
    #[serial]
    fn account_catalog_and_balance_refresh_do_not_invalidate_setup_identity() {
        let db = db();
        let before = account_revision(&db).unwrap();
        let mut status: YuanhengConnectionStatus =
            serde_json::from_str(&db.get_setting(CACHE_KEY).unwrap().unwrap()).unwrap();
        status.models = vec!["gpt-6-astra".into(), "gpt-image-2.5-sunburst".into()];
        status.last_synced_at = Some(123456);
        db.set_setting(CACHE_KEY, &serde_json::to_string(&status).unwrap())
            .unwrap();
        assert_eq!(account_revision(&db).unwrap(), before);
        status.user_id = Some("different-account".into());
        db.set_setting(CACHE_KEY, &serde_json::to_string(&status).unwrap())
            .unwrap();
        assert_ne!(account_revision(&db).unwrap(), before);
        secure_storage::clear_for_tests();
    }

    #[test]
    #[serial]
    fn core_reads_only_seeded_memory_and_rejects_public_record_tampering() {
        let db = db();
        crate::commands::imagegen_test_support::enable(&db, "dsh", true);
        test_support::install(&db, "dsh", "images", "sk-core-memory-synthetic");
        let snapshot = credential_snapshot(&db).unwrap();
        crate::imagegen_core::replace(&db, &snapshot).unwrap();
        secure_storage::block_access_for_tests(Some(Vec::new()));
        let provider = core_provider(&db, "dsh").unwrap().unwrap();
        assert_eq!(
            provider.settings_config["auth"]["OPENAI_API_KEY"],
            "sk-core-memory-synthetic"
        );
        assert_eq!(secure_storage::denied_calls_for_tests(), 0);
        let mut record = connection(&db, "dsh").unwrap().unwrap();
        record.group = "externally-edited-group".into();
        db.set_setting(
            &key("dsh").unwrap(),
            &serde_json::to_string(&record).unwrap(),
        )
        .unwrap();
        assert!(core_provider(&db, "dsh").is_err());
        assert_eq!(secure_storage::denied_calls_for_tests(), 0);
        secure_storage::clear_for_tests();
    }

    #[tokio::test]
    #[serial]
    async fn queued_reset_cannot_clear_a_new_accounts_connection() {
        let db = Arc::new(db());
        let state = AppState::new(db.clone());
        test_support::install(&db, "dsh", "old", "sk-old-synthetic");
        let queue = CONFIGURE.lock().await;
        let future = configure(&state, "dsh", None);
        tokio::pin!(future);
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut future)
            .await
            .is_err());
        invalidate(&db).unwrap();
        test_support::account(&db, "account-B", false);
        test_support::install(&db, "dsh", "new", "sk-new-synthetic");
        drop(queue);
        assert!(future.await.is_err());
        assert_eq!(token(&db, "dsh"), "sk-new-synthetic");
        secure_storage::clear_for_tests();
    }

    #[tokio::test]
    #[serial]
    async fn queued_configuration_never_acquires_the_replacement_accounts_cookie() {
        secure_storage::clear_for_tests();
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        let login = |user: &str| {
            let status = YuanhengConnectionStatus {
                connected: true,
                user_id: Some(user.into()),
                ..Default::default()
            };
            persist_connection(
                &state,
                &format!("session={user}-synthetic"),
                user,
                "sk-synthetic-login",
                1,
                &status,
            )
            .unwrap();
        };
        login("A");
        let queue = CONFIGURE.lock().await;
        let future = configure(&state, "dsh", Some("OpenAI · image".into()));
        tokio::pin!(future);
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut future)
            .await
            .is_err());
        login("B");
        drop(queue);
        // Rejection is before group lookup/token creation: no network is reached.
        assert!(future.await.err().unwrap().contains("账号已变化"));
        assert!(connection(&state.db, "dsh").unwrap().is_none());
        secure_storage::clear_for_tests();
    }

    #[tokio::test]
    async fn account_catalog_http_reads_are_bounded_redacted_and_do_not_follow_redirects() {
        use axum::{routing::get, Router};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = hits.clone();
        let router = Router::new()
            .route(
                "/ok",
                get(|| async {
                    axum::Json(json!({"success":true,"data":["gpt-image-2.5-sunburst"]}))
                }),
            )
            .route(
                "/denied",
                get(|| async {
                    (
                        axum::http::StatusCode::FORBIDDEN,
                        "sk-secret-must-not-be-exposed",
                    )
                }),
            )
            .route("/large", get(|| async { "x".repeat(2 * 1024 * 1024 + 1) }))
            .route(
                "/redirect",
                get(|| async { axum::response::Redirect::temporary("/destination") }),
            )
            .route(
                "/destination",
                get(move || {
                    let seen = seen.clone();
                    async move {
                        seen.fetch_add(1, Ordering::SeqCst);
                        "secret"
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let binding = Binding {
            account: "synthetic".into(),
            epoch: "unused".into(),
        };
        let value = account_json(
            &client,
            &format!("{origin}/ok"),
            &binding,
            "session=synthetic",
            Some("image"),
        )
        .await
        .unwrap();
        assert_eq!(
            select_model(&parse_user_models(&value).unwrap()).as_deref(),
            Some("gpt-image-2.5-sunburst")
        );
        for path in ["denied", "large", "redirect"] {
            let error = account_json(
                &client,
                &format!("{origin}/{path}"),
                &binding,
                "session=synthetic",
                None,
            )
            .await
            .unwrap_err();
            assert!(!error.contains("sk-secret") && !error.contains("session=synthetic"));
        }
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        task.abort();
    }

    #[test]
    fn model_selection_matches_helper_version_quality_namespace_and_byte_ties() {
        for (candidates, expected) in [
            (
                vec![
                    "openai/gpt-image-2.5-flare",
                    "vendor/gpt-image-2.5-sunburst",
                    "gpt-image-2",
                ],
                "vendor/gpt-image-2.5-sunburst",
            ),
            (
                vec!["gpt-image-2.9-sunburst", "team/gpt-image-2.10-mini"],
                "team/gpt-image-2.10-mini",
            ),
            (
                vec!["gpt-image-2.5-fast", "gpt-image-2.5-quality"],
                "gpt-image-2.5-quality",
            ),
            (
                vec!["gpt-image-2.5-sunburst", "OpenAI/gpt-image-2.5-sunburst"],
                "OpenAI/gpt-image-2.5-sunburst",
            ),
        ] {
            assert_eq!(
                select_model(
                    &candidates
                        .into_iter()
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                )
                .as_deref(),
                Some(expected)
            );
        }
        assert!(select_model(&[
            "gpt-image-latest".into(),
            "qwen-image".into(),
            "dall-e-3".into(),
            "bad\ngpt-image-2".into()
        ])
        .is_none());
    }
}
