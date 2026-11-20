use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const REASONING_LEVELS: &[&str] = &[
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningProfile {
    pub supported_levels: Vec<String>,
    pub default_level: Option<String>,
}

pub type PlatformProfiles = HashMap<String, ReasoningProfile>;
pub type ProfileSnapshot = HashMap<String, Option<ReasoningProfile>>;
const PLATFORM_SOURCE: &str = "yuanheng-managed-v2-platform";
pub(crate) const UNDECLARED_SOURCE: &str = "yuanheng-managed-v3-undeclared";

pub fn resolve_profile(model: &str, platform: &PlatformProfiles) -> Option<ReasoningProfile> {
    platform
        .get(model)
        .cloned()
        .or_else(|| managed_reasoning_profile(model))
}

/// None means unavailable (including an older server); an empty map is an authoritative reset.
pub fn parse_platform_profiles(value: &Value, visible: &[String]) -> Option<ProfileSnapshot> {
    let rows = value.get("reasoningProfiles")?.as_object()?;
    let mut result = ProfileSnapshot::new();
    for name in visible {
        let Some(row) = rows.get(name) else {
            continue;
        };
        let profile = serde_json::from_value::<ReasoningProfile>(row.clone())
            .ok()
            .and_then(|mut p| {
                if p.default_level
                    .as_ref()
                    .is_some_and(|d| !p.supported_levels.contains(d))
                {
                    return None;
                }
                if value["reasoningCatalogVersion"].as_u64() != Some(2) && p.default_level.is_none()
                {
                    return None;
                }
                p.supported_levels = normalize_reasoning_levels(p.supported_levels);
                p.default_level = p.default_level.filter(|d| p.supported_levels.contains(d));
                Some(p)
            });
        result.insert(name.to_owned(), profile);
    }
    Some(result)
}

pub fn merge_platform_profiles(
    fresh: Option<ProfileSnapshot>,
    cached: Option<&PlatformProfiles>,
    visible: &[String],
) -> PlatformProfiles {
    visible
        .iter()
        .filter_map(|name| {
            let profile = match &fresh {
                Some(rows) => rows.get(name)?.as_ref().or_else(|| cached?.get(name)),
                None => cached?.get(name),
            }?;
            Some((name.clone(), profile.clone()))
        })
        .collect()
}

pub fn normalize_reasoning_level(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    REASONING_LEVELS.contains(&value.as_str()).then_some(value)
}

/// Managed Chat-to-Gemini routes: use the platform's existing native extra_body contract.
/// No implicit default, alias expansion or conversion to an invented numerical budget.
pub(crate) fn gemini_chat_effort(model: &str, level: &str) -> Option<Value> {
    (model.starts_with("gemini-")
        && matches!(level, "minimal" | "low" | "medium" | "high" | "xhigh"))
    .then(|| serde_json::json!({"google":{"thinking_config":{"thinking_level":level}}}))
}

pub fn normalize_reasoning_levels(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let values = values
        .into_iter()
        .filter_map(|value| normalize_reasoning_level(&value))
        .collect::<Vec<_>>();
    REASONING_LEVELS
        .iter()
        .filter(|level| values.iter().any(|value| value == **level))
        .map(|level| (*level).to_string())
        .collect()
}

#[cfg(test)]
fn profile(levels: &[&str], default: &str) -> ReasoningProfile {
    ReasoningProfile {
        supported_levels: levels.iter().map(|level| (*level).to_string()).collect(),
        default_level: Some(default.to_string()),
    }
}

pub fn fallback_reasoning_profile(model: &str) -> Option<ReasoningProfile> {
    #[derive(Deserialize)]
    struct Seed {
        profiles: PlatformProfiles,
    }
    static SEED: std::sync::OnceLock<PlatformProfiles> = std::sync::OnceLock::new();
    SEED.get_or_init(|| {
        serde_json::from_str::<Seed>(include_str!("resources/official_reasoning_profiles.json"))
            .expect("validated offline reasoning catalog")
            .profiles
    })
    .get(model)
    .cloned()
}

/// Managed metadata must not depend on another application's cache.
/// Only exact published IDs qualify; a family or brand name is not evidence.
pub fn managed_reasoning_profile(model: &str) -> Option<ReasoningProfile> {
    fallback_reasoning_profile(model)
}

/// Read the account declaration from this managed provider's projected catalog, never a
/// different account or an identically named custom provider. An empty list is authoritative.
pub(crate) fn managed_wire_levels<'a>(
    provider: &'a crate::provider::Provider,
    model: &str,
) -> Option<&'a Vec<Value>> {
    if provider.id != crate::commands::MANAGED_PROVIDER_ID
        || provider.category.as_deref() != Some("managed")
    {
        return None;
    }
    let rows = provider
        .settings_config
        .pointer("/modelCatalog/models")?
        .as_array()?;
    let exact = |id: &str| rows.iter().find(|r| r["model"].as_str() == Some(id));
    let row = exact(model).or_else(|| {
        exact(crate::proxy::model_mapper::strip_one_m_suffix_for_upstream(
            model,
        ))
    })?;
    if row["reasoningProfileSource"].as_str() != Some(PLATFORM_SOURCE) {
        return None;
    }
    row["supportedReasoningLevels"].as_array()
}

