use super::*;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
fn audio_mime(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        Ok("audio/wav")
    } else if bytes.starts_with(b"ID3")
        || (bytes.len() > 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
    {
        Ok("audio/mpeg")
    } else if bytes.starts_with(b"OggS") {
        Ok("audio/ogg")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        Ok("audio/mp4")
    } else if bytes.starts_with(b"\x1aE\xdf\xa3") {
        Ok("audio/webm")
    } else if bytes.starts_with(b"fLaC") {
        Ok("audio/flac")
    } else {
        Err("仅支持 MP3、WAV、M4A、OGG、WebM 或 FLAC 音频".into())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TtsRequest {
    text: String,
    instruction: Option<String>,
    audio: String,
    consent_confirmed: bool,
    group: String,
}

fn validate(input: &TtsRequest) -> Result<&'static str, String> {
    if !input.consent_confirmed {
        return Err("请确认你拥有参考声音的使用授权".into());
    }
    if input.text.trim().is_empty()
        || input.group.len() > 160
        || input.group.chars().any(char::is_control)
        || input.text.chars().count() > 8000
        || input.instruction.as_deref().unwrap_or("").chars().count() > 2000
    {
        return Err("合成文本或语气指令超出限制".into());
    }
    if input.audio.len() > 14 * 1024 * 1024 {
        return Err("声音样本不能超过10MB".into());
    }
    let bytes = STANDARD
        .decode(&input.audio)
        .map_err(|_| "声音样本格式无效")?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("声音样本不能超过10MB".into());
    }
    audio_mime(&bytes)
}

// 声音克隆走 MiMo TTS 的语音克隆模型：参考音频放在 audio.voice 的 data URL 中。
#[tauri::command]
pub(crate) async fn mobile_tts(
    state: State<'_, MobileState>,
    id: String,
    input: TtsRequest,
    expected_user_id: Option<i64>,
) -> Result<Value, String> {
    let mime = validate(&input)?;
    let text = input.text.trim();
    let (session, epoch) = state.snapshot()?;
    MobileState::require_user(&session, expected_user_id)?;
    let cancel = state.begin_ai(&id, epoch)?;
    let work = async {
        state.check(epoch)?;
        let mut messages = Vec::new();
        if let Some(instruction) = input
            .instruction
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            messages.push(json!({"role": "user", "content": instruction}));
        }
        messages.push(json!({"role": "assistant", "content": text}));
        let body = json!({
            "model": "mimo-v2.5-tts-voiceclone",
            "group":input.group,
            "stream":false,
            "messages": messages,
            "audio": {"format": "mp3", "voice": format!("data:{mime};base64,{}", input.audio)},
        });
        let response = state
            .request(Method::POST, "/pg/chat/completions", &session)
            .json(&body)
            .timeout(Duration::from_secs(300))
            .send()
            .await
            .map_err(|_| "语音合成连接中断，请稍后重试")?;
        let value = bounded_json(response, 40 * 1024 * 1024).await?;
        state.check(epoch)?;
        let data = value
            .pointer("/choices/0/message/audio/data")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                transport::message(&value, "未收到语音数据；请先核对用量再决定是否重试")
            })?;
        let decoded = STANDARD.decode(data).map_err(|_| "返回的语音数据无效")?;
        if decoded.len() > 20 * 1024 * 1024 {
            return Err("语音文件过大".into());
        }
        let mime = audio_mime(&decoded)?;
        Ok(json!({"data": data, "mime": mime}))
    };
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("已停止等待；服务端可能仍在生成，请先核对用量".into()),
        result = work => result,
    };
    if let Ok(mut tasks) = state.tasks.lock() {
        tasks.remove(&id);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn voice_rejects_missing_consent_invalid_samples_and_oversized_instruction() {
        let mut v = TtsRequest {
            text: "hello".into(),
            instruction: None,
            audio: STANDARD.encode(b"RIFF0000WAVEtest"),
            consent_confirmed: true,
            group: String::new(),
        };
        assert_eq!(validate(&v).unwrap(), "audio/wav");
        v.consent_confirmed = false;
        assert!(validate(&v).is_err());
        v.consent_confirmed = true;
        v.instruction = Some("x".repeat(2001));
        assert!(validate(&v).is_err());
        v.instruction = None;
        v.audio = STANDARD.encode(b"not audio");
        assert!(validate(&v).is_err());
        v.audio = "x".repeat(14 * 1024 * 1024 + 1);
        assert!(validate(&v).is_err());
    }
}
