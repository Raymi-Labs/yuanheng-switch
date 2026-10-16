//! First-party transport selection. Logical provider identity and credentials never change.
//! See .agents/notes/implemented/architecture/2026-10-17-client-route-selection.md.
use crate::{database::Database, provider::Provider};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SETTING: &str = "yuanheng_route_policy_v1";
const SERVICE: &str = "yuanheng-api";
const STALE: Duration = Duration::from_secs(900);
const ACTIVE: Duration = Duration::from_secs(900);
const COOLDOWN: Duration = Duration::from_secs(300);
const ROUND_GAP: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteId {
    #[default]
    Relay,
    Cloudflare,
}
impl RouteId {
    pub fn origin(self) -> &'static str {
        match self {
            Self::Relay => "https://meta-api.vip",
            Self::Cloudflare => "https://nan.meta-api.vip",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Auto,
    Fixed,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub mode: Mode,
    pub fixed_route_id: RouteId,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    policy: Policy,
    selected: RouteId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub route_id: RouteId,
    pub origin: String,
    pub successes: u8,
    pub samples: u8,
    pub cold_ok: bool,
    pub latency_ms: Option<u64>,
    pub jitter_ms: Option<u64>,
    pub error: Option<String>,
    pub stream_status: Option<String>,
}
impl Measurement {
    fn empty(route: RouteId) -> Self {
        Self {
            route_id: route,
            origin: route.origin().into(),
            successes: 0,
            samples: 0,
            cold_ok: false,
            latency_ms: None,
            jitter_ms: None,
            error: None,
            stream_status: None,
        }
    }
    fn healthy(&self) -> bool {
        self.cold_ok
            && self.successes == 3
            && self.samples == 3
            && self.stream_status.as_deref().is_none_or(|s| s == "ok")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub revision: u64,
    pub network_generation: u64,
    pub policy: Policy,
    pub selected_route_id: RouteId,
    pub status: String,
    pub operation_id: Option<String>,
    pub last_checked_at: Option<String>,
    pub reason: String,
    pub routes: Vec<Measurement>,
    pub core_running: bool,
}

struct State {
    status: Status,
    checked: Option<Instant>,
    last_activity: Instant,
    last_tick: Instant,
    next_probe: Instant,
    last_probe: Option<Instant>,
    last_switch: Option<Instant>,
    pending: Option<RouteId>,
    wins: u8,
    failures: u8,
    failed_rounds: u8,
    cancel: Option<Arc<tokio::sync::Notify>>,
    network: (u64, Option<std::net::IpAddr>, Option<std::net::IpAddr>),
}

pub struct Selector {
    db: Arc<Database>,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct RequestRoute {
    selector: Arc<Selector>,
    route: RouteId,
    generation: u64,
    applied: Arc<std::sync::atomic::AtomicBool>,
}

impl RequestRoute {
    /// Only the exact owned provider and canonical model endpoint may carry a token to a route.
    pub fn rewrite(&self, provider: &Provider, raw: &str) -> Option<String> {
        if !eligible(provider, raw) {
            return None;
        }
        self.selector.state.lock().unwrap().last_activity = Instant::now();
        let mut url = reqwest::Url::parse(raw).ok()?;
        let host = reqwest::Url::parse(self.route.origin()).ok()?;
        url.set_host(host.host_str()).ok()?;
        self.applied
            .store(true, std::sync::atomic::Ordering::Relaxed);
        Some(url.to_string())
    }
    pub fn observe(&self, transport_ok: bool) {
        if !self.applied.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let mut state = self.selector.state.lock().unwrap();
        if state.status.network_generation != self.generation
            || state.status.selected_route_id != self.route
        {
            return;
        }
        state.failures = if transport_ok {
            0
        } else {
            state.failures.saturating_add(1)
        };
        if state.failures >= 2 {
            if state.status.reason != "connection_failures" {
                state.status.revision += 1;
            }
            state.status.status = "degraded".into();
            state.status.reason = "connection_failures".into();
            state.next_probe = state
                .last_probe
                .map(|t| t + ROUND_GAP)
                .unwrap_or_else(Instant::now)
                .max(Instant::now());
        }
    }
}

pub fn eligible(provider: &Provider, raw: &str) -> bool {
    if provider.id != crate::commands::MANAGED_PROVIDER_ID
        || provider.category.as_deref() != Some("managed")
    {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("meta-api.vip")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && (url.path().starts_with("/v1/") || url.path().starts_with("/v1beta/"))
}

fn network_key() -> (u64, Option<std::net::IpAddr>, Option<std::net::IpAddr>) {
    // UDP connect only asks the OS for its default source address; it sends no packet.
    fn source(bind: &str, peer: &str) -> Option<std::net::IpAddr> {
        let socket = std::net::UdpSocket::bind(bind).ok()?;
        socket.connect(peer).ok()?;
        socket.local_addr().ok().map(|a| a.ip())
    }
    (
        crate::proxy::http_client::generation(),
        source("0.0.0.0:0", "192.0.2.1:443"),
        source("[::]:0", "[2001:db8::1]:443"),
    )
}

impl Selector {
    pub fn new(db: Arc<Database>) -> Arc<Self> {
        let saved = db
            .get_setting(SETTING)
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_str::<Saved>(&v).ok())
            .unwrap_or(Saved {
                policy: Policy::default(),
                selected: RouteId::Relay,
            });
        let selected = if saved.policy.mode == Mode::Fixed {
            saved.policy.fixed_route_id
        } else {
            saved.selected
        };
        let now = Instant::now();
        Arc::new(Self {
            db,
            state: Mutex::new(State {
                status: Status {
                    revision: 1,
                    network_generation: 1,
                    policy: saved.policy,
                    selected_route_id: selected,
                    status: "unknown".into(),
                    operation_id: None,
                    last_checked_at: None,
                    reason: "startup".into(),
                    routes: vec![
                        Measurement::empty(RouteId::Relay),
                        Measurement::empty(RouteId::Cloudflare),
                    ],
                    core_running: true,
                },
                checked: None,
                last_activity: now,
                last_tick: now,
                next_probe: now,
                last_probe: None,
                last_switch: None,
                pending: None,
                wins: 0,
                failures: 0,
                failed_rounds: 0,
                cancel: None,
                network: network_key(),
            }),
        })
    }
    pub fn status(&self) -> Status {
        let state = self.state.lock().unwrap();
        let mut status = state.status.clone();
        if state.cancel.is_none() && state.checked.is_some_and(|t| t.elapsed() > STALE) {
            status.status = "stale".into();
        }
        status
    }
    pub fn snapshot(self: &Arc<Self>) -> RequestRoute {
        let state = self.state.lock().unwrap();
        RequestRoute {
            selector: self.clone(),
            route: state.status.selected_route_id,
            generation: state.status.network_generation,
            applied: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
    pub fn set_policy(&self, policy: Policy, revision: u64) -> Result<Status, &'static str> {
        let mut state = self.state.lock().unwrap();
        if revision != state.status.revision {
            return Err("stale_revision");
        }
        let selected = if policy.mode == Mode::Fixed {
            policy.fixed_route_id
        } else {
            state.status.selected_route_id
        };
        let value = serde_json::to_string(&Saved {
            policy: policy.clone(),
            selected,
        })
        .map_err(|_| "save_failed")?;
        self.db
            .set_setting(SETTING, &value)
            .map_err(|_| "save_failed")?;
        if let Some(cancel) = state.cancel.take() {
            cancel.notify_one();
        }
        state.status.operation_id = None;
        state.status.policy = policy;
        state.status.selected_route_id = selected;
        state.status.revision += 1;
        state.status.reason = "user_choice".into();
        state.status.status = "unknown".into();
        state.last_switch = Some(Instant::now());
        state.last_activity = Instant::now();
        state.pending = None;
        state.wins = 0;
        state.failures = 0;
        state.next_probe = Instant::now();
        Ok(state.status.clone())
    }
    pub fn cancel(&self, id: &str) -> Result<Status, &'static str> {
        let mut state = self.state.lock().unwrap();
        if state.status.operation_id.as_deref() != Some(id) {
            return Err("stale_operation");
        }
        if let Some(cancel) = state.cancel.take() {
            cancel.notify_one();
        }
        state.status.operation_id = None;
        state.status.status = "unknown".into();
        state.status.reason = "cancelled".into();
        state.status.revision += 1;
        state.next_probe = Instant::now() + Duration::from_secs(600);
        Ok(state.status.clone())
    }
    /// Called by Core, independent of GUI visibility. Never waits for network I/O.
    pub fn tick(self: &Arc<Self>) {
        let due = {
            let mut state = self.state.lock().unwrap();
            let now = Instant::now();
            if now.duration_since(state.last_tick) < Duration::from_secs(5) {
                return;
            }
            let resumed = now.duration_since(state.last_tick) > Duration::from_secs(30);
            state.last_tick = now;
            let network = network_key();
            if network != state.network || resumed {
                state.network = network;
                if let Some(cancel) = state.cancel.take() {
                    cancel.notify_one();
                }
                state.status.operation_id = None;
                state.status.network_generation += 1;
                state.status.revision += 1;
                state.status.status = "unknown".into();
                state.status.reason = "network_changed".into();
                state.checked = None;
                state.pending = None;
                state.wins = 0;
                state.failures = 0;
                state.next_probe = now;
            }
            state.cancel.is_none()
                && now >= state.next_probe
                && state.last_activity.elapsed() <= ACTIVE
        };
        if due {
            let _ = self.probe(false, false);
        }
    }
    pub fn probe(self: &Arc<Self>, stream: bool, manual: bool) -> Result<Status, &'static str> {
        let (cancel, id, generation, client) = {
            let mut state = self.state.lock().unwrap();
            if state.cancel.is_some() {
                return Ok(state.status.clone());
            }
            if state
                .last_probe
                .is_some_and(|t| t.elapsed() < Duration::from_secs(5))
            {
                return Err("probe_too_frequent");
            }
            let client =
                crate::proxy::http_client::route_probe_client().map_err(|_| "connection_failed")?;
            let cancel = Arc::new(tokio::sync::Notify::new());
            let id = uuid::Uuid::new_v4().to_string();
            state.cancel = Some(cancel.clone());
            state.last_probe = Some(Instant::now());
            if manual {
                state.last_activity = Instant::now();
            }
            state.status.operation_id = Some(id.clone());
            state.status.status = "checking".into();
            state.status.revision += 1;
            (cancel, id, state.status.network_generation, client)
        };
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let work = async {
                tokio::join!(
                    measure(&client, RouteId::Relay, stream),
                    measure(&client, RouteId::Cloudflare, stream)
                )
            };
            let result = tokio::select! { _ = cancel.notified() => return, result = tokio::time::timeout(Duration::from_secs(20), work) => result };
            if let Some(selector) = weak.upgrade() {
                let routes = match result {
                    Ok((a, b)) => vec![a, b],
                    Err(_) => [RouteId::Relay, RouteId::Cloudflare]
                        .iter()
                        .map(|r| {
                            let mut m = Measurement::empty(*r);
                            m.error = Some("timeout".into());
                            m
                        })
                        .collect(),
                };
                selector.finish(&id, generation, routes, Instant::now());
            }
        });
        Ok(self.status())
    }
    fn finish(&self, id: &str, generation: u64, mut routes: Vec<Measurement>, now: Instant) {
        let mut state = self.state.lock().unwrap();
        if state.status.operation_id.as_deref() != Some(id)
            || state.status.network_generation != generation
        {
            return;
        }
        state.cancel = None;
        state.status.operation_id = None;
        let previous_checked = state.checked;
        // A lightweight HTTP round cannot disprove observed stream buffering.
        // Keep that evidence until another stream check or a network change.
        if previous_checked.is_some() {
            for route in &mut routes {
                if route.stream_status.is_none() {
                    route.stream_status = state
                        .status
                        .routes
                        .iter()
                        .find(|old| old.route_id == route.route_id)
                        .and_then(|old| old.stream_status.clone());
                }
            }
        }
        state.checked = Some(now);
        state.status.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
        state.status.routes = routes;
        state.status.revision += 1;
        let candidate = choose(&state.status.routes);
        let selected = state.status.selected_route_id;
        let current_ok = state
            .status
            .routes
            .iter()
            .any(|r| r.route_id == selected && r.healthy());
        let mut next = selected;
        state.status.reason = if state.status.policy.mode == Mode::Fixed {
            "fixed"
        } else {
            "stable"
        }
        .into();
        if state.status.policy.mode == Mode::Auto {
            if let Some(best) = candidate.filter(|best| *best != selected) {
                if !current_ok {
                    next = best;
                    state.status.reason = "failover".into();
                } else if clearly_better(&state.status.routes, best, selected) {
                    if state.pending == Some(best)
                        && previous_checked.is_some_and(|t| now.duration_since(t) >= ROUND_GAP)
                    {
                        state.wins = state.wins.saturating_add(1);
                    } else if state.pending != Some(best) {
                        state.pending = Some(best);
                        state.wins = 1;
                    }
                    if state.wins >= 2
                        && state
                            .last_switch
                            .is_none_or(|t| now.duration_since(t) >= COOLDOWN)
                    {
                        next = best;
                        state.status.reason = "faster".into();
                    }
                } else {
                    state.pending = None;
                    state.wins = 0;
                }
            } else {
                state.pending = None;
                state.wins = 0;
            }
        }
        if next != selected {
            let saved = Saved {
                policy: state.status.policy.clone(),
                selected: next,
            };
            if serde_json::to_string(&saved)
                .ok()
                .is_some_and(|v| self.db.set_setting(SETTING, &v).is_ok())
            {
                state.status.selected_route_id = next;
                state.last_switch = Some(now);
                state.pending = None;
                state.wins = 0;
                state.failures = 0;
            } else {
                state.status.reason = "save_failed".into();
            }
        }
        let selected_ok = state
            .status
            .routes
            .iter()
            .any(|r| r.route_id == state.status.selected_route_id && r.healthy());
        state.status.status = if selected_ok {
            "healthy"
        } else if candidate.is_some() {
            "degraded"
        } else {
            "unavailable"
        }
        .into();
        state.failed_rounds = if candidate.is_none() {
            state.failed_rounds.saturating_add(1)
        } else {
            0
        };
        let delay = if state.failed_rounds > 0 {
            (30_u64 << state.failed_rounds.min(4)).min(600)
        } else if state.pending.is_some() {
            30
        } else {
            480 + (uuid::Uuid::new_v4().as_u128() % 241) as u64
        };
        state.next_probe = now + Duration::from_secs(delay);
    }
}

