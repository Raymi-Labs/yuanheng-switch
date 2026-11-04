//! DSH（DeepSeek Harness）写适配器。
//!
//! 格式以 DSH 0.2.1 自带的 `dsh-session-persistence-jsonl` 源码为准，并在隔离 `DSH_HOME`
//! 中用 `dsh --profile headless --session-id` 逐项实测（2026-11-03）：
//! - 路径 `sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd`。
//! - 多个 zstd 帧拼接，**首帧只能是一行头部**，否则报 "first frame is not exactly one header line"。
//! - 事件 `seq` 从 0 连续递增；`user/message`、`assistant/message` 顶层带 `surfaceOp: "append"`。
//! - 助手消息需要 `source.kind = "model"`，以及 `stream`、`usage` 结算字段（空数组即可）。
//! - 会话 id 用 `session-<uuid>`，与 DSH 自身一致。
//!
//! - 侧栏标题只从投影缓存 `storages/session_projcache/sessions/<id>.json` 读取；DSH 只在会话被
//!   打开时才生成缓存，没有缓存的同步会话会显示为 "Untitled"（2026-11-03 网页界面实测）。
//!   因此同时写一份最小缓存：只含 `title`、`titleInput`、`sessionListMetadata` 三行，
//!   身份字段与会话头一致。缓存只是加速项：DSH 打开会话时会从日志重算并整体覆盖它，
//!   缺失的行按初始值重新折叠，`ver` 不匹配的行直接丢弃，所以写错也不会产生错误数据。
//!
//! 写入前对 `session.lock` 取非阻塞 `flock`，与 DSH 自己的写锁互斥：DSH 正在写同一会话时放弃，
//! 不撕裂日志；锁文件写完保留，不删除（DSH 依赖其 inode 稳定）。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{file_fingerprint, SessionWriter, TargetRef};
use crate::session_manager::providers::dsh::{sessions_root, LOG_FILENAME};
use crate::session_sync::canonical::origin_title_prefix;
use crate::session_sync::CanonicalSession;

pub struct DshWriter;

const LOCK_FILENAME: &str = "session.lock";

