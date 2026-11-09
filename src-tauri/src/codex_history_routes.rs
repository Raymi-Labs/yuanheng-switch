//! Keep YuanHeng task provider IDs resolvable without rewriting Codex history.
//! This is a live configuration projection, never a provider template migration.

use crate::codex_config::CC_SWITCH_CODEX_OFFICIAL_PROXY_PROVIDER_ID as OFFICIAL;
use crate::error::AppError;
use toml_edit::{DocumentMut, Item, Table};

/// Stable provider id for new YuanHeng projections. `custom` is a user-facing
/// legacy alias and must never be claimed when it contains a foreign route.
const MANAGED_PROVIDER: &str = "yuanheng-switch";
const ALIASES: [&str; 3] = ["yuanheng", "custom", OFFICIAL];

fn parse(text: &str) -> Result<DocumentMut, AppError> {
    text.parse()
        .map_err(|e| AppError::Message(format!("Invalid Codex config.toml: {e}")))
}

fn providers(doc: &DocumentMut) -> Result<Table, AppError> {
    match doc.get("model_providers") {
        Some(item) => item.clone().into_table().map_err(|_| {
            AppError::Message("Invalid Codex config.toml: model_providers must be a table".into())
        }),
        None => {
            let mut table = Table::new();
            table.set_implicit(true);
            Ok(table)
        }
    }
}

fn string<'a>(item: &'a Item, key: &str) -> Option<&'a str> {
    item.get(key).and_then(Item::as_str)
}

fn local_route(url: &str) -> bool {
    url::Url::parse(url).ok().is_some_and(|url| {
        url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && matches!(
                url.path().trim_end_matches('/'),
                "/v1" | "/codex/v1" | "/chatgpt-desktop/v1"
            )
    })
}

/// Recognize generated shapes, not just a generic provider ID or localhost URL.
/// Unknown fields/credentials are treated as user edits and never overwritten.
fn owned(item: &Item) -> bool {
    let Some(table) = item.as_table_like() else {
        return false;
    };
    if table.iter().any(|(key, _)| {
        !matches!(
            key,
            "name"
                | "base_url"
                | "wire_api"
                | "requires_openai_auth"
                | "supports_websockets"
                | "experimental_bearer_token"
                | "request_max_retries"
                | "stream_max_retries"
        )
    }) {
        return false;
    }
    // Only the exact generated no-replay policy is owned; preserve user edits.
    if ["request_max_retries", "stream_max_retries"]
        .iter()
        .any(|key| item.get(key).is_some_and(|v| v.as_integer() != Some(0)))
    {
        return false;
    }
    if string(item, "wire_api") != Some("responses")
        || item.get("requires_openai_auth").and_then(Item::as_bool) != Some(true)
    {
        return false;
    }
    match string(item, "name") {
        Some("OpenAI") => {
            item.get("experimental_bearer_token").is_none()
                && item
                    .get("supports_websockets")
                    .and_then(Item::as_bool)
                    .is_some()
                && (item.get("base_url").is_none()
                    || string(item, "base_url").is_some_and(local_route))
        }
        Some("YuanHeng") => {
            string(item, "base_url").is_some_and(local_route)
                && string(item, "experimental_bearer_token") == Some("PROXY_MANAGED")
        }
        _ => false,
    }
}

fn active_route(doc: &DocumentMut, tables: &Table) -> Option<Item> {
    let id = doc.get("model_provider")?.as_str()?;
    if !ALIASES.contains(&id) && id != MANAGED_PROVIDER {
        return None;
    }
    tables.get(id).filter(|route| owned(route)).cloned()
}

fn native_route() -> Item {
    let mut table = Table::new();
    table["name"] = toml_edit::value("OpenAI");
    table["requires_openai_auth"] = toml_edit::value(true);
    table["supports_websockets"] = toml_edit::value(true);
    table["wire_api"] = toml_edit::value("responses");
    Item::Table(table)
}

