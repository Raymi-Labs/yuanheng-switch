//! Accio v0.34.5 protobuf-JSON boundary (not the Gemini HTTP protocol).
//! Official tokens, device identifiers and arbitrary properties never cross it.

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

fn field<'a>(v: &'a Value, snake: &str, camel: &str) -> Result<Option<&'a Value>, String> {
    if snake != camel && v.get(snake).is_some() && v.get(camel).is_some() {
        return Err(format!("Accio 字段重复: {snake}"));
    }
    Ok(v.get(snake).or_else(|| v.get(camel)))
}

fn required_string<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or_else(|| format!("Accio 缺少有效的 {key}"))
}

fn json_object(value: &Value) -> Result<Value, String> {
    let value = if let Some(raw) = value.as_str() {
        serde_json::from_str(raw).map_err(|_| "Accio 工具 JSON 无效")?
    } else {
        value.clone()
    };
    value
        .is_object()
        .then_some(value)
        .ok_or_else(|| "Accio 参数必须是 JSON 对象".into())
}

fn flush_message(input: &mut Vec<Value>, parts: &mut Vec<Value>, role: &str) {
    if !parts.is_empty() {
        input.push(json!({"role":role,"content":std::mem::take(parts)}));
    }
}

/// Preserve ordering and call IDs. Unsupported content fails before sending.
pub fn accio_to_responses(request: &Value) -> Result<Value, String> {
    let model = required_string(request, "model")?;
    let contents = request
        .get("contents")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
        .ok_or("Accio contents 不能为空")?;
    let mut input = Vec::new();
    let mut pending = BTreeMap::new();
    let mut call_ids = HashSet::new();
    for content in contents {
        let role = match required_string(content, "role")? {
            "model" | "assistant" => "assistant",
            "user" => "user",
            "function" | "tool" => "tool",
            _ => return Err("Accio 不支持的消息角色".into()),
        };
        let parts = content
            .get("parts")
            .and_then(Value::as_array)
            .ok_or("Accio parts 必须是数组")?;
        let mut message = Vec::new();
        for part in parts {
            let object = part.as_object().ok_or("Accio part 必须是对象")?;
            if object.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "text"
                        | "thought"
                        | "thought_signature"
                        | "thoughtSignature"
                        | "inline_data"
                        | "inlineData"
                        | "file_data"
                        | "fileData"
                        | "function_call"
                        | "functionCall"
                        | "function_response"
                        | "functionResponse"
                )
            }) {
                return Err("Accio 包含尚未支持的内容类型".into());
            }
            let call = field(part, "function_call", "functionCall")?;
            let result = field(part, "function_response", "functionResponse")?;
            let image = field(part, "inline_data", "inlineData")?;
            let file = field(part, "file_data", "fileData")?;
            if [part.get("text"), call, result, image, file]
                .iter()
                .filter(|v| v.is_some())
                .count()
                != 1
            {
                return Err("Accio part 必须且只能包含一种内容".into());
            }
            if file.is_some() {
                return Err("Accio fileData 尚未支持；请求未发送".into());
            }
            if let Some(text) = part.get("text") {
                let text = text.as_str().ok_or("Accio text 必须是字符串")?;
                if part.get("thought").and_then(Value::as_bool) == Some(true) {
                    if role != "assistant" {
                        return Err("Accio 用户消息不能标记为 thought".into());
                    }
                    continue;
                }
                if role == "tool" {
                    return Err("Accio 工具结果缺少 functionResponse".into());
                }
                message.push(json!({"type":if role == "assistant" {"output_text"} else {"input_text"},"text":text}));
            } else if let Some(image) = image {
                if role != "user" {
                    return Err("Accio 仅支持用户消息中的图片输入".into());
                }
                let mime = field(image, "mime_type", "mimeType")?
                    .and_then(Value::as_str)
                    .filter(|mime| {
                        matches!(
                            *mime,
                            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                        )
                    })
                    .ok_or("Accio 图片 MIME 类型不支持")?;
                let data = image
                    .get("data")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or("Accio 图片为空")?;
                use base64::Engine;
                base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|_| "Accio 图片不是有效 base64")?;
                message.push(
                    json!({"type":"input_image","image_url":format!("data:{mime};base64,{data}")}),
                );
            } else if let Some(call) = call {
                if role != "assistant" {
                    return Err("Accio functionCall 只能出现在模型消息中".into());
                }
                flush_message(&mut input, &mut message, role);
                let id = required_string(call, "id")?;
                let name = required_string(call, "name")?;
                if !call_ids.insert(id.to_owned()) {
                    return Err("Accio 工具调用 ID 重复".into());
                }
                let arguments = field(call, "args_json", "argsJson")?
                    .or_else(|| call.get("args"))
                    .map(json_object)
                    .transpose()?
                    .unwrap_or_else(|| json!({}));
                pending.insert(id.to_owned(), name.to_owned());
                input.push(json!({"type":"function_call","call_id":id,"name":name,"arguments":arguments.to_string()}));
            } else if let Some(result) = result {
                if role == "assistant" {
                    return Err("Accio 模型消息不能包含工具结果".into());
                }
                flush_message(&mut input, &mut message, role);
                let id = required_string(result, "id")?;
                let expected = pending
                    .remove(id)
                    .ok_or("Accio 工具结果没有对应的调用 ID")?;
                if result
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name != expected)
                {
                    return Err("Accio 工具结果名称与调用不一致".into());
                }
                let output = field(result, "response_json", "responseJson")?
                    .or_else(|| result.get("response"))
                    .ok_or("Accio 工具结果内容缺失")?;
                let output = output
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| output.to_string());
                input.push(json!({"type":"function_call_output","call_id":id,"output":output}));
            }
        }
        flush_message(&mut input, &mut message, role);
    }
    if !pending.is_empty() {
        return Err("Accio 历史工具调用尚无结果，请完成或开启新对话".into());
    }
    if !input
        .iter()
        .any(|v| v["role"] == "user" || v["type"] == "function_call_output")
    {
        return Err("Accio 没有用户输入或工具结果".into());
    }
    let mut out = json!({"model":model,"input":input,"stream":true,"store":false});
    if let Some(system) = field(request, "system_instruction", "systemInstruction")? {
        out["instructions"] = json!(system
            .as_str()
            .ok_or("Accio systemInstruction 必须是字符串")?);
    }
    for (snake, camel, target) in [
        ("temperature", "temperature", "temperature"),
        ("top_p", "topP", "top_p"),
        ("max_output_tokens", "maxOutputTokens", "max_output_tokens"),
    ] {
        if let Some(value) = field(request, snake, camel)? {
            if !value.is_number()
                || (target == "max_output_tokens" && value.as_u64().is_none_or(|v| v == 0))
            {
                return Err(format!("Accio {snake} 数值无效"));
            }
            out[target] = value.clone();
        }
    }
    if field(request, "stop_sequences", "stopSequences")?
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
    {
        return Err("Accio stopSequences 不能无损映射到当前协议；请求未发送".into());
    }
    let properties = request.get("properties");
    if let Some(properties) = properties {
        for (key, value) in properties
            .as_object()
            .ok_or("Accio properties 必须是对象")?
        {
            match key.as_str() {
                "normalized_response" if value == "true" => {}
                "reasoning_effort" => {}
                "toolConfig" | "tool_config"
                    if json_object(value)?
                        == json!({"functionCallingConfig":{"streamFunctionCallArguments":true}}) => {
                }
                _ => return Err("Accio 包含尚未支持的 properties；请求未发送".into()),
            }
        }
    }
    let reasoning = field(request, "reasoning_effort", "reasoningEffort")?
        .or_else(|| properties.and_then(|p| p.get("reasoning_effort")))
        .or(field(request, "thinking_level", "thinkingLevel")?);
    if let Some(reasoning) = reasoning {
        let effort = reasoning
            .as_str()
            .ok_or("Accio reasoningEffort 必须是字符串")?;
        if !matches!(
            effort,
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        ) {
            return Err("Accio 思考强度无效".into());
        }
        out["reasoning"] = json!({"effort":effort});
    }
    if field(request, "thinking_budget", "thinkingBudget")?
        .is_some_and(|v| v.as_i64().is_some_and(|n| n > 0))
    {
        return Err("Accio 精确 thinkingBudget 尚未支持；请求未发送".into());
    }
    if let Some(tools) = request.get("tools") {
        let mut converted = Vec::new();
        let mut names = HashSet::new();
        for tool in tools.as_array().ok_or("Accio tools 必须是数组")? {
            // Accio's Tool protobuf is a flat name/description/parametersJson
            // declaration. Retain the older grouped fixture shape explicitly.
            let declarations: &[Value] = if let Some(declarations) =
                field(tool, "function_declarations", "functionDeclarations")?
            {
                if tool.get("name").is_some() {
                    return Err("Accio 工具声明不能混用两种格式".into());
                }
                declarations
                    .as_array()
                    .filter(|v| !v.is_empty())
                    .ok_or("Accio functionDeclarations 必须是非空数组")?
            } else {
                std::slice::from_ref(tool)
            };
            for declaration in declarations {
                let name = required_string(declaration, "name")?;
                if !names.insert(name.to_owned()) {
                    return Err("Accio 工具名称重复".into());
                }
                let parameters = field(declaration, "parameters_json", "parametersJson")?
                    .or_else(|| declaration.get("parameters"))
                    .map(json_object)
                    .transpose()?
                    .unwrap_or_else(|| json!({"type":"object","properties":{}}));
                // Accio schemas contain optional and mutually exclusive fields.
                // Responses may normalize an omitted strict flag to required
                // properties; preserve the source tool's optional semantics.
                let mut item =
                    json!({"type":"function","name":name,"parameters":parameters,"strict":false});
                if let Some(description) = declaration.get("description") {
                    item["description"] =
                        json!(description.as_str().ok_or("Accio 工具描述无效")?);
                }
                converted.push(item);
            }
        }
        if !converted.is_empty() {
            out["tools"] = json!(converted);
        }
    }
    if let Some(choice) = field(request, "tool_choice", "toolChoice")? {
        out["tool_choice"] = match choice.as_str().ok_or("Accio toolChoice 无效")? {
            choice @ ("auto" | "none" | "required") => json!(choice),
            "any" => json!("required"),
            _ => return Err("Accio 命名 toolChoice 尚未支持".into()),
        };
    }
    if let Some(format) = field(request, "response_format", "responseFormat")? {
        let format = json_object(format)?;
        let format = match format["type"].as_str() {
            Some("json_object" | "text") => format,
            Some("json_schema") => {
                let schema = format.get("json_schema").ok_or("Accio JSON Schema 缺失")?;
                let name = required_string(schema, "name")?;
                let definition = schema
                    .get("schema")
                    .filter(|v| v.is_object())
                    .ok_or("Accio JSON Schema 无效")?;
                let mut result = json!({"type":"json_schema","name":name,"schema":definition});
                if let Some(strict) = schema.get("strict") {
                    result["strict"] =
                        json!(strict.as_bool().ok_or("Accio JSON Schema strict 无效")?);
                }
                if let Some(description) = schema.get("description") {
                    result["description"] =
                        json!(description.as_str().ok_or("Accio JSON Schema 描述无效")?);
                }
                result
            }
            _ => return Err("Accio responseFormat 尚未支持".into()),
        };
        out["text"] = json!({"format":format});
    }
    Ok(out)
}

