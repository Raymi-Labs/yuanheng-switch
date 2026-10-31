//! Account-bound local favorites. The caller holds the login lock through IO.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_ENTRY: u64 = 64 * 1024 * 1024;
const MAX_TOTAL: u64 = 80 * 1024 * 1024;
const MAX_COUNT: usize = 40;

fn id(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("收藏编号无效".into());
    }
    Ok(value)
}
fn private_dir(path: &Path) -> Result<(), String> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("收藏目录无效".into());
        }
    } else {
        fs::create_dir(path).map_err(|_| "无法创建收藏目录")?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护收藏目录")?;
    }
    Ok(())
}
fn directory(root: &Path, account: i64) -> Result<PathBuf, String> {
    if account <= 0 {
        return Err("请先登录再查看收藏".into());
    }
    // Never adopt the old unscoped gallery: there is no reliable owner metadata.
    let gallery = root.join("gallery-v2");
    private_dir(&gallery)?;
    let user = gallery.join(account.to_string());
    private_dir(&user)?;
    Ok(user)
}
fn files(dir: &Path) -> Result<Vec<(PathBuf, u64)>, String> {
    let mut result = Vec::new();
    for entry in fs::read_dir(dir).map_err(|_| "无法读取收藏目录")? {
        let entry = entry.map_err(|_| "无法读取收藏目录")?;
        if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let meta = fs::symlink_metadata(entry.path()).map_err(|_| "收藏文件无效")?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err("收藏文件无效".into());
        }
        result.push((entry.path(), meta.len()));
    }
    Ok(result)
}
fn validate_entry(raw: &str) -> Result<(String, Value), String> {
    if raw.len() as u64 > MAX_ENTRY {
        return Err("收藏内容过大".into());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "收藏数据无效")?;
    let identifier = id(value
        .get("id")
        .and_then(Value::as_str)
        .ok_or("收藏编号缺失")?)?
    .to_owned();
    let data = value
        .pointer("/result/data")
        .and_then(Value::as_str)
        .ok_or("收藏图片缺失")?;
    let bytes = STANDARD.decode(data).map_err(|_| "收藏图片编码无效")?;
    let mime = crate::transport::image_mime(&bytes)?;
    if value.pointer("/result/mime").and_then(Value::as_str) != Some(mime) {
        return Err("收藏图片格式不匹配".into());
    }
    for (field, limit) in [("prompt", 8000), ("model", 256), ("size", 64)] {
        if value
            .get(field)
            .and_then(Value::as_str)
            .is_none_or(|s| s.chars().count() > limit)
        {
            return Err("收藏描述或型号无效".into());
        }
    }
    let created = value
        .get("createdAt")
        .and_then(Value::as_u64)
        .ok_or("收藏时间无效")?;
    let mut safe = json!({"id":identifier,"prompt":value["prompt"],"model":value["model"],"size":value["size"],"createdAt":created,"result":{"data":data,"mime":mime}});
    if let Some(elapsed) = value.get("elapsed").and_then(Value::as_u64) {
        safe["elapsed"] = json!(elapsed);
    }
    if let Some(reference) = value.get("reference").and_then(Value::as_str) {
        if reference.len() > 14 * 1024 * 1024 {
            return Err("收藏参考图过大".into());
        }
        let (header, encoded) = reference.split_once(',').ok_or("收藏参考图无效")?;
        let decoded = STANDARD.decode(encoded).map_err(|_| "收藏参考图无效")?;
        let kind = crate::transport::image_mime(&decoded)?;
        if header != format!("data:{kind};base64") {
            return Err("收藏参考图无效".into());
        }
        safe["reference"] = json!(reference);
    }
    Ok((identifier, safe))
}
pub fn save(root: &Path, account: i64, raw: &str) -> Result<(), String> {
    let (identifier, value) = validate_entry(raw)?;
    let dir = directory(root, account)?;
    let path = dir.join(format!("{identifier}.json"));
    let encoded = serde_json::to_vec(&value).map_err(|_| "收藏数据无效")?;
    let others: Vec<_> = files(&dir)?
        .into_iter()
        .filter(|(p, _)| p != &path)
        .collect();
    if others.len() >= MAX_COUNT
        || others
            .iter()
            .map(|(_, n)| *n)
            .sum::<u64>()
            .saturating_add(encoded.len() as u64)
            > MAX_TOTAL
    {
        return Err("本账号收藏最多40条、合计80MB，请先删除不需要的收藏".into());
    }
    let mut file = tempfile::NamedTempFile::new_in(&dir).map_err(|_| "无法创建收藏文件")?;
    file.write_all(&encoded).map_err(|_| "保存收藏失败")?;
    file.as_file().sync_all().map_err(|_| "保存收藏失败")?;
    file.persist(path).map_err(|_| "保存收藏失败")?;
    Ok(())
}
pub fn list(root: &Path, account: i64) -> Result<Value, String> {
    let dir = directory(root, account)?;
    let entries = files(&dir)?;
    if entries.len() > MAX_COUNT || entries.iter().map(|(_, n)| *n).sum::<u64>() > MAX_TOTAL {
        return Err("收藏超过本机读取上限，请清理后重试".into());
    }
    let mut values = Vec::new();
    for (path, size) in entries {
        if size > MAX_ENTRY {
            return Err("收藏文件过大".into());
        }
        let mut raw = String::new();
        fs::File::open(path)
            .map_err(|_| "无法读取收藏")?
            .take(MAX_ENTRY + 1)
            .read_to_string(&mut raw)
            .map_err(|_| "无法读取收藏")?;
        if let Ok((_, value)) = validate_entry(&raw) {
            values.push(value);
        }
    }
    values.sort_by_key(|v| std::cmp::Reverse(v["createdAt"].as_u64().unwrap_or(0)));
    Ok(Value::Array(values))
}
pub fn delete(root: &Path, account: i64, identifier: &str) -> Result<(), String> {
    let path = directory(root, account)?.join(format!("{}.json", id(identifier)?));
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            return Err("收藏文件无效".into());
        }
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("删除收藏失败".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(identifier: &str, time: u64) -> String {
        json!({"id":identifier,"prompt":"private prompt","model":"gpt-image-2","size":"1024x1024","createdAt":time,"result":{"data":STANDARD.encode(b"\x89PNG\r\n\x1a\nsynthetic"),"mime":"image/png"},"apiKey":"must-not-persist"}).to_string()
    }
    #[test]
    fn accounts_are_isolated_and_legacy_files_not_adopted() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("gallery")).unwrap();
        fs::write(root.path().join("gallery/old.json"), entry("old", 1)).unwrap();
        save(root.path(), 1, &entry("one", 2)).unwrap();
        assert_eq!(list(root.path(), 1).unwrap().as_array().unwrap().len(), 1);
        assert!(list(root.path(), 2).unwrap().as_array().unwrap().is_empty());
        delete(root.path(), 2, "one").unwrap();
        assert_eq!(list(root.path(), 1).unwrap().as_array().unwrap().len(), 1);
        assert!(list(root.path(), 0).is_err());
        assert!(delete(root.path(), 1, "../one").is_err());
        assert!(
            !fs::read_to_string(root.path().join("gallery-v2/1/one.json"))
                .unwrap()
                .contains("must-not-persist")
        );
    }
    #[test]
    fn enforces_count_atomic_updates_and_stable_latest_order() {
        let root = tempfile::tempdir().unwrap();
        for n in 0..40 {
            save(root.path(), 1, &entry(&format!("id-{n}"), n)).unwrap();
        }
        assert!(save(root.path(), 1, &entry("extra", 41)).is_err());
        save(root.path(), 1, &entry("id-0", 90)).unwrap();
        assert_eq!(list(root.path(), 1).unwrap()[0]["id"], "id-0");
        delete(root.path(), 1, "id-0").unwrap();
        save(root.path(), 1, &entry("extra", 91)).unwrap();
        assert_eq!(
            fs::read_dir(root.path().join("gallery-v2/1"))
                .unwrap()
                .count(),
            40
        );
    }
    #[test]
    fn rejects_mime_mismatch_and_disk_overflow() {
        let root = tempfile::tempdir().unwrap();
        let bad = entry("bad", 1).replace("image/png", "image/jpeg");
        assert!(save(root.path(), 1, &bad).is_err());
        let dir = directory(root.path(), 1).unwrap();
        fs::File::create(dir.join("large.json"))
            .unwrap()
            .set_len(MAX_TOTAL)
            .unwrap();
        assert!(save(root.path(), 1, &entry("new", 2)).is_err());
        assert!(list(root.path(), 1).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_account_directories() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        private_dir(&root.path().join("gallery-v2")).unwrap();
        std::os::unix::fs::symlink(other.path(), root.path().join("gallery-v2/1")).unwrap();
        assert!(save(root.path(), 1, &entry("one", 2)).is_err());
    }
}
