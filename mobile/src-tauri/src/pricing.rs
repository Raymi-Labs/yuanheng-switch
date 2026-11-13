//! Compatibility reader for the current non-paginated pricing API.
//! Skip unused metadata during deserialization, before constructing any Value.
use futures_util::StreamExt;
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::{
    fmt,
    io::{self, BufReader, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

const WIRE_LIMIT: usize = 64 * 1024 * 1024;
const COMPACT_LIMIT: usize = 8 * 1024 * 1024;
const NODE_LIMIT: usize = 100_000;
const DEPTH_LIMIT: usize = 32;
const MODEL_FIELDS: &[&str] = &[
    "model_name",
    "display_name",
    "description",
    "tags",
    "icon",
    "vendor_id",
    "quota_type",
    "model_ratio",
    "completion_ratio",
    "model_price",
    "audio_duration_price",
    "enable_groups",
    "supported_endpoint_types",
    "context_length",
    "max_output_tokens",
    "release_date",
    "capabilities",
    "billing_mode",
    "billing_expr",
    "owner_by",
    "input_modalities",
    "output_modalities",
    "supports_cache_read",
    "cache_ratio",
];
const ROOT_FIELDS: &[&str] = &[
    "success",
    "message",
    "vendors",
    "group_ratio",
    "usable_group",
    "auto_groups",
    "time_ratio",
    "time_ratio_at",
];

// Budget encoded output before appending each value; never build a whole retained
// array/object and then measure it. The JSON decoder's temporary string buffer is
// separately bounded by the wire limit, not by this retained-data budget.
struct Budget {
    bytes: usize,
    nodes: usize,
}
impl Budget {
    fn charge<E: de::Error>(&mut self, bytes: usize) -> Result<(), E> {
        self.bytes = self
            .bytes
            .checked_sub(bytes)
            .ok_or_else(|| E::custom("compact catalogue exceeds budget"))?;
        Ok(())
    }
    fn node<E: de::Error>(&mut self) -> Result<(), E> {
        self.nodes = self
            .nodes
            .checked_sub(1)
            .ok_or_else(|| E::custom("catalogue has too many values"))?;
        Ok(())
    }
    fn string<E: de::Error>(&mut self, text: &str) -> Result<(), E> {
        let bytes = 2 + text
            .chars()
            .map(|c| match c {
                '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
                c if c <= '\u{1f}' => 6,
                c => c.len_utf8(),
            })
            .sum::<usize>();
        self.charge(bytes)
    }
}

struct ValueSeed<'a> {
    budget: &'a mut Budget,
    depth: usize,
}
impl<'de> DeserializeSeed<'de> for ValueSeed<'_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        if self.depth > DEPTH_LIMIT {
            return Err(de::Error::custom("catalogue nesting too deep"));
        }
        self.budget.node()?;
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for ValueSeed<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded JSON value")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        self.budget.charge(if v { 4 } else { 5 })?;
        Ok(Value::Bool(v))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        self.budget.charge(4)?;
        Ok(Value::Null)
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        self.budget.charge(v.to_string().len())?;
        Ok(v.into())
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        self.budget.charge(v.to_string().len())?;
        Ok(v.into())
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        let n = serde_json::Number::from_f64(v).ok_or_else(|| E::custom("invalid number"))?;
        self.budget.charge(n.to_string().len())?;
        Ok(Value::Number(n))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        self.budget.string(v)?;
        Ok(Value::String(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        self.budget.string(&v)?;
        Ok(Value::String(v))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        self.budget.charge(2)?;
        let mut values = Vec::new();
        while let Some(v) = seq.next_element_seed(ValueSeed {
            budget: self.budget,
            depth: self.depth + 1,
        })? {
            if !values.is_empty() {
                self.budget.charge(1)?;
            }
            values.push(v);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        self.budget.charge(2)?;
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("duplicate field"));
            }
            self.budget.string(&key)?;
            self.budget.charge(if values.is_empty() { 1 } else { 2 })?;
            let v = map.next_value_seed(ValueSeed {
                budget: self.budget,
                depth: self.depth + 1,
            })?;
            values.insert(key, v);
        }
        Ok(Value::Object(values))
    }
}