pub fn apply_managed_reasoning_profile(entry: &mut Value) {
    // Catalog readback has no fresh account snapshot; preserve the last platform declaration.
    if entry["reasoningProfileSource"].as_str() == Some(PLATFORM_SOURCE) {
        return;
    }
    apply_platform_profile(entry, None);
}

pub fn apply_platform_profile(entry: &mut Value, platform: Option<&ReasoningProfile>) {
    let Some(model) = entry.get("model").and_then(Value::as_str) else {
        return;
    };
    // Unmarked explicit values may belong to a user or imported provider.
    // Only defaults emitted by us may be replaced automatically.
    if !entry
        .get("reasoningProfileSource")
        .and_then(Value::as_str)
        .is_some_and(|source| source.starts_with("yuanheng-managed-v"))
        && (entry.get("supportedReasoningLevels").is_some()
            || entry.get("supported_reasoning_levels").is_some())
    {
        return;
    }
    let effective = platform
        .cloned()
        .or_else(|| managed_reasoning_profile(model));
    let undeclared = effective.is_none();
    let profile = effective.unwrap_or_default();
    entry["supportedReasoningLevels"] = serde_json::json!(profile.supported_levels);
    entry["defaultReasoningLevel"] = serde_json::json!(profile.default_level);
    entry["reasoningProfileSource"] = serde_json::json!(if platform.is_some() {
        PLATFORM_SOURCE
    } else if undeclared {
        UNDECLARED_SOURCE
    } else {
        "yuanheng-managed-v1"
    });
    if let Some(object) = entry.as_object_mut() {
        object.remove("supported_reasoning_levels");
        object.remove("default_reasoning_level");
    }
}

fn profile_from_catalog_entry(entry: &Value) -> Option<(String, ReasoningProfile)> {
    let slug = entry.get("slug")?.as_str()?.trim();
    if slug.is_empty() {
        return None;
    }
    let levels = entry
        .get("supported_reasoning_levels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("effort")
                .and_then(Value::as_str)
                .or_else(|| item.as_str())
                .map(str::to_string)
        });
    let supported_levels = normalize_reasoning_levels(levels);
    if supported_levels.is_empty() {
        return None;
    }
    let default_level = entry
        .get("default_reasoning_level")
        .and_then(Value::as_str)
        .and_then(normalize_reasoning_level)
        .filter(|level| supported_levels.contains(level))
        .or_else(|| supported_levels.first().cloned());
    Some((
        slug.to_owned(),
        ReasoningProfile {
            supported_levels,
            default_level,
        },
    ))
}

fn catalog_priority(path: &Path) -> usize {
    match path.file_name().and_then(|name| name.to_str()) {
        Some("model-catalog.cn-meta-api.json") => 0,
        Some(name) if name.starts_with("model-catalog.") => 1,
        Some("models_cache.json") => 2,
        _ => 3,
    }
}

pub fn load_local_reasoning_profiles() -> HashMap<String, ReasoningProfile> {
    let codex_dir = crate::config::get_home_dir().join(".codex");
    let Ok(entries) = fs::read_dir(codex_dir) else {
        return HashMap::new();
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            path.is_file()
                && name.ends_with(".json")
                && (name.starts_with("model-catalog.") || name == "models_cache.json")
        })
        .collect::<Vec<_>>();
    paths.sort_by_key(|path| catalog_priority(path));

    let mut result = HashMap::new();
    for path in paths {
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(catalog) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(models) = catalog.get("models").and_then(Value::as_array) else {
            continue;
        };
        for entry in models {
            if let Some((slug, profile)) = profile_from_catalog_entry(entry) {
                result.entry(slug).or_insert(profile);
            }
        }
    }
    result
}

