use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use futures::StreamExt;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::store::AppState;

const API_TOKEN_SETTING_KEY: &str = "yuanheng_api_token";
use crate::yuanheng_endpoints::CHAT_URL as VOICE_CLONE_ENDPOINT;
const VOICE_CLONE_MODEL: &str = "mimo-v2.5-tts-voiceclone";
const MAX_REFERENCE_BASE64_BYTES: usize = 10_000_000;
const MAX_REFERENCE_AUDIO_BYTES: usize = 7_500_000;
const MAX_RESPONSE_BYTES: usize = 40 * 1024 * 1024;
const MAX_OUTPUT_AUDIO_BYTES: usize = 24 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 20_000;
const MAX_SEGMENT_TEXT_CHARS: usize = 4_500;
const MAX_INSTRUCTION_CHARS: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCloneRequest {
    pub reference_audio_base64: String,
    pub mime_type: String,
    pub text: String,
    pub instruction: String,
    pub consent_confirmed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCloneResult {
    pub audio_base64: String,
    pub mime_type: String,
    pub final_text_preview: Option<String>,
    pub segments: Vec<VoiceCloneSegment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCloneSegment {
    pub audio_base64: String,
    pub mime_type: String,
    pub text: String,
    pub final_text_preview: Option<String>,
}

#[derive(Debug)]
struct ValidatedVoiceCloneRequest {
    reference_audio_base64: String,
    mime_type: &'static str,
    text: String,
    instruction: String,
}

fn count_chars(value: &str) -> usize {
    value.chars().count()
}

fn validate_voice_clone_request(
    request: VoiceCloneRequest,
) -> Result<ValidatedVoiceCloneRequest, String> {
    if !request.consent_confirmed {
        return Err("请先确认你拥有该声音的使用授权".to_string());
    }

    let mime_type = match request.mime_type.trim().to_ascii_lowercase().as_str() {
        "audio/wav" | "audio/x-wav" | "audio/wave" => "audio/wav",
        "audio/mpeg" | "audio/mp3" => "audio/mpeg",
        _ => return Err("参考音频仅支持 WAV 或 MP3".to_string()),
    };

    let reference_audio_base64 = request.reference_audio_base64.trim();
    if reference_audio_base64.is_empty() {
        return Err("请选择参考音频".to_string());
    }
    if reference_audio_base64.starts_with("data:") {
        return Err("参考音频格式无效".to_string());
    }
    if reference_audio_base64.len() > MAX_REFERENCE_BASE64_BYTES {
        return Err("参考音频编码后超过 10 MB 限制".to_string());
    }
    let decoded = BASE64_STANDARD
        .decode(reference_audio_base64)
        .map_err(|_| "参考音频编码无效".to_string())?;
    if decoded.is_empty() {
        return Err("参考音频内容为空".to_string());
    }
    if decoded.len() > MAX_REFERENCE_AUDIO_BYTES {
        return Err("参考音频文件过大，请压缩到 7 MB 以内".to_string());
    }

    let text = request.text.trim();
    if text.is_empty() {
        return Err("请输入需要生成的文字".to_string());
    }
    if count_chars(text) > MAX_TEXT_CHARS {
        return Err(format!("生成文字不能超过 {MAX_TEXT_CHARS} 个字符"));
    }

    let instruction = request.instruction.trim();
    if count_chars(instruction) > MAX_INSTRUCTION_CHARS {
        return Err(format!("声音要求不能超过 {MAX_INSTRUCTION_CHARS} 个字符"));
    }

    Ok(ValidatedVoiceCloneRequest {
        reference_audio_base64: reference_audio_base64.to_string(),
        mime_type,
        text: text.to_string(),
        instruction: if instruction.is_empty() {
            "保持参考声音的自然语气和正常语速。".to_string()
        } else {
            instruction.to_string()
        },
    })
}

fn upstream_error_message(status: StatusCode, value: Option<&Value>) -> String {
    let message = value
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|message| {
            !message.is_empty()
                && message.len() <= 500
                && !message.contains("data:audio")
                && !message.contains("base64")
        });

    match message {
        Some(message) => format!("声音克隆失败 (HTTP {}): {message}", status.as_u16()),
        None => format!("声音克隆失败 (HTTP {})", status.as_u16()),
    }
}

fn extract_voice_clone_segment(value: &Value, text: &str) -> Result<VoiceCloneSegment, String> {
    let raw_audio = value
        .pointer("/choices/0/message/audio/data")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|audio| !audio.is_empty())
        .ok_or_else(|| "声音克隆响应缺少音频数据".to_string())?;
    let audio_base64 = raw_audio
        .split_once(',')
        .filter(|(prefix, _)| prefix.starts_with("data:audio/"))
        .map(|(_, data)| data)
        .unwrap_or(raw_audio);
    let decoded = BASE64_STANDARD
        .decode(audio_base64)
        .map_err(|_| "声音克隆响应包含无效音频".to_string())?;
    if decoded.is_empty() {
        return Err("声音克隆返回了空音频".to_string());
    }
    if decoded.len() > MAX_OUTPUT_AUDIO_BYTES {
        return Err("声音克隆返回的音频超过客户端大小限制".to_string());
    }

    Ok(VoiceCloneSegment {
        audio_base64: audio_base64.to_string(),
        mime_type: "audio/wav".to_string(),
        text: text.to_string(),
        final_text_preview: value
            .pointer("/choices/0/message/final_text_preview")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string),
    })
}

