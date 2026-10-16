//! YuanHeng reference quotes in platform credits. Legacy USD records are never
//! relabelled or overwritten. Historical usage is quoted against today's catalog;
//! only the platform's settlement ledger can establish an actual charge.
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::services::sql_helpers::fresh_input_sql;
use crate::services::usage_stats::{effective_usage_log_filter, RequestLogDetail};
use chrono::{Local, TimeZone};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;

pub const CACHE_KEY: &str = "yuanheng_platform_pricing_v1";
pub const GROUP_KEY: &str = "yuanheng_quote_group";
pub const TTL_SECONDS: i64 = 6 * 60 * 60;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceBook {
    pub account_id: Option<String>,
    pub fetched_at: i64,
    pub symbol: String,
    pub quota_per_unit: String,
    pub display_rate: String,
    pub models: BTreeMap<String, Value>,
    pub groups: BTreeMap<String, String>,
    pub time_ratio: Value,
    pub selected_group: Option<String>,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub sync_error: Option<String>,
}

fn decimal(value: &Value) -> Option<Decimal> {
    let s = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string());
    let n = Decimal::from_str(&s).ok()?;
    (n >= Decimal::ZERO).then_some(n)
}

impl PriceBook {
    pub fn from_api(
        pricing: &Value,
        status: &Value,
        account_id: Option<String>,
    ) -> Result<Self, String> {
        let status = status.get("data").unwrap_or(status);
        if pricing.get("success").and_then(Value::as_bool) != Some(true)
            || status.get("quota_display_type").and_then(Value::as_str) != Some("CUSTOM")
        {
            return Err("平台定价或闪电单位配置无效".into());
        }
        let quota = status
            .get("quota_per_unit")
            .and_then(decimal)
            .filter(|n| *n > Decimal::ZERO)
            .ok_or("平台额度单位缺失")?;
        let rate = status
            .get("custom_currency_exchange_rate")
            .and_then(decimal)
            .filter(|n| *n > Decimal::ZERO)
            .ok_or("平台闪电换算率缺失")?;
        let symbol = status
            .get("custom_currency_symbol")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or("平台单位符号缺失")?;
        let rows = pricing
            .get("data")
            .and_then(Value::as_array)
            .filter(|r| !r.is_empty())
            .ok_or("平台价格目录为空")?;
        let mut models = BTreeMap::new();
        for row in rows {
            let name = row
                .get("model_name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("模型价格缺少名称")?;
            models.insert(name.to_string(), row.clone());
        }
        let ratios = pricing
            .get("group_ratio")
            .and_then(Value::as_object)
            .ok_or("平台分组倍率缺失")?;
        let groups = ratios
            .iter()
            .filter(|(k, _)| {
                pricing
                    .get("usable_group")
                    .and_then(|v| v.get(*k))
                    .is_some()
            })
            .filter_map(|(k, v)| decimal(v).map(|n| (k.clone(), n.to_string())))
            .collect();
        Ok(Self {
            account_id,
            fetched_at: chrono::Utc::now().timestamp(),
            symbol: symbol.into(),
            quota_per_unit: quota.to_string(),
            display_rate: rate.to_string(),
            models,
            groups,
            time_ratio: pricing.get("time_ratio").cloned().unwrap_or(json!({})),
            selected_group: None,
            stale: false,
            sync_error: None,
        })
    }

    /// Exact platform model IDs only. Never guess a price from a model prefix.
    #[cfg(test)]
    fn quote(&self, usage: &QuoteUsage) -> Value {
        self.quote_for_group(usage, self.selected_group.as_deref())
    }

    fn request_quote(&self, usage: &QuoteUsage, group: Option<&str>) -> Value {
        match group.filter(|g| !g.trim().is_empty() && *g != "auto") {
            Some(group) => self.quote_for_group(usage, Some(group)),
            None => json!({"amount":null,"reason":"request_group_unknown","symbol":self.symbol}),
        }
    }

    fn quote_for_group(&self, usage: &QuoteUsage, selected_group: Option<&str>) -> Value {
        let unavailable = |reason: &str| json!({"amount": null, "reason": reason, "symbol": self.symbol, "quotedAt": self.fetched_at});
        let Some(model) = self.models.get(&usage.model) else {
            return unavailable("model_missing");
        };
        if usage.input == 0 && usage.output == 0 && usage.read == 0 && usage.write == 0 {
            return unavailable("usage_missing");
        }
        if model.get("quota_type").and_then(Value::as_i64) != Some(0) {
            return unavailable("quantity_missing");
        }
        // Instantaneous time_ratio values cannot safely reconstruct a historical
        // request's multiplier. Keep unsupported rules visible instead of guessing.
        if self.time_ratio.as_object().is_none_or(|m| !m.is_empty()) {
            return unavailable("rule_unsupported");
        }
        let enabled = model.get("enable_groups").and_then(Value::as_array);
        let selected = self
            .groups
            .iter()
            .filter(|(g, _)| enabled.is_some_and(|a| a.iter().any(|v| v.as_str() == Some(g))))
            .filter(|(g, _)| selected_group.is_none_or(|s| s == g.as_str()))
            .filter_map(|(g, v)| Decimal::from_str(v).ok().map(|r| (g, r)))
            .min_by_key(|(_, r)| *r);
        let Some((group, ratio)) = selected else {
            return unavailable("group_missing");
        };
        let Some(rate) = Decimal::from_str(&self.display_rate).ok() else {
            return unavailable("rule_unsupported");
        };
        let p = Decimal::from(usage.input);
        let c = Decimal::from(usage.output);
        let cr = Decimal::from(usage.read);
        let cc = Decimal::from(usage.write);
        let amount = (|| -> Option<Decimal> {
            let base = if model.get("billing_mode").and_then(Value::as_str) == Some("tiered_expr") {
                let expr = model.get("billing_expr")?.as_str()?;
                let identifiers: Vec<_> = expr
                    .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                    .collect();
                // OpenAI input includes cache. If an expression has no separate
                // cache term, the platform leaves those tokens in prompt input.
                let prompt = if usage.inclusive {
                    p + if identifiers.contains(&"cr") {
                        Decimal::ZERO
                    } else {
                        cr
                    } + if identifiers.contains(&"cc") {
                        Decimal::ZERO
                    } else {
                        cc
                    }
                } else {
                    p
                };
                let vars = HashMap::from([
                    ("p", prompt),
                    ("c", c),
                    ("cr", cr),
                    ("cc", cc),
                    ("len", p + cr + cc),
                ]);
                super::platform_pricing_expr::evaluate(expr, &vars, usage.at)?
                    .checked_div(Decimal::from(1_000_000))?
            } else {
                // Verified platform legacy price: model_ratio * 2 per 1M tokens.
                let input = decimal(model.get("model_ratio")?)?.checked_mul(Decimal::from(2))?;
                let read =
                    if model.get("supports_cache_read").and_then(Value::as_bool) == Some(true) {
                        decimal(model.get("cache_ratio")?)?
                    } else {
                        Decimal::ONE
                    };
                let write = if model
                    .get("supports_cache_creation")
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    decimal(
                        model
                            .get("cache_creation_ratio")
                            .or_else(|| model.get("create_cache_ratio"))?,
                    )?
                } else {
                    Decimal::ONE
                };
                let output = decimal(model.get("completion_ratio")?)?;
                p.checked_add(cr.checked_mul(read)?)?
                    .checked_add(cc.checked_mul(write)?)?
                    .checked_add(c.checked_mul(output)?)?
                    .checked_mul(input)?
                    .checked_div(Decimal::from(1_000_000))?
            };
            base.checked_mul(ratio)?.checked_mul(rate)
        })();
        match amount {
            Some(amount) if amount >= Decimal::ZERO => {
                json!({"amount": amount.round_dp(8).normalize().to_string(), "symbol": self.symbol, "group": group, "groupRatio": ratio.to_string(), "quotedAt": self.fetched_at, "stale": self.stale, "reason": "estimate"})
            }
            _ => unavailable("rule_unsupported"),
        }
    }
}

