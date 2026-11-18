//! Account settlement totals from the same endpoint as the web dashboard.
//! Local logs, agent filters and current price catalogs never enter this calculation.
use super::*;
use rust_decimal::Decimal;
use std::str::FromStr;

const RANGE: &str = "platform_usage_range";
const INVALID: &str = "platform_usage_invalid";
const LOGIN: &str = "platform_usage_login";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YuanhengPlatformUsage {
    account_id: String,
    amount: Option<String>,
    symbol: Option<String>,
    requests: Option<u64>,
    tokens: Option<u64>,
    period_start: i64,
    period_end: i64,
    fetched_at: i64,
}

fn validate_range(start: i64, end: i64) -> Result<(), String> {
    if start <= 0 || end <= start || end.saturating_sub(start) > 30 * 86400 {
        return Err(RANGE.into());
    }
    Ok(())
}

fn decimal(value: &Value) -> Result<Decimal, String> {
    Decimal::from_str(
        value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string())
            .as_str(),
    )
    .map_err(|_| INVALID.into())
}

fn positive(value: &Value) -> Result<Decimal, String> {
    let result = decimal(value)?;
    if result <= Decimal::ZERO {
        return Err(INVALID.into());
    }
    Ok(result)
}

fn business_result(value: &Value, headers: &HeaderMap) -> Result<(), String> {
    if value["success"] == true {
        return Ok(());
    }
    // The server sets this only after UserAuth passed. An HTTP-200 ApiError
    // from the stats controller is unavailable data, not a fabricated zero.
    if value["success"] == false && headers.contains_key("auth-version") {
        return Err("platform_usage_unavailable".into());
    }
    // Missing/ambiguous authentication evidence cannot authorize a stale display.
    Err(LOGIN.into())
}

fn parse_summary(
    value: &Value,
    status: &Value,
    user: &str,
    start: i64,
    end: i64,
) -> Result<YuanhengPlatformUsage, String> {
    if value["success"] != true {
        return Err(INVALID.into());
    }
    let summary = &value["summary"];
    if summary["source"] != "retained_settlement_logs_v1"
        || summary["start_timestamp"].as_i64() != Some(start)
        || summary["end_timestamp"].as_i64() != Some(end)
    {
        return Err(INVALID.into());
    }
    let count = |field: &str| {
        summary[field]
            .as_u64()
            .filter(|v| *v <= 9_007_199_254_740_991)
    };
    let charge = display_charge(&summary["quota"], status).ok();
    let (amount, symbol) = charge
        .map(|(amount, symbol)| (Some(amount.normalize().to_string()), Some(symbol)))
        .unwrap_or_default();
    Ok(YuanhengPlatformUsage {
        account_id: user.into(),
        amount,
        symbol,
        requests: count("requests"),
        tokens: count("tokens"),
        period_start: start,
        period_end: end,
        fetched_at: chrono::Utc::now().timestamp(),
    })
}

fn display_charge(quota: &Value, status: &Value) -> Result<(Decimal, String), String> {
    if status["success"] != true {
        return Err(INVALID.into());
    }
    // Refunds can make net consumption negative. Do not clamp or reprice them.
    let quota = Decimal::from(quota.as_i64().ok_or(INVALID)?);
    let units = &status["data"];
    let (amount, symbol) = match units["quota_display_type"].as_str().ok_or(INVALID)? {
        "TOKENS" => (quota, String::new()),
        kind @ ("USD" | "CNY" | "CUSTOM") => {
            let rate = match kind {
                "CNY" => positive(&units["usd_exchange_rate"])?,
                "CUSTOM" => positive(&units["custom_currency_exchange_rate"])?,
                _ => Decimal::ONE,
            };
            let symbol = match kind {
                "CNY" => "¥",
                "CUSTOM" => units["custom_currency_symbol"]
                    .as_str()
                    .filter(|s| {
                        !s.trim().is_empty()
                            && s.chars().count() <= 16
                            && !s.chars().any(char::is_control)
                    })
                    .ok_or(INVALID)?,
                _ => "$",
            };
            let value = quota
                .checked_div(positive(&units["quota_per_unit"])?)
                .and_then(|v| v.checked_mul(rate))
                .ok_or(INVALID)?;
            (value, symbol.into())
        }
        _ => return Err(INVALID.into()),
    };
    Ok((amount, symbol))
}