fn split_voice_clone_text(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_SEGMENT_TEXT_CHARS {
        return vec![text.trim().to_string()];
    }

    let mut segments = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let hard_end = (start + MAX_SEGMENT_TEXT_CHARS).min(chars.len());
        let mut end = hard_end;
        if hard_end < chars.len() {
            let preferred_start = start + MAX_SEGMENT_TEXT_CHARS / 2;
            if let Some(boundary) = (preferred_start..hard_end)
                .rev()
                .find(|index| matches!(chars[*index], '。' | '！' | '？' | '.' | '!' | '?' | '\n'))
            {
                end = boundary + 1;
            }
        }
        let segment: String = chars[start..end].iter().collect();
        let segment = segment.trim();
        if !segment.is_empty() {
            segments.push(segment.to_string());
        }
        start = end;
    }
    segments
}

async fn generate_voice_clone_segment(
    client: &reqwest::Client,
    api_token: &str,
    request: &ValidatedVoiceCloneRequest,
    text: &str,
) -> Result<VoiceCloneSegment, String> {
    let body = json!({
        "model": VOICE_CLONE_MODEL,
        "messages": [
            { "role": "user", "content": request.instruction.as_str() },
            { "role": "assistant", "content": text }
        ],
        "audio": {
            "format": "wav",
            "voice": format!(
                "data:{};base64,{}",
                request.mime_type, request.reference_audio_base64.as_str()
            )
        },
        "stream": false
    });

    let response = client
        .post(VOICE_CLONE_ENDPOINT)
        .header("Accept", "application/json")
        .header("User-Agent", "yuanheng-desktop/voice-clone")
        .bearer_auth(api_token)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("连接声音克隆服务失败: {error}"))?;
    let status = response.status();
    let response_body = read_limited_response(response).await?;
    let value: Value = serde_json::from_slice(&response_body).map_err(|_| {
        if status.is_success() {
            "声音克隆服务返回了无法识别的响应".to_string()
        } else {
            format!("声音克隆失败 (HTTP {})", status.as_u16())
        }
    })?;
    if !status.is_success() {
        return Err(upstream_error_message(status, Some(&value)));
    }
    extract_voice_clone_segment(&value, text)
}

