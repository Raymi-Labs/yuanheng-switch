use crate::{provider::Provider, proxy::error::ProxyError};
use serde_json::{json, Value};
#[derive(Clone)]
pub struct RequestOwner(pub Option<String>);

pub fn parse_capability(value: &Value, model: &str, group: &str) -> Option<Vec<Value>> {
    let data = &value["data"];
    if value["success"] != true
        || data["model"] != model
        || data["group"] != group
        || data["managed"] != true
    {
        return None;
    }
    let tiers = data["tiers"].as_array()?;
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for tier in tiers {
        let id = tier["id"].as_str()?;
        let (multiplier, name) = match id {
            "default" => (1, "标准"),
            "priority" => (2, "Fast ×2"),
            "ultrafast" => (6, "UltraFast ×6"),
            _ => return None,
        };
        if !seen.insert(id) || tier["multiplier"].as_u64() != Some(multiplier) {
            return None;
        }
        if id != "default" {
            rows.push(json!({"id":id,"name":name,"description":format!("费用为当前模型、分组标准档的{multiplier}倍，不是速度保证；按服务端结算。") }));
        }
    }
    if !seen.contains("default") {
        return None;
    }
    Some(rows)
}
pub fn managed(provider: &Provider) -> bool {
    provider.id == crate::commands::MANAGED_PROVIDER_ID
        && provider.category.as_deref() == Some("managed")
}
pub fn paid(body: &Value) -> bool {
    body.get("service_tier")
        .is_some_and(|v| v != "default" && !v.is_null())
}
pub fn validate(
    provider: &Provider,
    body: &Value,
    current_owner: Option<&str>,
) -> Result<(), ProxyError> {
    if !managed(provider) {
        return Ok(());
    }
    let tier = body
        .get("service_tier")
        .and_then(Value::as_str)
        .unwrap_or("default");
    if !paid(body) {
        return Ok(());
    }
    let snapshot = &provider.settings_config["yuanhengServiceTiers"];
    let model = body["model"].as_str().unwrap_or("");
    let group = crate::commands::provider_group(provider);
    if !["priority", "ultrafast"].contains(&tier)
        || current_owner.is_none()
        || snapshot["owner"].as_str() != current_owner
        || snapshot["group"].as_str() != group.as_deref()
        || !snapshot["models"][model]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|r| r["id"] == tier))
    {
        return Err(ProxyError::InvalidRequest("当前账号、模型或分组不支持所选速度档位；请在元衡重新应用配置或明确选择标准。未发送请求。".into()));
    }
    Ok(())
}
pub fn validate_outbound(
    provider: &Provider,
    original: &Value,
    final_body: &mut Value,
) -> Result<(), ProxyError> {
    if !managed(provider) {
        return Ok(());
    }
    let tier = |v: &Value| {
        v.get("service_tier")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_string()
    };
    if tier(original) != tier(final_body)
        || (paid(original) && original["model"] != final_body["model"])
    {
        return Err(ProxyError::InvalidRequest(
            "速度档位在转换或覆盖后变化；未发送请求，不会自动改档重试。".into(),
        ));
    }
    if tier(final_body) == "default" {
        if let Some(obj) = final_body.as_object_mut() {
            obj.remove("service_tier");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn capability() -> Value {
        json!({"success":true,"data":{"model":"synthetic","group":"g","managed":true,"tiers":[{"id":"default","multiplier":1},{"id":"priority","multiplier":2},{"id":"ultrafast","multiplier":6}]}})
    }
    fn provider() -> Provider {
        let mut p = Provider::with_id(
            crate::commands::MANAGED_PROVIDER_ID.into(),
            "test".into(),
            json!({"yuanhengServiceTiers":{"owner":"7","group":"g","models":{"synthetic":parse_capability(&capability(),"synthetic","g").unwrap()}}}),
            None,
        );
        p.category = Some("managed".into());
        p.notes = Some("group=g".into());
        p
    }
    #[test]
    fn desktop_tiers_require_exact_backend_capability_and_multiplier() {
        assert_eq!(
            parse_capability(&capability(), "synthetic", "g")
                .unwrap()
                .len(),
            2
        );
        assert!(parse_capability(&capability(), "other", "g").is_none());
        let mut v = capability();
        v["data"]["tiers"][1]["multiplier"] = json!(3);
        assert!(parse_capability(&v, "synthetic", "g").is_none());
        v = capability();
        v["data"]["tiers"] = json!([{"id":"default","multiplier":1}]);
        assert!(parse_capability(&v, "synthetic", "g").unwrap().is_empty());
    }
    #[test]
    fn desktop_tiers_fail_closed_for_owner_group_model_and_missing_metadata() {
        let mut p = provider();
        let body = json!({"model":"synthetic","service_tier":"ultrafast"});
        assert!(validate(&p, &body, Some("7")).is_ok());
        assert!(validate(&p, &body, Some("8")).is_err());
        assert!(validate(&p, &body, None).is_err());
        assert!(validate(
            &p,
            &json!({"model":"other","service_tier":"priority"}),
            Some("7")
        )
        .is_err());
        assert!(validate(
            &p,
            &json!({"model":"synthetic","service_tier":"fast"}),
            Some("7")
        )
        .is_err());
        p.notes = Some("group=other".into());
        assert!(validate(&p, &body, Some("7")).is_err());
        p.settings_config = Value::Null;
        assert!(validate(&p, &body, Some("7")).is_err());
        assert!(validate(&p, &json!({"model":"synthetic"}), Some("7")).is_ok());
    }
    #[test]
    fn desktop_tiers_outbound_rejects_drop_raise_and_model_rewrite() {
        let p = provider();
        let a = json!({"model":"synthetic","service_tier":"priority"});
        for mut b in [
            json!({"model":"synthetic"}),
            json!({"model":"synthetic","service_tier":"ultrafast"}),
            json!({"model":"other","service_tier":"priority"}),
        ] {
            assert!(validate_outbound(&p, &a, &mut b).is_err());
        }
        assert!(validate_outbound(&p, &a, &mut a.clone()).is_ok());
        let mut b = json!({"model":"synthetic","service_tier":"default"});
        assert!(validate_outbound(&p, &json!({"model":"synthetic"}), &mut b).is_ok());
        assert!(b.get("service_tier").is_none());
    }
}
