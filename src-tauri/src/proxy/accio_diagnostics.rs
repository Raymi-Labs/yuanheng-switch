//! Bounded, allowlisted evidence. Never return or log raw upstream messages.
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub(super) struct Evidence {
    pub source: &'static str,
    pub code: &'static str,
    pub error_type: &'static str,
    pub parameter: &'static str,
    pub terms: Vec<&'static str>,
    pub http_status: Option<u16>,
    pub network: Option<&'static str>,
}

const CODES: &[&str] = &[
    "invalid_request_error",
    "invalid_function_parameters",
    "invalid_tool_call",
    "tool_use_failed",
    "model_behavior_error",
    "context_length_exceeded",
    "rate_limit_exceeded",
    "insufficient_quota",
    "invalid_api_key",
    "authentication_error",
    "permission_denied",
    "model_not_found",
    "server_error",
    "internal_error",
    "upstream_error",
    "overloaded_error",
    "timeout",
    "request_timeout",
    "bad_request",
    "validation_error",
    "inference_error",
    "generation_error",
    "response_parse_error",
    "invalid_json",
    "invalid_response",
    "api_error",
    "stream_error",
    "auth_unavailable",
    "no_available_channel",
    "model_error",
];
const TERMS: &[&str] = &[
    "tool",
    "function",
    "arguments",
    "parameters",
    "schema",
    "strict",
    "json",
    "parse",
    "parsing",
    "invalid",
    "malformed",
    "validation",
    "required",
    "missing",
    "unsupported",
    "write",
    "read",
    "bash",
    "content",
    "length",
    "context",
    "tokens",
    "maximum",
    "exceeded",
    "rate",
    "limit",
    "quota",
    "overloaded",
    "capacity",
    "timeout",
    "connection",
    "reset",
    "unavailable",
    "channel",
    "auth",
    "permission",
    "provider",
    "model",
    "internal",
    "server",
    "inference",
    "upstream",
    "failed",
    "empty",
    "truncated",
    "cancelled",
    "reasoning",
    "encrypted",
    "signature",
    "duplicate",
    "call_id",
    "output",
    "input",
    "status",
];

fn known(value: Option<&str>) -> &'static str {
    value
        .and_then(|value| CODES.iter().copied().find(|known| *known == value))
        .unwrap_or("other")
}

pub(super) fn evidence(source: &'static str, value: Option<&Value>) -> Evidence {
    let source = match source {
        "sse_error" | "responses_failed" | "responses_error" | "upstream_http" => source,
        _ => "local_stream_failure",
    };
    let empty = Value::Null;
    let value = value.unwrap_or(&empty);
    let error = value
        .pointer("/response/error")
        .or_else(|| value.get("error"))
        .unwrap_or(value);
    let code = known(error.get("code").and_then(Value::as_str));
    let error_type = known(error.get("type").and_then(Value::as_str));
    let parameter = match error
        .get("param")
        .and_then(Value::as_str)
        .unwrap_or("")
        .split(['.', '['])
        .next()
        .unwrap_or("")
    {
        "tools" => "tools",
        "input" => "input",
        "messages" => "messages",
        "model" => "model",
        "max_output_tokens" => "max_output_tokens",
        "reasoning" => "reasoning",
        "tool_choice" => "tool_choice",
        _ => "other",
    };
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .unwrap_or("");
    // Character bounding keeps UTF-8 valid; only dictionary words survive.
    let bounded = message
        .chars()
        .take(4096)
        .collect::<String>()
        .to_ascii_lowercase();
    let words: std::collections::BTreeSet<_> = bounded
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|word| !word.is_empty())
        .collect();
    let terms = TERMS
        .iter()
        .copied()
        .filter(|term| words.contains(term))
        .collect();
    Evidence {
        source,
        code,
        error_type,
        parameter,
        terms,
        http_status: None,
        network: None,
    }
}

pub(super) fn message(source: &'static str, value: Option<&Value>) -> String {
    format_message(evidence(source, value))
}

pub(super) fn http_message(status: u16, body: Option<&str>) -> String {
    let value = body
        .filter(|text| text.len() <= 64 * 1024)
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let mut evidence = evidence("upstream_http", value.as_ref());
    evidence.http_status = (100..600).contains(&status).then_some(status);
    format_message(evidence)
}

fn network_kind(message: &str) -> Option<&'static str> {
    if message.len() > 4096 {
        return None;
    }
    let detail = message
        .strip_prefix("上游连接失败 [network=")
        .or_else(|| message.strip_prefix("上游请求发送失败 [network="))?;
    let tag = detail.split_once(']')?.0.split(';').next()?;
    [
        "dns",
        "tls",
        "proxy_tunnel",
        "connection_refused",
        "connection_closed",
        "timeout",
        "network_unreachable",
        "unknown",
    ]
    .into_iter()
    .find(|known| *known == tag)
}

