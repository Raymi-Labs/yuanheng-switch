//! Independent, account-bound creation. Never replay a paid request.
use super::*;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures::StreamExt;
use sha2::{Digest, Sha256};
use std::{io::Write, path::PathBuf, sync::Mutex, time::Duration};
use tauri_plugin_dialog::DialogExt;

const LEGACY_GROUP: &str = "生图和视频";
const MAX_MEDIA: usize = 64 * 1024 * 1024;
const MAX_REFERENCE: usize = 10 * 1024 * 1024;
const MAX_GPT_REFERENCE: usize = 50 * 1024 * 1024;
const MAX_GPT_REFERENCES: usize = 16;
const MAX_VIDEO: u64 = 256 * 1024 * 1024;
const VIDEO_SUBMIT_TIMEOUT: Duration = Duration::from_secs(600);
const MUSE_SUBMIT_TIMEOUT: Duration = Duration::from_secs(1800);
const IMAGE_SUBMIT_TIMEOUT: Duration = Duration::from_secs(300);
static SUBMIT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static MEDIA_IO: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static RECORDS: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaModel {
    id: String,
    kind: String,
    reference: String,
    sizes: Vec<String>,
    durations: Vec<u32>,
    qualities: Vec<String>,
    resolutions: Vec<String>,
    output_formats: Vec<String>,
    backgrounds: Vec<String>,
    custom_size: bool,
}

fn video_family(id: &str) -> bool {
    id.split(['-', '_'])
        .any(|part| matches!(part, "video" | "seedance"))
        || [
            "sora-",
            "kling-",
            "vidu",
            "MiniMax-Hailuo-",
            "MiniMax-H3",
            "wan2.",
        ]
        .iter()
        .any(|prefix| id.starts_with(prefix))
}
fn valid_media_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
fn profile(id: &str) -> Option<MediaModel> {
    if !valid_media_model_id(id) || id == "flow-video-veo-3.1-lite" {
        return None;
    }

    let (kind, reference, sizes, durations): (&str, &str, &[&str], Vec<u32>) = match id {
        "gpt-image-1"
        | "gpt-image-1.5"
        | "gpt-image-2"
        | "gpt-image-2.5-sunburst"
        | "gpt-image-2.5-flare" => (
            "image",
            "optional",
            &["1024x1024", "1536x1024", "1024x1536"],
            vec![],
        ),
        "grok-imagine-image" | "grok-imagine-image-pro" => ("image", "none", &["auto"], vec![]),
        "gemini-3.1-flash-image-preview"
        | "gemini-2.5-flash-image"
        | "gemini-3-pro-image-preview" => ("image", "optional", &["1:1", "16:9", "9:16"], vec![]),
        "grok-imagine-video" | "grok-imagine-video-1.5" => (
            "video",
            "none",
            &["16:9", "9:16", "1:1"],
            (1..=15).collect(),
        ),
        "muse-video" => (
            "video",
            "optional",
            &["1280x720", "720x1280"],
            (4..=180).collect(),
        ),
        "snow-grok-imagine-video" | "flow-video-gemini-omni-flash-1.1" => {
            ("video", "none", &["1280x720", "720x1280"], vec![4])
        }
        "flow-video-gemini-omni-flash-1.1-1080p" => {
            ("video", "none", &["1920x1080", "1080x1920"], vec![4])
        }
        // Veo is intentionally excluded from this client at the user's request.
        // Omni720p was explicitly re-enabled after the user's confirmation.
        _ if video_family(id) => ("video", "optional", &["16:9", "9:16", "1:1"], vec![4]),
        _ if id.starts_with("gpt-image-") => (
            "image",
            "optional",
            &["1024x1024", "1536x1024", "1024x1536"],
            vec![],
        ),
        _ if id.starts_with("gemini-") && id.split('-').any(|p| p == "image") => {
            ("image", "optional", &["1:1", "16:9", "9:16"], vec![])
        }
        _ => return None,
    };
    let gpt = id.starts_with("gpt-image-");
    let custom_size = id.starts_with("gpt-image-2.5-");
    let values = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let mut sizes = values(sizes);
    if custom_size {
        sizes.extend(values(&[
            "1536x864",
            "864x1536",
            "2560x1440",
            "1440x2560",
            "3840x2160",
            "2160x3840",
        ]));
    }
    if gpt {
        sizes.push("auto".into());
    }
    if kind == "image" && id.starts_with("gemini-") {
        sizes = values(&[
            "1:1", "16:9", "9:16", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "21:9",
        ]);
        if id == "gemini-3.1-flash-image-preview" {
            sizes.extend(values(&["1:4", "4:1", "1:8", "8:1"]));
        }
    }
    if id.starts_with("grok-imagine-video") {
        sizes.extend(values(&["4:3", "3:4", "3:2", "2:3", "21:9", "5:2"]));
    }
    let resolutions = match id {
        "gemini-3.1-flash-image-preview" => values(&["1K", "512", "2K", "4K"]),
        "gemini-3-pro-image-preview" => values(&["1K", "2K", "4K"]),
        "gemini-2.5-flash-image" => values(&["1K"]),
        "grok-imagine-video" => values(&["480p", "720p"]),
        "grok-imagine-video-1.5" => values(&["480p", "720p", "1080p"]),
        "flow-video-gemini-omni-flash-1.1-1080p" => values(&["1080p", "720p", "480p"]),
        _ if kind == "video" => values(&["720p", "1080p", "480p"]),
        _ => vec![],
    };
    Some(MediaModel {
        id: id.into(),
        kind: kind.into(),
        reference: if kind == "video" {
            "optional".into()
        } else {
            reference.into()
        },
        sizes,
        durations,
        qualities: if custom_size {
            values(&["auto", "low", "medium", "high", "xhigh", "max"])
        } else if gpt {
            values(&["auto", "low", "medium", "high"])
        } else {
            vec![]
        },
        resolutions,
        output_formats: if gpt {
            values(&["png", "jpeg", "webp"])
        } else {
            vec![]
        },
        backgrounds: if gpt {
            values(&["auto", "opaque", "transparent"])
        } else {
            vec![]
        },
        custom_size: custom_size || kind == "video",
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaRequest {
    operation_id: String,
    #[serde(default)]
    quality: Option<String>,
    #[serde(default)]
    resolution: Option<String>,
    #[serde(default)]
    output_format: Option<String>,
    #[serde(default)]
    background: Option<String>,
    #[serde(default)]
    output_compression: Option<u8>,
    #[serde(default)]
    save_prompt: bool,
    group: String,
    model: String,
    prompt: String,
    size: String,
    duration: Option<u32>,
    reference: Option<String>,
    #[serde(default)]
    images: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRecord {
    id: String,
    #[serde(default = "legacy_group")]
    group: String,
    model: String,
    kind: String,
    status: String,
    created_at: i64,
    task_id: Option<String>,
    message: String,
    has_media: bool,
    #[serde(default)]
    token_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    draft: Option<MediaDraft>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDraft {
    size: String,
    duration: Option<u32>,
    #[serde(default)]
    quality: Option<String>,
    #[serde(default)]
    resolution: Option<String>,
    #[serde(default)]
    output_format: Option<String>,
    #[serde(default)]
    background: Option<String>,
    #[serde(default)]
    output_compression: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
    #[serde(default)]
    needs_reference: bool,
    #[serde(default)]
    prompt_saved: bool,
}
fn draft_snapshot(r: &MediaRequest) -> MediaDraft {
    MediaDraft {
        size: r.size.clone(),
        duration: r.duration,
        quality: r.quality.clone(),
        resolution: r.resolution.clone(),
        output_format: r.output_format.clone(),
        background: r.background.clone(),
        output_compression: r.output_compression,
        prompt: if r.save_prompt {
            Some(r.prompt.trim().into())
        } else {
            None
        },
        needs_reference: r.reference.is_some() || !r.images.is_empty(),
        prompt_saved: r.save_prompt,
    }
}
fn valid_custom_size(size: &str) -> bool {
    let Some((w, h)) = size.split_once('x') else {
        return false;
    };
    let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) else {
        return false;
    };
    w > 0
        && h > 0
        && w <= 3840
        && h <= 3840
        && w % 16 == 0
        && h % 16 == 0
        && w <= h * 3
        && h <= w * 3
        && (655_360..=8_294_400).contains(&(w * h))
}
fn validate_options(r: &MediaRequest, p: &MediaModel) -> Result<(), String> {
    if p.kind == "video" && r.resolution.as_ref().is_some_and(|v| !valid_resolution(v)) {
        return Err("该模型不支持所选生成参数".into());
    }
    for (value, allowed) in [
        (&r.quality, &p.qualities),
        (
            if p.kind == "video" {
                &None
            } else {
                &r.resolution
            },
            &p.resolutions,
        ),
        (&r.output_format, &p.output_formats),
        (&r.background, &p.backgrounds),
    ] {
        if value.as_ref().is_some_and(|v| !allowed.contains(v)) {
            return Err("该模型不支持所选生成参数".into());
        }
    }
    if r.background.as_deref() == Some("transparent") && r.output_format.as_deref() == Some("jpeg")
    {
        return Err("透明背景请使用PNG或WebP".into());
    }
    if r.output_compression.is_some_and(|n| n > 100)
        || (r.output_compression.is_some()
            && !matches!(r.output_format.as_deref(), Some("jpeg" | "webp")))
    {
        return Err("压缩质量仅支持JPEG/WebP的0至100整数".into());
    }
    Ok(())
}

struct Login {
    owner: String,
    user: String,
    cookie: String,
}
fn login(state: &AppState) -> Result<Login, String> {
    let status = read_cached_status(state)?;
    let user = get_yuanheng_secret(state, USER_ID_KEY)?.ok_or("请先登录元衡")?;
    let cookie = get_yuanheng_secret(state, SESSION_COOKIE_KEY)?.ok_or("请重新登录元衡")?;
    if !status.connected || status.user_id.as_deref() != Some(&user) {
        return Err("请先登录元衡".into());
    }
    let owner = format!(
        "{:x}",
        Sha256::digest(format!("{BASE_URL}\0{user}").as_bytes())
    );
    Ok(Login {
        owner,
        user,
        cookie,
    })
}
fn same_login(state: &AppState, expected: &Login) -> Result<(), String> {
    let current = login(state)?;
    if current.owner != expected.owner || current.cookie != expected.cookie {
        return Err("账号已变化，请重新打开图片与视频".into());
    }
    Ok(())
}
fn records_key(owner: &str) -> String {
    format!("media_studio_v1_{owner}")
}
fn records(state: &AppState, owner: &str) -> Result<Vec<MediaRecord>, String> {
    let mut rows: Vec<MediaRecord> = state
        .db
        .get_setting(&records_key(owner))
        .map_err(|_| "无法读取创作记录")?
        .map(|s| serde_json::from_str(&s).map_err(|_| "创作记录损坏，请勿重复提交".to_string()))
        .unwrap_or(Ok(vec![]))?;
    for row in &mut rows {
        if let Some(draft) = row.draft.as_mut() {
            draft.prompt = None;
            if draft.prompt_saved {
                draft.prompt = read_local_prompt(owner, &row.id).ok();
            }
        }
    }
    Ok(rows)
}
fn records_json(rows: &[MediaRecord]) -> Result<String, String> {
    let mut rows = rows.to_vec();
    for row in &mut rows {
        if let Some(draft) = row.draft.as_mut() {
            draft.prompt = None;
        }
    }
    serde_json::to_string(&rows).map_err(|_| "无法编码记录".into())
}
fn local_prompt_path(owner: &str, id: &str) -> Result<PathBuf, String> {
    Ok(media_path(owner, id)?.with_extension("prompt"))
}
fn save_local_prompt(owner: &str, id: &str, prompt: &str) -> Result<(), String> {
    let path = local_prompt_path(owner, id)?;
    let mut file = private_media_temp(&path)?;
    file.write_all(prompt.as_bytes())
        .map_err(|_| "无法保存本机描述")?;
    file.as_file().sync_all().map_err(|_| "无法保存本机描述")?;
    file.persist_noclobber(&path)
        .map_err(|_| "本机描述已存在或保存失败")?;
    Ok(())
}
fn read_local_prompt(owner: &str, id: &str) -> Result<String, String> {
    let path = local_prompt_path(owner, id)?;
    check_media_directory(&path)?;
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| "本机描述不可用")?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err("本机描述无效".into());
    }
    std::fs::read_to_string(&path).map_err(|_| "本机描述不可用".into())
}
fn remove_local_prompt(owner: &str, id: &str) -> Result<(), String> {
    let path = local_prompt_path(owner, id)?;
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {
            check_media_directory(&path)?;
            std::fs::remove_file(&path).map_err(|_| "无法删除本机描述")?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("无法读取本机描述".into()),
    }
    Ok(())
}
fn persist(state: &AppState, owner: &str, record: &MediaRecord, new: bool) -> Result<(), String> {
    let _lock = RECORDS.lock().map_err(|_| "创作记录锁不可用")?;
    let mut rows = records(state, owner)?;
    let index = rows.iter().position(|r| r.id == record.id);
    if new && index.is_some() {
        return Err("此生成操作已提交，请查看原记录，不要重复发送".into());
    }
    if let Some(index) = index {
        let mut updated = record.clone();
        // Existing local consent/redaction is authoritative over stale async snapshots.
        if let Some(draft) = updated.draft.as_mut() {
            draft.prompt_saved = rows[index].draft.as_ref().is_some_and(|d| d.prompt_saved);
            draft.prompt = rows[index].draft.as_ref().and_then(|d| d.prompt.clone());
        }
        rows[index] = updated;
    } else {
        if !new {
            return Err("原创作记录已移除，不能重新写入".into());
        }
        if rows.len() >= 50 {
            return Err("已有 50 条创作记录，请先删除不需要的记录".into());
        }
        if let Some(prompt) = record
            .draft
            .as_ref()
            .filter(|d| d.prompt_saved)
            .and_then(|d| d.prompt.as_deref())
        {
            save_local_prompt(owner, &record.id, prompt)?;
        }
        rows.insert(0, record.clone());
    }
    let text = records_json(&rows)?;
    if state.db.set_setting(&records_key(owner), &text).is_err() {
        if new && record.draft.as_ref().is_some_and(|d| d.prompt_saved) {
            let _ = remove_local_prompt(owner, &record.id);
        }
        return Err("无法保存创作记录，请勿重复提交".into());
    }
    Ok(())
}
fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
}
fn task_path(id: &str) -> Result<String, String> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err("任务编号无效，请保留记录并联系支持".into());
    }
    Ok(format!("{BASE_URL}/v1/videos/{id}"))
}
fn media_path(owner: &str, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) || owner.len() != 64 || !owner.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("作品编号无效".into());
    }
    Ok(crate::config::get_app_config_dir()
        .join("media-studio")
        .join(owner)
        .join(format!("{id}.bin")))
}
fn check_media_directory(path: &std::path::Path) -> Result<(), String> {
    let directory = path.parent().ok_or("作品目录无效")?;
    for part in [directory, directory.parent().ok_or("作品目录无效")?] {
        let metadata = std::fs::symlink_metadata(part).map_err(|_| "作品目录不存在")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("作品目录不能为符号链接或普通文件".into());
        }
    }
    Ok(())
}
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
fn reference(raw: &str) -> Result<(&'static str, Vec<u8>), String> {
    reference_with_webp(raw, false)
}
fn reference_with_webp(raw: &str, allow_webp: bool) -> Result<(&'static str, Vec<u8>), String> {
    reference_with_limit(raw, allow_webp, MAX_REFERENCE)
}
fn request_reference(model: &str, raw: &str) -> Result<(&'static str, Vec<u8>), String> {
    if model.starts_with("gpt-image-") {
        reference_with_limit(raw, true, MAX_GPT_REFERENCE - 1)
    } else {
        reference_with_webp(raw, video_family(model))
    }
}
fn reference_with_limit(
    raw: &str,
    allow_webp: bool,
    max_bytes: usize,
) -> Result<(&'static str, Vec<u8>), String> {
    if raw.len() > max_bytes.div_ceil(3) * 4 + 128 {
        return Err("参考图超过当前模型的单图大小上限".into());
    }
    let (header, value) = raw.split_once(',').ok_or("参考图格式无效")?;
    let bytes = B64.decode(value).map_err(|_| "参考图编码无效")?;
    let mime = image_mime(&bytes)
        .filter(|m| allow_webp || *m != "image/webp")
        .ok_or(if allow_webp {
            "参考图仅支持 PNG、JPEG 或 WebP"
        } else {
            "参考图仅支持 PNG 或 JPEG"
        })?;
    if bytes.len() > max_bytes || header != format!("data:{mime};base64") {
        return Err("参考图类型或大小无效".into());
    }
    decode_reference(&bytes)?;
    Ok((mime, bytes))
}