/// Route identity is independent from account mode.
pub(crate) fn is_official(config: &str) -> bool {
    let Ok(doc) = parse(config) else {
        return false;
    };
    let Ok(tables) = providers(&doc) else {
        return false;
    };
    active_route(&doc, &tables).is_some_and(|route| {
        string(&route, "name") == Some("OpenAI")
            && string(&route, "base_url").is_some_and(local_route)
    })
}

pub(crate) fn manages(config: &str) -> Result<bool, AppError> {
    let doc = parse(config)?;
    let tables = providers(&doc)?;
    Ok(tables.get(MANAGED_PROVIDER).is_some_and(owned)
        || ALIASES.iter().any(|id| tables.get(id).is_some_and(owned)))
}

/// Merge only provider definitions from the previous live file, then project all
/// owned aliases from the selected route. Unrelated settings come from `next`.
pub(crate) fn prepare(previous: &str, next: &str) -> Result<String, AppError> {
    let mut doc = parse(next)?;
    let mut tables = providers(&doc)?;
    let mut active = doc
        .get("model_provider")
        .and_then(Item::as_str)
        .map(str::to_string);
    let mut route = active_route(&doc, &tables);
    // A first-time YuanHeng setup may be projected using the historical
    // `custom` id while the live config already contains the user's own
    // `custom` provider. Never overwrite or activate that foreign route:
    // move only the generated YuanHeng route to its dedicated id.
    let old_doc = parse(previous)?;
    let old_tables = providers(&old_doc)?;
    if route.is_some()
        && active.as_deref() == Some("custom")
        && old_tables.get("custom").is_some_and(|item| !owned(item))
    {
        if old_tables
            .get(MANAGED_PROVIDER)
            .is_some_and(|item| !owned(item))
        {
            return Err(AppError::Message(
                "Codex 稳定会话供应商名称已被自定义配置占用，未覆盖".into(),
            ));
        }
        let generated = route.take().expect("route checked above");
        tables.insert(MANAGED_PROVIDER, generated);
        doc["model_provider"] = toml_edit::value(MANAGED_PROVIDER);
        active = Some(MANAGED_PROVIDER.to_string());
        route = tables.get(MANAGED_PROVIDER).cloned();
    }
    // A non-YuanHeng custom provider is outside this feature's scope.
    if route.is_none() && active.as_deref().is_some_and(|id| id != "openai") {
        return Ok(next.into());
    }
    let route = match route {
        Some(route) => route,
        None if ALIASES
            .iter()
            .any(|id| old_tables.get(id).is_some_and(owned)) =>
        {
            native_route()
        }
        None => return Ok(next.into()),
    };
    for (id, old) in old_tables.iter() {
        if ALIASES.contains(&id) && !owned(old) {
            if active.as_deref() == Some(id)
                && tables.get(id).map(Item::to_string).as_deref() != Some(old.to_string().as_str())
            {
                return Err(AppError::Message(format!(
                    "Codex 供应商 {id} 包含自定义配置，元衡未覆盖；请先在配置中为该供应商使用独立名称"
                )));
            }
            // Preserve a conflict against our generated projection. If the caller
            // supplied its own non-owned table, keep that explicit edit (including
            // proxy cleanup removing its PROXY_MANAGED placeholder).
            if tables.get(id).is_none_or(owned) {
                tables.insert(id, old.clone());
            }
        } else if !tables.contains_key(id) {
            tables.insert(id, old.clone());
        }
    }
    for alias in ALIASES {
        if tables.get(alias).is_none_or(owned) {
            tables.insert(alias, route.clone());
        }
    }
    let cleaned_managed = old_tables
        .get(MANAGED_PROVIDER)
        .filter(|item| owned(item))
        .map(|item| {
            let mut cleaned = item.clone();
            if let Some(table) = cleaned.as_table_like_mut() {
                table.remove("experimental_bearer_token");
            }
            cleaned.to_string()
        });
    if tables.get(MANAGED_PROVIDER).is_some_and(owned)
        || cleaned_managed.as_deref().is_some_and(|cleaned| {
            tables
                .get(MANAGED_PROVIDER)
                .is_some_and(|item| item.to_string() == cleaned)
        })
    {
        tables.insert(MANAGED_PROVIDER, route.clone());
    }
    // A restored third-party takeover can contribute a non-YuanHeng alias.
    // Keep its settings, but official mode must not resurrect the proxy-owned
    // placeholder removed by takeover cleanup. Real user tokens stay untouched.
    if string(&route, "name") == Some("OpenAI") {
        for (_, item) in tables.iter_mut() {
            if string(item, "experimental_bearer_token") == Some("PROXY_MANAGED")
                && string(item, "base_url").is_some_and(local_route)
            {
                if let Some(table) = item.as_table_like_mut() {
                    table.remove("experimental_bearer_token");
                }
            }
        }
    }
    // Recent Codex versions require exact provider identity on resume, even
    // when aliases have identical definitions. Both account modes use the
    // historical relay bucket; never activate a user-owned custom provider.
    let stable_id = if tables.get("custom").is_some_and(owned) {
        "custom"
    } else {
        if tables
            .get(MANAGED_PROVIDER)
            .is_some_and(|item| !owned(item))
        {
            return Err(AppError::Message(
                "Codex 稳定会话供应商名称已被自定义配置占用，未覆盖".into(),
            ));
        }
        MANAGED_PROVIDER
    };
    tables.insert(stable_id, route.clone());
    doc["model_provider"] = toml_edit::value(stable_id);
    doc["model_providers"] = Item::Table(tables);
    let output = doc.to_string();
    // Avoid rewrites/backups solely because toml_edit normalized formatting.
    if toml::from_str::<toml::Value>(&output).ok() == toml::from_str::<toml::Value>(next).ok() {
        Ok(next.into())
    } else {
        Ok(output)
    }
}

