//! Offline, fixed-schema sample workflow. No model, shell, or network calls.
use serde::Serialize;
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const LIMIT: u64 = 4 * 1024 * 1024;
const ASSETS: &[(&str, &str)] = &[
    (
        "products.json",
        include_str!("../../resources/accio-commerce/products.json"),
    ),
    (
        "task.md",
        include_str!("../../resources/accio-commerce/task.md"),
    ),
    (
        "guard.txt",
        include_str!("../../resources/accio-commerce/guard.txt"),
    ),
    (
        "revision.json",
        include_str!("../../resources/accio-commerce/revision.json"),
    ),
    (
        "render-preview.rb",
        include_str!("../../resources/accio-commerce/render-preview.rb"),
    ),
    (
        "render-preview.mjs",
        include_str!("../../resources/accio-commerce/render-preview.mjs"),
    ),
];
const FIELDS: &[&str] = &[
    "title_zh",
    "title_en",
    "bullets_zh",
    "bullets_en",
    "missing_information",
    "review_status",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommerceBundle {
    root: String,
    work: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommerceReport {
    passed: bool,
    errors: Vec<String>,
    product_count: usize,
    requires_human_review: bool,
    native_execution_verified: bool,
    baseline_saved: bool,
}

fn asset(name: &str) -> &'static str {
    ASSETS
        .iter()
        .find(|(n, _)| *n == name)
        .expect("fixed asset")
        .1
}
fn real_dir(path: &Path) -> Result<PathBuf, String> {
    let m = fs::symlink_metadata(path).map_err(|_| "无法读取任务目录")?;
    if !m.is_dir() || m.file_type().is_symlink() || reparse(&m) {
        return Err("请选择真实目录，不能使用符号链接".into());
    }
    fs::canonicalize(path).map_err(|_| "无法解析任务目录".into())
}
#[cfg(windows)]
fn reparse(m: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn reparse(_: &fs::Metadata) -> bool {
    false
}

fn read_file(path: &Path) -> Result<String, String> {
    let m = fs::symlink_metadata(path).map_err(|_| "任务文件缺失，请先让 Accio 完成当前阶段")?;
    if !m.is_file() || m.file_type().is_symlink() || reparse(&m) || m.len() > LIMIT {
        return Err("文件不是普通文件或超过 4MB 检查上限".into());
    }
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.custom_flags(0x00200000);
    }
    let file = opts.open(path).map_err(|_| "无法安全读取任务文件")?;
    let m = file.metadata().map_err(|_| "无法检查任务文件")?;
    if !m.is_file() || reparse(&m) || m.len() > LIMIT {
        return Err("文件状态已变化，请重新检查".into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取任务文件失败")?;
    if bytes.len() as u64 > LIMIT {
        return Err("文件超过 4MB 检查上限".into());
    }
    String::from_utf8(bytes).map_err(|_| "任务文件必须为 UTF-8 文本".into())
}
fn write_new(path: &Path, content: &str) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options
        .open(path)
        .map_err(|_| "目标文件已存在或不可写，未覆盖原文件")?;
    f.write_all(content.as_bytes())
        .and_then(|_| f.sync_all())
        .map_err(|_| "写入未完成，请保留现有文件并检查磁盘".into())
}
fn prepare(parent: &Path) -> Result<CommerceBundle, String> {
    let parent = real_dir(parent)?;
    let temp = tempfile::Builder::new()
        .prefix("Accio商品示例-")
        .tempdir_in(parent)
        .map_err(|_| "无法创建新任务目录")?;
    for name in ["work", "reference"] {
        let dir = temp.path().join(name);
        fs::create_dir(&dir).map_err(|_| "无法创建任务子目录")?;
        for (file, content) in ASSETS {
            write_new(&dir.join(file), content)?;
        }
    }
    let root = temp.keep();
    Ok(CommerceBundle {
        root: root.to_string_lossy().into(),
        work: root.join("work").to_string_lossy().into(),
    })
}
fn layout(path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let root = real_dir(path)?;
    let work = real_dir(&root.join("work"))?;
    let reference = real_dir(&root.join("reference"))?;
    if work.parent() != Some(root.as_path()) || reference.parent() != Some(root.as_path()) {
        return Err("任务目录结构异常".into());
    }
    Ok((work, reference))
}
fn parse(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|_| "JSON格式错误，未通过检查".into())
}
fn language(value: &Value, zh: bool) -> bool {
    let Some(s) = value.as_str() else {
        return false;
    };
    if s.trim().is_empty() || s.chars().count() > 2000 {
        return false;
    }
    let chinese = s.chars().any(|c| ('\u{3400}'..='\u{9fff}').contains(&c));
    if zh {
        chinese
    } else {
        !chinese && s.chars().any(|c| c.is_ascii_alphabetic())
    }
}
fn validate(draft: &Value) -> Vec<String> {
    let source: Value = serde_json::from_str(asset("products.json")).expect("bundled source");
    let mut errors = Vec::new();
    let Some(rows) = draft.get("products").and_then(Value::as_array) else {
        return vec!["缺少商品列表".into()];
    };
    if draft.as_object().is_none_or(|o| o.len() != 2) || draft["dataset"] != source["dataset"] {
        errors.push("资料集标识或顶层字段不符".into());
    }
    let originals = source["products"].as_array().expect("bundled rows");
    if rows.len() != originals.len() {
        errors.push("商品数量不符，必须完整保留六个商品".into());
    }
    for (i, p) in originals.iter().enumerate() {
        let sku = p["sku"].as_str().expect("bundled sku");
        let Some(d) = rows.get(i).and_then(Value::as_object) else {
            errors.push(format!("{sku}：商品缺失或格式错误"));
            continue;
        };
        let facts = p.as_object().expect("bundled facts");
        if d.len() != facts.len() + FIELDS.len()
            || FIELDS.iter().any(|k| !d.contains_key(*k))
            || facts.iter().any(|(k, v)| d.get(k) != Some(v))
        {
            errors.push(format!("{sku}：原始事实、顺序或字段集合发生变化"));
        }
        for (lang, zh) in [("zh", true), ("en", false)] {
            if !language(d.get(&format!("title_{lang}")).unwrap_or(&Value::Null), zh) {
                errors.push(format!("{sku}：{lang} 标题缺失或语言不符"));
            }
            if !d
                .get(&format!("bullets_{lang}"))
                .and_then(Value::as_array)
                .is_some_and(|b| b.len() == 3 && b.iter().all(|v| language(v, zh)))
            {
                errors.push(format!("{sku}：{lang} 卖点必须有三条"));
            }
        }
        let mut expected: Vec<&str> = facts
            .iter()
            .filter(|(_, v)| v.is_null() || v.as_array().is_some_and(Vec::is_empty))
            .map(|(k, _)| k.as_str())
            .collect();
        expected.sort();
        let actual = d
            .get("missing_information")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
            .map(|mut a| {
                a.sort();
                a
            });
        if actual.as_ref() != Some(&expected) {
            errors.push(format!("{sku}：待确认字段遗漏或多填"));
        }
        if d.get("review_status").and_then(Value::as_str) != Some("draft") {
            errors.push(format!("{sku}：必须保留草稿状态"));
        }
    }
    errors
}
fn escape(s: &str) -> String {
    let mut out = String::new();
    for c in s.replace("\r\n", "\n").chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\n' => out.push_str("<br>"),
            c if "\\`*_{}[]()#!|~".contains(c) => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out
}
fn render(draft: &Value) -> String {
    let mut lines = vec![
        "# 商品文案草稿 / Product copy draft".into(),
        "".into(),
        "仅供人工审稿，未上架 / Human review required; not published.".into(),
        "".into(),
    ];
    for p in draft["products"].as_array().expect("validated") {
        lines.extend([
            format!("## {}", p["sku"].as_str().unwrap()),
            "".into(),
            format!("价格 / Price (CNY): {}", p["price_cny"]),
            "".into(),
        ]);
        for lang in ["zh", "en"] {
            lines.push(format!(
                "### {}",
                escape(p[format!("title_{lang}")].as_str().unwrap())
            ));
            lines.extend(
                p[format!("bullets_{lang}")]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| format!("- {}", escape(v.as_str().unwrap()))),
            );
            lines.push("".into());
        }
        let missing = p["missing_information"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| escape(v.as_str().unwrap()))
            .collect::<Vec<_>>()
            .join(", ");
        lines.extend([
            format!(
                "待确认字段 / Unknown fields: {}",
                if missing.is_empty() { "—" } else { &missing }
            ),
            "".into(),
            "### 原始事实核对 / Source facts".into(),
            "".into(),
            "| 字段 / Field | 原值 / Value |".into(),
            "| --- | --- |".into(),
        ]);
        let mut keys: Vec<_> = p
            .as_object()
            .unwrap()
            .keys()
            .filter(|k| !FIELDS.contains(&k.as_str()) && k.as_str() != "supplier_note")
            .collect();
        keys.sort();
        for key in keys {
            lines.push(format!(
                "| {} | {} |",
                escape(key),
                escape(&p[key].to_string())
            ));
        }
        lines.push("".into());
    }
    lines.join("\n") + "\n"
}
fn inspect(root: &Path, revision: bool) -> Result<(CommerceReport, String, PathBuf), String> {
    let (work, reference) = layout(root)?;
    for (name, expected) in ASSETS {
        if read_file(&work.join(name))? != *expected
            || read_file(&reference.join(name))? != *expected
        {
            return Err("原始资料或保护文件已变化，未通过检查".into());
        }
    }
    for entry in fs::read_dir(&work).map_err(|_| "无法读取任务目录")? {
        let entry = entry.map_err(|_| "无法读取任务目录")?;
        let name = entry.file_name();
        let n = name.to_string_lossy();
        if !ASSETS.iter().any(|(a, _)| *a == n)
            && !["listing-draft.json", "listing-draft.md", ".DS_Store"].contains(&n.as_ref())
        {
            return Err("工作目录存在额外文件，请人工核对".into());
        }
    }
    let text = read_file(&work.join("listing-draft.json"))?;
    let draft = parse(&text)?;
    let mut errors = validate(&draft);
    if errors.is_empty() && read_file(&work.join("listing-draft.md"))? != render(&draft) {
        errors.push("Markdown预览与JSON不一致，请重新运行预览脚本".into());
    }
    let baseline_path = reference.join("initial-draft.json");
    let has_baseline = fs::symlink_metadata(&baseline_path).is_ok();
    if revision || has_baseline {
        let before = parse(&read_file(&baseline_path)?)?;
        if !validate(&before).is_empty() {
            errors.push("初稿基线无效".into());
        } else if revision {
            let request: Value = parse(asset("revision.json"))?;
            let mut expected = before;
            if let Some(target) = expected["products"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|p| p["sku"] == request["sku"])
            {
                if target["title_en"] == request["value"] {
                    errors.push("初稿已包含目标标题，无法证明本次修订".into());
                }
                target["title_en"] = request["value"].clone();
            }
            if draft != expected {
                errors.push("修订未按要求完成，或改动了指定标题以外的字段".into());
            }
        }
    }
    Ok((
        CommerceReport {
            passed: errors.is_empty(),
            errors,
            product_count: draft["products"].as_array().map_or(0, Vec::len),
            requires_human_review: true,
            native_execution_verified: false,
            baseline_saved: has_baseline,
        },
        text,
        reference,
    ))
}
fn check(root: &Path, action: &str) -> Result<CommerceReport, String> {
    if !["draft", "snapshot", "revision"].contains(&action) {
        return Err("不支持的检查阶段".into());
    }
    let (mut report, text, reference) = inspect(root, action == "revision")?;
    if action == "snapshot" && report.passed {
        let draft = parse(&text)?;
        let request = parse(asset("revision.json"))?;
        if draft["products"][0]["title_en"] == request["value"] {
            return Err("当前标题已是修订目标，请创建新示例重新验证".into());
        }
        write_new(&reference.join("initial-draft.json"), &text)?;
        report.baseline_saved = true;
    }
    Ok(report)
}
#[tauri::command]
pub async fn prepare_accio_commerce(parent: String) -> Result<CommerceBundle, String> {
    tauri::async_runtime::spawn_blocking(move || prepare(Path::new(&parent)))
        .await
        .map_err(|_| "准备示例任务失败")?
}
#[tauri::command]
pub async fn check_accio_commerce(root: String, action: String) -> Result<CommerceReport, String> {
    tauri::async_runtime::spawn_blocking(move || check(Path::new(&root), &action))
        .await
        .map_err(|_| "检查示例任务失败")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        let mut d = parse(asset("products.json")).unwrap();
        for p in d["products"].as_array_mut().unwrap() {
            let missing: Vec<_> = p
                .as_object()
                .unwrap()
                .iter()
                .filter(|(_, v)| v.is_null() || v.as_array().is_some_and(Vec::is_empty))
                .map(|(k, _)| Value::String(k.clone()))
                .collect();
            p["title_zh"] = p["name_zh"].clone();
            p["title_en"] = p["name_en"].clone();
            p["bullets_zh"] = serde_json::json!(["合成测试甲", "合成测试乙", "合成测试丙"]);
            p["bullets_en"] =
                serde_json::json!(["Synthetic one", "Synthetic two", "Synthetic three"]);
            p["missing_information"] = Value::Array(missing);
            p["review_status"] = Value::String("draft".into());
        }
        d
    }
    fn output(root: &Path, d: &Value) {
        fs::write(root.join("work/listing-draft.json"), d.to_string()).unwrap();
        fs::write(root.join("work/listing-draft.md"), render(d)).unwrap();
    }
    #[test]
    fn unicode_directory_create_is_unique_and_full_flow_preserves_baseline() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("商品资料");
        fs::create_dir(&parent).unwrap();
        let a = prepare(&parent).unwrap();
        let b = prepare(&parent).unwrap();
        assert_ne!(a.root, b.root);
        let root = Path::new(&a.root);
        let mut d = fixture();
        output(root, &d);
        assert!(check(root, "draft").unwrap().passed);
        assert!(check(root, "snapshot").unwrap().baseline_saved);
        assert!(check(root, "snapshot").is_err());
        d["products"][0]["title_en"] = parse(asset("revision.json")).unwrap()["value"].clone();
        output(root, &d);
        assert!(check(root, "revision").unwrap().passed);
        d["products"][1]["title_en"] = d["products"][0]["title_en"].clone();
        output(root, &d);
        assert!(!check(root, "revision").unwrap().passed);
    }
    #[test]
    fn wrong_fields_false_zero_and_protected_data_fail() {
        for (index, key, value) in [
            (0, "stock", serde_json::json!(2)),
            (2, "charging", serde_json::json!(true)),
            (0, "review_status", serde_json::json!("published")),
            (0, "missing_information", serde_json::json!([])),
        ] {
            let mut d = fixture();
            d["products"][index][key] = value;
            assert!(!validate(&d).is_empty());
        }
        for d in [
            Value::Null,
            serde_json::json!({"products":[null]}),
            serde_json::json!({}),
        ] {
            assert!(!validate(&d).is_empty());
        }
        let tmp = tempfile::tempdir().unwrap();
        let b = prepare(tmp.path()).unwrap();
        let root = Path::new(&b.root);
        output(root, &fixture());
        fs::write(root.join("work/guard.txt"), "changed").unwrap();
        assert!(check(root, "snapshot").is_err());
        assert!(!root.join("reference/initial-draft.json").exists());
    }
    #[test]
    fn malformed_preview_large_file_missing_output_and_extra_file_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let b = prepare(tmp.path()).unwrap();
        let root = Path::new(&b.root);
        assert!(check(root, "draft").is_err());
        output(root, &fixture());
        fs::write(root.join("work/listing-draft.md"), "fake preview").unwrap();
        assert!(!check(root, "snapshot").unwrap().passed);
        assert!(!root.join("reference/initial-draft.json").exists());
        fs::write(
            root.join("work/listing-draft.json"),
            vec![b' '; LIMIT as usize + 1],
        )
        .unwrap();
        assert!(check(root, "draft").is_err());
        output(root, &fixture());
        fs::write(root.join("work/extra.txt"), "extra").unwrap();
        assert!(check(root, "draft").is_err());
        assert!(check(root, "unsupported").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_or_overwrite_baseline() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let b = prepare(tmp.path()).unwrap();
        let root = Path::new(&b.root);
        output(root, &fixture());
        let target = tmp.path().join("keep.txt");
        fs::write(&target, "keep").unwrap();
        symlink(&target, root.join("reference/initial-draft.json")).unwrap();
        assert!(check(root, "snapshot").is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
        fs::remove_file(root.join("work/listing-draft.json")).unwrap();
        symlink(&target, root.join("work/listing-draft.json")).unwrap();
        assert!(check(root, "draft").is_err());
        let link = tmp.path().join("linked");
        symlink(root, &link).unwrap();
        assert!(layout(&link).is_err());
    }
    #[test]
    fn bundled_renderer_contract_matches_js_fixture() {
        let pair: Value = serde_json::from_str(include_str!(
            "../../resources/accio-commerce/checker-fixture.json"
        ))
        .unwrap();
        assert!(validate(&pair["draft"]).is_empty());
        assert_eq!(render(&pair["draft"]), pair["markdown"].as_str().unwrap());
    }

    #[test]
    fn corrupt_baseline_is_not_ready_and_immutable_source_cannot_be_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        let b = prepare(tmp.path()).unwrap();
        let root = Path::new(&b.root);
        output(root, &fixture());
        fs::write(root.join("reference/initial-draft.json"), "{}").unwrap();
        assert!(!check(root, "draft").unwrap().passed);
        assert!(!check(root, "revision").unwrap().passed);
        fs::write(root.join("reference/products.json"), "{}").unwrap();
        fs::write(root.join("work/products.json"), "{}").unwrap();
        assert!(check(root, "draft").is_err());
    }

    #[test]
    fn native_read_and_snapshot_do_not_execute_task_scripts() {
        let tmp = tempfile::tempdir().unwrap();
        let b = prepare(tmp.path()).unwrap();
        let root = Path::new(&b.root);
        output(root, &fixture());
        let before = fs::read(root.join("work/listing-draft.json")).unwrap();
        let report = check(root, "snapshot").unwrap();
        assert!(report.passed && report.requires_human_review && !report.native_execution_verified);
        assert_eq!(
            fs::read(root.join("work/listing-draft.json")).unwrap(),
            before
        );
        assert_eq!(
            fs::read_dir(root.join("work")).unwrap().count(),
            ASSETS.len() + 2
        );
    }
}