fn decode_reference(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    if bytes.len() > MAX_MEDIA || image_mime(bytes).is_none() {
        return Err("参考图格式或大小无效".into());
    }
    let dimensions = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "无法识别参考图")?
        .into_dimensions()
        .map_err(|_| "参考图损坏，无法读取尺寸")?;
    if dimensions.0 == 0
        || dimensions.1 == 0
        || dimensions.0 > 8192
        || dimensions.1 > 8192
        || u64::from(dimensions.0) * u64::from(dimensions.1) > 16_777_216
    {
        return Err("参考图尺寸过大，请使用边长不超过8192像素、总像素不超过1677万的图片".into());
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "无法识别参考图")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "参考图损坏或尺寸过大，请使用边长不超过8192像素的有效图片".into())
}

fn video_reference(bytes: &[u8]) -> Result<MediaPreview, String> {
    let decoded = decode_reference(bytes)?;
    let resized = if decoded.width() > 1536 || decoded.height() > 1536 {
        decoded.thumbnail(1536, 1536)
    } else {
        decoded
    };
    let mut output = std::io::Cursor::new(Vec::new());
    resized
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| "参考图转换失败")?;
    let bytes = output.into_inner();
    if bytes.len() > MAX_REFERENCE {
        return Err("转换后的参考图超过10MB，请手动压缩图片".into());
    }
    Ok(MediaPreview {
        data: B64.encode(bytes),
        mime: "image/png".into(),
    })
}
fn valid_video_size(size: &str) -> bool {
    size.split_once('x')
        .or_else(|| size.split_once(':'))
        .is_some_and(|(w, h)| {
            [w, h].iter().all(|s| {
                !s.starts_with('0')
                    && s.bytes().all(|b| b.is_ascii_digit())
                    && s.parse::<u32>().is_ok_and(|v| v > 0)
            })
        })
}
fn valid_resolution(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn video_pixel_size(size: &str, resolution: Option<&str>) -> Option<String> {
    if size.contains('x') {
        return Some(size.into());
    }
    let (a, b) = size.split_once(':')?;
    let (a, b) = (a.parse::<u64>().ok()?, b.parse::<u64>().ok()?);
    let pixels = resolution?.strip_suffix('p')?.parse::<u32>().ok()? as u64;
    let short = a.min(b);
    if short == 0 || pixels == 0 || pixels * a % short != 0 || pixels * b % short != 0 {
        return None;
    }
    let (w, h) = (pixels * a / short, pixels * b / short);
    if w > u32::MAX as u64 || h > u32::MAX as u64 {
        return None;
    }
    Some(format!("{w}x{h}"))
}
fn compatible_task_id(value: &Value) -> Result<String, String> {
    let read = |name: &str| -> Result<Option<&str>, String> {
        match value.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(v)) if v.is_empty() => Ok(None),
            Some(Value::String(v)) => Ok(Some(v.as_str())),
            _ => Err("任务编号格式错误，提交结果未知；请勿重复生成".into()),
        }
    };
    let (id, alias) = (read("id")?, read("task_id")?);
    if id.is_some() && alias.is_some() && id != alias {
        return Err("任务编号冲突，提交结果未知；请勿重复生成".into());
    }
    let id = id
        .or(alias)
        .ok_or("未返回任务编号，提交结果未知；请勿重复生成")?;
    task_path(id)?;
    Ok(id.into())
}
fn validate(request: &MediaRequest) -> Result<MediaModel, String> {
    if !valid_id(&request.operation_id) {
        return Err("生成操作编号无效".into());
    }
    let p = profile(&request.model).ok_or("当前客户端尚未适配该模型")?;
    let prompt_limit = if request.model == "muse-video" {
        4000
    } else {
        8000
    };
    if request.prompt.trim().is_empty() || request.prompt.chars().count() > prompt_limit {
        return Err(format!("请填写 1–{prompt_limit} 字的画面描述"));
    }
    validate_options(request, &p)?;
    let size_valid = if p.kind == "video" {
        valid_video_size(&request.size)
    } else {
        p.sizes.contains(&request.size) || (p.custom_size && valid_custom_size(&request.size))
    };
    if !size_valid
        || (p.kind == "video" && request.duration.unwrap_or(0) == 0)
        || (p.kind == "image" && request.duration.is_some())
    {
        return Err("该模型不支持所选尺寸或时长".into());
    }
    if p.kind == "video" {
        if let (Some((w, h)), Some(pixels)) = (
            request.size.split_once('x'),
            request
                .resolution
                .as_deref()
                .and_then(|v| v.strip_suffix('p'))
                .and_then(|v| v.parse::<u32>().ok()),
        ) {
            if w.parse::<u32>().unwrap().min(h.parse::<u32>().unwrap()) != pixels {
                return Err("像素尺寸与分辨率冲突，请使用一致参数".into());
            }
        }
    }
    if !request.images.is_empty() {
        let max_count = if request.model.starts_with("gpt-image-") {
            MAX_GPT_REFERENCES
        } else if p.kind == "video" {
            // Local request resource protection, not a provider capability limit.
            16
        } else {
            return Err("当前模型不支持多图参考".into());
        };
        if request.reference.is_some() || request.images.len() > max_count {
            return Err(format!(
                "当前模型最多支持{max_count}张参考图，images不能与reference同时提交"
            ));
        }
        let mut total = 0;
        for raw in &request.images {
            total += request_reference(&request.model, raw)?.1.len();
            if p.kind == "video" && total > MAX_MEDIA {
                return Err("参考图总大小超过客户端资源限制".into());
            }
        }
    }
    if p.reference == "required" && request.reference.is_none() && request.images.is_empty() {
        return Err("此模型需要上传参考图".into());
    }
    if let Some(raw) = &request.reference {
        if p.reference == "none" {
            return Err("此模型当前不支持参考图".into());
        }
        request_reference(&request.model, raw)?;
    }
    Ok(p)
}
async fn body(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "元衡请求失败（HTTP {}），请查看用量记录；未自动重试",
            status.as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err("结果超过客户端大小限制，请保留任务编号".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "响应中断，结果可能已生成；请勿重复提交")?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("结果超过客户端大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn json_response(response: reqwest::Response, limit: usize) -> Result<Value, String> {
    serde_json::from_slice(&body(response, limit).await?)
        .map_err(|_| "响应格式异常，请勿重复提交".into())
}
fn legacy_group() -> String {
    LEGACY_GROUP.into()
}
fn group_setting_key(owner: &str) -> String {
    format!("media_studio_group_v1_{owner}")
}
fn validate_group(group: &str, groups: &[YuanhengGroupOption]) -> Result<(), String> {
    if group.trim().is_empty() || group.len() > 256 || !groups.iter().any(|g| g.id == group) {
        return Err("所选创作分组已不可用，请刷新分组后重新选择；不会自动换组".into());
    }
    Ok(())
}
fn selected_group(saved: Option<String>, groups: &[YuanhengGroupOption]) -> Option<String> {
    match saved {
        Some(group) => validate_group(&group, groups).ok().map(|_| group),
        None => validate_group(LEGACY_GROUP, groups)
            .ok()
            .map(|_| legacy_group()),
    }
}
async fn authorized_groups_at(
    state: &AppState,
    session: &Login,
    client: &reqwest::Client,
    origin: &str,
) -> Result<Vec<YuanhengGroupOption>, String> {
    let groups = device_credentials::groups_at(client, origin, &session.cookie, &session.user)
        .await
        .map_err(|_| "读取创作分组失败")?;
    same_login(state, session)?;
    Ok(groups)
}
async fn authorized_groups(
    state: &AppState,
    session: &Login,
) -> Result<Vec<YuanhengGroupOption>, String> {
    authorized_groups_at(state, session, &yuanheng_client()?, BASE_URL).await
}
fn save_group_preference(
    state: &AppState,
    session: &Login,
    group: &str,
    groups: &[YuanhengGroupOption],
) -> Result<(), String> {
    validate_group(group, groups)?;
    same_login(state, session)?;
    state
        .db
        .set_setting(&group_setting_key(&session.owner), group)
        .map_err(|_| "无法保存创作分组偏好".into())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaGroups {
    groups: Vec<YuanhengGroupOption>,
    selected_group: Option<String>,
    unverified_group_count: usize,
    models_by_group: HashMap<String, Vec<MediaModel>>,
    selected_groups: HashMap<String, Option<String>>,
}
async fn creation_groups_at(
    state: &AppState,
    session: &Login,
    client: &reqwest::Client,
    origin: &str,
) -> Result<
    (
        Vec<YuanhengGroupOption>,
        usize,
        HashMap<String, Vec<MediaModel>>,
    ),
    String,
> {
    let authorized = tokio::time::timeout(
        Duration::from_secs(15),
        authorized_groups_at(state, session, client, origin),
    )
    .await
    .map_err(|_| "读取创作分组超时，请刷新重试")??;
    let total = authorized.len();
    // Buffered futures are cancelled on drop; no detached catalog workers.
    let mut pending = futures::stream::iter(authorized.into_iter().map(|group| async move {
        let result = media_catalog_at(state, session, client, origin, &group.id).await;
        (group, result)
    }))
    .buffered(4);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut groups = Vec::new();
    let mut models_by_group = HashMap::new();
    let mut checked = 0;
    let mut failed = 0;
    loop {
        match tokio::time::timeout_at(deadline, pending.next()).await {
            Ok(Some((group, result))) => {
                checked += 1;
                match result {
                    Ok(models) if !models.is_empty() => {
                        models_by_group.insert(group.id.clone(), models);
                        groups.push(group);
                    }
                    Ok(_) => {}
                    Err(_) => failed += 1,
                }
            }
            Ok(None) => break,
            Err(_) => {
                failed += total - checked;
                break;
            }
        }
    }
    same_login(state, session)?;
    if total > 0 && failed == total {
        return Err("创作模型目录读取失败，请刷新重试".into());
    }
    Ok((groups, failed, models_by_group))
}
struct MediaCatalogCache {
    owner: String,
    session_hash: String,
    at: std::time::Instant,
    groups: Vec<YuanhengGroupOption>,
    models: HashMap<String, Vec<MediaModel>>,
}
static MEDIA_CATALOG: Mutex<Option<MediaCatalogCache>> = Mutex::new(None);
fn cached_selection(
    session: &Login,
    group: &str,
) -> Option<(Vec<YuanhengGroupOption>, Vec<MediaModel>)> {
    let cache = MEDIA_CATALOG.lock().ok()?;
    let cache = cache.as_ref()?;
    if cache.owner != session.owner
        || cache.session_hash != format!("{:x}", Sha256::digest(session.cookie.as_bytes()))
        || cache.at.elapsed() >= Duration::from_secs(60)
    {
        return None;
    }
    Some((cache.groups.clone(), cache.models.get(group)?.clone()))
}
#[tauri::command]
pub async fn get_media_studio_groups(state: State<'_, AppState>) -> Result<MediaGroups, String> {
    let session = login(&state)?;
    // An explicit refresh invalidates a previous authorization snapshot, including on error.
    *MEDIA_CATALOG.lock().map_err(|_| "模型目录缓存不可用")? = None;
    let (groups, unverified_group_count, models_by_group) =
        creation_groups_at(&state, &session, &yuanheng_client()?, BASE_URL).await?;
    let saved = state
        .db
        .get_setting(&group_setting_key(&session.owner))
        .map_err(|_| "无法读取创作分组偏好")?;
    let mut selected_groups = HashMap::new();
    for kind in ["image", "video"] {
        let preference = state
            .db
            .get_setting(&format!("{}_{}", group_setting_key(&session.owner), kind))
            .map_err(|_| "无法读取创作偏好")?;
        let value = preference.or_else(|| saved.clone());
        let eligible = groups
            .iter()
            .filter(|g| {
                models_by_group
                    .get(&g.id)
                    .is_some_and(|m| m.iter().any(|m| m.kind == kind))
            })
            .cloned()
            .collect::<Vec<_>>();
        selected_groups.insert(kind.into(), selected_group(value, &eligible));
    }
    same_login(&state, &session)?;
    *MEDIA_CATALOG.lock().map_err(|_| "模型目录缓存不可用")? = Some(MediaCatalogCache {
        owner: session.owner.clone(),
        session_hash: format!("{:x}", Sha256::digest(session.cookie.as_bytes())),
        at: std::time::Instant::now(),
        groups: groups.clone(),
        models: models_by_group.clone(),
    });
    Ok(MediaGroups {
        selected_group: selected_group(saved, &groups),
        groups,
        unverified_group_count,
        models_by_group,
        selected_groups,
    })
}
#[tauri::command]
pub async fn set_media_studio_group(
    state: State<'_, AppState>,
    group: String,
    kind: Option<String>,
) -> Result<String, String> {
    let session = login(&state)?;
    let (groups, models) = if let Some(cached) = cached_selection(&session, &group) {
        cached
    } else {
        let groups = authorized_groups(&state, &session).await?;
        validate_group(&group, &groups)?;
        let models =
            media_catalog_at(&state, &session, &yuanheng_client()?, BASE_URL, &group).await?;
        (groups, models)
    };
    validate_group(&group, &groups)?;
    if models.is_empty()
        || kind
            .as_ref()
            .is_some_and(|kind| !models.iter().any(|m| m.kind == *kind))
    {
        return Err("此分组没有当前创作类型可用的模型，请重新选择".into());
    }
    if let Some(kind) = kind {
        if !["image", "video"].contains(&kind.as_str()) {
            return Err("创作类型无效".into());
        }
        same_login(&state, &session)?;
        state
            .db
            .set_setting(
                &format!("{}_{}", group_setting_key(&session.owner), kind),
                &group,
            )
            .map_err(|_| "无法保存创作偏好")?;
    } else {
        save_group_preference(&state, &session, &group, &groups)?;
    }
    Ok(group)
}
async fn catalog(
    state: &AppState,
    session: &Login,
    group: &str,
) -> Result<Vec<MediaModel>, String> {
    catalog_at(state, session, &yuanheng_client()?, BASE_URL, group).await
}
async fn catalog_at(
    state: &AppState,
    session: &Login,
    client: &reqwest::Client,
    origin: &str,
    group: &str,
) -> Result<Vec<MediaModel>, String> {
    let groups = authorized_groups_at(state, session, client, origin).await?;
    validate_group(group, &groups)?;
    media_catalog_at(state, session, client, origin, group).await
}
async fn media_catalog_at(
    state: &AppState,
    session: &Login,
    client: &reqwest::Client,
    origin: &str,
    group: &str,
) -> Result<Vec<MediaModel>, String> {
    let response = with_session(
        client
            .get(format!("{origin}/api/user/models"))
            .query(&[("group", group)])
            .timeout(Duration::from_secs(10)),
        Some(&session.cookie),
        Some(&session.user),
    )
    .send()
    .await
    .map_err(|_| "无法读取创作模型目录")?;
    let models = parse_user_models(&json_response(response, 2 * 1024 * 1024).await?)
        .map_err(|_| "读取创作模型目录失败")?;
    same_login(state, session)?;
    Ok(models.iter().filter_map(|id| profile(id)).collect())
}

fn json_payload(request: &MediaRequest, p: &MediaModel) -> Value {
    if p.kind == "image" && request.model.starts_with("gemini-") {
        let mut parts = vec![json!({"text":request.prompt.trim()})];
        if let Some(raw) = &request.reference {
            // Validated before constructing a wire payload.
            let (mime, bytes) = reference(raw).expect("validated reference");
            parts.push(json!({"inlineData":{"mimeType":mime,"data":B64.encode(bytes)}}));
        }
        return json!({"contents":[{"role":"user","parts":parts}],"generationConfig":{"responseModalities":["IMAGE"],"candidateCount":1,"imageConfig":{"aspectRatio":request.size,"imageSize":request.resolution.as_deref().unwrap_or("1K")}}});
    }
    if p.kind == "image" {
        let mut v = json!({"model":request.model,"prompt":request.prompt.trim(),"n":1,"response_format":"b64_json"});
        if request.size != "auto" {
            v["size"] = json!(request.size);
        }
        for (name, value) in [
            ("quality", &request.quality),
            ("output_format", &request.output_format),
            ("background", &request.background),
        ] {
            if let Some(value) = value {
                v[name] = json!(value);
            }
        }
        if let Some(n) = request.output_compression {
            v["output_compression"] = json!(n);
        }
        return v;
    }
    let mut v = if request.model.starts_with("grok-imagine-video") {
        json!({"model":request.model,"prompt":request.prompt.trim(),"duration":request.duration,"resolution":request.resolution.as_deref().unwrap_or("480p"),"aspect_ratio":request.size})
    } else if request.model.split('-').any(|part| part == "seedance") {
        let ratio = request
            .size
            .split_once('x')
            .map(|(w, h)| {
                let (w, h) = (w.parse::<u32>().unwrap(), h.parse::<u32>().unwrap());
                let (mut a, mut b) = (w, h);
                while b != 0 {
                    (a, b) = (b, a % b);
                }
                format!("{}:{}", w / a, h / a)
            })
            .unwrap_or_else(|| request.size.clone());
        json!({"model":request.model,"prompt":request.prompt.trim(),"seconds":request.duration.unwrap_or(4).to_string(),"resolution":request.resolution.as_deref().unwrap_or("720p"),"metadata":{"ratio":ratio,"generate_audio":true,"watermark":false}})
    } else {
        let mut v = json!({"model":request.model,"prompt":request.prompt.trim(),"seconds":request.duration.unwrap_or(4).to_string()});
        if let Some(size) = video_pixel_size(&request.size, request.resolution.as_deref()) {
            v["size"] = json!(size);
        }
        if request.size.contains(':') {
            v["aspect_ratio"] = json!(request.size);
        }
        if let Some(value) = &request.resolution {
            v["resolution"] = json!(value);
        }
        v
    };
    let refs = request
        .reference
        .iter()
        .chain(request.images.iter())
        .collect::<Vec<_>>();
    if !refs.is_empty() {
        if request.model.split('-').any(|part| part == "seedance") || refs.len() > 1 {
            v["images"] = json!(refs);
        } else if request.model.starts_with("grok-imagine-video") {
            v["image"] = json!({"url":refs[0]});
        } else {
            v["input_reference"] = json!(refs[0]);
        }
    }
    v
}

fn submission_endpoint(request: &MediaRequest, p: &MediaModel) -> String {
    if p.kind == "video" {
        "/v1/videos".into()
    } else if request.model.starts_with("gemini-") {
        format!("/v1beta/models/{}:generateContent", request.model)
    } else if request.reference.is_some() || !request.images.is_empty() {
        "/v1/images/edits".into()
    } else {
        "/v1/images/generations".into()
    }
}

fn multipart(request: &MediaRequest) -> Result<(String, Vec<u8>), String> {
    let boundary = format!("yh{}", uuid::Uuid::new_v4().simple());
    let mut out = Vec::new();
    for (name, value) in [
        ("model", request.model.as_str()),
        ("prompt", request.prompt.trim()),
        ("size", request.size.as_str()),
        ("n", "1"),
        ("response_format", "b64_json"),
    ] {
        write!(
            out,
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        )
        .map_err(|_| "无法构建图片请求")?;
    }
    for (name, value) in [
        ("quality", request.quality.clone()),
        ("output_format", request.output_format.clone()),
        ("background", request.background.clone()),
        (
            "output_compression",
            request.output_compression.map(|n| n.to_string()),
        ),
    ] {
        if let Some(value) = value {
            write!(out,"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").map_err(|_| "无法构建图片请求")?;
        }
    }
    let references: Vec<&str> = request
        .reference
        .as_deref()
        .into_iter()
        .chain(request.images.iter().map(String::as_str))
        .collect();
    if references.is_empty()
        || references.len() > MAX_GPT_REFERENCES
        || (request.reference.is_some() && !request.images.is_empty())
    {
        return Err("图片编辑需要1至16张参考图，不能混用reference和images".into());
    }
    let multiple = references.len() > 1;
    for (index, raw) in references.into_iter().enumerate() {
        let (mime, bytes) = request_reference(&request.model, raw)?;
        let field = if multiple { "image[]" } else { "image" };
        let extension = media_extension(mime)?;
        let filename = if multiple {
            format!("reference-{}.{}", index + 1, extension)
        } else {
            format!("reference.{extension}")
        };
        write!(out, "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n").map_err(|_| "无法构建图片请求")?;
        out.extend_from_slice(&bytes);
        out.extend_from_slice(b"\r\n");
    }
    write!(out, "--{boundary}--\r\n").map_err(|_| "无法构建图片请求")?;
    Ok((format!("multipart/form-data; boundary={boundary}"), out))
}
fn image_result(value: &Value) -> Result<Vec<u8>, String> {
    let data = value
        .pointer("/data/0/b64_json")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .pointer("/candidates/0/content/parts")
                .and_then(Value::as_array)?
                .iter()
                .find_map(|p| p.pointer("/inlineData/data").and_then(Value::as_str))
        })
        .ok_or("未返回内嵌图片，结果可能已生成，请检查平台记录；未自动重试")?;
    let bytes = B64.decode(data).map_err(|_| "图片结果编码异常")?;
    if bytes.len() > MAX_MEDIA || image_mime(&bytes).is_none() {
        return Err("图片结果格式或大小不受支持".into());
    }
    Ok(bytes)
}