pub fn reasoning_profile_for_model(
    model: &str,
    catalog: &HashMap<String, ReasoningProfile>,
) -> Option<ReasoningProfile> {
    catalog
        .get(model)
        .cloned()
        .or_else(|| fallback_reasoning_profile(model))
}

pub fn effective_reasoning_level(model: &str, selected: &str) -> Option<String> {
    if selected.trim() != "auto" && !selected.trim().is_empty() {
        return normalize_reasoning_level(selected);
    }
    managed_reasoning_profile(model)?.default_level
}

#[cfg(test)]
mod tests {
    #[test]
    fn platform_profile_roundtrip_preserves_custom_and_supports_authoritative_reset() {
        use super::*;
        let profile = profile(&["low", "ultra"], "low");
        let mut entry = serde_json::json!({"model":"future-not-hardcoded"});
        apply_platform_profile(&mut entry, Some(&profile));
        apply_managed_reasoning_profile(&mut entry);
        assert_eq!(entry["defaultReasoningLevel"], "low");
        apply_platform_profile(&mut entry, None);
        assert_eq!(entry["supportedReasoningLevels"], serde_json::json!([]));
        let mut own = serde_json::json!({"model":"future", "supported_reasoning_levels":["high"]});
        let old = own.clone();
        apply_platform_profile(&mut own, Some(&profile));
        assert_eq!(own, old);
        for m in ["gpt-6.2-astra", "gpt-6.2-sol"] {
            let p = managed_reasoning_profile(m).unwrap();
            assert_eq!(
                p.supported_levels,
                ["low", "medium", "high", "xhigh", "max", "ultra"]
            );
            assert_eq!(p.default_level.as_deref(), Some("low"));
        }
        assert!(managed_reasoning_profile("gpt-6.2-other").is_none());
    }
    use super::*;

    #[test]
    fn managed_projection_is_deterministic_and_preserves_explicit_overrides() {
        let mut old = serde_json::json!({"model":"gpt-6.1-sol", "reasoningProfileSource":"yuanheng-managed-v0", "supportedReasoningLevels":["high"]});
        apply_managed_reasoning_profile(&mut old);
        assert_eq!(
            old["supportedReasoningLevels"],
            serde_json::json!(["low", "medium", "high", "xhigh", "max", "ultra"])
        );
        let once = old.clone();
        apply_managed_reasoning_profile(&mut old);
        assert_eq!(old, once);
        let mut explicit = serde_json::json!({"model":"gpt-6.1-sol", "supported_reasoning_levels":["high"], "default_reasoning_level":"high"});
        let original = explicit.clone();
        apply_managed_reasoning_profile(&mut explicit);
        assert_eq!(explicit, original);
        for id in [
            "gpt-future",
            "GPT-6-ASTRA",
            "gpt-6-astra-latest",
            "vendor-claude-test",
            "unknown-gemini",
            "custom/codex",
        ] {
            assert!(managed_reasoning_profile(id).is_none(), "{id}");
        }
    }

    #[test]
    fn fresh_install_sol_61_has_complete_reasoning_levels() {
        let profile = managed_reasoning_profile("gpt-6.1-sol").unwrap();
        assert_eq!(
            profile.supported_levels,
            vec!["low", "medium", "high", "xhigh", "max", "ultra"]
        );
    }

    #[test]
    fn preserves_canonical_level_order() {
        assert_eq!(
            normalize_reasoning_levels(
                ["ultra", "low", "high", "low", "invalid"]
                    .into_iter()
                    .map(str::to_string)
            ),
            vec!["low", "high", "ultra"]
        );
    }

    #[test]
    fn gives_gpt_5_6_its_full_fallback_profile() {
        let profile = fallback_reasoning_profile("gpt-5.6-sol").unwrap();
        assert_eq!(profile.default_level.as_deref(), Some("low"));
        assert_eq!(
            profile.supported_levels,
            vec!["low", "medium", "high", "xhigh", "max", "ultra"]
        );
    }

    #[test]
    fn unknown_models_do_not_claim_adjustable_reasoning() {
        assert!(fallback_reasoning_profile("ocr-specialist").is_none());
    }
}