fn choose(routes: &[Measurement]) -> Option<RouteId> {
    routes
        .iter()
        .filter(|r| r.healthy())
        .min_by_key(|r| {
            (
                r.jitter_ms.unwrap_or(u64::MAX) / 100,
                r.latency_ms.unwrap_or(u64::MAX),
            )
        })
        .map(|r| r.route_id)
}
fn clearly_better(routes: &[Measurement], best: RouteId, current: RouteId) -> bool {
    let a = routes.iter().find(|r| r.route_id == best);
    let b = routes.iter().find(|r| r.route_id == current);
    match (a.and_then(|r| r.latency_ms), b.and_then(|r| r.latency_ms)) {
        (Some(a), Some(b)) => {
            b.saturating_sub(a) >= 100 && a.saturating_mul(4) <= b.saturating_mul(3)
        }
        _ => false,
    }
}

#[derive(Deserialize)]
struct ProbeReply {
    version: u8,
    service: String,
    nonce: String,
}

fn uncached(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get("cache-control")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| {
            h.split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("no-store"))
        })
        && !headers
            .get("cf-cache-status")
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| {
                matches!(
                    h.to_ascii_uppercase().as_str(),
                    "HIT" | "STALE" | "UPDATING"
                )
            })
}

async fn read_bounded(
    mut response: reqwest::Response,
    max: usize,
) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "connection_failed")? {
        if bytes.len() + chunk.len() > max {
            return Err("invalid_response");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn probe_once(client: &reqwest::Client, origin: &str) -> Result<u64, &'static str> {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let started = Instant::now();
    let response = client
        .get(format!("{origin}/api/route-probe"))
        .query(&[("nonce", &nonce)])
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")
        .header(
            "User-Agent",
            concat!("YuanHeng-Desktop/", env!("CARGO_PKG_VERSION")),
        )
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "timeout"
            } else {
                "connection_failed"
            }
        })?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(match response.status().as_u16() {
            404 => "probe_not_supported",
            403 => "access_blocked",
            429 => "rate_limited",
            _ => "http_error",
        });
    }
    let headers = response.headers();
    if headers
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_none_or(|h| h.split(';').next() != Some("application/json"))
        || !uncached(headers)
    {
        return Err("invalid_response");
    }
    let bytes = read_bounded(response, 2048).await?;
    let reply: ProbeReply = serde_json::from_slice(&bytes).map_err(|_| "invalid_response")?;
    if reply.version != 1 || reply.service != SERVICE || reply.nonce != nonce {
        return Err("invalid_response");
    }
    Ok(started.elapsed().as_millis() as u64)
}