fn is_safe_char(c: char) -> bool {
    c != '~' && (c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn escape_unit(out: &mut String, unit: u16) {
    out.push_str(&format!("~{unit:04X}"));
}

/// 与 DSH `encodeSegment` 一致：安全字符原样保留，其余按 UTF-16 码元转 `~XXXX`。
pub fn encode_segment(raw: &str) -> String {
    match raw {
        "." => return "~002E".into(),
        ".." => return "~002E~002E".into(),
        _ => {}
    }
    let mut out = String::new();
    for c in raw.chars() {
        if is_safe_char(c) {
            out.push(c);
        } else {
            let mut buf = [0u16; 2];
            for unit in c.encode_utf16(&mut buf) {
                escape_unit(&mut out, *unit);
            }
        }
    }
    out
}

/// 与 DSH `projectKey` 一致：分隔符合并成一个 `-`，其余转义，去掉开头的 `-`，截断 251 个码元，两侧加 `--`。
pub fn project_key(cwd: &str) -> String {
    let mut readable = String::new();
    let mut separator_run = false;
    for c in cwd.chars() {
        if matches!(c, '/' | '\\' | ':') {
            if !separator_run {
                readable.push('-');
            }
            separator_run = true;
        } else if is_safe_char(c) {
            readable.push(c);
            separator_run = false;
        } else {
            let mut buf = [0u16; 2];
            for unit in c.encode_utf16(&mut buf) {
                escape_unit(&mut readable, *unit);
            }
            separator_run = false;
        }
    }
    let trimmed = readable.trim_start_matches('-');
    let base = if trimmed.is_empty() { "root" } else { trimmed };
    // 编码结果只含 ASCII，按字符截断等同按 UTF-16 码元截断
    let cut: String = base.chars().take(251).collect();
    format!("--{cut}--")
}

pub fn dsh_session_id(target_session_id: &str) -> String {
    format!("session-{target_session_id}")
}

pub fn log_path(root: &Path, cwd: &str, session_id: &str) -> PathBuf {
    root.join(project_key(cwd))
        .join(encode_segment(session_id))
        .join(LOG_FILENAME)
}

/// 生成会话日志后，按 DSH 投影规则算出的列表摘要（标题与首条用户消息）。
pub struct ListHints {
    pub title: Option<(String, usize)>,
    pub first_user: Option<(usize, String)>,
    pub user_count: usize,
    pub last_user_seq: Option<usize>,
    pub last_prompt_at: Option<i64>,
    pub end_seq: usize,
}

/// 生成两帧：头部一帧、全部事件一帧。
pub fn build_log(session: &CanonicalSession, session_id: &str) -> (Value, Vec<Value>) {
    let header = json!({
        "type": "session",
        "version": 4,
        "id": session_id,
        "createdAt": session.created_at,
        "cwd": session.project_dir,
        "isSeeded": false,
        "delegationDepth": 0,
    });

    let mut events: Vec<Value> = Vec::new();
    let push = |events: &mut Vec<Value>, kind: &str, time: i64, data: Value, append: bool| {
        let seq = events.len();
        let mut event = json!({"type": kind, "seq": seq, "time": time, "data": data});
        if append {
            event["surfaceOp"] = json!("append");
        }
        events.push(event);
        seq
    };

    let mut turn = 0u64;
    let mut first_user_seq: Option<usize> = None;
    let mut last_time = session.created_at;
    let mut index = 0usize;
    while index < session.turns.len() {
        let user = &session.turns[index];
        if user.role != "user" {
            index += 1;
            continue;
        }
        turn += 1;
        let t = user
            .ts
            .unwrap_or(session.created_at + index as i64)
            .max(last_time);
        push(&mut events, "turn/start", t, json!({"turn": turn}), false);
        let user_seq = push(
            &mut events,
            "user/message",
            t,
            json!({
                "content": [{"type": "text", "text": user.text}],
                "source": {"kind": "user"},
                "role": "user",
                "id": super::line_uuid(session_id, index),
            }),
            true,
        );
        first_user_seq.get_or_insert(user_seq);
        last_time = t;
        index += 1;

        let mut step = 0u64;
        while index < session.turns.len() && session.turns[index].role == "assistant" {
            let reply = &session.turns[index];
            step += 1;
            let at = reply.ts.unwrap_or(last_time + 1).max(last_time);
            push(
                &mut events,
                "step/start",
                at,
                json!({"turn": turn, "step": step}),
                false,
            );
            push(
                &mut events,
                "assistant/message",
                at,
                json!({
                    "turn": turn,
                    "step": step,
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": reply.text}],
                        "source": {
                            "kind": "model",
                            "provider": "meta-api-sync",
                            "model": format!("{}-import", session.origin_provider),
                        },
                        "id": super::line_uuid(session_id, index),
                    },
                    "stream": [],
                    "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
                }),
                true,
            );
            push(
                &mut events,
                "step/end",
                at,
                json!({"turn": turn, "step": step}),
                false,
            );
            last_time = at;
            index += 1;
        }
        push(
            &mut events,
            "turn/end",
            last_time,
            json!({"turn": turn, "reason": {"kind": "completed"}}),
            false,
        );
    }
    if let Some(seq) = first_user_seq {
        let title = format!(
            "{}{}",
            origin_title_prefix(&session.origin_provider),
            session.title
        );
        push(
            &mut events,
            "session/title",
            last_time,
            json!({"title": title, "messageSeqs": [seq], "source": {"kind": "fallback"}}),
            false,
        );
    }

    (header, events)
}

pub fn encode_log(header: &Value, events: &[Value]) -> Result<Vec<u8>, String> {
    let encode = |text: &str| {
        zstd::stream::encode_all(text.as_bytes(), 3).map_err(|e| format!("压缩 DSH 会话失败: {e}"))
    };
    let mut out = encode(&format!("{header}\n"))?;
    let body: String = events.iter().map(|e| format!("{e}\n")).collect();
    out.extend(encode(&body)?);
    Ok(out)
}

#[cfg(test)]
pub fn render(session: &CanonicalSession, session_id: &str) -> Result<Vec<u8>, String> {
    let (header, events) = build_log(session, session_id);
    encode_log(&header, &events)
}

/// 按 DSH 的投影规则（`dsh-session-title` 与 `dsh-api-session-controller`）从事件算出列表摘要。
pub fn list_hints(events: &[Value]) -> ListHints {
    let mut hints = ListHints {
        title: None,
        first_user: None,
        user_count: 0,
        last_user_seq: None,
        last_prompt_at: None,
        end_seq: 0,
    };
    for event in events {
        let seq = event["seq"].as_u64().unwrap_or(0) as usize;
        hints.end_seq = seq;
        match event["type"].as_str() {
            Some("session/title") => {
                if let Some(t) = event["data"]["title"].as_str() {
                    hints.title = Some((t.to_string(), seq));
                }
            }
            Some("user/message") if event["data"]["source"]["kind"] == "user" => {
                let text = event["data"]["content"]
                    .as_array()
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter(|b| b["type"] == "text")
                            .filter_map(|b| b["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default();
                hints.user_count += 1;
                hints.first_user.get_or_insert((seq, text));
                hints.last_user_seq = Some(seq);
                hints.last_prompt_at = event["time"].as_i64();
            }
            _ => {}
        }
    }
    hints
}

/// 最小投影缓存：只给侧栏需要的三行。行的 `ver` 必须与 DSH 当前投影版本一致，
/// 否则 DSH 会丢弃该行（不会出错，只是仍显示 Untitled）。
pub fn render_projection_cache(header: &Value, events: &[Value]) -> Value {
    let hints = list_hints(events);
    let seq = hints.end_seq;
    let title_input = match (&hints.first_user, hints.last_user_seq) {
        (Some((first_seq, text)), Some(last)) => json!({
            "first": {"seq": first_seq, "text": text},
            "count": hints.user_count,
            "lastSeq": last,
        }),
        _ => json!({"first": null, "count": 0, "lastSeq": null}),
    };
    json!({
        "version": 7,
        "record": {
            "identity": {
                "formatVersion": header["version"],
                "createdAt": header["createdAt"],
                "cwd": header["cwd"],
                "isSeeded": false,
                "inheritedEventCount": 0,
            },
            "rows": {
                "title": {"ver": 1, "seq": seq, "val": hints.title.map(|(t, _)| t)},
                "titleInput": {"ver": 3, "seq": seq, "val": title_input},
                "sessionListMetadata": {
                    "ver": 1,
                    "seq": seq,
                    "val": {"blank": false, "lastPromptAt": hints.last_prompt_at},
                },
            },
        },
    })
}

fn projection_cache_path(session_id: &str) -> PathBuf {
    crate::commands::dsh_install::home()
        .join("storages")
        .join("session_projcache")
        .join("sessions")
        .join(format!("{session_id}.json"))
}

/// 写投影缓存（同目录临时文件 + rename）。失败只记日志：缓存缺失只影响标题显示。
fn write_projection_cache(session_id: &str, cache: &Value) {
    let path = projection_cache_path(session_id);
    let result = (|| -> Result<(), String> {
        let dir = path.parent().ok_or("invalid cache path")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(cache).map_err(|e| e.to_string())?
        );
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })
    })();
    if let Err(e) = result {
        log::warn!("[session-sync] 写 DSH 标题缓存失败 {session_id}: {e}");
    }
}