struct CompactSeed<'a> {
    remaining: &'a mut Budget,
    model: bool,
}
impl<'de> DeserializeSeed<'de> for CompactSeed<'_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for CompactSeed<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("pricing object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        self.remaining.node()?;
        self.remaining.charge(2)?;
        let mut output = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if key.len() > 256 {
                return Err(de::Error::custom("field name too long"));
            }
            if output.contains_key(&key) {
                return Err(de::Error::custom("duplicate field"));
            }
            let kept = (!self.model && key == "data")
                || (if self.model {
                    MODEL_FIELDS
                } else {
                    ROOT_FIELDS
                })
                .contains(&key.as_str());
            if kept {
                self.remaining.string(&key)?;
                self.remaining
                    .charge(if output.is_empty() { 1 } else { 2 })?;
            }
            if !self.model && key == "data" {
                // Only one data array: duplicate fields must not bypass the retained budget.
                let models = map.next_value_seed(ModelsSeed {
                    remaining: self.remaining,
                })?;
                output.insert(key, models);
            } else if (if self.model {
                MODEL_FIELDS
            } else {
                ROOT_FIELDS
            })
            .contains(&key.as_str())
            {
                let value = map.next_value_seed(ValueSeed {
                    budget: self.remaining,
                    depth: 0,
                })?;
                output.insert(key, value);
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        if self.model && output.get("model_name").and_then(Value::as_str).is_none() {
            return Err(de::Error::custom("missing model name"));
        }
        Ok(Value::Object(output))
    }
}
struct ModelsSeed<'a> {
    remaining: &'a mut Budget,
}
impl<'de> DeserializeSeed<'de> for ModelsSeed<'_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for ModelsSeed<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("model array")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        self.remaining.node()?;
        self.remaining.charge(2)?;
        let mut models = Vec::new();
        while let Some(model) = seq.next_element_seed(CompactSeed {
            remaining: self.remaining,
            model: true,
        })? {
            if !models.is_empty() {
                self.remaining.charge(1)?;
            }
            models.push(model);
        }
        Ok(Value::Array(models))
    }
}
fn decode(reader: impl Read, budget: usize) -> Result<Value, serde_json::Error> {
    let mut de = serde_json::Deserializer::from_reader(BufReader::with_capacity(64 * 1024, reader));
    let mut remaining = Budget {
        bytes: budget,
        nodes: NODE_LIMIT,
    };
    let result = CompactSeed {
        remaining: &mut remaining,
        model: false,
    }
    .deserialize(&mut de)?;
    de.end()?; // Reject truncated responses and trailing data; never publish partial models.
    Ok(result)
}
struct ChunkReader {
    receiver: tokio::sync::mpsc::Receiver<Vec<u8>>,
    current: io::Cursor<Vec<u8>>,
    failed: Arc<AtomicBool>,
}
impl Read for ChunkReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        loop {
            let n = self.current.read(output)?;
            if n != 0 {
                return Ok(n);
            }
            match self.receiver.blocking_recv() {
                Some(bytes) => self.current = io::Cursor::new(bytes),
                None if self.failed.load(Ordering::Acquire) => {
                    return Err(io::Error::other("response interrupted"))
                }
                None => return Ok(0),
            }
        }
    }
}
pub async fn read(response: reqwest::Response) -> Result<Value, String> {
    read_limited(response, WIRE_LIMIT).await
}
async fn read_limited(response: reqwest::Response, wire_limit: usize) -> Result<Value, String> {
    if !response.status().is_success() {
        return crate::transport::bounded_json(response, 1024 * 1024).await;
    }
    if response
        .content_length()
        .is_some_and(|n| n > wire_limit as u64)
    {
        return Err("模型目录超过设备安全读取范围，请稍后重试".into());
    }
    let (sender, receiver) = tokio::sync::mpsc::channel(4);
    let failed = Arc::new(AtomicBool::new(false));
    let reader = ChunkReader {
        receiver,
        current: io::Cursor::new(Vec::new()),
        failed: failed.clone(),
    };
    let parser = tokio::task::spawn_blocking(move || decode(reader, COMPACT_LIMIT));
    let mut stream = response.bytes_stream();
    let mut total = 0usize;
    let mut network_error = None;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) => {
                total = total.saturating_add(chunk.len());
                if total > wire_limit {
                    network_error = Some("模型目录超过设备安全读取范围，请稍后重试");
                    break;
                }
                let mut closed = false;
                for piece in chunk.chunks(64 * 1024) {
                    if sender.send(piece.to_vec()).await.is_err() {
                        closed = true;
                        break;
                    }
                }
                if closed {
                    break;
                }
            }
            Err(_) => {
                network_error = Some("响应中断，请稍后重试");
                break;
            }
        }
    }
    failed.store(network_error.is_some(), Ordering::Release);
    drop(sender);
    let parsed = parser.await.map_err(|_| "模型目录读取失败，请重试")?;
    if let Some(error) = network_error {
        return Err(error.into());
    }
    let value = parsed.map_err(|_| "模型目录格式异常或内容过多，请稍后重试")?;
    crate::transport::ensure_success(&value)?;
    if !value.get("data").is_some_and(Value::is_array) {
        return Err("模型目录缺少列表，请稍后重试".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skips_more_than_eight_mib_of_unused_metadata() {
        let raw = format!(
            r#"{{"success":true,"data":[{{"model_name":"last","model_ratio":0.5,"enable_groups":["paid"],"description":"可搜索介绍","faq":[{{"answer":"{}"}}]}}],"group_ratio":{{"paid":2}}}}"#,
            "x".repeat(9 * 1024 * 1024)
        );
        let value = decode(raw.as_bytes(), 4096).unwrap();
        assert_eq!(value["data"][0]["model_name"], "last");
        assert_eq!(value["data"][0]["enable_groups"][0], "paid");
        assert_eq!(value["data"][0]["description"], "可搜索介绍");
        assert_eq!(value["group_ratio"]["paid"], 2);
        assert!(value["data"][0].get("faq").is_none());
    }
    #[test]
    fn rejects_truncation_trailing_data_and_retained_overflow() {
        assert!(decode(br#"{"data":[{"model_name":"x"}]"#.as_slice(), 4096).is_err());
        assert!(decode(br#"{"data":[]}{}"#.as_slice(), 4096).is_err());
        assert!(decode(br#"{"data":[{"model_name":"too long"}]}"#.as_slice(), 4).is_err());
        assert!(decode(br#"{"data":[{}]}"#.as_slice(), 4096).is_err());
    }
    #[test]
    fn preserves_all_frontend_fields_including_nested_values() {
        // Cross-language guard: adding a consumed TS field requires updating this reader.
        let api = include_str!("../../src/api.ts");
        for (name, fields) in [("PricingModel", MODEL_FIELDS), ("Pricing", ROOT_FIELDS)] {
            let body = api
                .split(&format!("export type {name} = {{"))
                .nth(1)
                .unwrap()
                .split("};")
                .next()
                .unwrap();
            for line in body.lines().filter(|l| l.contains(':')) {
                let key = line.trim().split(':').next().unwrap().trim_end_matches('?');
                assert!(
                    key == "data" || fields.contains(&key),
                    "field missing: {key}"
                );
            }
        }
        let mut model = Map::new();
        for key in MODEL_FIELDS {
            model.insert((*key).into(), serde_json::json!({"s":"中文\\\"\n", "false":false,"zero":0,"null":null,"a":[1,2.5,-3]}));
        }
        model.insert("model_name".into(), "end-model".into());
        let mut root = Map::new();
        for key in ROOT_FIELDS {
            root.insert((*key).into(), serde_json::json!(["test", 0, false]));
        }
        root.insert("success".into(), true.into());
        root.insert("data".into(), serde_json::json!([model]));
        let expected = Value::Object(root);
        let bytes = serde_json::to_vec(&expected).unwrap();
        assert_eq!(decode(bytes.as_slice(), bytes.len()).unwrap(), expected);
        assert!(decode(bytes.as_slice(), bytes.len() - 1).is_err());
    }

    #[test]
    fn rejects_duplicate_fields_deep_or_many_retained_values() {
        for raw in [
            r#"{"data":[],"data":[]}"#,
            r#"{"success":true,"success":false,"data":[]}"#,
            r#"{"data":[{"model_name":"a","model_name":"b"}]}"#,
            r#"{"data":[],"group_ratio":{"x":1,"x":2}}"#,
        ] {
            assert!(decode(raw.as_bytes(), COMPACT_LIMIT).is_err());
        }
        let raw = format!(
            r#"{{"data":[],"vendors":{}0{}}}"#,
            "[".repeat(DEPTH_LIMIT + 2),
            "]".repeat(DEPTH_LIMIT + 2)
        );
        assert!(decode(raw.as_bytes(), COMPACT_LIMIT).is_err());
        let raw = format!(r#"{{"data":[],"vendors":[{}0]}}"#, "0,".repeat(NODE_LIMIT));
        assert!(decode(raw.as_bytes(), COMPACT_LIMIT).is_err());
    }

    #[test]
    fn retained_array_budget_stops_before_reading_the_entire_field() {
        let raw = format!(r#"{{"data":[],"vendors":[{}0]}}"#, "0,".repeat(100_000));
        let mut input = io::Cursor::new(raw.as_bytes());
        assert!(decode(&mut input, 128).is_err());
        // One BufReader prefetch is allowed; the oversized value is not materialized.
        assert!(input.position() < raw.len() as u64);
    }
    async fn response(body: Vec<u8>, status: &str, length: usize) -> reqwest::Response {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            socket
                .set_write_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request);
            let header = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n");
            let _ = socket.write_all(header.as_bytes());
            for chunk in body.chunks(16 * 1024) {
                if socket.write_all(chunk).is_err() {
                    break;
                }
            }
        });
        reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap()
            .get(format!("http://{address}/pricing"))
            .send()
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn network_bridge_rejects_interruption_and_auth_failure() {
        let body = br#"{"success":true,"data":[{"model_name":"test"}]}"#.to_vec();
        let full = read(response(body.clone(), "200 OK", body.len()).await)
            .await
            .unwrap();
        assert_eq!(full["data"][0]["model_name"], "test");
        assert!(read(response(body.clone(), "200 OK", body.len() + 1).await)
            .await
            .is_err());
        let error = read(response(b"{}".to_vec(), "401 Unauthorized", 2).await)
            .await
            .unwrap_err();
        assert!(error.contains("登录已失效"));
        assert!(read(response(Vec::new(), "200 OK", WIRE_LIMIT + 1).await)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn network_bridge_accepts_large_unused_metadata_without_dropping_last_model() {
        let raw = format!(
            r#"{{"success":true,"data":[{{"model_name":"first","faq":"{}"}},{{"model_name":"last","model_price":0.25,"enable_groups":["paid"]}}]}}"#,
            "x".repeat(5 * 1024 * 1024)
        );
        let length = raw.len();
        assert!(crate::transport::bounded_json(
            response(raw.as_bytes().to_vec(), "200 OK", length).await,
            4 * 1024 * 1024,
        )
        .await
        .unwrap_err()
        .contains("响应数据过大"));
        let compact = read(response(raw.into_bytes(), "200 OK", length).await)
            .await
            .unwrap();
        assert_eq!(compact["data"].as_array().unwrap().len(), 2);
        assert_eq!(compact["data"][1]["model_name"], "last");
        assert_eq!(compact["data"][1]["model_price"], 0.25);
        assert!(serde_json::to_vec(&compact).unwrap().len() < 1024);
    }

    #[tokio::test]
    async fn missing_data_and_failed_business_response_never_publish_partial_models() {
        for raw in [
            r#"{"success":true}"#,
            r#"{"success":false,"message":"denied","data":[]}"#,
            r#"{"success":true,"data":[{"model_name":"ok"},{}]}"#,
        ] {
            assert!(
                read(response(raw.as_bytes().to_vec(), "200 OK", raw.len()).await)
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn wire_limit_without_content_length_and_timeout_fail_closed() {
        use std::io::Write;
        for stall in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (release, wait) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0; 4096];
                let _ = socket.read(&mut request);
                let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
                if stall {
                    let _ = socket.write_all(br#"{"success":true,"data":["#);
                    let _ = wait.recv_timeout(std::time::Duration::from_secs(2));
                } else {
                    let _ = socket.write_all(&vec![b' '; 2048]);
                }
            });
            let res = reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_millis(200))
                .build()
                .unwrap()
                .get(format!("http://{address}/pricing"))
                .send()
                .await
                .unwrap();
            let error = read_limited(res, 1024).await.unwrap_err();
            assert!(error.contains(if stall {
                "中断"
            } else {
                "安全读取范围"
            }));
            let _ = release.send(());
            worker.join().unwrap();
        }
    }

    #[tokio::test]
    async fn dropping_producer_unblocks_parser_and_does_not_leave_a_worker_waiting() {
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        let failed = Arc::new(AtomicBool::new(false));
        let worker = tokio::task::spawn_blocking(move || {
            decode(
                ChunkReader {
                    receiver,
                    current: io::Cursor::new(Vec::new()),
                    failed,
                },
                COMPACT_LIMIT,
            )
        });
        sender.send(br#"{"data":["#.to_vec()).await.unwrap();
        drop(sender);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), worker)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }
}