async fn fetch_at(
    state: &AppState,
    client: &reqwest::Client,
    origin: &str,
    session: (&str, &str),
    start: i64,
    end: i64,
) -> Result<YuanhengPlatformUsage, String> {
    validate_range(start, end)?;
    let (cookie, user) = session;
    device_credentials::check_owner(state, cookie, user).map_err(|_| LOGIN.to_string())?;
    let url = format!("{origin}/api/data/self?start_timestamp={start}&end_timestamp={end}");
    let status_url = format!("{origin}/api/status");
    let request = with_session(
        client.get(&url).header("Accept", "application/json"),
        Some(cookie),
        Some(user),
    );
    let (usage, units) = tokio::join!(
        account_http::get_json_typed(request, Some("platform_usage")),
        fetch_json(client, &status_url, None, None),
    );
    let (usage, headers) = usage.map_err(|error| match error {
        account_http::ReadError::Http(
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN,
            _,
        ) => LOGIN.to_string(),
        _ => "platform_usage_unavailable".into(),
    })?;
    device_credentials::check_owner(state, cookie, user).map_err(|_| LOGIN.to_string())?;
    business_result(&usage, &headers)?;
    parse_summary(&usage, &units.unwrap_or(Value::Null), user, start, end)
}

#[tauri::command]
pub async fn get_yuanheng_platform_usage(
    state: State<'_, AppState>,
    start_date: i64,
    end_date: i64,
    expected_user_id: String,
) -> Result<YuanhengPlatformUsage, String> {
    validate_range(start_date, end_date)?;
    let cookie = get_yuanheng_secret(&state, SESSION_COOKIE_KEY)?
        .filter(|s| !s.is_empty())
        .ok_or(LOGIN)?;
    let user = get_yuanheng_secret(&state, USER_ID_KEY)?
        .filter(|s| !s.is_empty())
        .ok_or(LOGIN)?;
    if user != expected_user_id {
        return Err(LOGIN.into());
    }
    fetch_at(
        &state,
        &yuanheng_client()?,
        BASE_URL,
        (&cookie, &user),
        start_date,
        end_date,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::sync::Arc;
    fn summary() -> Value {
        json!({"success":true,"summary":{"source":"retained_settlement_logs_v1","start_timestamp":100,"end_timestamp":200,"quota":1250000,"requests":3545,"tokens":18000000}})
    }
    fn units() -> Value {
        json!({"success":true,"data":{"quota_per_unit":500000,"quota_display_type":"CUSTOM","custom_currency_exchange_rate":7,"custom_currency_symbol":"⚡"}})
    }

    #[test]
    fn settlement_contract_preserves_refunds_boundaries_and_actual_quota() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/platform-usage-settlement.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let summary = &case["response"]["summary"];
            let result = parse_summary(
                &case["response"],
                &fixture["status"],
                fixture["accountId"].as_str().unwrap(),
                summary["start_timestamp"].as_i64().unwrap(),
                summary["end_timestamp"].as_i64().unwrap(),
            )
            .unwrap();
            assert_eq!(
                result.amount.as_deref(),
                case["amount"].as_str(),
                "{}",
                case["name"]
            );
            assert_eq!(result.requests, summary["requests"].as_u64());
            assert_eq!(result.tokens, summary["tokens"].as_u64());
            assert_eq!(result.account_id, "417");
        }
    }

    #[test]
    fn actual_settlement_does_not_depend_on_local_request_groups_or_quotes() {
        let result = parse_summary(&summary(), &units(), "owner", 100, 200).unwrap();
        assert_eq!(result.amount.as_deref(), Some("17.5"));
        assert_eq!(result.requests, Some(3545));
        assert_eq!(result.tokens, Some(18000000));
        assert_eq!(result.symbol.as_deref(), Some("⚡"));
        let mut value = summary();
        value["summary"]["quota"] = json!(-500000);
        assert_eq!(
            parse_summary(&value, &units(), "owner", 100, 200)
                .unwrap()
                .amount
                .as_deref(),
            Some("-7")
        );
        for key in ["quota", "requests", "tokens"] {
            value["summary"][key] = json!(0);
        }
        assert_eq!(
            parse_summary(&value, &units(), "owner", 100, 200)
                .unwrap()
                .amount
                .as_deref(),
            Some("0")
        );
    }
    #[test]
    fn readable_counts_survive_a_missing_currency_response() {
        let result = parse_summary(&summary(), &Value::Null, "owner", 100, 200).unwrap();
        assert!(result.amount.is_none());
        assert_eq!(result.requests, Some(3545));
        assert_eq!(result.tokens, Some(18000000));
    }

    #[test]
    fn incomplete_responses_cannot_look_like_zero_usage() {
        for field in ["source", "end_timestamp"] {
            let mut v = summary();
            v["summary"].as_object_mut().unwrap().remove(field);
            assert!(parse_summary(&v, &units(), "owner", 100, 200).is_err());
        }
        assert!(parse_summary(&summary(), &units(), "owner", 101, 200).is_err());
        let mut status = units();
        status["data"]["quota_per_unit"] = json!(0);
        assert!(parse_summary(&summary(), &status, "owner", 100, 200)
            .unwrap()
            .amount
            .is_none());
        for field in ["quota", "requests", "tokens"] {
            let mut v = summary();
            v["summary"].as_object_mut().unwrap().remove(field);
            let partial = parse_summary(&v, &units(), "owner", 100, 200).unwrap();
            assert_eq!(partial.amount.is_none(), field == "quota");
            assert_eq!(partial.requests.is_none(), field == "requests");
            assert_eq!(partial.tokens.is_none(), field == "tokens");
        }
        assert!(validate_range(1, 1 + 30 * 86400).is_ok());
        assert!(validate_range(1, 2 + 30 * 86400).is_err());
        assert!(validate_range(0, 100).is_err());
        assert!(validate_range(100, 100).is_err());
    }
    #[test]
    fn authenticated_stats_failures_keep_last_snapshot_but_auth_failures_do_not() {
        let mut headers = HeaderMap::new();
        let error = json!({"success":false,"message":"统计查询繁忙，请稍后重试"});
        assert_eq!(business_result(&error, &headers).unwrap_err(), LOGIN);
        headers.insert(
            "auth-version",
            reqwest::header::HeaderValue::from_static("authenticated"),
        );
        assert_eq!(
            business_result(&error, &headers).unwrap_err(),
            "platform_usage_unavailable"
        );
        assert!(business_result(&summary(), &headers).is_ok());
    }

    #[test]
    fn account_balance_distinguishes_missing_zero_and_negative_values() {
        let partial = parse_account(&json!({"success":true,"data":{"quota":0}})).unwrap();
        assert_eq!(partial.remaining_usd, Some(0.0));
        assert!(partial.used_usd.is_none());
        let invalid =
            parse_account(&json!({"success":true,"data":{"quota":"bad","used_quota":null}}))
                .unwrap();
        assert!(invalid.remaining_usd.is_none());
        assert!(invalid.used_usd.is_none());
        assert_eq!(quota_to_usd(Some(&json!(-500000))), Some(-1.0));
    }

    #[test]
    fn units_follow_web_settings() {
        for (kind, amount, symbol) in [
            ("USD", "2.5", "$"),
            ("CNY", "20", "¥"),
            ("TOKENS", "1250000", ""),
        ] {
            let mut status = units();
            status["data"]["quota_display_type"] = json!(kind);
            status["data"]["usd_exchange_rate"] = json!(8);
            let v = parse_summary(&summary(), &status, "owner", 100, 200).unwrap();
            assert_eq!(v.amount.as_deref(), Some(amount));
            assert_eq!(v.symbol.as_deref(), Some(symbol));
        }
    }
    #[test]
    fn missing_currency_kind_never_defaults_to_a_dollar_charge() {
        for kind in [Value::Null, json!(false), json!(123), json!("unsupported")] {
            let mut status = units();
            status["data"]["quota_display_type"] = kind;
            let result = parse_summary(&summary(), &status, "owner", 100, 200).unwrap();
            assert!(result.amount.is_none());
            assert!(result.symbol.is_none());
            assert_eq!(result.requests, Some(3545));
            assert_eq!(result.tokens, Some(18000000));
        }
        let mut status = units();
        status["data"]
            .as_object_mut()
            .unwrap()
            .remove("quota_display_type");
        assert!(parse_summary(&summary(), &status, "owner", 100, 200)
            .unwrap()
            .amount
            .is_none());
    }
    #[tokio::test]
    #[serial]
    async fn only_self_endpoint_and_current_owner_can_receive_account_totals() {
        use axum::{
            extract::{Query, State},
            routing::get,
            Json, Router,
        };
        let (_home, state) = super::super::tests::isolated_state();
        let save = |user: &str| {
            persist_connection_for_group(
                &state,
                "session=fake",
                user,
                "",
                0,
                &YuanhengConnectionStatus {
                    connected: true,
                    user_id: Some(user.into()),
                    ..Default::default()
                },
                "",
            )
            .unwrap()
        };
        save("test-user");
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let started = Arc::new(tokio::sync::Semaphore::new(0));
        let currency_unavailable = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let currency_response = currency_unavailable.clone();
        let app = Router::new()
            .route(
                "/api/data/self",
                get(
                    |headers: axum::http::HeaderMap,
                     Query(query): Query<HashMap<String, String>>,
                     State((started, gate)): State<(
                        Arc<tokio::sync::Semaphore>,
                        Arc<tokio::sync::Semaphore>,
                    )>| async move {
                        assert_eq!(headers["cookie"], "session=fake");
                        assert_eq!(headers["new-api-user"], "test-user");
                        assert_eq!(query.len(), 2);
                        assert_eq!(query["start_timestamp"], "100");
                        assert_eq!(query["end_timestamp"], "200");
                        started.add_permits(1);
                        gate.acquire().await.unwrap().forget();
                        Json(summary())
                    },
                ),
            )
            .route(
                "/api/status",
                get(move |headers: axum::http::HeaderMap| {
                    let unavailable = currency_response.clone();
                    async move {
                        assert!(headers.get("cookie").is_none());
                        if unavailable.load(std::sync::atomic::Ordering::SeqCst) {
                            (
                                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                                Json(json!({"success":false})),
                            )
                        } else {
                            (axum::http::StatusCode::OK, Json(units()))
                        }
                    }
                }),
            )
            .with_state((started.clone(), gate.clone()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap();
        gate.add_permits(1);
        let first = fetch_at(
            &state,
            &client,
            &origin,
            ("session=fake", "test-user"),
            100,
            200,
        )
        .await
        .unwrap();
        assert_eq!(first.requests, Some(3545));
        started.acquire().await.unwrap().forget();
        currency_unavailable.store(true, std::sync::atomic::Ordering::SeqCst);
        gate.add_permits(1);
        let partial = fetch_at(
            &state,
            &client,
            &origin,
            ("session=fake", "test-user"),
            100,
            200,
        )
        .await
        .unwrap();
        assert_eq!(partial.requests, Some(3545));
        assert_eq!(partial.tokens, Some(18000000));
        assert!(partial.amount.is_none());
        started.acquire().await.unwrap().forget();
        let change = async {
            tokio::time::timeout(std::time::Duration::from_secs(2), started.acquire())
                .await
                .unwrap()
                .unwrap()
                .forget();
            save("other-user");
            gate.add_permits(1);
        };
        let (result, ()) = tokio::join!(
            fetch_at(
                &state,
                &client,
                &origin,
                ("session=fake", "test-user"),
                100,
                200
            ),
            change
        );
        server.abort();
        let _ = server.await;
        assert_eq!(result.unwrap_err(), LOGIN);
    }
}
