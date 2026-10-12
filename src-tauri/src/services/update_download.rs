//! Bounded, resumable downloads of the same signed release from our two origins.
//! The Tauri installer is only called after verification with its configured key.
use base64::{engine::general_purpose::STANDARD, Engine};
use futures::{stream::FuturesUnordered, StreamExt};
use minisign_verify::{PublicKey, Signature};
use reqwest::{header, Client, Response, StatusCode};
use std::time::Duration;
use tauri_plugin_updater::Update;
use tokio::time::{timeout, Instant};
use url::Url;

const MAX_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Copy)]
struct Policy {
    sample: usize,
    probe_timeout: Duration,
    stall_timeout: Duration,
    slow_window: Duration,
    slow_bytes_per_second: usize,
    overall_timeout: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            sample: 256 * 1024,
            probe_timeout: Duration::from_secs(6),
            stall_timeout: Duration::from_secs(15),
            slow_window: Duration::from_secs(8),
            slow_bytes_per_second: 128 * 1024,
            overall_timeout: Duration::from_secs(30 * 60),
        }
    }
}

/// Derive an alternative only for an exact, versioned asset belonging to us.
/// Unknown/CDN URLs keep the standard updater behavior and are never rewritten.
fn official_sources(url: &Url, version: &str) -> Option<Vec<Url>> {
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    for suffix in ["aarch64.app.tar.gz", "x64.app.tar.gz", "x64-setup.exe"] {
        let name = format!("YuanHeng.Desktop_{version}_{suffix}");
        let mirror = Url::parse(&format!(
            "https://meta-api.vip/desktop/update/releases/{version}/{name}"
        ))
        .ok()?;
        let github = Url::parse(&format!(
            "https://github.com/nanashiwang/yuanheng-switch/releases/download/v{version}/{name}"
        ))
        .ok()?;
        if *url == mirror {
            return Some(vec![mirror, github]);
        }
        if *url == github {
            return Some(vec![github, mirror]);
        }
    }
    None
}

fn verify(bytes: &[u8], public_key: &str, signature: &str) -> Result<(), String> {
    let decode = |value: &str| {
        STANDARD
            .decode(value)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or_else(|| "更新签名格式无效".to_string())
    };
    let key =
        PublicKey::decode(&decode(public_key)?).map_err(|_| "更新公钥格式无效".to_string())?;
    let signature =
        Signature::decode(&decode(signature)?).map_err(|_| "更新签名格式无效".to_string())?;
    key.verify(bytes, &signature, true)
        .map_err(|_| "更新包签名校验失败".to_string())
}

pub async fn download(
    update: &Update,
    public_key: &str,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<Vec<u8>, String> {
    let Some(sources) = official_sources(&update.download_url, &update.version) else {
        let mut downloaded = 0;
        return timeout(
            Policy::default().overall_timeout,
            update.download(
                |size, total| {
                    downloaded += size as u64;
                    progress(downloaded, total);
                },
                || {},
            ),
        )
        .await
        .map_err(|_| "更新下载超时，请重试".to_string())?
        .map_err(|_| "下载更新失败，请重试或从官方下载页安装".to_string());
    };
    // Do not forward arbitrary manifest-request headers to the other origin.
    let mut builder = Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .user_agent("YuanHeng-Desktop-Updater")
        .redirect(reqwest::redirect::Policy::limited(5));
    if update.no_proxy {
        builder = builder.no_proxy();
    } else if let Some(proxy) = &update.proxy {
        builder = builder.proxy(
            reqwest::Proxy::all(proxy.as_str()).map_err(|_| "更新代理配置无效".to_string())?,
        );
    }
    let client = builder
        .build()
        .map_err(|_| "无法初始化更新下载".to_string())?;
    download_from_sources(
        &client,
        &sources,
        Policy::default(),
        |bytes| verify(bytes, public_key, &update.signature),
        &mut progress,
    )
    .await
}

#[derive(Default)]
struct Partial {
    bytes: Vec<u8>,
    total: Option<usize>,
}

impl Partial {
    fn clear(&mut self) {
        self.bytes.clear();
        self.total = None;
    }
}

fn content_range(value: &str) -> Result<(usize, usize, usize), String> {
    let invalid = || "下载服务器返回了无效的文件范围".to_string();
    let (range, total) = value
        .strip_prefix("bytes ")
        .ok_or_else(invalid)?
        .split_once('/')
        .ok_or_else(invalid)?;
    let (start, end) = range.split_once('-').ok_or_else(invalid)?;
    let (start, end, total) = (
        start.parse::<usize>().map_err(|_| invalid())?,
        end.parse::<usize>().map_err(|_| invalid())?,
        total.parse::<usize>().map_err(|_| invalid())?,
    );
    if start > end || end >= total || total > MAX_BYTES {
        return Err(invalid());
    }
    Ok((start, end, total))
}

fn prepare_response(
    response: &Response,
    partial: &mut Partial,
    sample: Option<usize>,
) -> Result<Option<usize>, String> {
    if response
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|v| v != "identity")
    {
        return Err("下载服务器返回了不支持的文件编码".into());
    }
    match response.status() {
        StatusCode::PARTIAL_CONTENT => {
            let raw = response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .ok_or("下载响应缺少文件范围")?;
            let (start, end, total) = content_range(raw)?;
            let expected_end = sample.map_or(total - 1, |size| (size - 1).min(total - 1));
            if start != partial.bytes.len()
                || end != expected_end
                || partial.total.is_some_and(|old| old != total)
                || response
                    .content_length()
                    .is_some_and(|n| n != (end - start + 1) as u64)
            {
                return Err("下载文件范围或长度不一致".into());
            }
            partial.total = Some(total);
            Ok(Some(end + 1))
        }
        StatusCode::OK => {
            // Range ignored: a 200 response is a new complete representation.
            partial.clear();
            if let Some(length) = response.content_length() {
                if length == 0 || length > MAX_BYTES as u64 {
                    return Err("更新包大小超出限制".into());
                }
                partial.total = Some(length as usize);
            }
            Ok(partial.total)
        }
        _ => Err(format!(
            "下载服务器暂不可用（HTTP {}）",
            response.status().as_u16()
        )),
    }
}