#[derive(Default)]
pub(crate) struct Health {
    pub needs_repair: bool,
    pub conflicts: Vec<String>,
}

pub(crate) fn health(config: &str) -> Result<Health, AppError> {
    let doc = parse(config)?;
    let tables = providers(&doc)?;
    if active_route(&doc, &tables).is_none() {
        let mut health = Health::default();
        if let Some(id) = doc.get("model_provider").and_then(Item::as_str) {
            if ALIASES.contains(&id) {
                health.needs_repair = !tables.contains_key(id);
                if tables.get(id).is_some_and(|item| !owned(item)) {
                    health.conflicts.push(id.into());
                }
            }
        }
        return Ok(health);
    }
    let mut health = Health::default();
    for alias in ALIASES {
        if tables.get(alias).is_some_and(|item| !owned(item)) {
            health.conflicts.push(alias.into());
        }
    }
    health.needs_repair = prepare(config, config)? != config;
    Ok(health)
}

/// Crash cleanup keeps old task IDs, but removes every owned local endpoint and
/// token so those tasks can use native ChatGPT login after Core is stopped.
pub(crate) fn release_official(config: &str) -> Result<String, AppError> {
    let mut doc = parse(config)?;
    if !is_official(config) {
        return Ok(config.into());
    }
    let mut tables = providers(&doc)?;
    if active_route(&doc, &tables).is_none() {
        return Err(AppError::Message(
            "Codex 官方路由已被外部修改，未自动清理".into(),
        ));
    }
    for alias in ALIASES.into_iter().chain([MANAGED_PROVIDER]) {
        if tables.get(alias).is_some_and(owned) {
            tables.insert(alias, native_route());
        }
    }
    // Keep the stable bucket when removing the local endpoint.
    doc["model_providers"] = Item::Table(tables);
    Ok(doc.to_string())
}