fn proxy_evidence(error: &super::ProxyError) -> Evidence {
    use super::ProxyError;
    let mut result = evidence("local_stream_failure", None);
    result.source = "core_error";
    result.error_type = "proxy_error";
    result.http_status = Some(super::error_mapper::map_proxy_error_to_status(error));
    result.code = match error {
        ProxyError::ForwardFailed(message) => {
            result.network = network_kind(message);
            if result.network.is_some() {
                "local_transport_error"
            } else {
                "local_forward_error"
            }
        }
        ProxyError::Timeout(_) | ProxyError::StreamIdleTimeout(_) => {
            result.network = Some("timeout");
            "local_timeout"
        }
        ProxyError::TransformError(_) => "local_transform_error",
        ProxyError::AuthError(_) => "local_auth_error",
        ProxyError::ConfigError(_) | ProxyError::InvalidRequest(_) => "local_config_error",
        ProxyError::NoAvailableProvider
        | ProxyError::NoProvidersConfigured
        | ProxyError::AllProvidersCircuitOpen
        | ProxyError::ProviderUnhealthy(_)
        | ProxyError::MaxRetriesExceeded => "local_route_unavailable",
        _ => "local_internal_error",
    };
    result
}

pub(super) fn proxy_message(error: &super::ProxyError) -> String {
    if let super::ProxyError::UpstreamError { status, body } = error {
        return http_message(*status, body.as_deref());
    }
    format_message(proxy_evidence(error))
}

fn category(evidence: &Evidence) -> &'static str {
    match evidence.code {
        "local_transport_error" => {
            return "元衡 Core 连接上游失败，尚未取得模型响应；请检查网络和出站代理"
        }
        "local_forward_error" => return "元衡 Core 转发请求失败，尚不能确定具体网络原因",
        "local_timeout" => return "元衡 Core 等待上游超时；请检查网络和上游状态",
        "local_transform_error" => return "元衡 Core 协议转换失败，请提供诊断编号排查",
        "local_auth_error" => return "元衡 Core 认证失败，请检查当前分组配置",
        "local_config_error" => return "元衡 Core 请求或配置无效，请检查当前配置",
        "local_route_unavailable" => return "元衡 Core 当前模型路由不可用，请检查分组配置",
        "local_internal_error" => return "元衡 Core 本地处理失败，请提供诊断编号排查",
        _ => {}
    }
    if evidence.code == "server_error" && evidence.terms.contains(&"overloaded") {
        return "上游模型服务过载，暂时无法处理请求";
    }
    match evidence.code {
        "invalid_request_error"
        | "invalid_function_parameters"
        | "invalid_tool_call"
        | "tool_use_failed"
        | "validation_error"
        | "invalid_json" => "上游拒绝请求或工具参数",
        "context_length_exceeded" => "上游上下文超限",
        "rate_limit_exceeded" | "insufficient_quota" | "overloaded_error" => "上游限额或容量异常",
        "authentication_error" | "invalid_api_key" | "auth_unavailable" | "permission_denied" => {
            "上游认证或权限异常"
        }
        "model_not_found" | "no_available_channel" => "上游模型路由不可用",
        _ => "上游返回错误",
    }
}