async fn read_limited_response(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("声音克隆响应超过客户端大小限制".to_string());
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取声音克隆响应失败: {error}"))?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("声音克隆响应超过客户端大小限制".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[tauri::command]
pub async fn generate_yuanheng_voice_clone(
    state: State<'_, AppState>,
    request: VoiceCloneRequest,
) -> Result<VoiceCloneResult, String> {
    let request = validate_voice_clone_request(request)?;
    let api_token = super::yuanheng::get_yuanheng_secret(&state, API_TOKEN_SETTING_KEY)?
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| "请先在连接诊断中选择支持声音模型的分组，配置通用凭据".to_string())?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| format!("创建声音克隆客户端失败: {error}"))?;
    let text_segments = split_voice_clone_text(&request.text);
    let mut segments = Vec::with_capacity(text_segments.len());
    let mut total_audio_bytes = 0usize;
    for (index, segment_text) in text_segments.iter().enumerate() {
        let segment = generate_voice_clone_segment(&client, &api_token, &request, segment_text)
            .await
            .map_err(|error| {
                if text_segments.len() > 1 {
                    format!("第 {} 段生成失败: {error}", index + 1)
                } else {
                    error
                }
            })?;
        total_audio_bytes = total_audio_bytes.saturating_add(
            BASE64_STANDARD
                .decode(&segment.audio_base64)
                .map(|bytes| bytes.len())
                .unwrap_or(MAX_OUTPUT_AUDIO_BYTES),
        );
        if total_audio_bytes > MAX_RESPONSE_BYTES {
            return Err("声音克隆分段结果总大小超过客户端限制".to_string());
        }
        segments.push(segment);
    }
    let first = segments
        .first()
        .cloned()
        .ok_or_else(|| "声音克隆未返回任何分段结果".to_string())?;
    Ok(VoiceCloneResult {
        audio_base64: first.audio_base64,
        mime_type: first.mime_type,
        final_text_preview: first.final_text_preview,
        segments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_request() -> VoiceCloneRequest {
        VoiceCloneRequest {
            reference_audio_base64: BASE64_STANDARD.encode(b"RIFF-test-audio"),
            mime_type: "audio/wav".to_string(),
            text: "你好，这是声音克隆测试。".to_string(),
            instruction: "自然清晰地朗读。".to_string(),
            consent_confirmed: true,
        }
    }

    #[test]
    fn validates_supported_reference_audio() {
        let request = validate_voice_clone_request(valid_request()).unwrap();
        assert_eq!(request.mime_type, "audio/wav");
        assert_eq!(request.text, "你好，这是声音克隆测试。");
    }

    #[test]
    fn rejects_missing_consent_and_data_uri_input() {
        let mut request = valid_request();
        request.consent_confirmed = false;
        assert!(validate_voice_clone_request(request)
            .unwrap_err()
            .contains("授权"));

        let mut request = valid_request();
        request.reference_audio_base64 = "data:audio/wav;base64,UklGRg==".to_string();
        assert!(validate_voice_clone_request(request)
            .unwrap_err()
            .contains("格式无效"));
    }

    #[test]
    fn extracts_audio_without_returning_data_uri_prefix() {
        let encoded = BASE64_STANDARD.encode(b"wave-output");
        let value = json!({
            "choices": [{
                "message": {
                    "audio": { "data": format!("data:audio/wav;base64,{encoded}") },
                    "final_text_preview": "实际朗读文本"
                }
            }]
        });
        let result = extract_voice_clone_segment(&value, "测试文本").unwrap();
        assert_eq!(result.audio_base64, encoded);
        assert_eq!(result.text, "测试文本");
        assert_eq!(result.final_text_preview.as_deref(), Some("实际朗读文本"));
    }

    #[test]
    fn upstream_errors_do_not_echo_audio_payloads() {
        let value = json!({ "error": { "message": "invalid data:audio/wav;base64,AAAA" } });
        let message = upstream_error_message(StatusCode::BAD_REQUEST, Some(&value));
        assert_eq!(message, "声音克隆失败 (HTTP 400)");
    }

    #[test]
    fn long_text_is_split_on_sentence_boundaries() {
        let text = format!("{}。{}。", "甲".repeat(4_400), "乙".repeat(4_400));
        let segments = split_voice_clone_text(&text);
        assert_eq!(segments.len(), 2);
        assert!(segments
            .iter()
            .all(|segment| segment.chars().count() <= 4_500));
        assert!(segments[0].ends_with('。'));
    }
}
