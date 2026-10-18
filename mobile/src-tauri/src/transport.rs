use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, SET_COOKIE},
    Method, Response,
};
use serde_json::Value;
pub const BASE: &str = "https://meta-api.vip";

pub fn message(value: &Value, fallback: &str) -> String {
    let raw = value
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/error/message").and_then(Value::as_str))
        .unwrap_or(fallback);
    // Never surface a gateway page or an echoed credential.
    if raw.is_empty()
        || raw.len() > 600
        || raw.contains("sk-")
        || raw.contains("session=")
        || raw.contains('<')
    {
        fallback.into()
    } else {
        raw.into()
    }
}
pub fn ensure_success(value: &Value) -> Result<(), String> {
    if value.get("success").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(message(value, "请求未成功，请重试"))
    }
}
pub async fn bounded_json(response: Response, limit: usize) -> Result<Value, String> {
    let status = response.status();
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("响应数据过大".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "响应中断，请稍后重试")?;
        if bytes.len() + chunk.len() > limit {
            return Err("响应数据过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if status.as_u16() == 401 {
        return Err("登录已失效，请退出后重新登录".into());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| format!("服务暂时不可用（HTTP {}），请稍后重试", status.as_u16()))?;
    if !status.is_success() {
        return Err(message(
            &value,
            &format!("请求失败（HTTP {}）", status.as_u16()),
        ));
    }
    Ok(value)
}
pub fn cookie_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| {
            let pair = v.split(';').next()?.trim();
            let (name, value) = pair.split_once('=')?;
            (name == "session" && !value.is_empty() && pair.len() <= 8192).then(|| pair.to_string())
        })
        .next_back()
}
pub fn api_route(operation: &str, body: &Value) -> Result<(Method, String), String> {
    if serde_json::to_vec(body).map_err(|_| "参数无效")?.len() > 64000 {
        return Err("请求参数过长".into());
    }
    let page = body
        .get("page")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, 10000);
    let id = || {
        body.get("id")
            .and_then(Value::as_i64)
            .filter(|v| *v > 0)
            .ok_or("令牌 ID 无效".to_string())
    };
    let path = match operation {
        "status" => "/api/status".into(),
        "account" => "/api/user/self".into(),
        "groups" => "/api/user/self/groups".into(),
        "models" => {
            let mut url =
                url::Url::parse(&format!("{BASE}/api/user/models")).map_err(|_| "地址无效")?;
            if let Some(group) = body.get("group").and_then(Value::as_str) {
                url.query_pairs_mut().append_pair("group", group);
            }
            format!(
                "{}{}",
                url.path(),
                url.query().map(|v| format!("?{v}")).unwrap_or_default()
            )
        }
        "tokens" => format!("/api/token/?p={page}&size=20"),
        "token_key" => format!("/api/token/{}/key", id()?),
        "records" => format!("/api/user/payment-records/self?p={page}&size=20"),
        "token_create" => return Ok((Method::POST, "/api/token/".into())),
        "token_status" => {
            id()?;
            return Ok((Method::PUT, "/api/token/?status_only=true".into()));
        }
        "token_delete" => return Ok((Method::DELETE, format!("/api/token/{}", id()?))),
        "redeem" => return Ok((Method::POST, "/api/user/redeem".into())),
        _ => return Err("不支持的操作".into()),
    };
    Ok((Method::GET, path))
}
pub fn website_url(destination: &str) -> Result<String, String> {
    let path = match destination {
        "topup" => "/console/topup",
        "register" => "/register",
        "account" => "/console/personal",
        "usage" => "/console/log",
        "privacy" => "/privacy-policy",
        "terms" => "/user-agreement",
        _ => return Err("不支持的网页入口".into()),
    };
    Ok(format!("{BASE}{path}"))
}
pub fn validate_chat(body: &Value) -> Result<(), String> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("缺少消息")?;
    if messages.is_empty()
        || messages.len() > 200
        || body.get("stream").and_then(Value::as_bool) != Some(true)
        || body
            .get("model")
            .and_then(Value::as_str)
            .is_none_or(|s| s.is_empty() || s.len() > 160)
        || serde_json::to_vec(body).map_err(|_| "消息无效")?.len() > 1024 * 1024
    {
        return Err("对话过长或模型无效，请新建对话后重试".into());
    }
    for message in messages {
        if ![Some("user"), Some("assistant"), Some("system")]
            .contains(&message.get("role").and_then(Value::as_str))
            || message.get("content").and_then(Value::as_str).is_none()
        {
            return Err("消息格式无效".into());
        }
    }
    Ok(())
}
pub fn image_credential(value: &Value) -> Result<String, String> {
    let raw = value
        .pointer("/data/url")
        .and_then(Value::as_str)
        .ok_or("生图会话缺少凭据")?;
    let url = url::Url::parse(raw).map_err(|_| "生图会话无效")?;
    let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
    let key = if let Some(settings) = query.get("settings") {
        let settings: Value = serde_json::from_str(settings).map_err(|_| "生图会话无效")?;
        settings
            .pointer("/profiles/0/apiKey")
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        query.get("apiKey").map(|v| v.to_string())
    }
    .ok_or("生图会话缺少凭据")?;
    if !key.starts_with("sk-") || key.len() > 4096 || key.contains(['\r', '\n']) {
        return Err("生图会话凭据无效".into());
    }
    // Only the credential is used; the response can never select the request origin.
    Ok(key)
}
pub fn image_mime(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Ok("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Ok("image/webp")
    } else {
        Err("仅支持 PNG、JPEG 或 WebP 图片".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_arbitrary_credential_destinations() {
        for name in ["https://evil.test", "../topup", "/api/user/self"] {
            assert!(website_url(name).is_err());
            assert!(api_route(name, &json!({})).is_err());
        }
        assert_eq!(
            website_url("topup").unwrap(),
            "https://meta-api.vip/console/topup"
        );
        let (_, path) = api_route("models", &json!({"group":"x&token=secret"})).unwrap();
        assert!(path.contains("x%26token%3Dsecret"));
    }
    #[test]
    fn reads_only_session_cookie() {
        let mut headers = HeaderMap::new();
        headers.append(SET_COOKIE, "other=1; Secure".parse().unwrap());
        headers.append(SET_COOKIE, "session=a=b; HttpOnly; Secure".parse().unwrap());
        assert_eq!(cookie_from_headers(&headers).unwrap(), "session=a=b");
    }
    #[test]
    fn image_session_never_changes_origin() {
        assert_eq!(
            image_credential(&json!({"data":{"url":"https://arbitrary.test/?apiKey=sk-example"}}))
                .unwrap(),
            "sk-example"
        );
        assert!(
            image_credential(&json!({"data":{"url":"https://example.test/?apiKey=invalid"}}))
                .is_err()
        );
    }
    #[test]
    fn limits_ids_messages_and_images() {
        assert!(api_route("token_key", &json!({"id":-1})).is_err());
        assert!(validate_chat(
            &json!({"model":"a","stream":true,"messages":[{"role":"tool","content":"x"}]})
        )
        .is_err());
        assert!(validate_chat(
            &json!({"model":"a","stream":true,"messages":[{"role":"user","content":"你好"}]})
        )
        .is_ok());
        assert!(image_mime(b"<svg></svg>").is_err());
    }
    #[test]
    fn errors_do_not_echo_secrets_or_html() {
        for raw in ["session=secret", "bad sk-secret", "<html>failure</html>"] {
            assert_eq!(message(&json!({"message":raw}), "请求失败"), "请求失败");
        }
    }
}