fn submission_timeout(profile: &MediaModel) -> Duration {
    if profile.id == "muse-video" {
        MUSE_SUBMIT_TIMEOUT
    } else if profile.kind == "video" {
        VIDEO_SUBMIT_TIMEOUT
    } else {
        IMAGE_SUBMIT_TIMEOUT
    }
}
fn submission_builder(
    client: &reqwest::Client,
    endpoint: &str,
    key: &str,
    profile: &MediaModel,
) -> reqwest::RequestBuilder {
    client
        .post(format!("{BASE_URL}{endpoint}"))
        .bearer_auth(key)
        .timeout(submission_timeout(profile))
}

fn trusted_image_url(raw: &str) -> Result<url::Url, String> {
    if raw.len() > 8192 || raw.trim() != raw || raw.chars().any(char::is_control) {
        return Err("图片下载地址无效".into());
    }
    let url = url::Url::parse(raw).map_err(|_| "图片下载地址无效")?;
    let host = url.host_str().ok_or("图片下载地址缺少域名")?;
    let trusted = [
        "meta-api.vip",
        "imgen.x.ai",
        "images.x.ai",
        "storage.googleapis.com",
    ]
    .contains(&host)
        || [".blob.core.windows.net", ".oaiusercontent.com"]
            .iter()
            .any(|suffix| host.ends_with(suffix) && host.len() > suffix.len());
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !trusted
    {
        return Err("图片下载来源暂不受支持，请保留原记录联系支持；未重新生成".into());
    }
    Ok(url)
}

