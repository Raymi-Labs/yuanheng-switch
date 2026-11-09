use super::*;
use futures::{stream, StreamExt};

#[tauri::command]
pub async fn get_codex_launch_tiers(
    state: tauri::State<'_, AppState>,
    model: String,
    group: String,
    owner: String,
) -> Result<Vec<Value>, String> {
    query_launch_tiers(&state, &model, &group, &owner).await
}

pub(crate) async fn query_launch_tiers(
    state: &AppState,
    model: &str,
    group: &str,
    owner: &str,
) -> Result<Vec<Value>, String> {
    let cookie = get_yuanheng_secret(state, SESSION_COOKIE_KEY)?.ok_or("请先登录元衡")?;
    if get_yuanheng_secret(state, USER_ID_KEY)?.as_deref() != Some(owner) {
        return Err("账号已变化，请重新选择速度".into());
    }
    let mut url = reqwest::Url::parse(&format!("{BASE_URL}/api/user/service-tiers"))
        .map_err(|_| "能力接口地址无效")?;
    url.query_pairs_mut()
        .append_pair("model", model)
        .append_pair("group", group);
    let client = yuanheng_client()?;
    let value = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        fetch_capability(&client, url.as_str(), &cookie, owner),
    )
    .await
    .ok()
    .flatten()
    .ok_or("未能确认速度支持范围，请重试或明确选择标准")?;
    if get_yuanheng_secret(state, USER_ID_KEY)?.as_deref() != Some(owner) {
        return Err("账号已变化，请重新选择速度".into());
    }
    if value["success"] == true
        && value["data"]["model"] == model
        && value["data"]["group"] == group
        && value["data"]["managed"] == false
    {
        return Ok(vec![]);
    }
    crate::services::desktop_service_tiers::parse_capability(&value, model, group)
        .ok_or_else(|| "速度能力响应无效，请重试或明确选择标准".into())
}

async fn fetch_capability(
    client: &reqwest::Client,
    url: &str,
    cookie: &str,
    owner: &str,
) -> Option<Value> {
    let mut response = with_session(
        client
            .get(url)
            .header("Accept", "application/json")
            .header("User-Agent", "codex_cli_rs/yuanheng-desktop"),
        Some(cookie),
        Some(owner),
    )
    .timeout(std::time::Duration::from_secs(3))
    .send()
    .await
    .ok()?;
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 65536) {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > 65536 {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn desktop_tier_query_uses_codex_client_scope_and_bounded_response() {
        use axum::{routing::get, Json, Router};
        let app=Router::new().route("/cap",get(|headers:axum::http::HeaderMap|async move{
   assert_eq!(headers.get("user-agent").unwrap(),"codex_cli_rs/yuanheng-desktop");
   assert_eq!(headers.get("new-api-user").unwrap(),"7");
   Json(json!({"success":true,"data":{"model":"m","group":"g","managed":true,"tiers":[{"id":"default","multiplier":1},{"id":"priority","multiplier":2}]}}))
  })).route("/large",get(||async{"x".repeat(65537)}));
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", socket.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let cap = fetch_capability(&client, &format!("{base}/cap"), "synthetic", "7").await;
        let large = fetch_capability(&client, &format!("{base}/large"), "synthetic", "7").await;
        task.abort();
        let _ = task.await;
        assert!(
            crate::services::desktop_service_tiers::parse_capability(&cap.unwrap(), "m", "g")
                .is_some()
        );
        assert!(large.is_none());
    }
}

pub(super) async fn annotate(
    state: &AppState,
    provider: &mut Provider,
    group: &str,
) -> Result<(), String> {
    // Replace old group/account snapshots before attempting a network lookup.
    provider.settings_config["yuanhengServiceTiersSchema"] = json!(1);
    provider.settings_config["yuanhengServiceTiers"] = Value::Null;
    if let Some(rows) = provider
        .settings_config
        .pointer_mut("/modelCatalog/models")
        .and_then(Value::as_array_mut)
    {
        for row in rows {
            row["serviceTiers"] = json!([]);
        }
    }
    let owner = get_yuanheng_secret(state, USER_ID_KEY)?.filter(|s| !s.is_empty());
    let cookie = get_yuanheng_secret(state, SESSION_COOKIE_KEY)?.filter(|s| !s.is_empty());
    let (Some(owner), Some(cookie)) = (owner, cookie) else {
        return Ok(());
    };
    let client = yuanheng_client()?;
    let models = provider
        .settings_config
        .pointer("/modelCatalog/models")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row["model"].as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let queries = stream::iter(models)
        .map(|model| {
            let client = &client;
            let cookie = &cookie;
            let owner = &owner;
            async move {
                let mut url =
                    reqwest::Url::parse(&format!("{BASE_URL}/api/user/service-tiers")).ok()?;
                url.query_pairs_mut()
                    .append_pair("model", &model)
                    .append_pair("group", group);
                let value = tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    fetch_capability(client, url.as_str(), cookie, owner),
                )
                .await
                .ok()??;
                let tiers = crate::services::desktop_service_tiers::parse_capability(
                    &value, &model, group,
                )?;
                Some((model, tiers))
            }
        })
        .buffer_unordered(4);
    tokio::pin!(queries);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut capabilities = serde_json::Map::new();
    while let Ok(Some(result)) = tokio::time::timeout_at(deadline, queries.next()).await {
        if let Some((model, tiers)) = result {
            capabilities.insert(model, json!(tiers));
        }
    }
    if read_cached_status(state)?.user_id.as_deref() != Some(owner.as_str()) {
        return Err("账号已变化，请重新配置".into());
    }
    if let Some(rows) = provider
        .settings_config
        .pointer_mut("/modelCatalog/models")
        .and_then(Value::as_array_mut)
    {
        for row in rows {
            if let Some(tiers) = row["model"].as_str().and_then(|m| capabilities.get(m)) {
                row["serviceTiers"] = tiers.clone();
            }
        }
    }
    provider.settings_config["yuanhengServiceTiers"] =
        json!({"owner":owner,"group":group,"models":capabilities});
    Ok(())
}