/// The official reader recognizes two camelCase envelope fields. Snake-only
/// content/turn_complete frames are incorrectly treated as error passthrough.
fn frame(parts: Vec<Value>, complete: bool) -> Value {
    json!({"content":{"role":"model","parts":parts},"partial":!complete,"turnComplete":complete})
}

pub fn error_frame(code: &str, message: &str) -> Value {
    let mut value = frame(Vec::new(), true);
    value["errorCode"] = json!(code);
    value["errorMessage"] = json!(message);
    value
}

#[derive(Default)]
pub struct ResponseFrames {
    text: BTreeMap<(String, u64, bool), String>,
    validated_calls: BTreeMap<String, Value>,
    tracked_bytes: usize,
    pub complete: bool,
}

impl ResponseFrames {
    fn charge(&mut self, n: usize) -> Result<(), String> {
        self.tracked_bytes = self.tracked_bytes.saturating_add(n);
        if self.tracked_bytes > 16 * 1024 * 1024 {
            return Err("Accio 响应超出安全大小限制".into());
        }
        Ok(())
    }

    fn function(&mut self, item: &Value) -> Result<Value, String> {
        let id = required_string(item, "id")?;
        let call_id = required_string(item, "call_id")?;
        let name = required_string(item, "name")?;
        let args = json_object(item.get("arguments").ok_or("上游工具调用缺少参数")?)?;
        let part = json!({"functionCall":{"id":call_id,"name":name,"argsJson":args.to_string()}});
        if let Some(previous) = self.validated_calls.get(id) {
            return if previous == &part {
                Ok(previous.clone())
            } else {
                Err("上游最终工具调用与已完成条目不一致".into())
            };
        }
        self.charge(part.to_string().len())?;
        self.validated_calls.insert(id.to_string(), part.clone());
        Ok(part)
    }