fn public_image_address(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && (b == 0 || b == 168 || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        std::net::IpAddr::V6(ip) => {
            let segments = ip.segments();
            (segments[0] & 0xe000) == 0x2000
                && !(segments[0] == 0x2001 && (segments[1] < 0x200 || segments[1] == 0xdb8))
                && segments[0] != 0x2002
                && !(segments[0] == 0x3fff && segments[1] < 0x1000)
        }
    }
}

// Prefer inline data if present. A malformed inline result must not silently
// trigger a second download from an unrelated URL in the same response.
fn image_result_url(value: &Value) -> Result<Option<url::Url>, String> {
    let inline = value.pointer("/data/0/b64_json").is_some()
        || value
            .pointer("/candidates/0/content/parts")
            .and_then(Value::as_array)
            .is_some_and(|parts| parts.iter().any(|p| p.get("inlineData").is_some()));
    if inline {
        return Ok(None);
    }
    value
        .pointer("/data/0/url")
        .and_then(Value::as_str)
        .map(trusted_image_url)
        .transpose()
}

fn image_url_key(owner: &str, id: &str) -> Result<String, String> {
    media_path(owner, id)?;
    Ok(format!("media-studio-image-url-{owner}-{id}"))
}
fn save_image_url(owner: &str, id: &str, url: &url::Url) -> Result<(), String> {
    let key = image_url_key(owner, id)?;
    crate::secure_storage::set_secret(&key, url.as_str())
        .map_err(|_| "无法保存原图片下载地址，请检查系统凭据访问；请勿重新生成")?;
    if !crate::secure_storage::verify_secret(&key, url.as_str()).unwrap_or(false) {
        return Err("原图片下载地址未可靠保存，请勿重新生成".into());
    }
    Ok(())
}

async fn image_download_response(response: reqwest::Response) -> Result<Vec<u8>, String> {
    let bytes = body(response, MAX_MEDIA).await?;
    if image_mime(&bytes).is_none() {
        return Err("下载内容不是支持的图片；原记录已保留，未重新生成".into());
    }
    Ok(bytes)
}
fn image_download_builder(client: &reqwest::Client, url: url::Url) -> reqwest::RequestBuilder {
    client.get(url)
}

async fn download_image(raw: &str) -> Result<Vec<u8>, String> {
    let url = trusted_image_url(raw)?;
    let host = url.host_str().ok_or("图片下载地址无效")?;
    let addresses: Vec<_> =
        tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host, 443)))
            .await
            .map_err(|_| "图片域名解析超时，可稍后重试下载")?
            .map_err(|_| "图片域名解析失败，可稍后重试下载")?
            .collect();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !public_image_address(address.ip()))
    {
        return Err("图片下载目标不是公网地址，已阻止访问".into());
    }
    let client = crate::proxy::http_client::image_download_client(host, &addresses)
        .map_err(|_| "无法建立图片下载连接")?;
    // No platform auth, session cookie, or reference/prompt accompanies this GET.
    let response = image_download_builder(&client, url)
        .send()
        .await
        .map_err(|_| "图片下载失败，原记录已保留；可重试下载，不要重新生成")?;
    image_download_response(response).await
}
fn save_media(owner: &str, id: &str, bytes: &[u8]) -> Result<(), String> {
    let path = media_path(owner, id)?;
    let mut file = private_media_temp(&path)?;
    file.write_all(bytes)
        .map_err(|_| "磁盘写入失败，请保留任务记录")?;
    file.as_file().sync_all().map_err(|_| "磁盘同步失败")?;
    file.persist(&path).map_err(|_| "无法保存作品")?;
    Ok(())
}
fn private_media_temp(path: &std::path::Path) -> Result<tempfile::NamedTempFile, String> {
    let dir = path.parent().ok_or("作品目录无效")?;
    let root = dir.parent().ok_or("作品目录无效")?;
    if std::fs::symlink_metadata(root).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("作品目录不能为符号链接".into());
    }
    std::fs::create_dir_all(dir).map_err(|_| "无法创建作品目录")?;
    if std::fs::symlink_metadata(dir)
        .map_err(|_| "作品目录无效")?
        .file_type()
        .is_symlink()
    {
        return Err("作品目录不能为符号链接".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护作品目录")?;
    }
    tempfile::NamedTempFile::new_in(dir).map_err(|_| "无法保存作品".into())
}
async fn stream_video(
    response: reqwest::Response,
    path: &std::path::Path,
) -> Result<tempfile::NamedTempFile, String> {
    if !response.status().is_success() {
        return Err(format!(
            "视频下载失败（HTTP {}），可重试下载原任务",
            response.status().as_u16()
        ));
    }
    if response.content_length().is_some_and(|n| n > MAX_VIDEO) {
        return Err("视频超过256MB下载上限，请保留任务编号".into());
    }
    let mut file = private_media_temp(path)?;
    let mut stream = response.bytes_stream();
    let mut length = 0u64;
    let mut prefix = Vec::with_capacity(12);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "视频下载中断，临时文件已清理；可重新下载原任务")?;
        length = length.saturating_add(chunk.len() as u64);
        if length > MAX_VIDEO {
            return Err("视频超过256MB下载上限".into());
        }
        prefix.extend_from_slice(&chunk[..chunk.len().min(12 - prefix.len())]);
        if prefix.len() == 12 && &prefix[4..8] != b"ftyp" {
            return Err("未取得MP4成品，请保留任务编号".into());
        }
        file.write_all(&chunk).map_err(|_| "视频写入磁盘失败")?;
    }
    if prefix.len() < 12 {
        return Err("视频文件不完整".into());
    }
    file.as_file().sync_all().map_err(|_| "视频磁盘同步失败")?;
    Ok(file)
}

#[tauri::command]
pub async fn get_media_studio_models(
    state: State<'_, AppState>,
    group: String,
) -> Result<Vec<MediaModel>, String> {
    let session = login(&state)?;
    catalog(&state, &session, &group).await
}
#[tauri::command]
pub fn get_media_studio_history(state: State<'_, AppState>) -> Result<Vec<MediaRecord>, String> {
    let session = login(&state)?;
    let mut rows = records(&state, &session.owner)?;
    for row in &mut rows {
        if row.status == "submitting" {
            row.status = "unknown".into();
            row.message = "提交尚未确认，请先查用量记录，不要重复生成".into();
        }
    }
    Ok(rows)
}