fn format_message(evidence: Evidence) -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let reference = &id[..12];
    // Evidence contains only static strings from this module and fixed words.
    let diagnostic = serde_json::to_string(&evidence).unwrap_or_else(|_| "{}".into());
    log::warn!("[AccioStream] diagnostic={reference} evidence={diagnostic}");
    let category = category(&evidence);
    let status = evidence
        .http_status
        .map(|status| {
            format!(
                "{}HTTP {status}；",
                if evidence.source == "core_error" {
                    "本地 "
                } else {
                    ""
                }
            )
        })
        .unwrap_or_default();
    let network = evidence
        .network
        .map(|kind| format!("；network={kind}"))
        .unwrap_or_default();
    format!(
        "{category}（{status}{}{network}；诊断编号 {reference}）；未自动重试或切换模型",
        evidence.code
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accio_local_transport_errors_keep_provenance_without_raw_details() {
        use super::super::ProxyError;
        let error = ProxyError::ForwardFailed(
            "上游连接失败 [network=unknown]；alice@example.test /Users/private/file sk-secret"
                .into(),
        );
        let result = proxy_evidence(&error);
        assert_eq!(result.source, "core_error");
        assert_eq!(result.code, "local_transport_error");
        assert_eq!(result.network, Some("unknown"));
        assert_eq!(result.http_status, Some(502));
        let message = proxy_message(&error);
        assert!(message.contains("本地 HTTP 502"));
        assert!(message.contains("尚未取得模型响应"));
        for secret in ["alice", "private", "sk-secret", "file"] {
            assert!(!message.contains(secret));
            assert!(!serde_json::to_string(&result).unwrap().contains(secret));
        }
        let upstream = proxy_message(&ProxyError::UpstreamError {
            status: 502,
            body: Some(
                json!({"error":{"type":"proxy_error","message":"上游连接失败 [network=dns]"}})
                    .to_string(),
            ),
        });
        assert!(!upstream.contains("本地 HTTP"));
        assert!(!upstream.contains("network=dns"));
    }

    #[test]
    fn accio_local_errors_only_emit_known_categories_and_network_tags() {
        use super::super::ProxyError;
        for tag in [
            "dns",
            "tls",
            "proxy_tunnel",
            "connection_refused",
            "connection_closed",
            "timeout",
            "network_unreachable",
            "unknown",
        ] {
            assert_eq!(
                network_kind(&format!(
                    "上游连接失败 [network={tag}; io=secret; os=13]；secret"
                )),
                Some(tag)
            );
        }
        for message in [
            "[network=dns]",
            "private [network=dns]",
            "上游连接失败 [network=secret]",
            "上游连接失败 [network=tls",
            "上游连接失败 [network=tls/secret]",
        ] {
            assert!(network_kind(message).is_none());
        }
        assert!(network_kind(&format!("上游连接失败 [network=dns]{}", "a".repeat(4096))).is_none());
        for (error, code, status) in [
            (
                ProxyError::ForwardFailed("private message".into()),
                "local_forward_error",
                502,
            ),
            (
                ProxyError::Timeout("private message".into()),
                "local_timeout",
                504,
            ),
            (
                ProxyError::TransformError("private message".into()),
                "local_transform_error",
                422,
            ),
            (
                ProxyError::AuthError("private message".into()),
                "local_auth_error",
                401,
            ),
            (
                ProxyError::ConfigError("private message".into()),
                "local_config_error",
                400,
            ),
            (
                ProxyError::NoAvailableProvider,
                "local_route_unavailable",
                503,
            ),
        ] {
            let result = proxy_evidence(&error);
            assert_eq!(result.code, code);
            assert_eq!(result.http_status, Some(status));
            assert!(!proxy_message(&error).contains("private message"));
        }
    }

    #[test]
    fn accio_error_diagnostics_drop_secrets_and_keep_fixed_evidence() {
        let value = json!({"type":"response.failed","response":{"error":{"code":"invalid_function_parameters","type":"invalid_request_error","param":"tools[2].parameters.secret-key","message":"Invalid JSON arguments for write; alice@example.test /Users/private-name/report.txt Bearer sensitive-key-123"}}});
        let result = evidence("responses_failed", Some(&value));
        assert_eq!(result.code, "invalid_function_parameters");
        assert_eq!(result.parameter, "tools");
        assert!(result.terms.contains(&"write"));
        assert!(result.terms.contains(&"json"));
        let serialized = serde_json::to_string(&result).unwrap();
        for forbidden in [
            "alice",
            "private-name",
            "sensitive-key",
            "report.txt",
            "secret-key",
            "Bearer",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn accio_error_diagnostics_never_trust_arbitrary_fields_or_nested_payloads() {
        let value = json!({"code":"secret-123","type":"person@example.test","param":"private-field", "message":"private-value", "payload":{"prompt":"must not be copied"}});
        let result = evidence("unknown-sensitive-source", Some(&value));
        assert_eq!(result.source, "local_stream_failure");
        assert_eq!(result.code, "other");
        assert_eq!(result.error_type, "other");
        assert_eq!(result.parameter, "other");
        assert!(result.terms.is_empty());
        let oversize = json!({"error":{"message": "字".repeat(5000) + " invalid json"}});
        assert!(evidence("sse_error", Some(&oversize)).terms.is_empty());
        assert_eq!(evidence("sse_error", None).code, "other");
    }

    #[test]
    fn accio_http_overload_is_distinguished_from_tools_and_never_echoes_body() {
        let body = json!({"error":{"message":"Our servers are currently overloaded. Please try again later. sk-secret /Users/alice/a.txt", "code":"server_error", "type":"secret"}}).to_string();
        let message = http_message(503, Some(&body));
        assert!(message.contains("服务过载"));
        assert!(message.contains("HTTP 503"));
        assert!(!message.contains("sk-secret"));
        assert!(!message.contains("alice"));
        assert!(!message.contains("工具参数"));
        assert!(http_message(400, Some("<html>private content</html>")).contains("HTTP 400"));
        assert!(
            !http_message(400, Some("<html>private content</html>")).contains("private content")
        );
    }
}