    pub fn push(&mut self, event: &Value) -> Result<Vec<Value>, String> {
        if self.complete {
            return Err("上游在完成后继续发送事件".into());
        }
        let kind = required_string(event, "type")?;
        match kind {
            "error" | "response.failed" => Err(crate::proxy::accio_diagnostics::message(
                if kind == "error" { "responses_error" } else { "responses_failed" },
                Some(event),
            )),
            "response.output_text.delta"
            | "response.refusal.delta"
            | "response.reasoning_summary_text.delta" => {
                let id = required_string(event, "item_id")?.to_owned();
                let index = event
                    .get("content_index")
                    .or_else(|| event.get("summary_index"))
                    .and_then(Value::as_u64)
                    .ok_or("上游文本缺少索引")?;
                let text = event
                    .get("delta")
                    .and_then(Value::as_str)
                    .ok_or("上游文本增量无效")?;
                self.charge(text.len())?;
                let thought = kind == "response.reasoning_summary_text.delta";
                self.text
                    .entry((id, index, thought))
                    .or_default()
                    .push_str(text);
                Ok(vec![frame(
                    vec![json!({"text":text,"thought":thought})],
                    false,
                )])
            }
            "response.output_item.done" => {
                let item = event.get("item").ok_or("上游缺少 output item")?;
                if item["type"] != "function_call" {
                    return Ok(Vec::new());
                }
                // Accio's agent consumer intentionally skips function calls
                // while turnComplete=false. Validate now; emit in the terminal
                // frame once the upstream confirms the entire response.
                self.function(item)?;
                Ok(Vec::new())
            }
            "response.completed" | "response.incomplete" => {
                let response = event.get("response").ok_or("上游完成事件缺少 response")?;
                let finish = if kind == "response.incomplete" {
                    match response
                        .pointer("/incomplete_details/reason")
                        .and_then(Value::as_str)
                    {
                        Some("max_output_tokens") => "MAX_TOKENS",
                        Some("content_filter") => "SAFETY",
                        _ => return Err("元衡上游未完整完成响应".into()),
                    }
                } else {
                    "STOP"
                };
                let mut parts = Vec::new();
                let mut seen_text = HashSet::new();
                let mut seen_calls = HashSet::new();
                for item in response
                    .get("output")
                    .and_then(Value::as_array)
                    .ok_or("上游完成事件缺少 output")?
                {
                    if item["type"] == "function_call" {
                        let id = required_string(item, "id")?;
                        if !seen_calls.insert(id.to_string()) {
                            return Err("上游最终工具条目重复".into());
                        }
                        parts.push(self.function(item)?);
                    } else if item["type"] == "message" || item["type"] == "reasoning" {
                        let id = required_string(item, "id")?;
                        let thought = item["type"] == "reasoning";
                        let contents = item
                            .get(if thought { "summary" } else { "content" })
                            .and_then(Value::as_array);
                        for (index, content) in contents.into_iter().flatten().enumerate() {
                            if let Some(text) = content
                                .get("text")
                                .or_else(|| content.get("refusal"))
                                .and_then(Value::as_str)
                            {
                                let key = (id.to_string(), index as u64, thought);
                                if !seen_text.insert(key.clone()) {
                                    return Err("上游最终文本条目重复".into());
                                }
                                let previous =
                                    self.text.get(&key).map(String::as_str).unwrap_or("");
                                let rest = text
                                    .strip_prefix(previous)
                                    .ok_or("上游最终文本与增量不一致")?;
                                if !rest.is_empty() {
                                    parts.push(json!({"text":rest,"thought":thought}));
                                }
                            }
                        }
                    } else {
                        return Err("上游返回了不支持的工具或媒体类型".into());
                    }
                }
                if self.text.keys().any(|k| !seen_text.contains(k))
                    || self.validated_calls.keys().any(|k| !seen_calls.contains(k))
                {
                    return Err("上游完成事件丢失已发送的内容".into());
                }
                self.complete = true;
                let mut result = frame(parts, true);
                result["finishReason"] = json!(finish);
                if let Some(usage) = response.get("usage").filter(|v| v.is_object()) {
                    result["usageMetadata"] = json!({
                        "promptTokenCount":usage.get("input_tokens").cloned().unwrap_or(json!(0)),
                        "candidatesTokenCount":usage.get("output_tokens").cloned().unwrap_or(json!(0)),
                        "totalTokenCount":usage.get("total_tokens").cloned().unwrap_or(json!(0)),
                        "cachedContentTokenCount":usage.pointer("/input_tokens_details/cached_tokens").cloned().unwrap_or(json!(0)),
                        "thoughtsTokenCount":usage.pointer("/output_tokens_details/reasoning_tokens").cloned().unwrap_or(json!(0))
                    });
                }
                Ok(vec![result])
            }
            "response.created"
            | "response.in_progress"
            // Observed on the managed Responses stream. These are transport,
            // rate-limit and routing metadata, not generated user content.
            | "codex.rate_limits"
            | "codex.response.metadata"
            | "response.metadata"
            | "responsesapi.websocket_timing"
            | "response.output_item.added"
            | "response.content_part.added"
            | "response.content_part.done"
            | "response.output_text.done"
            | "response.refusal.done"
            | "response.output_text.annotation.added"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.reasoning_summary_text.done"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done" => Ok(Vec::new()),
            _ => Err("上游返回了尚未支持的流事件".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_proto_without_forwarding_official_identity() {
        let request = json!({"model":"m","token":"official-secret","empid":"private","system_instruction":"hello","contents":[{"role":"user","parts":[{"text":"hi"}]}],"max_output_tokens":512,"properties":{"normalized_response":"true","reasoning_effort":"high"},"tools":[{"function_declarations":[{"name":"read","parameters_json":"{\"type\":\"object\",\"properties\":{\"filePath\":{\"type\":\"string\"}}}"}]}]});
        let output = accio_to_responses(&request).unwrap();
        assert_eq!(output["instructions"], "hello");
        assert_eq!(output["max_output_tokens"], 512);
        assert_eq!(output["reasoning"]["effort"], "high");
        assert_eq!(
            output["tools"][0]["parameters"]["properties"]["filePath"]["type"],
            "string"
        );
        assert!(!output.to_string().contains("official-secret"));
        assert!(output.get("empid").is_none());
    }

    #[test]
    fn accio_optional_mutually_exclusive_tool_fields_remain_optional() {
        let schema = json!({"type":"object","properties":{
            "file_path":{"type":"string"},
            "json_path":{"type":"string"},
            "json_paths":{"type":"array","items":{"type":"string"}},
            "json_with_paths":{"type":"boolean"}
        },"required":["file_path"]});
        for tool in [
            json!({"name":"read","parameters_json":schema.to_string()}),
            json!({"function_declarations":[{"name":"read","parameters":schema}]}),
        ] {
            let request = json!({"model":"m","contents":[{"role":"user","parts":[{"text":"read"}]}],"tools":[tool]});
            let output = accio_to_responses(&request).unwrap();
            assert_eq!(output["tools"][0]["strict"], false);
            assert_eq!(output["tools"][0]["parameters"], schema);
        }
    }

    #[test]
    fn mixed_text_calls_results_preserve_order_and_do_not_duplicate_text() {
        let request = json!({"model":"m","contents":[
            {"role":"model","parts":[{"text":"before"},{"function_call":{"id":"a","name":"f","args_json":"{}"}},{"function_call":{"id":"b","name":"f","args_json":"{}"}}]},
            {"role":"user","parts":[{"function_response":{"id":"a","name":"f","response_json":"{\"ok\":true}"}},{"function_response":{"id":"b","name":"f","response_json":"plain result"}},{"text":"after"}]}]});
        let output = accio_to_responses(&request).unwrap();
        assert_eq!(output["input"].as_array().unwrap().len(), 6);
        assert_eq!(output["input"][0]["content"][0]["text"], "before");
        assert_eq!(output["input"][1]["call_id"], "a");
        assert_eq!(output["input"][2]["call_id"], "b");
        assert_eq!(output["input"][4]["output"], "plain result");
        assert_eq!(output["input"][5]["content"][0]["text"], "after");
    }

    #[test]
    fn rejects_unsupported_content_and_unmatched_results() {
        for part in [
            json!({"file_data":{"file_uri":"file://private"}}),
            json!({"text":"a","function_call":{"id":"x","name":"f"}}),
            json!({"video":{}}),
            json!({"function_response":{"id":"orphan","response_json":"{}"}}),
        ] {
            assert!(accio_to_responses(
                &json!({"model":"m","contents":[{"role":"user","parts":[part]}]})
            )
            .is_err());
        }
        assert!(accio_to_responses(&json!({"model":"m","system_instruction":"a","systemInstruction":"b","contents":[{"role":"user","parts":[{"text":"x"}]}]})).is_err());
    }

    #[test]
    fn maps_structured_output_without_losing_schema_keys() {
        let request = json!({"model":"m","contents":[{"role":"user","parts":[{"text":"x"}]}],
            "response_format":"{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"Result\",\"strict\":true,\"schema\":{\"type\":\"object\",\"properties\":{\"itemID\":{\"type\":\"integer\"}}}}}"});
        let output = accio_to_responses(&request).unwrap();
        assert_eq!(output["text"]["format"]["name"], "Result");
        assert_eq!(
            output["text"]["format"]["schema"]["properties"]["itemID"]["type"],
            "integer"
        );
    }

    #[test]
    fn accio_actual_flat_proto_tools_keep_names_and_json_parameter_case() {
        let request = json!({"model":"m","contents":[{"role":"user","parts":[{"text":"x"}]}],"tools":[{"name":"read_file","description":"Read a file","parameters_json":"{\"type\":\"object\",\"properties\":{\"filePath\":{\"type\":\"string\"}}}"}]});
        let output = accio_to_responses(&request).unwrap();
        assert_eq!(output["tools"][0]["name"], "read_file");
        assert_eq!(
            output["tools"][0]["parameters"]["properties"]["filePath"]["type"],
            "string"
        );
        let mut ambiguous = request;
        ambiguous["tools"][0]["function_declarations"] = json!([]);
        assert!(accio_to_responses(&ambiguous).is_err());
    }

    #[test]
    fn streams_refusals_without_turning_them_into_a_proxy_error() {
        let mut state = ResponseFrames::default();
        state.push(&json!({"type":"response.refusal.delta","item_id":"m","content_index":0,"delta":"Cannot help"})).unwrap();
        let result = state.push(&json!({"type":"response.completed","response":{"output":[{"type":"message","id":"m","content":[{"type":"refusal","refusal":"Cannot help"}]}]}})).unwrap();
        assert_eq!(result[0]["turnComplete"], true);
        assert!(result[0].get("errorCode").is_none());
    }

    #[test]
    fn accio_ignores_only_observed_transport_metadata_not_unknown_content() {
        let mut state = ResponseFrames::default();
        for kind in [
            "codex.rate_limits",
            "codex.response.metadata",
            "response.metadata",
            "responsesapi.websocket_timing",
        ] {
            assert!(state
                .push(&json!({"type":kind,"private_transport_data":"must not leak"}))
                .unwrap()
                .is_empty());
            assert!(!state.complete);
        }
        assert!(state
            .push(&json!({"type":"response.future_content.delta","delta":"must not silently drop"}))
            .is_err());
    }

    #[test]
    fn completion_does_not_duplicate_deltas_and_uses_recognized_envelope() {
        let mut state = ResponseFrames::default();
        let delta = state.push(&json!({"type":"response.output_text.delta","item_id":"msg","content_index":0,"delta":"你好"})).unwrap();
        assert_eq!(delta[0]["content"]["parts"][0]["text"], "你好");
        let done = state.push(&json!({"type":"response.completed","response":{"output":[{"type":"message","id":"msg","content":[{"type":"output_text","text":"你好！"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}})).unwrap();
        assert_eq!(done[0]["content"]["parts"][0]["text"], "！");
        assert_eq!(done[0]["turnComplete"], true);
        assert_eq!(done[0]["usageMetadata"]["totalTokenCount"], 5);
        assert!(state.complete);
    }

    #[test]
    fn tools_emit_once_only_after_valid_json() {
        let mut state = ResponseFrames::default();
        let item = json!({"type":"function_call","id":"i","call_id":"c","name":"read","arguments":"{\"filePath\":\"x\"}"});
        let output = state
            .push(&json!({"type":"response.output_item.done","item":item}))
            .unwrap();
        assert!(
            output.is_empty(),
            "Accio skips incomplete function-call frames"
        );
        let done = state
            .push(&json!({"type":"response.completed","response":{"output":[item]}}))
            .unwrap();
        assert_eq!(done[0]["content"]["parts"][0]["functionCall"]["id"], "c");
        assert_eq!(done[0]["turnComplete"], true);
        let mut malformed = ResponseFrames::default();
        assert!(malformed.push(&json!({"type":"response.output_item.done","item":{"type":"function_call","id":"i","call_id":"c","name":"f","arguments":"{"}})).is_err());
    }
}