/// Prepare a self-heal from an existing owned route, retaining its surface path.
pub(crate) fn refresh(config: &str, port: Option<u16>) -> Result<String, AppError> {
    let mut doc = parse(config)?;
    let tables = providers(&doc)?;
    if active_route(&doc, &tables).is_none() {
        return Ok(config.into());
    }
    if let (Some(port), Some(id)) = (
        port,
        doc.get("model_provider")
            .and_then(Item::as_str)
            .map(str::to_string),
    ) {
        if let Some(base) = string(&tables[&id], "base_url").filter(|base| local_route(base)) {
            let mut url = url::Url::parse(base).expect("validated local URL");
            url.set_port(Some(port))
                .map_err(|_| AppError::Message("本地路由端口无效".into()))?;
            doc["model_providers"][&id]["base_url"] =
                toml_edit::value(url.as_str().trim_end_matches('/'));
        }
    }
    let refreshed = prepare(config, &doc.to_string())?;
    if toml::from_str::<toml::Value>(&refreshed).ok() == toml::from_str::<toml::Value>(config).ok()
    {
        Ok(config.into())
    } else {
        Ok(refreshed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn managed() -> String {
        r#"model_provider = "custom"
model = "old-model"
[model_providers.custom]
name = "YuanHeng"
base_url = "http://127.0.0.1:15721/chatgpt-desktop/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "PROXY_MANAGED"
"#
        .into()
    }

    fn official() -> String {
        crate::codex_config::apply_codex_official_proxy_route("", "http://127.0.0.1:15721/v1")
            .unwrap()
    }

    fn value(text: &str) -> toml::Value {
        toml::from_str(text).unwrap()
    }

    #[test]
    fn account_modes_share_stable_identity_and_cleanup_retains_it() {
        let relay = prepare("", &managed()).unwrap();
        let official = prepare(&relay, &official()).unwrap();
        assert!(is_official(&official));
        let returned = prepare(&official, &managed()).unwrap();
        assert!(!is_official(&returned));
        let native = release_official(&official).unwrap();
        assert!(!is_official(&native));
        for config in [&relay, &official, &returned, &native] {
            assert_eq!(value(config)["model_provider"].as_str(), Some("custom"));
            assert_eq!(prepare(config, config).unwrap(), *config);
        }
    }

    #[test]
    fn occupied_stable_buckets_are_not_overwritten() {
        let source = "[model_providers.custom]\nname = 'Mine'\n[model_providers.yuanheng-switch]\nname = 'Also mine'\n";
        assert!(prepare(source, &managed()).is_err());
        assert!(prepare(source, &official()).is_err());
    }

    #[test]
    fn dedicated_bucket_retains_identity_when_custom_is_foreign() {
        let foreign = "[model_providers.custom]\nname = 'Mine'\nbase_url = 'https://example.com/v1'\nenv_key = 'MY_KEY'\n";
        let relay = prepare(foreign, &managed()).unwrap();
        let official = crate::codex_config::apply_codex_official_proxy_route(
            &relay,
            "http://127.0.0.1:15721/v1",
        )
        .unwrap();
        assert!(is_official(&official));
        let native = release_official(&official).unwrap();
        for config in [&relay, &official, &native] {
            assert_eq!(
                value(config)["model_provider"].as_str(),
                Some(MANAGED_PROVIDER)
            );
            assert_eq!(
                value(config)["model_providers"]["custom"],
                value(foreign)["model_providers"]["custom"]
            );
        }
        assert!(value(&native)["model_providers"][MANAGED_PROVIDER]
            .get("base_url")
            .is_none());
    }

    #[test]
    fn real_codex_smoke_fixtures_match_production_projection() {
        let relay = include_str!("../../tests/fixtures/codex-history/relay.toml");
        let broken = include_str!("../../tests/fixtures/codex-history/broken.toml");
        let official = include_str!("../../tests/fixtures/codex-history/official.toml");
        let returned = include_str!("../../tests/fixtures/codex-history/returned.toml");
        let native = include_str!("../../tests/fixtures/codex-history/native.toml");
        assert_eq!(value(&prepare(relay, broken).unwrap()), value(official));
        assert_eq!(value(&prepare(official, relay).unwrap()), value(returned));
        assert_eq!(value(&release_official(official).unwrap()), value(native));
    }

    #[test]
    fn official_restore_cleans_only_proxy_placeholders_in_foreign_routes() {
        for token in ["PROXY_MANAGED", "user-owned-token"] {
            let source = format!("[model_providers.custom]\nname = 'Other'\nbase_url = 'http://127.0.0.1:15721/v1'\nwire_api = 'responses'\nexperimental_bearer_token = '{token}'\n");
            let result = value(&prepare(&source, &official()).unwrap());
            let table = &result["model_providers"]["custom"];
            assert_eq!(table["name"].as_str(), Some("Other"));
            if token == "PROXY_MANAGED" {
                assert!(table.get("experimental_bearer_token").is_none());
            } else {
                assert_eq!(table["experimental_bearer_token"].as_str(), Some(token));
            }
        }
    }

    #[test]
    fn old_task_ids_follow_both_account_modes_without_retaining_credentials() {
        let relay = prepare("", &managed()).unwrap();
        let official = prepare(&relay, &official()).unwrap();
        let doc = value(&official);
        for id in ALIASES {
            let provider = &doc["model_providers"][id];
            assert_eq!(
                provider["base_url"].as_str(),
                Some("http://127.0.0.1:15721/v1")
            );
            assert_eq!(provider["requires_openai_auth"].as_bool(), Some(true));
            assert!(provider.get("experimental_bearer_token").is_none());
        }
        let relay = value(&prepare(&official, &managed()).unwrap());
        for id in ALIASES {
            assert_eq!(
                relay["model_providers"][id]["experimental_bearer_token"].as_str(),
                Some("PROXY_MANAGED")
            );
            assert_eq!(
                relay["model_providers"][id]["base_url"].as_str(),
                Some("http://127.0.0.1:15721/chatgpt-desktop/v1")
            );
        }
    }

    #[test]
    fn missing_aliases_self_heal_and_repeated_repair_is_byte_identical() {
        assert!(health(&managed()).unwrap().needs_repair);
        let fixed = refresh(&managed(), Some(15721)).unwrap();
        assert!(!health(&fixed).unwrap().needs_repair);
        assert_eq!(refresh(&fixed, Some(15721)).unwrap(), fixed);
        assert_eq!(value(&fixed)["model"].as_str(), Some("old-model"));
    }

    #[test]
    fn core_port_change_refreshes_all_aliases_and_preserves_surface() {
        for source in [official(), prepare("", &managed()).unwrap()] {
            let refreshed = value(&refresh(&source, Some(18888)).unwrap());
            for id in ALIASES {
                let url = refreshed["model_providers"][id]["base_url"]
                    .as_str()
                    .unwrap();
                assert!(url.starts_with("http://127.0.0.1:18888/"));
            }
            assert_eq!(refreshed.get("model"), value(&source).get("model"));
        }
    }

    #[test]
    fn unrelated_provider_tables_and_custom_alias_conflicts_survive_switch() {
        let source = r#"[model_providers.custom]
name = "My server"
base_url = "https://example.com/v1"
env_key = "MY_KEY"
[model_providers.personal]
name = "Personal"
base_url = "http://localhost:4444/v1"
"#;
        let next = prepare(source, &official()).unwrap();
        assert_eq!(
            value(&next)["model_providers"]["custom"],
            value(source)["model_providers"]["custom"]
        );
        assert_eq!(
            value(&next)["model_providers"]["personal"],
            value(source)["model_providers"]["personal"]
        );
        assert_eq!(health(&next).unwrap().conflicts, vec!["custom"]);
        assert_eq!(prepare(&next, &next).unwrap(), next);
        let switched = value(&prepare(source, &managed()).unwrap());
        assert_eq!(switched["model_provider"].as_str(), Some(MANAGED_PROVIDER));
        assert_eq!(
            switched["model_providers"]["custom"]["base_url"].as_str(),
            Some("https://example.com/v1")
        );
    }

    #[test]
    fn first_time_setup_uses_dedicated_provider_when_custom_is_user_owned() {
        let previous = r#"[model_providers.custom]
name = "My server"
base_url = "https://example.com/v1"
api_key_env = "MY_KEY"
"#;
        let generated = managed();
        let fixed = prepare(previous, &generated).unwrap();
        let doc = value(&fixed);
        assert_eq!(doc["model_provider"].as_str(), Some(MANAGED_PROVIDER));
        assert_eq!(
            doc["model_providers"]["custom"]["base_url"].as_str(),
            Some("https://example.com/v1")
        );
        assert_eq!(
            doc["model_providers"][MANAGED_PROVIDER]["base_url"].as_str(),
            Some("http://127.0.0.1:15721/chatgpt-desktop/v1")
        );
        assert_eq!(prepare(&fixed, &fixed).unwrap(), fixed);
    }

    #[test]
    fn user_edits_to_generated_alias_are_preserved_and_reported() {
        let mut doc = parse(&official()).unwrap();
        doc["model_providers"]["custom"]["env_key"] = toml_edit::value("USER_KEY");
        let source = doc.to_string();
        let next = prepare(&source, &official()).unwrap();
        assert_eq!(
            value(&next)["model_providers"]["custom"]["env_key"].as_str(),
            Some("USER_KEY")
        );
        assert_eq!(health(&next).unwrap().conflicts, vec!["custom"]);
    }

    #[test]
    fn cleanup_keeps_history_ids_with_native_auth_and_no_dead_proxy() {
        let source = official();
        let cleaned = release_official(&source).unwrap();
        let doc = value(&cleaned);
        assert_eq!(doc["model_provider"].as_str(), Some("custom"));
        for id in ALIASES {
            let table = &doc["model_providers"][id];
            assert!(table.get("base_url").is_none());
            assert!(table.get("experimental_bearer_token").is_none());
            assert_eq!(table["supports_websockets"].as_bool(), Some(true));
        }
        assert_eq!(release_official(&cleaned).unwrap(), cleaned);
        let restored = value(&prepare(&source, "model = \"gpt-backup\"\n").unwrap());
        assert_eq!(restored["model"].as_str(), Some("gpt-backup"));
        assert!(restored["model_providers"]["yuanheng"]
            .get("base_url")
            .is_none());
    }

    #[test]
    fn malformed_tables_fail_without_panicking() {
        for input in [
            "model_providers = 3",
            "[[model_providers]]\nname = 'invalid'",
            "[broken",
        ] {
            assert!(prepare("", input).is_err());
            assert!(refresh(input, Some(15721)).is_err());
        }
    }

    #[test]
    fn inline_tables_are_supported() {
        let input = r#"model_provider = "custom"
model_providers = { custom = { name = "YuanHeng", base_url = "http://127.0.0.1:15721/codex/v1", wire_api = "responses", requires_openai_auth = true, experimental_bearer_token = "PROXY_MANAGED" } }
"#;
        let fixed = prepare("", input).unwrap();
        assert!(value(&fixed)["model_providers"].get("yuanheng").is_some());
        assert_eq!(prepare(&fixed, &fixed).unwrap(), fixed);
    }

    #[test]
    fn foreign_routes_are_not_claimed_by_name_or_url_substrings() {
        for base in [
            "https://example.com/v1",
            "http://127.0.0.1.evil/v1",
            "http://localhost:15721/other/v1",
        ] {
            let input = managed().replace("http://127.0.0.1:15721/chatgpt-desktop/v1", base);
            assert_eq!(prepare("", &input).unwrap(), input);
            assert_eq!(refresh(&input, Some(18888)).unwrap(), input);
        }
    }
}
