use super::{YuanhengConnectionStatus, YuanhengModelVendor, BASE_URL};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Presentation metadata only. Neither the public vendor list nor its model
/// associations can add models to the account's selectable catalog.
pub(super) fn model_vendors(
    pricing: Option<&Value>,
    models: &[String],
    cached: Option<&YuanhengConnectionStatus>,
    user_id: &str,
) -> HashMap<String, YuanhengModelVendor> {
    let allowed: HashSet<&str> = models.iter().map(String::as_str).collect();
    let directory = pricing
        .filter(|value| value.get("success").and_then(Value::as_bool) != Some(false))
        .and_then(|value| {
            Some((
                value.get("vendors")?.as_array()?,
                value.get("data")?.as_array()?,
            ))
        });
    let Some((vendors, entries)) = directory else {
        return cached
            .filter(|status| {
                status.connected
                    && status.base_url == BASE_URL
                    && status.user_id.as_deref() == Some(user_id)
            })
            .map(|status| {
                status
                    .model_vendors
                    .iter()
                    .filter(|(model, _)| allowed.contains(model.as_str()))
                    .map(|(model, vendor)| (model.clone(), vendor.clone()))
                    .collect()
            })
            .unwrap_or_default();
    };

    let vendors: HashMap<i64, YuanhengModelVendor> = vendors
        .iter()
        .filter_map(|vendor| {
            let id = vendor.get("id")?.as_i64().filter(|id| *id > 0)?;
            let name = vendor.get("name")?.as_str()?.trim();
            (!name.is_empty()).then(|| {
                (
                    id,
                    YuanhengModelVendor {
                        id: id.to_string(),
                        name: name.to_string(),
                    },
                )
            })
        })
        .collect();
    entries
        .iter()
        .filter_map(|entry| {
            let model = entry.get("model_name")?.as_str()?;
            if !allowed.contains(model) {
                return None;
            }
            let vendor = vendors.get(&entry.get("vendor_id")?.as_i64()?)?;
            Some((model.to_string(), vendor.clone()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalog(name: &str) -> Value {
        json!({"success": true, "vendors": [{"id": 16, "name": name}], "data": [
            {"model_name": "qwen-plus", "vendor_id": 16},
            {"model_name": "custom-chat", "vendor_id": 16},
            {"model_name": "private-model", "vendor_id": 16}
        ]})
    }
    fn models() -> Vec<String> {
        vec!["qwen-plus".into(), "custom-chat".into()]
    }
    fn cached() -> YuanhengConnectionStatus {
        YuanhengConnectionStatus {
            connected: true,
            user_id: Some("account-a".into()),
            model_vendors: model_vendors(Some(&catalog("旧厂商")), &models(), None, "account-a"),
            ..Default::default()
        }
    }

    #[test]
    fn syncs_cloud_names_and_exact_associations_within_account_models() {
        let result = model_vendors(
            Some(&catalog("阿里百联大模型")),
            &models(),
            None,
            "account-a",
        );
        assert_eq!(result.len(), 2);
        assert_eq!(result["qwen-plus"].id, "16");
        assert_eq!(result["custom-chat"].name, "阿里百联大模型");
        assert!(!result.contains_key("private-model"));
        let renamed = model_vendors(
            Some(&catalog("阿里巴巴")),
            &models(),
            Some(&cached()),
            "account-a",
        );
        assert_eq!(renamed["qwen-plus"].name, "阿里巴巴");
        assert_eq!(renamed["qwen-plus"].id, result["qwen-plus"].id);
    }

    #[test]
    fn failure_retains_only_same_account_and_remaining_models() {
        let mut cached = cached();
        let remaining = vec!["qwen-plus".into()];
        for pricing in [
            None,
            Some(json!({"success": false})),
            Some(json!({"data": []})),
        ] {
            let result = model_vendors(pricing.as_ref(), &remaining, Some(&cached), "account-a");
            assert_eq!(result.len(), 1);
            assert_eq!(result["qwen-plus"].name, "旧厂商");
        }
        assert!(model_vendors(None, &models(), Some(&cached), "account-b").is_empty());
        cached.base_url = "https://other.example".into();
        assert!(model_vendors(None, &models(), Some(&cached), "account-a").is_empty());
        cached.base_url = BASE_URL.into();
        cached.connected = false;
        assert!(model_vendors(None, &models(), Some(&cached), "account-a").is_empty());
    }

    #[test]
    fn successful_directory_removes_old_or_invalid_associations() {
        let pricing = json!({"vendors": [
            {"id": 16, "name": " "}, {"id": 0, "name": "无效"}, {"id": 42, "name": "新厂商"}
        ], "data": [
            {"model_name": "qwen-plus", "vendor_id": 16},
            {"model_name": "custom-chat", "vendor_id": 42},
            {"model_name": "missing", "vendor_id": 99}
        ]});
        let result = model_vendors(Some(&pricing), &models(), Some(&cached()), "account-a");
        assert_eq!(result.len(), 1);
        assert_eq!(result["custom-chat"].id, "42");
        assert!(model_vendors(
            Some(&json!({"vendors": [], "data": []})),
            &models(),
            Some(&cached()),
            "account-a"
        )
        .is_empty());
    }

    #[test]
    fn legacy_snapshot_defaults_to_empty_and_new_snapshot_round_trips() {
        let mut legacy = serde_json::to_value(cached()).unwrap();
        legacy.as_object_mut().unwrap().remove("modelVendors");
        let legacy: YuanhengConnectionStatus = serde_json::from_value(legacy).unwrap();
        assert!(legacy.model_vendors.is_empty());
        let restored: YuanhengConnectionStatus =
            serde_json::from_value(serde_json::to_value(cached()).unwrap()).unwrap();
        assert_eq!(restored.model_vendors, cached().model_vendors);
    }

    #[test]
    fn reads_existing_platform_pricing_fixture() {
        let mut fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/yuanheng-pricing.json"
        ))
        .unwrap();
        fixture["pricing"]["vendors"] = json!([{"id": 16, "name": "阿里巴巴"}]);
        let result = model_vendors(
            Some(&fixture["pricing"]),
            &["Qwen/Qwen3.5-4B".into()],
            None,
            "account-a",
        );
        assert_eq!(result["Qwen/Qwen3.5-4B"].id, "16");
    }
}