async fn measure(client: &reqwest::Client, route: RouteId, stream: bool) -> Measurement {
    let mut result = Measurement::empty(route);
    match probe_once(client, route.origin()).await {
        Ok(_) => result.cold_ok = true,
        Err(e) => result.error = Some(e.into()),
    }
    let mut latencies = Vec::new();
    for _ in 0..3 {
        result.samples += 1;
        match probe_once(client, route.origin()).await {
            Ok(ms) => {
                result.successes += 1;
                latencies.push(ms);
            }
            Err(error) => result.error = Some(error.into()),
        }
    }
    latencies.sort_unstable();
    if !latencies.is_empty() {
        result.latency_ms = Some(latencies[latencies.len() / 2]);
        result.jitter_ms = Some(latencies[latencies.len() - 1] - latencies[0]);
    }
    if stream && result.healthy() {
        result.stream_status = Some(
            match stream_probe(client, route.origin()).await {
                Ok(()) => "ok",
                Err(e) => e,
            }
            .into(),
        );
    }
    result
}

async fn stream_probe(client: &reqwest::Client, origin: &str) -> Result<(), &'static str> {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let work = async {
        let response = client
            .get(format!("{origin}/api/route-probe/stream"))
            .query(&[("nonce", &nonce)])
            .header("Accept", "text/event-stream")
            .header("Accept-Encoding", "identity")
            .header(
                "User-Agent",
                concat!("YuanHeng-Desktop/", env!("CARGO_PKG_VERSION")),
            )
            .timeout(Duration::from_secs(4))
            .send()
            .await
            .map_err(|_| "connection_failed")?;
        if response.status() != reqwest::StatusCode::OK
            || !uncached(response.headers())
            || response
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .is_none_or(|h| h.split(';').next() != Some("text/event-stream"))
        {
            return Err("invalid_response");
        }
        let mut body = response.bytes_stream();
        let mut buffer = String::new();
        let mut count = 0;
        let mut times = Vec::new();
        let mut total = 0;
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|_| "connection_failed")?;
            total += chunk.len();
            if total > 4096 {
                return Err("invalid_response");
            }
            buffer.push_str(std::str::from_utf8(&chunk).map_err(|_| "invalid_response")?);
            while let Some(end) = buffer.find("\n\n") {
                let frame: String = buffer.drain(..end + 2).collect();
                let data = frame
                    .trim()
                    .strip_prefix("data: ")
                    .ok_or("invalid_response")?;
                let value: serde_json::Value =
                    serde_json::from_str(data).map_err(|_| "invalid_response")?;
                if value["nonce"] != nonce
                    || value["service"] != SERVICE
                    || value["version"] != 1
                    || value["sequence"] != count
                {
                    return Err("invalid_response");
                }
                count += 1;
                times.push(Instant::now());
            }
        }
        if count != 3 || !buffer.trim().is_empty() {
            return Err("interrupted");
        }
        if times[1].duration_since(times[0]) < Duration::from_millis(150)
            || times[2].duration_since(times[1]) < Duration::from_millis(150)
        {
            return Err("buffered");
        }
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(4), work)
        .await
        .map_err(|_| "timeout")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Query, State},
        response::IntoResponse,
        routing::get,
        Json, Router,
    };
    use std::collections::HashMap;
    fn selector() -> Arc<Selector> {
        Selector::new(Arc::new(Database::memory().unwrap()))
    }
    fn good(route: RouteId, ms: u64) -> Measurement {
        let mut m = Measurement::empty(route);
        m.samples = 3;
        m.successes = 3;
        m.cold_ok = true;
        m.latency_ms = Some(ms);
        m.jitter_ms = Some(10);
        m
    }
    fn finish(s: &Selector, results: Vec<Measurement>, now: Instant) {
        let generation = {
            let mut state = s.state.lock().unwrap();
            state.status.operation_id = Some("round".into());
            state.status.network_generation
        };
        s.finish("round", generation, results, now);
    }
    fn provider() -> Provider {
        let mut p = Provider::with_id(
            crate::commands::MANAGED_PROVIDER_ID.into(),
            "YuanHeng".into(),
            serde_json::json!({}),
            None,
        );
        p.category = Some("managed".into());
        p
    }

    #[test]
    fn exact_owned_api_only_and_request_snapshot_is_pinned() {
        let s = selector();
        let p = provider();
        let old = s.snapshot();
        s.set_policy(
            Policy {
                mode: Mode::Fixed,
                fixed_route_id: RouteId::Cloudflare,
            },
            1,
        )
        .unwrap();
        assert_eq!(
            old.rewrite(&p, "https://meta-api.vip/v1/responses?x=1")
                .unwrap(),
            "https://meta-api.vip/v1/responses?x=1"
        );
        assert_eq!(
            s.snapshot()
                .rewrite(&p, "https://meta-api.vip/v1/messages")
                .unwrap(),
            "https://nan.meta-api.vip/v1/messages"
        );
        for url in [
            "http://meta-api.vip/v1/responses",
            "https://meta-api.vip:444/v1/responses",
            "https://u:p@meta-api.vip/v1/responses",
            "https://meta-api.vip.evil.test/v1/responses",
            "https://cn.meta-api.vip/v1/responses",
            "https://meta-api.vip/api/user/self",
            "https://meta-api.vip/v1/responses#fragment",
        ] {
            assert!(s.snapshot().rewrite(&p, url).is_none(), "{url}");
        }
        let mut other = p.clone();
        other.id = "custom".into();
        assert!(s
            .snapshot()
            .rewrite(&other, "https://meta-api.vip/v1/responses")
            .is_none());
    }
    #[test]
    fn fixed_mode_never_fails_over_and_revision_conflicts_preserve_it() {
        let s = selector();
        let saved = s
            .set_policy(
                Policy {
                    mode: Mode::Fixed,
                    fixed_route_id: RouteId::Relay,
                },
                1,
            )
            .unwrap();
        assert_eq!(
            s.set_policy(Policy::default(), 1).unwrap_err(),
            "stale_revision"
        );
        finish(
            &s,
            vec![
                Measurement::empty(RouteId::Relay),
                good(RouteId::Cloudflare, 100),
            ],
            Instant::now(),
        );
        assert_eq!(s.status().selected_route_id, RouteId::Relay);
        assert_eq!(s.status().status, "degraded");
        assert_eq!(
            Selector::new(s.db.clone()).status().policy.mode,
            saved.policy.mode
        );
    }
    #[test]
    fn unavailable_fails_over_but_fast_errors_never_win() {
        let s = selector();
        let mut bad = good(RouteId::Relay, 1);
        bad.successes = 0;
        bad.cold_ok = false;
        bad.error = Some("http_error".into());
        finish(
            &s,
            vec![bad, good(RouteId::Cloudflare, 200)],
            Instant::now(),
        );
        assert_eq!(s.status().selected_route_id, RouteId::Cloudflare);
        finish(
            &s,
            vec![
                Measurement::empty(RouteId::Relay),
                Measurement::empty(RouteId::Cloudflare),
            ],
            Instant::now(),
        );
        assert_eq!(s.status().status, "unavailable");
        assert_eq!(s.status().selected_route_id, RouteId::Cloudflare);
    }
    #[test]
    fn latency_switch_requires_independent_rounds_and_cooldown() {
        let s = selector();
        let now = Instant::now();
        let rows = vec![good(RouteId::Relay, 450), good(RouteId::Cloudflare, 200)];
        finish(&s, rows.clone(), now);
        assert_eq!(s.status().selected_route_id, RouteId::Relay);
        finish(&s, rows.clone(), now + Duration::from_secs(2));
        assert_eq!(s.status().selected_route_id, RouteId::Relay);
        finish(&s, rows, now + Duration::from_secs(32));
        assert_eq!(s.status().selected_route_id, RouteId::Cloudflare);
        let reverse = vec![good(RouteId::Relay, 100), good(RouteId::Cloudflare, 450)];
        finish(&s, reverse.clone(), now + Duration::from_secs(62));
        finish(&s, reverse, now + Duration::from_secs(92));
        assert_eq!(s.status().selected_route_id, RouteId::Cloudflare);
        assert!(!clearly_better(
            &[good(RouteId::Relay, 180), good(RouteId::Cloudflare, 200)],
            RouteId::Relay,
            RouteId::Cloudflare
        ));
    }
    #[test]
    fn cancelled_or_previous_network_results_cannot_publish() {
        let s = selector();
        {
            let mut st = s.state.lock().unwrap();
            st.status.operation_id = Some("old".into());
            st.cancel = Some(Arc::new(tokio::sync::Notify::new()));
        }
        let before = s.cancel("old").unwrap();
        s.finish(
            "old",
            1,
            vec![good(RouteId::Cloudflare, 100)],
            Instant::now(),
        );
        assert_eq!(s.status().revision, before.revision);
        {
            let mut st = s.state.lock().unwrap();
            st.status.operation_id = Some("new".into());
            st.status.network_generation = 2;
        }
        s.finish(
            "new",
            1,
            vec![good(RouteId::Cloudflare, 100)],
            Instant::now(),
        );
        assert_eq!(s.status().operation_id.as_deref(), Some("new"));
    }
    #[test]
    fn cold_failures_and_buffered_stream_are_not_healthy() {
        let mut m = good(RouteId::Relay, 10);
        m.cold_ok = false;
        assert!(!m.healthy());
        m.cold_ok = true;
        m.stream_status = Some("buffered".into());
        assert!(!m.healthy());
    }
    #[test]
    fn unavailable_network_does_not_clear_fixed_preference() {
        let s = selector();
        s.set_policy(
            Policy {
                mode: Mode::Fixed,
                fixed_route_id: RouteId::Cloudflare,
            },
            1,
        )
        .unwrap();
        finish(
            &s,
            vec![
                Measurement::empty(RouteId::Relay),
                Measurement::empty(RouteId::Cloudflare),
            ],
            Instant::now(),
        );
        assert_eq!(
            Selector::new(s.db.clone()).status().selected_route_id,
            RouteId::Cloudflare
        );
    }
    #[test]
    fn errors_only_observed_for_actual_routes_and_current_generation() {
        let s = selector();
        let r = s.snapshot();
        r.observe(false);
        r.observe(false);
        assert_eq!(s.state.lock().unwrap().failures, 0);
        r.rewrite(&provider(), "https://meta-api.vip/v1/messages");
        r.observe(false);
        r.observe(false);
        assert_eq!(s.status().status, "degraded");
        s.state.lock().unwrap().status.network_generation += 1;
        r.observe(true);
        assert_eq!(s.state.lock().unwrap().failures, 2);
    }
    async fn endpoint(
        State(kind): State<String>,
        Query(q): Query<HashMap<String, String>>,
    ) -> axum::response::Response {
        let mut reply = serde_json::json!({"version":1,"service":SERVICE,"nonce":q.get("nonce")});
        if kind == "wrong" {
            reply["nonce"] = serde_json::json!("cached");
        }
        if kind == "redirect" {
            return (
                axum::http::StatusCode::TEMPORARY_REDIRECT,
                [("location", "/trap")],
                "redirect",
            )
                .into_response();
        }
        if kind == "error" {
            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "fast error").into_response();
        }
        if kind == "oversize" {
            return (
                [
                    ("content-type", "application/json"),
                    ("cache-control", "no-store"),
                ],
                "x".repeat(4096),
            )
                .into_response();
        }
        (
            [(
                "cache-control",
                if kind == "cached" {
                    "public"
                } else {
                    "no-store"
                },
            )],
            Json(reply),
        )
            .into_response()
    }
    async fn server(kind: &str) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = Router::new()
            .route("/api/route-probe", get(endpoint))
            .with_state(kind.to_string());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (format!("http://{addr}"), task)
    }
    #[tokio::test]
    async fn actual_http_probe_rejects_errors_cache_nonce_redirect_and_size() {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        for (kind, error) in [
            ("ok", None),
            ("wrong", Some("invalid_response")),
            ("cached", Some("invalid_response")),
            ("redirect", Some("http_error")),
            ("error", Some("http_error")),
            ("oversize", Some("invalid_response")),
        ] {
            let (url, task) = server(kind).await;
            let result = probe_once(&client, &url).await;
            task.abort();
            if let Some(error) = error {
                assert_eq!(result.unwrap_err(), error, "{kind}");
            } else {
                assert!(result.is_ok());
            }
        }
    }

    async fn sse_endpoint(
        State(kind): State<String>,
        Query(q): Query<HashMap<String, String>>,
    ) -> axum::response::Response {
        let frames=(0..if kind=="interrupted" {2} else {3}).map(|sequence| {
            format!("data: {}\n\n",serde_json::json!({"version":1,"service":SERVICE,"nonce":q.get("nonce"),"sequence":sequence}))
        }).collect::<Vec<_>>();
        let delayed = kind == "ok" || kind == "interrupted";
        let stream =
            futures::stream::iter(frames)
                .enumerate()
                .then(move |(index, frame)| async move {
                    if delayed && index > 0 {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                    Ok::<_, std::convert::Infallible>(frame)
                });
        axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-store")
            .body(axum::body::Body::from_stream(stream))
            .unwrap()
    }
    #[tokio::test]
    async fn actual_stream_checks_delivery_timing_and_completion() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for (kind, expected) in [
            ("ok", Ok(())),
            ("buffered", Err("buffered")),
            ("interrupted", Err("interrupted")),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let router = Router::new()
                .route("/api/route-probe/stream", get(sse_endpoint))
                .with_state(kind.to_string());
            let task = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            assert_eq!(
                stream_probe(&client, &format!("http://{addr}")).await,
                expected,
                "{kind}"
            );
            task.abort();
        }
    }
    #[test]
    fn http_only_checks_preserve_stream_failure_and_failed_rounds_back_off() {
        let s = selector();
        let mut m = good(RouteId::Relay, 10);
        m.stream_status = Some("buffered".into());
        let now = Instant::now();
        finish(&s, vec![m, Measurement::empty(RouteId::Cloudflare)], now);
        finish(
            &s,
            vec![
                good(RouteId::Relay, 10),
                Measurement::empty(RouteId::Cloudflare),
            ],
            now + Duration::from_secs(60),
        );
        assert_eq!(s.status().status, "unavailable");
        assert_eq!(
            s.state.lock().unwrap().next_probe.duration_since(now),
            Duration::from_secs(180)
        );
        let mut recovered = good(RouteId::Relay, 10);
        recovered.stream_status = Some("ok".into());
        finish(
            &s,
            vec![recovered, Measurement::empty(RouteId::Cloudflare)],
            now + Duration::from_secs(180),
        );
        assert_eq!(s.status().status, "healthy");
    }
}