async fn transfer(
    client: &Client,
    url: &Url,
    partial: &mut Partial,
    policy: Policy,
    sample: Option<usize>,
    switch_if_slow: bool,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> Result<(), String> {
    let range = match sample {
        Some(size) => format!("bytes=0-{}", size - 1),
        None => format!("bytes={}-", partial.bytes.len()),
    };
    let response = timeout(
        policy.stall_timeout,
        client
            .get(url.clone())
            .header(header::ACCEPT_ENCODING, "identity")
            .header(header::RANGE, range)
            .send(),
    )
    .await
    .map_err(|_| "下载连接超时".to_string())?
    .map_err(|_| "下载连接失败".to_string())?;
    let end = match prepare_response(&response, partial, sample) {
        Ok(end) => end,
        Err(error) => {
            // An invalid range/length must not poison every later attempt.
            partial.clear();
            progress(0, None);
            return Err(error);
        }
    };
    progress(partial.bytes.len() as u64, partial.total.map(|n| n as u64));
    let mut stream = response.bytes_stream();
    let mut window_start = Instant::now();
    let mut window_bytes = partial.bytes.len();
    loop {
        let chunk = timeout(policy.stall_timeout, stream.next())
            .await
            .map_err(|_| "下载长时间没有进展".to_string())?;
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk.map_err(|_| "下载连接中断".to_string())?;
        let new_size = partial.bytes.len().saturating_add(chunk.len());
        if new_size > MAX_BYTES || end.is_some_and(|n| new_size > n) {
            partial.clear();
            progress(0, None);
            return Err("更新包数据长度超出预期".into());
        }
        let keep = sample.map_or(chunk.len(), |limit| {
            chunk.len().min(limit - partial.bytes.len())
        });
        partial.bytes.extend_from_slice(&chunk[..keep]);
        progress(partial.bytes.len() as u64, partial.total.map(|n| n as u64));
        if sample.is_some_and(|limit| partial.bytes.len() >= limit) {
            return Ok(());
        }
        let elapsed = window_start.elapsed();
        if switch_if_slow && elapsed >= policy.slow_window {
            let speed = (partial.bytes.len() - window_bytes) as f64 / elapsed.as_secs_f64();
            if speed < policy.slow_bytes_per_second as f64
                && partial.total != Some(partial.bytes.len())
            {
                return Err("当前下载线路持续低速".into());
            }
            window_start = Instant::now();
            window_bytes = partial.bytes.len();
        }
    }
    if partial.bytes.is_empty() || end.is_some_and(|n| partial.bytes.len() != n) {
        return Err("更新包下载不完整".into());
    }
    if sample.is_none() {
        partial.total = Some(partial.bytes.len());
    }
    Ok(())
}

async fn download_from_sources(
    client: &Client,
    sources: &[Url],
    policy: Policy,
    verify: impl Fn(&[u8]) -> Result<(), String>,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> Result<Vec<u8>, String> {
    if sources.is_empty() {
        return Err("没有可用下载源".into());
    }
    timeout(policy.overall_timeout, async {
        let mut partial = Partial::default();
        let mut selected = 0;
        // Only sample a small prefix. Dropping the remaining futures closes the
        // losing streams, rather than downloading two complete installers.
        let mut probes = FuturesUnordered::new();
        for (index, url) in sources.iter().enumerate() {
            probes.push(async move {
                let mut prefix = Partial::default();
                timeout(
                    policy.probe_timeout,
                    transfer(
                        client,
                        url,
                        &mut prefix,
                        policy,
                        Some(policy.sample),
                        false,
                        &mut |_, _| {},
                    ),
                )
                .await
                .ok()?
                .ok()?;
                Some((index, prefix))
            });
        }
        while let Some(result) = probes.next().await {
            if let Some((index, prefix)) = result {
                selected = index;
                partial = prefix;
                break;
            }
        }
        drop(probes);
        let mut last_error = "下载更新失败，请重试".to_string();
        for attempt in 0..sources.len() * 2 {
            let index = (selected + attempt) % sources.len();
            log::info!(
                "[Updater] Download attempt {}, source {}, offset {}",
                attempt + 1,
                index + 1,
                partial.bytes.len()
            );
            let result = if partial.total == Some(partial.bytes.len()) && !partial.bytes.is_empty()
            {
                Ok(())
            } else {
                // Second pass accepts slow-but-working links instead of endlessly switching.
                transfer(
                    client,
                    &sources[index],
                    &mut partial,
                    policy,
                    None,
                    attempt + 1 < sources.len(),
                    progress,
                )
                .await
            };
            match result {
                Ok(()) => match verify(&partial.bytes) {
                    Ok(()) => return Ok(partial.bytes),
                    Err(error) => {
                        last_error = error;
                        partial.clear();
                        progress(0, None);
                    }
                },
                Err(error) => {
                    last_error = error;
                    // A complete but invalid response must not skip the next request.
                    if partial.total == Some(partial.bytes.len()) {
                        partial.clear();
                        progress(0, None);
                    }
                }
            }
        }
        Err(format!("{last_error}；请重试或从官方下载页安装"))
    })
    .await
    .map_err(|_| "更新下载超时，请重试".to_string())?
}

#[cfg(test)]
mod tests;