/// 持有 DSH 会话写锁期间执行 `f`；锁被占用（DSH 正在写）时返回错误。
#[cfg(unix)]
fn with_session_lock<T>(dir: &Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    use std::os::unix::io::AsRawFd;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建 DSH 会话目录失败: {e}"))?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(dir.join(LOCK_FILENAME))
        .map_err(|e| format!("打开 DSH 会话锁失败: {e}"))?;
    let rc = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        return Err("DSH 正在使用这个会话，稍后再同步".into());
    }
    let result = f();
    unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_UN) };
    result
}

/// Windows 上 DSH 用命名信号量而非锁文件，这里不支持写入。
#[cfg(not(unix))]
fn with_session_lock<T>(_dir: &Path, _f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    Err("当前系统暂不支持写入 DSH 会话".into())
}

impl SessionWriter for DshWriter {
    fn write(
        &self,
        session: &CanonicalSession,
        target_session_id: &str,
    ) -> Result<TargetRef, String> {
        let id = dsh_session_id(target_session_id);
        let path = log_path(&sessions_root(), &session.project_dir, &id);
        let dir = path
            .parent()
            .ok_or_else(|| format!("Invalid DSH path: {}", path.display()))?
            .to_path_buf();
        let (header, events) = build_log(session, &id);
        let bytes = encode_log(&header, &events)?;
        with_session_lock(&dir, || {
            let tmp = dir.join(format!(".{LOG_FILENAME}.meta-api.tmp"));
            std::fs::write(&tmp, &bytes).map_err(|e| format!("写入 DSH 会话失败: {e}"))?;
            std::fs::rename(&tmp, &path).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                format!("写入 DSH 会话失败: {e}")
            })
        })?;
        write_projection_cache(&id, &render_projection_cache(&header, &events));
        Ok(TargetRef {
            session_id: id,
            path: path.to_string_lossy().to_string(),
        })
    }

    fn fingerprint(&self, target: &TargetRef) -> Option<String> {
        file_fingerprint(Path::new(&target.path))
    }

    fn remove(&self, target: &TargetRef) -> Result<(), String> {
        let path = Path::new(&target.path);
        let dir = path
            .parent()
            .ok_or_else(|| format!("Invalid DSH target: {}", target.path))?;
        let root = sessions_root();
        if dir.parent().and_then(Path::parent) != Some(root.as_path()) {
            return Err(format!(
                "Refusing to remove outside DSH sessions: {}",
                dir.display()
            ));
        }
        if dir.file_name().and_then(|n| n.to_str())
            != Some(encode_segment(&target.session_id).as_str())
        {
            return Err(format!(
                "DSH session directory does not match id: {}",
                dir.display()
            ));
        }
        if !dir.exists() {
            return Ok(());
        }
        with_session_lock(dir, || Ok(()))?;
        std::fs::remove_dir_all(dir).map_err(|e| format!("删除 DSH 会话失败: {e}"))?;
        let _ = std::fs::remove_file(projection_cache_path(&target.session_id));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_sync::CanonicalTurn;

    #[test]
    fn path_encoding_matches_dsh() {
        // 与本机 DSH 生成的目录名一致
        assert_eq!(
            project_key("/Users/nanashiwang/Documents/Projects/meta-api"),
            "--Users-nanashiwang-Documents-Projects-meta-api--"
        );
        assert_eq!(
            project_key("/private/tmp/dshproj"),
            "--private-tmp-dshproj--"
        );
        assert_eq!(project_key("/a//b"), "--a-b--");
        assert_eq!(project_key("/"), "--root--");
        assert_eq!(project_key("/my proj/中"), "--my~0020proj-~4E2D--");
        assert_eq!(encode_segment("session-ab_c.d"), "session-ab_c.d");
        assert_eq!(encode_segment("a~b"), "a~007Eb");
        assert_eq!(encode_segment(".."), "~002E~002E");
    }

    fn sample() -> CanonicalSession {
        CanonicalSession {
            origin_provider: "codex".into(),
            origin_session_id: "s".into(),
            project_dir: "/p".into(),
            title: "t".into(),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_005_000,
            turns: vec![
                CanonicalTurn {
                    role: "user".into(),
                    text: "q1".into(),
                    ts: None,
                },
                CanonicalTurn {
                    role: "assistant".into(),
                    text: "a1".into(),
                    ts: None,
                },
                CanonicalTurn {
                    role: "user".into(),
                    text: "q2".into(),
                    ts: None,
                },
            ],
        }
    }

    #[test]
    fn render_has_header_frame_contiguous_seq_and_reads_back() {
        let bytes = render(&sample(), "session-x").unwrap();
        // 首帧独立可解且只有一行头部
        let magic = [0x28u8, 0xb5, 0x2f, 0xfd];
        let second = bytes[4..]
            .windows(4)
            .position(|w| w == magic)
            .map(|i| i + 4)
            .expect("two frames");
        let head = zstd::stream::decode_all(&bytes[..second]).unwrap();
        let head = String::from_utf8(head).unwrap();
        assert_eq!(head.lines().count(), 1);
        assert!(head.contains("\"type\":\"session\""));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p/s/session.v4.jsonl.zstd");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let events = crate::session_manager::providers::dsh::read_events(&path).unwrap();
        let seqs: Vec<i64> = events[1..]
            .iter()
            .map(|e| e["seq"].as_i64().unwrap())
            .collect();
        assert_eq!(seqs, (0..seqs.len() as i64).collect::<Vec<_>>());
        for e in &events[1..] {
            let t = e["type"].as_str().unwrap();
            if t == "user/message" || t == "assistant/message" {
                assert_eq!(e["surfaceOp"], "append");
            }
            if t == "assistant/message" {
                assert_eq!(e["data"]["message"]["source"]["kind"], "model");
                assert!(e["data"]["stream"].is_array());
                assert!(e["data"]["usage"].is_object());
            }
        }
        let messages = crate::session_manager::providers::dsh::load_messages(&path).unwrap();
        let texts: Vec<&str> = messages.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(texts, vec!["q1", "a1", "q2"]);
    }

    #[test]
    fn projection_cache_matches_the_log_and_dsh_row_versions() {
        let (header, events) = build_log(&sample(), "session-x");
        let cache = render_projection_cache(&header, &events);
        let identity = &cache["record"]["identity"];
        assert_eq!(identity["formatVersion"], 4);
        assert_eq!(identity["createdAt"], header["createdAt"]);
        assert_eq!(identity["cwd"], "/p");
        let rows = &cache["record"]["rows"];
        assert_eq!(rows["title"]["ver"], 1);
        assert_eq!(rows["title"]["val"], "[Codex] t");
        assert_eq!(rows["titleInput"]["ver"], 3);
        assert_eq!(rows["titleInput"]["val"]["count"], 2);
        assert_eq!(rows["titleInput"]["val"]["first"]["text"], "q1");
        assert_eq!(rows["sessionListMetadata"]["val"]["blank"], false);
        // 所有行的 seq 都是日志最后一个事件的 seq
        let end = events.last().unwrap()["seq"].clone();
        for key in ["title", "titleInput", "sessionListMetadata"] {
            assert_eq!(rows[key]["seq"], end);
        }
        // titleInput 的状态约束：first.seq <= lastSeq
        let first = rows["titleInput"]["val"]["first"]["seq"].as_u64().unwrap();
        let last = rows["titleInput"]["val"]["lastSeq"].as_u64().unwrap();
        assert!(first <= last);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_write_while_dsh_holds_the_lock() {
        use std::os::unix::io::AsRawFd;
        let dir = tempfile::tempdir().unwrap();
        let lock = std::fs::File::create(dir.path().join(LOCK_FILENAME)).unwrap();
        assert_eq!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let err = with_session_lock(dir.path(), || Ok(())).unwrap_err();
        assert!(err.contains("DSH 正在使用"));
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_UN) };
        assert!(with_session_lock(dir.path(), || Ok(())).is_ok());
    }
}