#[tauri::command]
pub async fn submit_media_studio(
    state: State<'_, AppState>,
    request: MediaRequest,
) -> Result<MediaRecord, String> {
    let _lock = SUBMIT
        .try_lock()
        .map_err(|_| "已有生成正在提交，请等待结果")?;
    let p = validate(&request)?;
    let session = login(&state)?;
    let previous = records(&state, &session.owner)?;
    if previous.iter().any(|r| r.id == request.operation_id) {
        return Err("此生成操作已提交，请查看原记录，不要重复发送".into());
    }
    if previous.len() >= 50 {
        return Err("已有 50 条创作记录，请先删除不需要的记录".into());
    }
    if !catalog(&state, &session, &request.group)
        .await?
        .iter()
        .any(|m| m.id == request.model)
    {
        return Err("此模型不在当前分组授权目录中".into());
    }
    let account = yuanheng_client()?;
    let (key, token_id) = ensure_shared_api_token(
        &state,
        &account,
        &session.cookie,
        &session.user,
        &request.group,
    )
    .await
    .map_err(|_| "无法获取所选创作分组凭据，请重新登录或检查权限")?;
    same_login(&state, &session)?;
    let client = crate::proxy::http_client::image_client().map_err(|_| "无法创建生成连接")?;
    let response = client
        .get(format!("{BASE_URL}/v1/models"))
        .bearer_auth(&key)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "无法验证模型权限")?;
    let value = json_response(response, 2 * 1024 * 1024).await?;
    if !value
        .get("data")
        .and_then(Value::as_array)
        .is_some_and(|rows| {
            rows.iter()
                .any(|r| r.get("id").and_then(Value::as_str) == Some(&request.model))
        })
    {
        return Err("当前创作凭据无此模型权限".into());
    }
    same_login(&state, &session)?;
    let mut record = MediaRecord {
        draft: Some(draft_snapshot(&request)),
        group: request.group.clone(),
        id: request.operation_id.clone(),
        model: request.model.clone(),
        kind: p.kind.clone(),
        status: "submitting".into(),
        created_at: chrono::Utc::now().timestamp(),
        task_id: None,
        message: "正在提交，请勿重复生成".into(),
        has_media: false,
        token_id: Some(token_id),
    };
    persist(&state, &session.owner, &record, true)?;
    let endpoint = submission_endpoint(&request, &p);
    let mut builder = submission_builder(&client, &endpoint, &key, &p);
    if endpoint == "/v1/images/edits" {
        let (content_type, bytes) = multipart(&request)?;
        builder = builder.header("Content-Type", content_type).body(bytes);
    } else {
        builder = builder.json(&json_payload(&request, &p));
    }
    let result = async {
        same_login(&state, &session)?;
        let response = builder
            .send()
            .await
            .map_err(|_| "提交连接中断或超时，结果未知；请先查用量记录，未自动重试")?;
        let value = json_response(
            response,
            if p.kind == "image" {
                90 * 1024 * 1024
            } else {
                2 * 1024 * 1024
            },
        )
        .await?;
        if p.kind == "image" {
            same_login(&state, &session)?;
            if let Some(url) = image_result_url(&value)? {
                save_image_url(&session.owner, &record.id, &url)?;
                record.message = "图片已生成，点击预览或保存获取原图".into();
            } else {
                save_media(&session.owner, &record.id, &image_result(&value)?)?;
                record.has_media = true;
                record.message = "图片已生成并保存在本机".into();
            }
            record.status = "completed".into();
        } else {
            record.task_id = Some(compatible_task_id(&value)?);
            record.status = "queued".into();
            record.message = "任务已提交，查询原任务不会重新生成".into();
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = result {
        record.status = "unknown".into();
        record.message = error;
    }
    persist(&state, &session.owner, &record, false)?;
    same_login(&state, &session)?;
    find_record(&state, &session, &record.id)
}

fn find_record(state: &AppState, session: &Login, id: &str) -> Result<MediaRecord, String> {
    if !valid_id(id) {
        return Err("作品编号无效".into());
    }
    records(state, &session.owner)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or("当前账号无此作品记录".into())
}
async fn record_key(
    state: &AppState,
    session: &Login,
    record: &MediaRecord,
) -> Result<String, String> {
    record_key_at(state, session, record, &yuanheng_client()?, BASE_URL).await
}
async fn record_key_at(
    state: &AppState,
    session: &Login,
    record: &MediaRecord,
    client: &reqwest::Client,
    origin: &str,
) -> Result<String, String> {
    let id = record.token_id.ok_or("原任务凭据编号缺失")?;
    let response = with_session(
        client.get(format!("{origin}/api/token/{id}/key")),
        Some(&session.cookie),
        Some(&session.user),
    )
    .send()
    .await
    .map_err(|_| "无法读取原任务凭据")?;
    let value = json_response(response, 2 * 1024 * 1024).await?;
    let key = value
        .pointer("/data/key")
        .and_then(Value::as_str)
        .ok_or("原任务凭据不可用，请到平台查看任务")?;
    same_login(state, session)?;
    normalize_api_token(key)
}
#[tauri::command]
pub async fn refresh_media_studio(
    state: State<'_, AppState>,
    id: String,
) -> Result<MediaRecord, String> {
    let session = login(&state)?;
    let mut record = find_record(&state, &session, &id)?;
    let path = task_path(
        record
            .task_id
            .as_deref()
            .ok_or("没有可查询的任务编号，请先检查用量记录")?,
    )?;
    if record.status == "completed" || record.status == "failed" {
        return Ok(record);
    }
    let key = record_key(&state, &session, &record).await?;
    let client = crate::proxy::http_client::image_client().map_err(|_| "无法创建查询连接")?;
    let response = client
        .get(path)
        .bearer_auth(key)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "查询失败，任务仍保留，可稍后继续查询")?;
    let value = json_response(response, 2 * 1024 * 1024).await?;
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .ok_or("任务状态缺失")?;
    if !["queued", "in_progress", "completed", "failed"].contains(&status) {
        return Err("未知任务状态，请保留任务编号".into());
    }
    record.status = status.into();
    record.message = match status {
        "completed" => "视频已生成，点击预览或保存获取成品",
        "failed" => "任务失败，请到平台查看用量和任务记录；未重新提交",
        "queued" => "任务排队中",
        _ => "视频生成中",
    }
    .into();
    same_login(&state, &session)?;
    persist(&state, &session.owner, &record, false)?;
    find_record(&state, &session, &record.id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPreview {
    data: String,
    mime: String,
}
fn media_extension(mime: &str) -> Result<&'static str, String> {
    match mime {
        "video/mp4" => Ok("mp4"),
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        _ => Err("不支持的媒体格式".into()),
    }
}
fn validate_media_destination(path: &std::path::Path, extension: &str) -> Result<(), String> {
    let actual = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if actual == extension || (extension == "jpg" && actual == "jpeg") {
        return Ok(());
    }
    Err(format!(
        "请将保存文件名的扩展名设为 .{extension}，不要使用 .sql 或其他格式"
    ))
}
fn media_save_builder<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
    extension: &str,
) -> Result<tauri_plugin_dialog::FileDialogBuilder<R>, String> {
    let (label, extensions) = media_save_filter(extension)?;
    if name.is_empty() || name.contains(['/', '\\', '\0']) {
        return Err("保存文件名无效".into());
    }
    validate_media_destination(std::path::Path::new(name), extension)?;
    Ok(app
        .dialog()
        .file()
        .add_filter(label, extensions)
        .set_file_name(name))
}
fn media_save_filter(extension: &str) -> Result<(&'static str, &'static [&'static str]), String> {
    match extension {
        "mp4" => Ok(("MP4 视频", &["mp4"])),
        "png" => Ok(("PNG 图片", &["png"])),
        "jpg" => Ok(("JPEG 图片", &["jpg", "jpeg"])),
        "webp" => Ok(("WebP 图片", &["webp"])),
        _ => Err("不支持的媒体保存格式".into()),
    }
}
#[tauri::command]
pub async fn save_media_file_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    default_name: String,
    extension: String,
) -> Result<Option<String>, String> {
    let result = media_save_builder(&app, &default_name, &extension)?.blocking_save_file();
    result
        .map(|path| {
            let path = path.to_string();
            validate_media_destination(std::path::Path::new(&path), &extension)?;
            Ok(path)
        })
        .transpose()
}
async fn ensure_media_file(
    state: &AppState,
    session: &Login,
    id: &str,
) -> Result<(PathBuf, String), String> {
    let mut record = find_record(state, session, id)?;
    if record.status != "completed" {
        return Err("作品尚未完成".into());
    }
    let path = media_path(&session.owner, id)?;
    if !record.has_media && record.kind == "image" {
        let key = image_url_key(&session.owner, id)?;
        let url = crate::secure_storage::get_secret(&key)
            .map_err(|_| "无法读取原图片下载地址，请恢复系统凭据访问")?
            .ok_or("原图片下载地址不可用，请查看平台记录，不要重新生成")?;
        let bytes = download_image(&url).await?;
        same_login(state, session)?;
        save_media(&session.owner, id, &bytes)?;
        record.has_media = true;
        persist(state, &session.owner, &record, false)?;
    }
    if !record.has_media && record.kind == "video" {
        let key = record_key(state, session, &record).await?;
        let url = format!(
            "{}/content",
            task_path(record.task_id.as_deref().ok_or("任务编号缺失")?)?
        );
        let response = crate::proxy::http_client::image_client()
            .map_err(|_| "无法创建下载连接")?
            .get(url)
            .bearer_auth(key)
            .timeout(Duration::from_secs(900))
            .send()
            .await
            .map_err(|_| "视频下载失败，可稍后重试下载，不会重新生成")?;
        let file = stream_video(response, &path).await?;
        same_login(state, session)?;
        file.persist(&path).map_err(|_| "无法保存视频成品")?;
        record.has_media = true;
        persist(state, &session.owner, &record, false)?;
    }
    check_media_directory(&path)?;
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|_| "本机作品不存在，请保留任务记录")?;
    if !metadata.is_file()
        || metadata.len()
            > if record.kind == "video" {
                MAX_VIDEO
            } else {
                MAX_MEDIA as u64
            }
    {
        return Err("本机作品格式或大小异常".into());
    }
    let mut prefix = [0; 12];
    use std::io::Read;
    let mut file = std::fs::File::open(&path).map_err(|_| "无法读取作品")?;
    file.read_exact(&mut prefix).map_err(|_| "作品文件不完整")?;
    let mime = if record.kind == "image" {
        image_mime(&prefix).ok_or("图片格式异常")?
    } else {
        if &prefix[4..8] != b"ftyp" {
            return Err("视频格式异常".into());
        }
        "video/mp4"
    };
    same_login(state, session)?;
    Ok((path, mime.into()))
}
async fn load_media(
    state: &AppState,
    session: &Login,
    id: &str,
) -> Result<(Vec<u8>, String), String> {
    let (path, mime) = ensure_media_file(state, session, id).await?;
    if std::fs::metadata(&path).map_err(|_| "无法读取作品")?.len() > MAX_MEDIA as u64 {
        return Err("视频已下载到本机，超过64MB内嵌预览上限；请点击保存后用播放器打开".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "无法读取作品")?;
    Ok((bytes, mime))
}
#[tauri::command]
pub fn forget_media_studio_prompt(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let session = login(&state)?;
    forget_prompt(&state, &session, &id)
}
fn forget_prompt(state: &AppState, session: &Login, id: &str) -> Result<(), String> {
    let _lock = RECORDS.lock().map_err(|_| "创作记录锁不可用")?;
    let mut rows = records(state, &session.owner)?;
    let row = rows
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or("创作记录不存在")?;
    if pending_status(&row.status) {
        return Err("请等待任务结束再删除描述".into());
    }
    if let Some(draft) = row.draft.as_mut() {
        draft.prompt = None;
        draft.prompt_saved = false;
    }
    same_login(state, session)?;
    remove_local_prompt(&session.owner, id)?;
    state
        .db
        .set_setting(&records_key(&session.owner), &records_json(&rows)?)
        .map_err(|_| "无法更新记录".into())
}
fn pending_status(status: &str) -> bool {
    ["submitting", "queued", "in_progress"].contains(&status)
}
#[tauri::command]
pub async fn preview_media_studio(
    state: State<'_, AppState>,
    id: String,
) -> Result<MediaPreview, String> {
    let _io = MEDIA_IO
        .try_lock()
        .map_err(|_| "正在读取或保存作品，请稍后再试")?;
    let session = login(&state)?;
    let (bytes, mime) = load_media(&state, &session, &id).await?;
    Ok(MediaPreview {
        data: B64.encode(bytes),
        mime,
    })
}
#[tauri::command]
pub async fn prepare_media_video_reference(
    state: State<'_, AppState>,
    id: String,
) -> Result<MediaPreview, String> {
    let _io = MEDIA_IO
        .try_lock()
        .map_err(|_| "正在读取或保存作品，请稍后再试")?;
    let session = login(&state)?;
    let record = find_record(&state, &session, &id)?;
    if record.kind != "image" || record.status != "completed" {
        return Err("请选择已完成的图片作品".into());
    }
    let (bytes, _) = load_media(&state, &session, &id).await?;
    let prepared = tokio::task::spawn_blocking(move || video_reference(&bytes))
        .await
        .map_err(|_| "参考图转换未完成")??;
    same_login(&state, &session)?;
    Ok(prepared)
}
#[tauri::command]
pub async fn export_media_studio(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let _io = MEDIA_IO
        .try_lock()
        .map_err(|_| "正在读取或保存作品，请稍后再试")?;
    let session = login(&state)?;
    if path.trim().is_empty() {
        return Err("请选择保存位置".into());
    }
    let (source, mime) = ensure_media_file(&state, &session, &id).await?;
    let destination = PathBuf::from(path);
    validate_media_destination(&destination, media_extension(&mime)?)?;
    // Never truncate an existing destination while a copy can still fail.
    let parent = destination.parent().ok_or("保存目录无效")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建保存文件")?;
    let mut input = std::fs::File::open(&source).map_err(|_| "无法读取作品")?;
    std::io::copy(&mut input, &mut temporary).map_err(|_| "保存作品失败")?;
    temporary.as_file().sync_all().map_err(|_| "保存同步失败")?;
    same_login(&state, &session)?;
    temporary
        .persist(destination)
        .map_err(|_| "无法写入所选保存位置")?;
    Ok(())
}
#[tauri::command]
pub fn delete_media_studio(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let _io = MEDIA_IO
        .try_lock()
        .map_err(|_| "正在读取或保存作品，请稍后再删除")?;
    let _submit = SUBMIT
        .try_lock()
        .map_err(|_| "正在提交，请等待提交结束再删除")?;
    let session = login(&state)?;
    let _lock = RECORDS.lock().map_err(|_| "创作记录锁不可用")?;
    let record = find_record(&state, &session, &id)?;
    if ["queued", "in_progress"].contains(&record.status.as_str()) {
        return Err("任务未结束，请保留记录以便查询".into());
    }
    let path = media_path(&session.owner, &id)?;
    remove_local_prompt(&session.owner, &id)?;
    crate::secure_storage::delete_secret(&image_url_key(&session.owner, &id)?)
        .map_err(|_| "无法清理作品下载地址，请恢复系统凭据访问后重试")?;
    if path.exists() {
        check_media_directory(&path)?;
        std::fs::remove_file(path).map_err(|_| "无法删除本机作品")?;
    }
    let mut rows = records(&state, &session.owner)?;
    rows.retain(|r| r.id != id);
    state
        .db
        .set_setting(&records_key(&session.owner), &records_json(&rows)?)
        .map_err(|_| "无法更新创作记录".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use std::sync::Arc;
    #[test]
    fn generation_options_validate_each_model_without_cross_provider_leaks() {
        let mut r = request("gpt-image-2.5-sunburst");
        r.size = "3840x2160".into();
        r.quality = Some("max".into());
        r.output_format = Some("webp".into());
        r.background = Some("transparent".into());
        r.output_compression = Some(85);
        let p = validate(&r).unwrap();
        let payload = json_payload(&r, &p);
        assert_eq!(payload["quality"], "max");
        assert_eq!(payload["output_format"], "webp");
        assert_eq!(payload["output_compression"], 85);
        assert_eq!(payload["background"], "transparent");
        for bad in ["3841x2160", "3840x3840", "16x16", "2000x100", "4096x2048"] {
            r.size = bad.into();
            assert!(validate(&r).is_err());
        }
        r.size = "1536x864".into();
        assert!(validate(&r).is_ok());
        r.output_format = Some("jpeg".into());
        assert!(validate(&r).is_err());
        r.background = Some("opaque".into());
        r.output_compression = Some(101);
        assert!(validate(&r).is_err());
        let mut old = request("gpt-image-1");
        old.quality = Some("max".into());
        assert!(validate(&old).is_err());
        let mut g = request("gemini-3.1-flash-image-preview");
        g.size = "4:1".into();
        g.resolution = Some("4K".into());
        let p = validate(&g).unwrap();
        assert_eq!(
            json_payload(&g, &p)["generationConfig"]["imageConfig"]["imageSize"],
            "4K"
        );
        g.model = "gemini-2.5-flash-image".into();
        g.size = "16:9".into();
        assert!(validate(&g).is_err());
        let mut video = request("grok-imagine-video-1.5");
        video.resolution = Some("1080p".into());
        video.size = "21:9".into();
        let p = validate(&video).unwrap();
        assert_eq!(json_payload(&video, &p)["resolution"], "1080p");
        video.model = "grok-imagine-video".into();
        assert!(validate(&video).is_ok());
        video.resolution = Some("720p".into());
        video.quality = Some("high".into());
        assert!(validate(&video).is_err());
    }
    #[test]
    fn editing_multipart_carries_options_and_never_privacy_flag() {
        let mut r = request("gpt-image-2.5-flare");
        r.reference = Some(png());
        r.quality = Some("xhigh".into());
        r.output_format = Some("webp".into());
        r.output_compression = Some(90);
        r.save_prompt = true;
        validate(&r).unwrap();
        let (_, bytes) = multipart(&r).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("name=\"quality\"\r\n\r\nxhigh"));
        assert!(text.contains("name=\"output_compression\"\r\n\r\n90"));
        assert!(!text.contains("savePrompt"));
    }
    #[test]
    fn history_snapshot_only_retains_opted_in_prompt_and_never_reference_bytes() {
        let mut r = request("gpt-image-2.5-sunburst");
        r.prompt = "private synthetic prompt".into();
        r.reference = Some(png());
        let draft = draft_snapshot(&r);
        assert!(draft.prompt.is_none());
        assert!(draft.needs_reference);
        let raw = serde_json::to_string(&draft).unwrap();
        assert!(!raw.contains("private synthetic"));
        assert!(!raw.contains("base64"));
        r.save_prompt = true;
        let mut draft = draft_snapshot(&r);
        assert_eq!(draft.prompt.as_deref(), Some("private synthetic prompt"));
        draft.prompt = None;
        assert!(!serde_json::to_string(&draft)
            .unwrap()
            .contains("private synthetic"));
        let legacy:MediaRecord=serde_json::from_value(json!({"id":"legacy","model":"muse-video","kind":"video","status":"completed","createdAt":1,"taskId":null,"message":"done","hasMedia":false})).unwrap();
        assert!(legacy.draft.is_none());
    }
    #[test]
    #[serial_test::serial]
    fn prompt_stays_out_of_database_sync_and_redaction_survives_stale_updates() {
        let (_home, state) = super::super::tests::isolated_state();
        let status = YuanhengConnectionStatus {
            connected: true,
            user_id: Some("test-user".into()),
            ..Default::default()
        };
        persist_connection_for_group(
            &state,
            "session=test",
            "test-user",
            "",
            0,
            &status,
            "chat-group",
        )
        .unwrap();
        let session = login(&state).unwrap();
        let mut r = request("gpt-image-2.5-sunburst");
        r.prompt = "local-secret-description".into();
        r.save_prompt = true;
        let mut record = MediaRecord {
            id: r.operation_id.clone(),
            group: r.group.clone(),
            model: r.model.clone(),
            kind: "image".into(),
            status: "completed".into(),
            created_at: 1,
            task_id: None,
            message: "done".into(),
            has_media: false,
            token_id: None,
            draft: Some(draft_snapshot(&r)),
        };
        persist(&state, &session.owner, &record, true).unwrap();
        let raw = state
            .db
            .get_setting(&records_key(&session.owner))
            .unwrap()
            .unwrap();
        assert!(!raw.contains("local-secret-description"));
        assert!(!state
            .db
            .export_sql_string_for_sync()
            .unwrap()
            .contains("local-secret-description"));
        assert_eq!(
            records(&state, &session.owner).unwrap()[0]
                .draft
                .as_ref()
                .unwrap()
                .prompt
                .as_deref(),
            Some("local-secret-description")
        );
        assert!(read_local_prompt(&"a".repeat(64), &record.id).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(local_prompt_path(&session.owner, &record.id).unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        forget_prompt(&state, &session, &record.id).unwrap();
        record.message = "late completed".into();
        persist(&state, &session.owner, &record, false).unwrap();
        let rows = records(&state, &session.owner).unwrap();
        assert!(rows[0].draft.as_ref().unwrap().prompt.is_none());
        assert!(!rows[0].draft.as_ref().unwrap().prompt_saved);
        assert!(!local_prompt_path(&session.owner, &record.id)
            .unwrap()
            .exists());
    }
    #[test]
    #[serial_test::serial]
    fn catalog_preference_cache_is_session_bound_and_expires() {
        let session = Login {
            owner: "one".into(),
            user: "one".into(),
            cookie: "session-one".into(),
        };
        let mut models = HashMap::new();
        models.insert("video".into(), vec![profile("muse-video").unwrap()]);
        *MEDIA_CATALOG.lock().unwrap() = Some(MediaCatalogCache {
            owner: session.owner.clone(),
            session_hash: format!("{:x}", Sha256::digest(session.cookie.as_bytes())),
            at: std::time::Instant::now(),
            groups: test_groups(),
            models,
        });
        assert!(cached_selection(&session, "video").is_some());
        assert!(cached_selection(&session, "unknown").is_none());
        let stale = Login {
            owner: "one".into(),
            user: "one".into(),
            cookie: "other-session".into(),
        };
        assert!(cached_selection(&stale, "video").is_none());
        MEDIA_CATALOG.lock().unwrap().as_mut().unwrap().at =
            std::time::Instant::now() - Duration::from_secs(61);
        assert!(cached_selection(&session, "video").is_none());
        *MEDIA_CATALOG.lock().unwrap() = None;
    }
    fn test_groups() -> Vec<YuanhengGroupOption> {
        vec![LEGACY_GROUP, "partner-video"]
            .into_iter()
            .map(|id| YuanhengGroupOption {
                id: id.into(),
                description: "".into(),
                ratio: None,
            })
            .collect()
    }
    #[test]
    fn media_group_defaults_never_fall_back_after_revocation() {
        let groups = test_groups();
        assert_eq!(selected_group(None, &groups).as_deref(), Some(LEGACY_GROUP));
        assert_eq!(selected_group(None, &groups[1..]), None);
        assert_eq!(selected_group(Some("revoked".into()), &groups), None);
        assert_eq!(
            selected_group(Some("partner-video".into()), &groups).as_deref(),
            Some("partner-video")
        );
        for group in ["", " ", "partner", "PARTNER-VIDEO", "partner-video "] {
            assert!(validate_group(group, &groups).is_err());
        }
    }
    #[test]
    fn media_group_snapshots_migrate_legacy_records_without_changing_token() {
        let legacy = json!({"id":"one", "model":"muse-video", "kind":"video", "status":"queued", "createdAt":1, "taskId":"old_task", "message":"pending", "hasMedia":false, "tokenId":123});
        let mut record: MediaRecord = serde_json::from_value(legacy).unwrap();
        assert_eq!(record.group, LEGACY_GROUP);
        assert_eq!(record.token_id, Some(123));
        record.group = "partner-video".into();
        let roundtrip: MediaRecord =
            serde_json::from_value(serde_json::to_value(&record).unwrap()).unwrap();
        assert_eq!(roundtrip.group, "partner-video");
        assert_eq!(roundtrip.token_id, Some(123));
        let mut wire = serde_json::to_value(json!({"operationId":uuid::Uuid::new_v4().to_string(),"model":"muse-video","prompt":"scene","size":"1280x720","duration":4,"reference":null})).unwrap();
        assert!(serde_json::from_value::<MediaRequest>(wire.clone()).is_err());
        wire["group"] = json!("partner-video");
        assert_eq!(
            serde_json::from_value::<MediaRequest>(wire).unwrap().group,
            "partner-video"
        );
    }
    #[test]
    #[serial_test::serial]
    fn media_group_preferences_are_account_bound_and_do_not_touch_chat() {
        let (_home, state) = super::super::tests::isolated_state();
        let status = YuanhengConnectionStatus {
            connected: true,
            user_id: Some("test-user".into()),
            ..Default::default()
        };
        persist_connection_for_group(
            &state,
            "session=test",
            "test-user",
            "",
            0,
            &status,
            "chat-group",
        )
        .unwrap();
        let session = login(&state).unwrap();
        let before = read_cached_status(&state).unwrap();
        save_group_preference(&state, &session, "partner-video", &test_groups()).unwrap();
        assert_eq!(
            state
                .db
                .get_setting(&group_setting_key(&session.owner))
                .unwrap()
                .as_deref(),
            Some("partner-video")
        );
        assert!(state
            .db
            .get_setting(&group_setting_key("other-account"))
            .unwrap()
            .is_none());
        assert_eq!(
            serde_json::to_value(read_cached_status(&state).unwrap()).unwrap(),
            serde_json::to_value(before).unwrap()
        );
        assert!(save_group_preference(&state, &session, "revoked", &test_groups()).is_err());
        let stale = Login {
            cookie: "stale".into(),
            user: session.user.clone(),
            owner: session.owner.clone(),
        };
        assert!(save_group_preference(&state, &stale, LEGACY_GROUP, &test_groups()).is_err());
        assert_eq!(
            state
                .db
                .get_setting(&group_setting_key(&session.owner))
                .unwrap()
                .as_deref(),
            Some("partner-video")
        );
    }
    #[tokio::test]
    #[serial_test::serial]
    async fn media_group_catalog_uses_explicit_group_and_rejects_unauthorized_or_stale_login() {
        use axum::{
            extract::{Query, State as AxumState},
            routing::get,
            Json, Router,
        };
        let (_home, state) = super::super::tests::isolated_state();
        let status = YuanhengConnectionStatus {
            connected: true,
            user_id: Some("test-user".into()),
            ..Default::default()
        };
        persist_connection_for_group(
            &state,
            "session=test",
            "test-user",
            "",
            0,
            &status,
            "chat-group",
        )
        .unwrap();
        let session = login(&state).unwrap();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let app = Router::new().route("/api/user/self/groups", get(|| async { Json(json!({"success":true,"data":{"partner-video":{"desc":"Video only"},"生图和视频":{"desc":"Legacy"}}})) }))
            .route("/api/user/models", get(|AxumState(seen):AxumState<Arc<std::sync::Mutex<Vec<String>>>>, Query(query):Query<HashMap<String,String>>| async move {
                let group = query.get("group").cloned().unwrap_or_default();
                seen.lock().unwrap().push(group.clone());
                Json(json!({"success":true,"data":if group == "partner-video" { vec!["muse-video", "doubao-seedance-2-5-260628", "gpt-6-astra", "flow-video-veo-3.1-lite"] } else { vec!["gpt-image-2.5-sunburst"] }}))
            })).with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let result = catalog_at(&state, &session, &client, &origin, "partner-video")
            .await
            .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(
            result.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["doubao-seedance-2-5-260628", "muse-video"]
        );
        assert!(
            catalog_at(&state, &session, &client, &origin, "unauthorized")
                .await
                .is_err()
        );
        let stale = Login {
            cookie: "stale".into(),
            user: session.user.clone(),
            owner: session.owner.clone(),
        };
        assert!(catalog_at(&state, &stale, &client, &origin, LEGACY_GROUP)
            .await
            .is_err());
        assert_eq!(*seen.lock().unwrap(), vec!["partner-video"]);
        server.abort();
        let _ = server.await;
    }
    #[tokio::test]
    #[serial_test::serial]
    async fn creation_groups_hide_text_and_empty_groups_by_catalog_not_name() {
        use axum::{extract::Query, routing::get, Json, Router};
        let (_home, state) = super::super::tests::isolated_state();
        let status = YuanhengConnectionStatus {
            connected: true,
            user_id: Some("test-user".into()),
            ..Default::default()
        };
        persist_connection_for_group(
            &state,
            "session=test",
            "test-user",
            "",
            0,
            &status,
            "chat-group",
        )
        .unwrap();
        let session = login(&state).unwrap();
        let app = Router::new()
            .route("/api/user/self/groups",get(||async {Json(json!({"success":true,"data":{"chat":{},"empty":{},"image":{},"video":{},"生图和视频":{}}}))}))
            .route("/api/user/models",get(|Query(q):Query<HashMap<String,String>>|async move {
                Json(json!({"success":true,"data":match q["group"].as_str() {
                    "image" => vec!["gpt-image-2.5-sunburst"],
                    "video" => vec!["muse-video"],
                    "empty" => vec![],
                    _ => vec!["claude-sonnet-4"]
                }}))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let result = creation_groups_at(&state, &session, &client, &origin).await;
        server.abort();
        let _ = server.await;
        let mut ids = result
            .unwrap()
            .0
            .into_iter()
            .map(|g| g.id)
            .collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, vec!["image", "video"]);
    }
    #[tokio::test]
    #[serial_test::serial]
    async fn creation_group_failures_are_not_empty_catalogs_and_stale_accounts_are_rejected() {
        use axum::{
            extract::{Query, State as AxumState},
            routing::get,
            Json, Router,
        };
        let (_home, state) = super::super::tests::isolated_state();
        let status = YuanhengConnectionStatus {
            connected: true,
            user_id: Some("test-user".into()),
            ..Default::default()
        };
        persist_connection_for_group(
            &state,
            "session=test",
            "test-user",
            "",
            0,
            &status,
            "chat-group",
        )
        .unwrap();
        let session = login(&state).unwrap();
        let all_fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let app = Router::new()
            .route(
                "/api/user/self/groups",
                get(|| async { Json(json!({"success":true,"data":{"good":{},"failed":{}}})) }),
            )
            .route(
                "/api/user/models",
                get(
                    |AxumState(all): AxumState<Arc<std::sync::atomic::AtomicBool>>,
                     Query(q): Query<HashMap<String, String>>| async move {
                        if all.load(std::sync::atomic::Ordering::SeqCst) || q["group"] == "failed" {
                            Json(json!({"success":false,"data":["muse-video"]}))
                        } else {
                            Json(json!({"success":true,"data":["muse-video"]}))
                        }
                    },
                ),
            )
            .with_state(all_fail.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let partial = creation_groups_at(&state, &session, &client, &origin).await;
        all_fail.store(true, std::sync::atomic::Ordering::SeqCst);
        let failed = creation_groups_at(&state, &session, &client, &origin).await;
        let stale = Login {
            cookie: "stale".into(),
            user: session.user.clone(),
            owner: session.owner.clone(),
        };
        let stale_result = creation_groups_at(&state, &stale, &client, &origin).await;
        server.abort();
        let _ = server.await;
        let (groups, count, _) = partial.unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, "good");
        assert_eq!(count, 1);
        assert!(failed.is_err());
        assert!(stale_result.is_err());
        assert_eq!(selected_group(Some("failed".into()), &groups), None);
    }
    #[tokio::test]
    #[serial_test::serial]
    async fn old_media_task_reads_original_token_even_after_group_preference_changes() {
        use axum::{routing::get, Json, Router};
        let (_home, state) = super::super::tests::isolated_state();
        let status = YuanhengConnectionStatus {
            connected: true,
            user_id: Some("test-user".into()),
            ..Default::default()
        };
        persist_connection_for_group(
            &state,
            "session=test",
            "test-user",
            "",
            0,
            &status,
            "chat-group",
        )
        .unwrap();
        let session = login(&state).unwrap();
        save_group_preference(&state, &session, "partner-video", &test_groups()).unwrap();
        let record: MediaRecord = serde_json::from_value(json!({"id":"old","model":"muse-video","kind":"video","status":"queued","createdAt":1,"taskId":"task","message":"pending","hasMedia":false,"tokenId":123})).unwrap();
        let app = Router::new().route(
            "/api/token/123/key",
            get(|| async { Json(json!({"success":true,"data":{"key":"synthetic-old-task"}})) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        assert_eq!(
            record_key_at(&state, &session, &record, &client, &origin)
                .await
                .unwrap(),
            normalize_api_token("synthetic-old-task").unwrap()
        );
        assert_eq!(record.group, LEGACY_GROUP);
        server.abort();
        let _ = server.await;
    }
    #[test]
    fn media_save_filters_and_destination_formats_match_real_content() {
        for (mime, ext) in [
            ("video/mp4", "mp4"),
            ("image/png", "png"),
            ("image/jpeg", "jpg"),
            ("image/webp", "webp"),
        ] {
            assert_eq!(media_extension(mime).unwrap(), ext);
            let (label, filters) = media_save_filter(ext).unwrap();
            assert!(filters.contains(&ext));
            assert!(!filters.contains(&"sql"));
            assert!(!label.contains("SQL"));
            for name in [
                format!("视频输出.{ext}"),
                format!("export.{}", ext.to_uppercase()),
            ] {
                assert!(validate_media_destination(std::path::Path::new(&name), ext).is_ok());
            }
            for name in [
                format!("video.{ext}.sql"),
                "no-extension".into(),
                "file.txt".into(),
            ] {
                assert!(validate_media_destination(std::path::Path::new(&name), ext).is_err());
            }
        }
        assert!(validate_media_destination(std::path::Path::new("photo.jpeg"), "jpg").is_ok());
        assert!(validate_media_destination(std::path::Path::new("photo.mp4"), "png").is_err());
        assert!(media_save_filter("sql").is_err());
        assert!(media_extension("application/sql").is_err());
    }

    fn request(model: &str) -> MediaRequest {
        let p = profile(model).unwrap();
        MediaRequest {
            quality: None,
            resolution: None,
            output_format: None,
            background: None,
            output_compression: None,
            save_prompt: false,
            group: legacy_group(),
            operation_id: uuid::Uuid::new_v4().to_string(),
            model: model.into(),
            prompt: "synthetic scene".into(),
            size: p.sizes[0].clone(),
            duration: p.durations.first().copied(),
            reference: None,
            images: vec![],
        }
    }
    fn png() -> String {
        let mut output = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        format!("data:image/png;base64,{}", B64.encode(output.into_inner()))
    }
    #[test]
    fn damaged_reference_is_rejected_despite_a_valid_magic_header() {
        assert!(reference(&format!(
            "data:image/png;base64,{}",
            B64.encode(b"\x89PNG\r\n\x1a\ninvalid")
        ))
        .is_err());
        assert!(video_reference(b"\xff\xd8\xffbroken").is_err());
        let mut output = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8193, 1)
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        assert!(video_reference(&output.into_inner()).is_err());
    }
    #[test]
    fn muse_document_duration_prompt_and_multi_image_contract() {
        let mut r = request("muse-video");
        for seconds in [3, 4, 30, 31, 60, 120, 180, 181] {
            r.duration = Some(seconds);
            assert!(validate(&r).is_ok());
            assert_eq!(
                json_payload(&r, &profile(&r.model).unwrap())["seconds"],
                seconds.to_string()
            );
        }
        for seconds in [0] {
            r.duration = Some(seconds);
            assert!(validate(&r).is_err());
        }
        r.duration = Some(180);
        r.prompt = "😀".repeat(4000);
        assert!(validate(&r).is_ok());
        r.prompt.push('a');
        assert!(validate(&r).is_err());
        r.prompt = "scene".into();
        let first = png();
        let mut webp = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut webp, image::ImageFormat::WebP)
            .unwrap();
        let second = format!("data:image/webp;base64,{}", B64.encode(webp.into_inner()));
        r.images = vec![first.clone()];
        let v = json_payload(&r, &validate(&r).unwrap());
        assert_eq!(v["input_reference"], first);
        assert!(v.get("images").is_none());
        r.images = vec![first.clone(), second.clone(), first.clone(), second.clone()];
        let v = json_payload(&r, &validate(&r).unwrap());
        assert_eq!(v["images"], json!(r.images));
        assert!(v.get("input_reference").is_none());
        r.images.push(first.clone());
        assert!(validate(&r).is_ok());
        r.images.pop();
        r.reference = Some(first.clone());
        assert!(validate(&r).is_err());
        r.images.clear();
        r.reference = Some(second);
        assert!(validate(&r).is_ok());
        r.model = "gpt-image-2".into();
        r.size = "1024x1024".into();
        r.duration = None;
        assert!(validate(&r).is_ok());
        r.reference = None;
        r.images = vec![first];
        assert!(validate(&r).is_ok());
    }
    #[test]
    fn muse_total_reference_limit_counts_decoded_bytes() {
        let mut bytes = B64.decode(png().split_once(',').unwrap().1).unwrap();
        bytes.resize(8 * 1024 * 1024 + 1, 0);
        let data = format!("data:image/png;base64,{}", B64.encode(&bytes));
        let mut r = request("muse-video");
        r.images = vec![data.clone(), data.clone()];
        assert!(validate(&r).is_ok());
        r.images = vec![data; 8];
        assert!(validate(&r).err().unwrap().contains("资源限制"));
        bytes.resize(MAX_REFERENCE + 1, 0);
        r.images = vec![format!("data:image/png;base64,{}", B64.encode(&bytes))];
        assert!(validate(&r).is_err());
    }
    #[tokio::test]
    async fn long_video_streams_to_disk_without_64mb_limit_and_rejects_partial_results() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (declared, sent, valid, success) in [
            (65 * 1024 * 1024u64, 65 * 1024 * 1024u64, true, true),
            (100, 12, true, false),
            (12, 12, false, false),
            (MAX_VIDEO + 1, 0, true, false),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("owner").join("result.bin");
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let n = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..n]);
                assert!(request.starts_with("GET "));
                assert!(!request.to_lowercase().contains("range:"));
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                let mut chunk = vec![0u8; 65536];
                if valid {
                    chunk[4..8].copy_from_slice(b"ftyp");
                }
                let mut left = sent;
                while left > 0 {
                    let length = left.min(chunk.len() as u64) as usize;
                    if socket.write_all(&chunk[..length]).await.is_err() {
                        break;
                    }
                    left -= length as u64;
                }
            });
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap();
            let response = client.get(format!("http://{addr}/")).send().await.unwrap();
            let result = stream_video(response, &path).await;
            assert_eq!(result.is_ok(), success);
            assert!(!path.exists());
            if let Ok(file) = result {
                assert_eq!(file.as_file().metadata().unwrap().len(), declared);
                drop(file);
            }
            if path.parent().unwrap().exists() {
                assert_eq!(
                    std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
                    0
                );
            }
            server.await.unwrap();
        }
    }
    #[test]
    fn generated_reference_normalizes_formats_and_preserves_aspect_ratio() {
        for format in [
            image::ImageFormat::Png,
            image::ImageFormat::Jpeg,
            image::ImageFormat::WebP,
        ] {
            let image = image::DynamicImage::new_rgb8(1800, 900);
            let mut output = std::io::Cursor::new(Vec::new());
            image.write_to(&mut output, format).unwrap();
            let prepared = video_reference(&output.into_inner()).unwrap();
            assert_eq!(prepared.mime, "image/png");
            let bytes = B64.decode(prepared.data).unwrap();
            assert!(bytes.len() <= MAX_REFERENCE);
            let result = decode_reference(&bytes).unwrap();
            assert_eq!((result.width(), result.height()), (1536, 768));
        }
    }

    #[test]
    fn refreshed_catalog_includes_new_video_families_and_preserves_parameters() {
        for id in [
            "doubao-seedance-2-5-260628",
            "sora-3",
            "flow-video-next",
            "grok-imagine-video-2",
        ] {
            let p = profile(id).expect("server-authorized video must not be hidden by exact IDs");
            assert_eq!(p.kind, "video");
            let mut r = request(id);
            r.size = "21:9".into();
            r.duration = Some(30);
            r.resolution = Some("2160p".into());
            assert!(validate(&r).is_ok());
            let body = json_payload(&r, &p);
            assert_eq!(body["model"], id);
            assert_eq!(body["resolution"], "2160p");
            assert_eq!(submission_endpoint(&r, &p), "/v1/videos");
        }
        assert!(profile("gpt-6-astra").is_none());
        assert!(profile("flow-video-veo-3.1-lite").is_none());
    }

    #[test]
    fn seedance_and_grok_requests_preserve_reference_resolution_and_ratio() {
        let mut r = request("doubao-seedance-2-5-260628");
        r.duration = Some(8);
        r.resolution = Some("1080p".into());
        r.size = "1920x1080".into();
        r.reference = Some(png());
        let p = validate(&r).unwrap();
        let value = json_payload(&r, &p);
        assert_eq!(value["seconds"], "8");
        assert_eq!(value["resolution"], "1080p");
        assert_eq!(value["metadata"]["ratio"], "16:9");
        assert_eq!(value["images"][0], r.reference.as_ref().unwrap().as_str());
        r.model = "grok-imagine-video-2".into();
        r.size = "21:9".into();
        let p = validate(&r).unwrap();
        let value = json_payload(&r, &p);
        assert_eq!(
            value["image"]["url"],
            r.reference.as_ref().unwrap().as_str()
        );
        assert_eq!(value["duration"], 8);
        assert_eq!(value["resolution"], "1080p");
        for size in ["0:9", "01:9", "-1:9", "16:9:1", "4294967296:9"] {
            r.size = size.into();
            assert!(validate(&r).is_err());
        }
    }

    #[test]
    fn video_default_dimensions_match_named_1080p_model() {
        let p = profile("flow-video-gemini-omni-flash-1.1-1080p").unwrap();
        assert_eq!(p.resolutions[0], "1080p");
        let mut r = request(&p.id);
        r.resolution = Some(p.resolutions[0].clone());
        let body = json_payload(&r, &validate(&r).unwrap());
        assert_eq!(body["size"], "1920x1080");
    }

    #[test]
    fn compatible_video_dimensions_and_task_id_aliases() {
        assert_eq!(
            video_pixel_size("21:9", Some("1080p")).as_deref(),
            Some("2520x1080")
        );
        assert_eq!(
            video_pixel_size("9:16", Some("1080p")).as_deref(),
            Some("1080x1920")
        );
        assert_eq!(video_pixel_size("21:9", Some("cinema")), None);
        let mut r = request("muse-video");
        r.size = "21:9".into();
        r.resolution = Some("1080p".into());
        assert_eq!(
            json_payload(&r, &validate(&r).unwrap())["size"],
            "2520x1080"
        );
        r.size = "1920x1080".into();
        r.resolution = Some("720p".into());
        assert!(validate(&r).is_err());
        for body in [
            json!({"id":"task_ok"}),
            json!({"task_id":"task_ok"}),
            json!({"id":"", "task_id":"task_ok"}),
            json!({"id":"task_ok","task_id":"task_ok"}),
        ] {
            assert_eq!(compatible_task_id(&body).unwrap(), "task_ok");
        }
        for body in [
            json!({}),
            json!({"task_id":"../bad"}),
            json!({"id":"task_a","task_id":"task_b"}),
            json!({"id":12,"task_id":"task_ok"}),
        ] {
            assert!(compatible_task_id(&body).is_err());
        }
    }

    #[test]
    fn profiles_reject_unknown_models_and_preserve_explicit_ids() {
        for id in [
            "gpt-6-astra",
            "unknown-image",
            "../gpt-image-2",
            "gpt-image-2/evil",
            "GROK-IMAGINE-VIDEO",
        ] {
            assert!(profile(id).is_none());
        }
        for id in [
            "gpt-image-2.5-sunburst",
            "gpt-image-2.5-flare",
            "muse-video",
            "grok-imagine-video-1.5",
            "gemini-3.1-flash-image-preview",
        ] {
            assert_eq!(profile(id).unwrap().id, id);
        }
    }
    #[test]
    fn validation_rejects_invalid_parameters_before_submission() {
        let mut r = request("muse-video");
        assert!(validate(&r).is_ok());
        r.duration = Some(181);
        assert!(validate(&r).is_ok());
        r.duration = Some(4);
        r.size = "1920x1080".into();
        assert!(validate(&r).is_ok());
        r.size = "1280x720".into();
        r.prompt = " ".into();
        assert!(validate(&r).is_err());
        r.prompt = "x".repeat(8001);
        assert!(validate(&r).is_err());
        let mut r = request("gpt-image-2");
        r.operation_id = "../x".into();
        assert!(validate(&r).is_err());
        let mut r = request("gpt-image-2");
        r.duration = Some(1);
        assert!(validate(&r).is_err());
    }
    #[test]
    fn references_require_a_verified_profile_and_matching_magic() {
        let mut r = request("muse-video");
        assert!(validate(&r).is_ok());
        r.reference = Some(png());
        assert!(validate(&r).is_ok());
        let mut r = request("grok-imagine-video");
        r.reference = Some(png());
        assert!(validate(&r).is_ok());
        assert!(reference("data:image/png;base64,PHN2Zz4=").is_err());
        assert!(reference(&png().replace("image/png", "image/jpeg")).is_err());
        assert!(reference("https://example.test/image.png").is_err());
        assert!(reference(&format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_REFERENCE * 2)
        ))
        .is_err());
    }
    #[test]
    fn actual_submission_deadline_is_1800_for_muse_and_600_for_other_video() {
        let client = reqwest::Client::new();
        for model in [
            "grok-imagine-video",
            "grok-imagine-video-1.5",
            "muse-video",
            "snow-grok-imagine-video",
            "flow-video-gemini-omni-flash-1.1",
            "flow-video-gemini-omni-flash-1.1-1080p",
        ] {
            let r =
                submission_builder(&client, "/v1/videos", "synthetic", &profile(model).unwrap())
                    .build()
                    .unwrap();
            let seconds = if model == "muse-video" { 1800 } else { 600 };
            assert_eq!(r.timeout(), Some(&Duration::from_secs(seconds)));
            assert_eq!(r.method(), reqwest::Method::POST);
        }
        let image = submission_builder(
            &client,
            "/v1/images/generations",
            "synthetic",
            &profile("gpt-image-2").unwrap(),
        )
        .build()
        .unwrap();
        assert_eq!(image.timeout(), Some(&Duration::from_secs(300)));
    }
    #[test]
    fn removed_veo_cannot_be_listed_or_submitted_even_if_authorized() {
        for model in ["flow-video-veo-3.1-lite"] {
            assert!(profile(model).is_none());
            let mut r = request("muse-video");
            r.model = model.into();
            r.reference = Some(png());
            assert!(validate(&r).is_err());
        }
    }
    #[test]
    fn omni_720p_uses_confirmed_text_video_parameters_only() {
        let mut r = request("flow-video-gemini-omni-flash-1.1");
        for size in ["1280x720", "720x1280"] {
            r.size = size.into();
            let value = json_payload(&r, &validate(&r).unwrap());
            assert_eq!(
                value,
                json!({"model": r.model, "prompt":"synthetic scene", "seconds":"4", "size":size})
            );
        }
        r.duration = Some(8);
        assert!(validate(&r).is_ok());
        r.duration = Some(4);
        r.size = "1920x1080".into();
        assert!(validate(&r).is_ok());
        r.size = "1280x720".into();
        r.reference = Some(png());
        assert!(validate(&r).is_ok());
    }
    #[test]
    fn download_urls_restrict_origins_and_never_echo_signed_values() {
        for raw in [
            "https://imgen.x.ai/image.png?signature=synthetic",
            "https://images.x.ai/image.png",
            "https://a.blob.core.windows.net/b/c.png",
            "https://a.oaiusercontent.com/c.png",
            "https://meta-api.vip/images/x",
            "https://storage.googleapis.com/bucket/x",
        ] {
            assert!(trusted_image_url(raw).is_ok());
        }
        for raw in [
            "http://imgen.x.ai/image.png",
            "https://user:secret@imgen.x.ai/x",
            "https://imgen.x.ai:444/x",
            "https://imgen.x.ai.evil.test/x",
            "https://evilblob.core.windows.net/x",
            "https://evil.test/x?signature=secret",
            "https://localhost/x",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "file:///tmp/private.png",
            "https://imgen.x.ai/x#fragment",
            " https://imgen.x.ai/x",
            "https://imgen.x.ai/x\n",
        ] {
            let error = trusted_image_url(raw).unwrap_err();
            assert!(!error.contains("secret"));
        }
    }
    #[test]
    fn private_special_and_mapped_addresses_are_rejected() {
        for ip in [
            "127.0.0.1",
            "10.1.1.1",
            "192.168.0.1",
            "172.16.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "192.0.2.2",
            "198.51.100.5",
            "203.0.113.9",
            "198.18.1.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "fd00::1",
            "fe80::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "64:ff9b::7f00:1",
        ] {
            assert!(!public_image_address(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(public_image_address(ip.parse().unwrap()));
        }
    }
    #[test]
    fn signed_urls_are_account_bound_in_secure_storage_and_inline_takes_priority() {
        let owner = "a".repeat(64);
        let other = "b".repeat(64);
        let id = uuid::Uuid::new_v4().to_string();
        let value = json!({"data":[{"url":"https://imgen.x.ai/x?signature=synthetic-private"}]});
        let url = image_result_url(&value).unwrap().unwrap();
        save_image_url(&owner, &id, &url).unwrap();
        let key = image_url_key(&owner, &id).unwrap();
        assert_eq!(
            crate::secure_storage::get_secret(&key).unwrap().as_deref(),
            Some(url.as_str())
        );
        assert!(
            crate::secure_storage::get_secret(&image_url_key(&other, &id).unwrap())
                .unwrap()
                .is_none()
        );
        assert!(
            image_result_url(&json!({"data":[{"b64_json":"bad", "url":url.as_str()}]}))
                .unwrap()
                .is_none()
        );
        assert!(image_result_url(
            &json!({"candidates":[{"content":{"parts":[{"inlineData":{"data":"bad"}}]}}]})
        )
        .unwrap()
        .is_none());
        crate::secure_storage::delete_secret(&key).unwrap();
    }
    #[tokio::test]
    async fn image_downloads_reject_redirects_bad_content_and_oversized_bodies() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, content, success) in [
            ("200 OK", b"\x89PNG\r\n\x1a\nsynthetic".as_slice(), true),
            ("200 OK", b"<html>not an image</html>".as_slice(), false),
            ("403 Forbidden", b"secret-error".as_slice(), false),
            ("302 Found", b"".as_slice(), false),
            ("200 OK", b"".as_slice(), false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut raw = [0; 4096];
                let count = socket.read(&mut raw).await.unwrap();
                let request = String::from_utf8_lossy(&raw[..count]).to_ascii_lowercase();
                assert!(request.starts_with("get "));
                assert!(!request.contains("authorization:"));
                assert!(!request.contains("cookie:"));
                let length = if status == "200 OK" && content.is_empty() {
                    MAX_MEDIA + 1
                } else {
                    content.len()
                };
                let headers = format!("HTTP/1.1 {status}\r\nLocation: https://invalid.test/x\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n");
                socket.write_all(headers.as_bytes()).await.unwrap();
                socket.write_all(content).await.unwrap();
            });
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();
            let result = image_download_response(
                image_download_builder(&client, format!("http://{address}/").parse().unwrap())
                    .send()
                    .await
                    .unwrap(),
            )
            .await;
            assert_eq!(result.is_ok(), success);
            if let Err(error) = result {
                assert!(!error.contains("secret-error"));
            }
            server.await.unwrap();
        }
    }
    #[test]
    fn providers_receive_their_own_wire_fields() {
        let mut r = request("muse-video");
        r.reference = Some(png());
        let value = json_payload(&r, &validate(&r).unwrap());
        assert_eq!(value["seconds"], "4");
        assert_eq!(value["size"], "1280x720");
        assert!(value.get("duration").is_none());
        assert!(value.get("input_reference").is_some());
        let r = request("grok-imagine-video");
        let value = json_payload(&r, &validate(&r).unwrap());
        assert_eq!(value["duration"], 1);
        assert_eq!(value["resolution"], "480p");
        assert!(value.get("seconds").is_none());
        let mut r = request("gemini-3.1-flash-image-preview");
        r.reference = Some(png());
        let value = json_payload(&r, &validate(&r).unwrap());
        assert_eq!(
            value
                .pointer("/contents/0/parts/1/inlineData/mimeType")
                .unwrap(),
            "image/png"
        );
        assert_eq!(
            value
                .pointer("/generationConfig/imageConfig/imageSize")
                .unwrap(),
            "1K"
        );
        let r = request("grok-imagine-image");
        assert!(json_payload(&r, &validate(&r).unwrap())
            .get("size")
            .is_none());
    }
    #[test]
    fn gpt_edits_use_multipart_without_local_path_or_json_reference() {
        let mut r = request("gpt-image-2");
        r.reference = Some(png());
        let (mime, payload) = multipart(&r).unwrap();
        let text = String::from_utf8_lossy(&payload);
        assert!(mime.starts_with("multipart/form-data; boundary="));
        assert!(text.contains("name=\"image\"; filename=\"reference.png\""));
        assert!(text.contains("name=\"model\"\r\n\r\ngpt-image-2"));
        assert!(!text.contains("data:image"));
        assert!(!text.contains("/Users/"));
    }
    #[test]
    fn gpt_multiple_references_follow_official_count_and_edit_wire_contract() {
        let mut webp = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut webp, image::ImageFormat::WebP)
            .unwrap();
        let webp = format!("data:image/webp;base64,{}", B64.encode(webp.into_inner()));
        for model in ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"] {
            let mut r = request(model);
            assert_eq!(
                submission_endpoint(&r, &validate(&r).unwrap()),
                "/v1/images/generations"
            );
            r.images = vec![png(); 16];
            r.images[1] = webp.clone();
            assert_eq!(
                submission_endpoint(&r, &validate(&r).unwrap()),
                "/v1/images/edits"
            );
            let (_, payload) = multipart(&r).unwrap();
            let text = String::from_utf8_lossy(&payload);
            assert_eq!(text.matches("name=\"image[]\"").count(), 16);
            assert!(text.find("reference-1.png").unwrap() < text.find("reference-2.webp").unwrap());
            assert!(text.contains("reference-16.png"));
            assert!(!text.contains("data:image"));
            r.images.push(png());
            assert!(validate(&r).is_err());
            r.images.pop();
            r.reference = Some(png());
            assert!(validate(&r).is_err());
            r.reference = None;
            r.images[0] = "data:image/png;base64,bm90LWltYWdl".into();
            assert!(validate(&r).is_err());
        }
    }
    #[test]
    fn gpt_reference_size_does_not_inherit_muse_limits() {
        let mut bytes = B64.decode(png().split_once(',').unwrap().1).unwrap();
        bytes.resize(13 * 1024 * 1024, 0);
        let raw = format!("data:image/png;base64,{}", B64.encode(bytes));
        let mut r = request("gpt-image-2.5-sunburst");
        r.images = vec![raw.clone(), raw];
        assert!(validate(&r).is_ok()); // 26MB exceeds Muse total; each exceeds old 10MB.
        assert!(reference_with_limit(&png(), true, 1).is_err());
        assert_eq!(MAX_GPT_REFERENCE, 50 * 1024 * 1024);
    }
    #[test]
    fn image_results_reject_urls_html_empty_and_accept_both_protocols() {
        for v in [
            json!({}),
            json!({"data":[{"url":"http://127.0.0.1/secret"}]}),
            json!({"data":[{"b64_json":B64.encode(b"<html>secret</html>")} ]}),
        ] {
            assert!(image_result(&v).is_err());
        }
        let b64 = B64.encode(b"\x89PNG\r\n\x1a\ntest");
        assert_eq!(
            image_result(&json!({"data":[{"b64_json":b64}]})).unwrap(),
            image_result(
                &json!({"candidates":[{"content":{"parts":[{"inlineData":{"data":b64}}]}}]})
            )
            .unwrap()
        );
    }
    #[test]
    fn task_and_file_identifiers_cannot_select_other_hosts_or_paths() {
        assert!(!valid_id("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"));
        for id in [
            "",
            "../a",
            "a?x=y",
            "https://evil.test/a",
            "a/b",
            "a%2fb",
            "a\r\nAuthorization:",
        ] {
            assert!(task_path(id).is_err());
        }
        assert_eq!(
            task_path("task_abc-1").unwrap(),
            format!("{BASE_URL}/v1/videos/task_abc-1")
        );
        assert!(media_path("../owner", &uuid::Uuid::new_v4().to_string()).is_err());
        assert!(media_path(&"a".repeat(64), "../result").is_err());
    }
    #[test]
    fn records_block_replay_isolate_accounts_and_never_store_prompts_or_keys() {
        let state = AppState::new(Arc::new(Database::memory().unwrap()));
        let r = MediaRecord {
            draft: None,
            group: legacy_group(),
            id: uuid::Uuid::new_v4().to_string(),
            model: "muse-video".into(),
            kind: "video".into(),
            status: "submitting".into(),
            created_at: 1,
            task_id: None,
            message: "pending".into(),
            has_media: false,
            token_id: Some(123),
        };
        persist(&state, "one", &r, true).unwrap();
        assert!(persist(&state, "one", &r, true).is_err());
        assert!(persist(&state, "two", &r, false).is_err());
        assert!(records(&state, "two").unwrap().is_empty());
        let raw = state.db.get_setting(&records_key("one")).unwrap().unwrap();
        assert!(!raw.contains("prompt"));
        assert!(!raw.contains("reference"));
        assert!(!raw.contains("api_key"));
    }
    #[tokio::test]
    async fn bounded_response_does_not_expose_error_body_or_follow_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (response, limit) in [
            ("HTTP/1.1 403 Forbidden\r\nContent-Length: 12\r\n\r\nsecret-token", 100),
            ("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n", 10),
            ("HTTP/1.1 302 Found\r\nLocation: https://invalid.test/\r\nContent-Length: 0\r\n\r\n", 100),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = [0; 1024]; let _ = socket.read(&mut data).await;
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never()).timeout(Duration::from_secs(2)).build().unwrap();
            let response = client.get(format!("http://{address}/")).send().await.unwrap();
            let error = body(response, limit).await.unwrap_err();
            assert!(!error.contains("secret-token")); assert!(!error.contains("invalid.test"));
            server.await.unwrap();
        }
    }
}