pub fn load(db: &Database) -> Result<Option<PriceBook>, AppError> {
    let mut book: Option<PriceBook> = db
        .get_setting(CACHE_KEY)?
        .and_then(|s| serde_json::from_str(&s).ok());
    if let Some(b) = &mut book {
        let account_id = db
            .get_setting("yuanheng_connection_cache")?
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("userId").and_then(Value::as_str).map(str::to_owned));
        if b.account_id != account_id {
            return Ok(None);
        }
        b.selected_group = db.get_setting(GROUP_KEY)?.filter(|s| !s.is_empty());
        b.stale = chrono::Utc::now().timestamp() - b.fetched_at >= TTL_SECONDS;
    }
    Ok(book)
}

struct QuoteUsage {
    model: String,
    input: u64,
    output: u64,
    read: u64,
    write: u64,
    inclusive: bool,
    at: i64,
}

pub fn log_quote(book: Option<&PriceBook>, log: &RequestLogDetail) -> Value {
    let Some(book) = book else {
        return json!({"amount":null,"reason":"pricing_missing","symbol":"⚡️"});
    };
    let inclusive =
        ["codex", "chatgpt-desktop", "gemini", "grokbuild"].contains(&log.app_type.as_str());
    let cached = if log.input_token_semantics == super::sql_helpers::INPUT_TOKEN_SEMANTICS_TOTAL {
        log.cache_read_tokens
            .saturating_add(log.cache_creation_tokens)
    } else {
        log.cache_read_tokens
    };
    let input = if inclusive
        && log.input_token_semantics != super::sql_helpers::INPUT_TOKEN_SEMANTICS_FRESH
        && log.input_tokens >= cached
    {
        log.input_tokens - cached
    } else {
        log.input_tokens
    };
    book.request_quote(
        &QuoteUsage {
            model: log
                .pricing_model
                .as_ref()
                .filter(|m| !m.is_empty())
                .unwrap_or(&log.model)
                .clone(),
            input: input.into(),
            output: log.output_tokens.into(),
            read: log.cache_read_tokens.into(),
            write: log.cache_creation_tokens.into(),
            inclusive,
            at: log.created_at,
        },
        log.request_group.as_deref(),
    )
}

