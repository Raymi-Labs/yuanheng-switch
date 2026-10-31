//! Independent, account-bound creation. Never replay a paid request.
use super::*;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures::StreamExt;
use sha2::{Digest, Sha256};
use std::{io::Write, path::PathBuf, sync::Mutex, time::Duration};

const GROUP: &str = "生图和视频";
const MAX_MEDIA: usize = 64 * 1024 * 1024;
const MAX_REFERENCE: usize = 10 * 1024 * 1024;
const MAX_MUSE_REFERENCES: usize = 24 * 1024 * 1024;
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
}

fn profile(id: &str) -> Option<MediaModel> {
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
        _ => return None,
    };
    Some(MediaModel {
        id: id.into(),
        kind: kind.into(),
        reference: reference.into(),
        sizes: sizes.iter().map(|v| (*v).into()).collect(),
        durations,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaRequest {
    operation_id: String,
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
    model: String,
    kind: String,
    status: String,
    created_at: i64,
    task_id: Option<String>,
    message: String,
    has_media: bool,
    #[serde(default)]
    token_id: Option<i64>,
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
    state
        .db
        .get_setting(&records_key(owner))
        .map_err(|_| "无法读取创作记录")?
        .map(|s| serde_json::from_str(&s).map_err(|_| "创作记录损坏，请勿重复提交".into()))
        .unwrap_or(Ok(vec![]))
}
fn persist(state: &AppState, owner: &str, record: &MediaRecord, new: bool) -> Result<(), String> {
    let _lock = RECORDS.lock().map_err(|_| "创作记录锁不可用")?;
    let mut rows = records(state, owner)?;
    let index = rows.iter().position(|r| r.id == record.id);
    if new && index.is_some() {
        return Err("此生成操作已提交，请查看原记录，不要重复发送".into());
    }
    if let Some(index) = index {
        rows[index] = record.clone();
    } else {
        if !new {
            return Err("原创作记录已移除，不能重新写入".into());
        }
        if rows.len() >= 50 {
            return Err("已有 50 条创作记录，请先删除不需要的记录".into());
        }
        rows.insert(0, record.clone());
    }
    let text = serde_json::to_string(&rows).map_err(|_| "无法编码创作记录")?;
    state
        .db
        .set_setting(&records_key(owner), &text)
        .map_err(|_| "无法保存创作记录，请勿重复提交".into())
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
    if raw.len() > MAX_REFERENCE * 4 / 3 + 128 {
        return Err("参考图不能超过 10 MB".into());
    }
    let (header, value) = raw.split_once(',').ok_or("参考图格式无效")?;
    let bytes = B64.decode(value).map_err(|_| "参考图编码无效")?;
    let mime = image_mime(&bytes)
        .filter(|m| allow_webp || *m != "image/webp")
        .ok_or("参考图仅支持 PNG 或 JPEG")?;
    if bytes.len() > MAX_REFERENCE || header != format!("data:{mime};base64") {
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
    if !p.sizes.contains(&request.size)
        || (p.kind == "video" && !p.durations.contains(&request.duration.unwrap_or(0)))
        || (p.kind == "image" && request.duration.is_some())
    {
        return Err("该模型不支持所选尺寸或时长".into());
    }
    if !request.images.is_empty() {
        if request.model != "muse-video" || request.reference.is_some() || request.images.len() > 4
        {
            return Err(
                "Muse最多4张参考图，images不能与单图reference同时提交；其他模型不支持多图".into(),
            );
        }
        let mut total = 0;
        for raw in &request.images {
            total += reference_with_webp(raw, true)?.1.len();
            if total > MAX_MUSE_REFERENCES {
                return Err("Muse参考图总大小不能超过24MB".into());
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
        reference_with_webp(raw, request.model == "muse-video")?;
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
async fn account_get(
    client: &reqwest::Client,
    session: &Login,
    path: &str,
) -> Result<Value, String> {
    let response = with_session(
        client.get(format!("{BASE_URL}{path}")),
        Some(&session.cookie),
        Some(&session.user),
    )
    .send()
    .await
    .map_err(|_| "无法读取创作权限，请检查网络")?;
    json_response(response, 2 * 1024 * 1024).await
}
async fn catalog(state: &AppState, session: &Login) -> Result<Vec<MediaModel>, String> {
    let client = yuanheng_client()?;
    let groups = parse_user_groups(&account_get(&client, session, "/api/user/self/groups").await?)
        .map_err(|_| "读取创作分组失败")?;
    if !groups.iter().any(|g| g.id == GROUP) {
        return Err("当前账号没有“生图和视频”分组权限，请联系平台开通；不会改用聊天分组".into());
    }
    let response = with_session(
        client
            .get(format!("{BASE_URL}/api/user/models"))
            .query(&[("group", GROUP)]),
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
    if request.model.starts_with("gemini-") {
        let mut parts = vec![json!({"text":request.prompt.trim()})];
        if let Some(raw) = &request.reference {
            // Validated before constructing a wire payload.
            let (mime, bytes) = reference(raw).expect("validated reference");
            parts.push(json!({"inlineData":{"mimeType":mime,"data":B64.encode(bytes)}}));
        }
        return json!({"contents":[{"role":"user","parts":parts}],"generationConfig":{"responseModalities":["IMAGE"],"candidateCount":1,"imageConfig":{"aspectRatio":request.size,"imageSize":"1K"}}});
    }
    if p.kind == "image" {
        let mut v = json!({"model":request.model,"prompt":request.prompt.trim(),"n":1,"response_format":"b64_json"});
        if request.size != "auto" {
            v["size"] = json!(request.size);
        }
        return v;
    }
    if request.model.starts_with("grok-imagine-video") {
        return json!({"model":request.model,"prompt":request.prompt.trim(),"duration":request.duration,"resolution":"480p","aspect_ratio":request.size});
    }
    let mut v = json!({"model":request.model,"prompt":request.prompt.trim(),"seconds":request.duration.unwrap_or(4).to_string(),"size":request.size});
    if let Some(raw) = &request.reference {
        v["input_reference"] = json!(raw);
    } else if request.images.len() == 1 {
        v["input_reference"] = json!(request.images[0]);
    } else if !request.images.is_empty() {
        v["images"] = json!(request.images);
    }
    v
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
    let (mime, bytes) = reference(request.reference.as_deref().ok_or("缺少参考图")?)?;
    write!(out, "--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"reference.{}\"\r\nContent-Type: {mime}\r\n\r\n", if mime == "image/png" { "png" } else { "jpg" }).map_err(|_| "无法构建图片请求")?;
    out.extend_from_slice(&bytes);
    write!(out, "\r\n--{boundary}--\r\n").map_err(|_| "无法构建图片请求")?;
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
) -> Result<Vec<MediaModel>, String> {
    let session = login(&state)?;
    catalog(&state, &session).await
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
    if !catalog(&state, &session)
        .await?
        .iter()
        .any(|m| m.id == request.model)
    {
        return Err("此模型不在当前分组授权目录中".into());
    }
    let account = yuanheng_client()?;
    let (key, token_id) = ensure_named_api_token(
        &account,
        &session.cookie,
        &session.user,
        GROUP,
        "元衡桌面端 - 图片与视频",
    )
    .await
    .map_err(|_| "无法获取生图和视频分组凭据，请重新登录或检查权限")?;
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
    let endpoint = if p.kind == "video" {
        "/v1/videos".into()
    } else if request.model.starts_with("gemini-") {
        format!("/v1beta/models/{}:generateContent", request.model)
    } else if request.reference.is_some() {
        "/v1/images/edits".into()
    } else {
        "/v1/images/generations".into()
    };
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
            let id = value
                .get("id")
                .and_then(Value::as_str)
                .ok_or("未返回任务编号，提交结果未知；请勿重复生成")?;
            task_path(id)?;
            record.task_id = Some(id.into());
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
    Ok(record)
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
    let id = record.token_id.ok_or("原任务凭据编号缺失")?;
    let client = yuanheng_client()?;
    let value = account_get(&client, session, &format!("/api/token/{id}/key")).await?;
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
    Ok(record)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPreview {
    data: String,
    mime: String,
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
    let (source, _) = ensure_media_file(&state, &session, &id).await?;
    let destination = PathBuf::from(path);
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
        .set_setting(
            &records_key(&session.owner),
            &serde_json::to_string(&rows).map_err(|_| "无法编码记录")?,
        )
        .map_err(|_| "无法更新创作记录".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use std::sync::Arc;

    fn request(model: &str) -> MediaRequest {
        let p = profile(model).unwrap();
        MediaRequest {
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
        for seconds in [4, 30, 31, 60, 120, 180] {
            r.duration = Some(seconds);
            assert!(validate(&r).is_ok());
            assert_eq!(
                json_payload(&r, &profile(&r.model).unwrap())["seconds"],
                seconds.to_string()
            );
        }
        for seconds in [0, 3, 181] {
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
        assert!(validate(&r).is_err());
        r.images.pop();
        r.reference = Some(first.clone());
        assert!(validate(&r).is_err());
        r.images.clear();
        r.reference = Some(second);
        assert!(validate(&r).is_ok());
        r.model = "gpt-image-2".into();
        r.size = "1024x1024".into();
        r.duration = None;
        assert!(validate(&r).is_err());
        r.reference = None;
        r.images = vec![first];
        assert!(validate(&r).is_err());
    }
    #[test]
    fn muse_total_reference_limit_counts_decoded_bytes() {
        let mut bytes = B64.decode(png().split_once(',').unwrap().1).unwrap();
        bytes.resize(8 * 1024 * 1024 + 1, 0);
        let data = format!("data:image/png;base64,{}", B64.encode(&bytes));
        let mut r = request("muse-video");
        r.images = vec![data.clone(), data.clone()];
        assert!(validate(&r).is_ok());
        r.images.push(data);
        assert!(validate(&r).err().unwrap().contains("24MB"));
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
        assert!(validate(&r).is_err());
        r.duration = Some(4);
        r.size = "1920x1080".into();
        assert!(validate(&r).is_err());
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
        assert!(validate(&r).is_err());
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
        assert!(validate(&r).is_err());
        r.duration = Some(4);
        r.size = "1920x1080".into();
        assert!(validate(&r).is_err());
        r.size = "1280x720".into();
        r.reference = Some(png());
        assert!(validate(&r).is_err());
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