#[derive(Default)]
struct Sum {
    amount: Decimal,
    priced: u64,
}
impl Sum {
    fn add(&mut self, amount: Decimal) {
        self.amount += amount;
        self.priced += 1;
    }
    fn apply(&self, value: &mut Value, count_key: &str) {
        let count = value[count_key].as_u64().unwrap_or(0);
        value["totalCost"] = if self.priced > 0 || count == 0 {
            json!(self.amount.to_string())
        } else {
            Value::Null
        };
        value["pricedRequests"] = json!(self.priced);
        value["unpricedRequests"] = json!(count.saturating_sub(self.priced));
        if value.get("avgCostPerRequest").is_some() {
            value["avgCostPerRequest"] = if self.priced > 0 {
                json!((self.amount / Decimal::from(self.priced)).to_string())
            } else {
                Value::Null
            };
        }
    }
}

/// Decorate API statistics with reference amounts, keeping persisted USD and
/// quota-limit accounting intact. Rollups lack request length/time, so cannot be
/// retrospectively tier-priced; their requests remain explicitly uncovered.
#[allow(clippy::too_many_arguments)]
pub fn decorate_stats(
    db: &Database,
    mut value: Value,
    kind: &str,
    start: Option<i64>,
    end: Option<i64>,
    app: Option<&str>,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<Value, AppError> {
    let book = load(db)?;
    let mut total = Sum::default();
    let mut sums: HashMap<String, Sum> = HashMap::new();
    let buckets: Vec<_> = if kind == "trends" {
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| {
                let s = v["date"].as_str()?;
                let at = chrono::DateTime::parse_from_rfc3339(s)
                    .map(|d| d.timestamp())
                    .ok()
                    .or_else(|| {
                        chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                            .ok()
                            .and_then(|d| {
                                Local
                                    .from_local_datetime(&d.and_hms_opt(0, 0, 0)?)
                                    .earliest()
                            })
                            .map(|d| d.timestamp())
                    })?;
                Some((at, s.to_owned()))
            })
            .collect()
    } else {
        Vec::new()
    };
    if let Some(book) = book.as_ref() {
        let conn = lock_conn!(db.conn);
        let folded = super::usage_stats::folded_app_type_sql("l.app_type");
        let pname = super::usage_stats::provider_name_coalesce("l", "p");
        let effective_model = super::usage_stats::effective_model_sql("l");
        let fresh = fresh_input_sql("l");
        let filter = effective_usage_log_filter("l");
        let sql = format!("SELECT {folded}, l.provider_id, {effective_model}, {fresh}, l.output_tokens, l.cache_read_tokens, l.cache_creation_tokens, l.created_at, l.app_type, l.request_group FROM proxy_request_logs l LEFT JOIN providers p ON p.id=l.provider_id AND p.app_type=l.app_type WHERE (?1 IS NULL OR l.created_at>=?1) AND (?2 IS NULL OR l.created_at<=?2) AND (?3 IS NULL OR {folded}=?3) AND (?4 IS NULL OR {pname}=?4) AND (?5 IS NULL OR {effective_model}=?5) AND {filter}");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![start, end, app, provider, model], |r| {
            Ok((
                r.get::<_, Option<String>>(9)?,
                r.get::<_, String>(0)?,
                format!("{}:{}", r.get::<_, String>(8)?, r.get::<_, String>(1)?),
                QuoteUsage {
                    model: r.get(2)?,
                    input: r.get(3)?,
                    output: r.get(4)?,
                    read: r.get(5)?,
                    write: r.get(6)?,
                    at: r.get(7)?,
                    inclusive: false,
                },
            ))
        })?;
        for row in rows {
            let (group, app, provider, mut usage) = row?;
            usage.inclusive =
                ["codex", "chatgpt-desktop", "gemini", "grokbuild"].contains(&app.as_str());
            let q = book.request_quote(&usage, group.as_deref());
            if let Some(amount) = q.get("amount").and_then(decimal) {
                total.add(amount);
                let key = match kind {
                    "byApp" => app,
                    "providers" => provider,
                    "models" => usage.model,
                    "trends" => buckets
                        .iter()
                        .rev()
                        .find(|(at, _)| *at <= usage.at)
                        .map(|(_, s)| s.clone())
                        .unwrap_or_default(),
                    _ => String::new(),
                };
                sums.entry(key).or_default().add(amount);
            }
        }
    }
    let symbol = book.as_ref().map(|b| b.symbol.as_str()).unwrap_or("⚡️");
    if kind == "summary" {
        value["costSymbol"] = json!(symbol);
        total.apply(&mut value, "totalRequests");
    } else if let Some(rows) = value.as_array_mut() {
        for row in rows.iter_mut() {
            let key = match kind {
                "byApp" => "appType",
                "providers" => "providerId",
                "models" => "model",
                _ => "date",
            };
            let lookup = if kind == "providers" {
                format!(
                    "{}:{}",
                    row["appType"].as_str().unwrap_or_default(),
                    row["providerId"].as_str().unwrap_or_default()
                )
            } else {
                row[key].as_str().unwrap_or_default().to_owned()
            };
            let sum = sums.remove(&lookup).unwrap_or_default();
            if kind == "byApp" {
                row["summary"]["costSymbol"] = json!(symbol);
                sum.apply(&mut row["summary"], "totalRequests");
            } else {
                row["costSymbol"] = json!(symbol);
                sum.apply(row, "requestCount");
            }
        }
    }
    if ["providers", "models"].contains(&kind) {
        if let Some(rows) = value.as_array_mut() {
            rows.sort_by(|a, b| decimal(&b["totalCost"]).cmp(&decimal(&a["totalCost"])));
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn book() -> PriceBook {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/yuanheng-pricing.json"))
                .unwrap();
        PriceBook::from_api(&fixture["pricing"], &fixture["status"], None).unwrap()
    }
    fn usage(model: &str) -> QuoteUsage {
        QuoteUsage {
            model: model.into(),
            input: 1074,
            output: 94,
            read: 224256,
            write: 0,
            inclusive: true,
            at: chrono::DateTime::parse_from_rfc3339("2026-09-11T10:00:00+08:00")
                .unwrap()
                .timestamp(),
        }
    }
    #[test]
    fn request_quotes_ignore_catalog_selection_and_never_guess_history() -> Result<(), AppError> {
        let db = Database::memory()?;
        let mut b = book();
        b.selected_group = Some("OpenAI · 企业专属".into());
        db.set_setting(CACHE_KEY, &serde_json::to_string(&b).unwrap())?;
        db.set_setting(GROUP_KEY, "OpenAI · 企业专属")?;
        let at = usage("gpt-6-astra").at;
        {
            let conn = lock_conn!(db.conn);
            for (id, group) in [
                ("quality", Some("OpenAI · 优质")),
                ("enterprise", Some("OpenAI · 企业专属")),
                ("history", None),
                ("auto", Some("auto")),
            ] {
                conn.execute("INSERT INTO proxy_request_logs(request_id,provider_id,app_type,model,input_tokens,output_tokens,cache_read_tokens,input_token_semantics,latency_ms,status_code,created_at,request_group,total_cost_usd) VALUES (?1,'p','chatgpt-desktop','gpt-6-astra',41466,130,41088,1,1,200,?2,?3,'999')", rusqlite::params![id,at,group])?;
            }
        }
        for (id, expected) in [("quality", "0.115578"), ("enterprise", "0.25684")] {
            let log = db.get_request_detail(id)?.unwrap();
            let q = log_quote(Some(&b), &log);
            assert_eq!(q["amount"], expected);
            assert_eq!(q["group"], log.request_group.unwrap());
            assert_eq!(log.total_cost_usd, "999");
        }
        for id in ["history", "auto"] {
            let q = log_quote(Some(&b), &db.get_request_detail(id)?.unwrap());
            assert!(q["amount"].is_null());
            assert_eq!(q["reason"], "request_group_unknown");
        }
        // Catalog changes affect neither request history nor aggregate cost.
        for group in ["OpenAI · 企业专属", "OpenAI · 优质", ""] {
            db.set_setting(GROUP_KEY, group)?;
            let raw = db.get_usage_summary(Some(at), Some(at + 1), None, None, None)?;
            let q = decorate_stats(
                &db,
                serde_json::to_value(raw).unwrap(),
                "summary",
                Some(at),
                Some(at + 1),
                None,
                None,
                None,
            )?;
            assert_eq!(decimal(&q["totalCost"]), Decimal::from_str("0.372418").ok());
            assert_eq!(q["pricedRequests"], 2);
            assert_eq!(q["unpricedRequests"], 2);
        }
        Ok(())
    }

    #[test]
    fn quotes_platform_rates_groups_and_long_context_without_usd_relabelling() {
        let mut book = book();
        assert_eq!(book.models.len(), 64);
        book.selected_group = Some("OpenAI · 优质".into());
        let mut u = usage("gpt-6-astra");
        assert_eq!(book.quote(&u)["amount"], "0.539316");
        u.input = 272000 - u.read;
        let standard = book.quote(&u)["amount"]
            .as_str()
            .unwrap()
            .parse::<Decimal>()
            .unwrap();
        u.input += 1;
        let long = book.quote(&u)["amount"]
            .as_str()
            .unwrap()
            .parse::<Decimal>()
            .unwrap();
        assert!(long > standard * Decimal::from_str("1.9").unwrap());
        book.display_rate = "3".into();
        assert_eq!(book.quote(&usage("gpt-6-astra"))["amount"], "1.617948");
        book.selected_group = Some("missing".into());
        assert_eq!(book.quote(&u)["reason"], "group_missing");
        assert_eq!(
            book.quote(&usage("gpt-6-astra-new-unknown"))["reason"],
            "model_missing"
        );
    }
    #[test]
    fn handles_all_current_dynamic_rules_and_peak_off_peak() {
        let book = book();
        for (model, rule) in &book.models {
            if rule["billing_mode"] == "tiered_expr" {
                assert!(book.quote(&usage(model))["amount"].is_string(), "{model}");
            }
        }
        let mut u = usage("deepseek-v4-flash");
        let peak = decimal(&book.quote(&u)["amount"]).unwrap();
        u.at += 3 * 3600; // 13:00 lunch/off-peak
        let off = decimal(&book.quote(&u)["amount"]).unwrap();
        assert_eq!(peak, off * Decimal::from(2));
        u.at += 21 * 3600; // Saturday 10:00 is still off-peak
        assert_eq!(decimal(&book.quote(&u)["amount"]).unwrap(), off);
    }
    #[test]
    fn requires_quantity_and_fails_closed_for_unknown_rules() {
        let mut book = book();
        for model in ["gpt-image-2", "mimo-v2.5-asr"] {
            assert_eq!(book.quote(&usage(model))["reason"], "quantity_missing");
        }
        book.models.get_mut("gpt-6-astra").unwrap()["billing_expr"] = json!("unknown_param * 1");
        assert_eq!(
            book.quote(&usage("gpt-6-astra"))["reason"],
            "rule_unsupported"
        );
        book.time_ratio = json!({"some-new-rule": 0.5});
        assert_eq!(
            book.quote(&usage("claude-sonnet-4-6"))["reason"],
            "rule_unsupported"
        );
        let mut u = usage("claude-sonnet-4-6");
        u.input = 0;
        u.output = 0;
        u.read = 0;
        assert_eq!(book.quote(&u)["reason"], "usage_missing");
    }
    #[test]
    fn account_scope_and_corrupt_feeds_do_not_replace_cached_prices() -> Result<(), AppError> {
        let db = Database::memory()?;
        let mut book = book();
        book.account_id = Some("account-a".into());
        db.set_setting(CACHE_KEY, &serde_json::to_string(&book).unwrap())?;
        assert!(load(&db)?.is_none());
        db.set_setting("yuanheng_connection_cache", r#"{"userId":"account-a"}"#)?;
        assert_eq!(load(&db)?.unwrap().models.len(), 64);
        db.set_setting("yuanheng_connection_cache", r#"{"userId":"account-b"}"#)?;
        assert!(load(&db)?.is_none());
        assert!(PriceBook::from_api(&json!({"success":true,"data":[]}), &json!({}), None).is_err());
        assert!(db.get_setting(CACHE_KEY)?.is_some());
        Ok(())
    }
    #[test]
    fn summary_and_provider_quotes_match_without_modifying_legacy_costs() -> Result<(), AppError> {
        let db = Database::memory()?;
        let mut b = book();
        b.selected_group = Some("OpenAI · 优质".into());
        db.set_setting(CACHE_KEY, &serde_json::to_string(&b).unwrap())?;
        db.set_setting(GROUP_KEY, "OpenAI · 优质")?;
        let at = usage("gpt-6-astra").at;
        {
            let conn = lock_conn!(db.conn);
            for (id, app, input, semantics) in [("a", "codex", 225330, 1), ("b", "claude", 1074, 2)]
            {
                conn.execute("INSERT INTO proxy_request_logs (request_id,provider_id,app_type,model,input_tokens,output_tokens,cache_read_tokens,input_token_semantics,total_cost_usd,latency_ms,status_code,created_at,request_group) VALUES (?1,'same-provider',?2,'gpt-6-astra',?3,94,224256,?4,'999',1,200,?5,'OpenAI · 优质')",rusqlite::params![id,app,input,semantics,at])?;
            }
        }
        let raw = db.get_usage_summary(Some(at), Some(at + 1), None, None, None)?;
        let quote = decorate_stats(
            &db,
            serde_json::to_value(raw).unwrap(),
            "summary",
            Some(at),
            Some(at + 1),
            None,
            None,
            None,
        )?;
        assert_eq!(
            decimal(&quote["totalCost"]),
            Decimal::from_str("1.078632").ok()
        );
        assert_eq!(quote["pricedRequests"], 2);
        let providers = db.get_provider_stats(Some(at), Some(at + 1), None, None, None)?;
        let quoted = decorate_stats(
            &db,
            serde_json::to_value(providers).unwrap(),
            "providers",
            Some(at),
            Some(at + 1),
            None,
            None,
            None,
        )?;
        for p in quoted.as_array().unwrap() {
            assert_eq!(decimal(&p["totalCost"]), Decimal::from_str("0.539316").ok());
        }
        let log = db.get_request_detail("a")?.unwrap();
        assert_eq!(
            decimal(&log_quote(Some(&b), &log)["amount"]),
            Decimal::from_str("0.539316").ok()
        );
        assert_eq!(log.total_cost_usd, "999");
        let partial = decorate_stats(
            &db,
            json!({"totalRequests":3,"totalCost":"1998"}),
            "summary",
            Some(at),
            Some(at + 1),
            None,
            None,
            None,
        )?;
        assert_eq!(partial["unpricedRequests"], 1); // a pruned/unknown request cannot be invented
        Ok(())
    }
}
