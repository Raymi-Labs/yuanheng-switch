//! Choose a credential from successful model catalogs before any paid request.
//! Each credential is restricted to one platform group. Generation errors never
//! enter this selection path again, and original media bytes stay untouched.
use super::*;

struct Catalog {
    url: String,
    headers: HeaderMap,
}

impl Catalog {
    fn for_provider(provider: &Provider) -> Result<Self, ProxyError> {
        let (url, headers) = prepare_model_catalog_request(provider)?;
        Ok(Self { url, headers })
    }

    async fn models(&self, client: &reqwest::Client) -> Result<Vec<String>, ProxyError> {
        model_ids_response(
            fetch_image_models(
                client,
                &self.url,
                self.headers.clone(),
                MODEL_CATALOG_TIMEOUT,
                MODEL_CATALOG_LIMIT,
            )
            .await,
        )
        .await
        .map_err(ProxyError::ForwardFailed)
    }
}

fn reference(state: &ProxyState, surface: &str) -> Result<String, ProxyError> {
    crate::commands::imagegen_connection_reference(&state.db, surface)
        .map_err(ProxyError::ConfigError)?
        .ok_or_else(|| ProxyError::ConfigError("请先配置图片分组".into()))
}

fn check_unchanged(state: &ProxyState, uri: &Uri, expected: &str) -> Result<(), ProxyError> {
    // Recheck both account/connection and the skill's enabled state after I/O.
    if reference(state, provider_namespace(uri)?)? != expected {
        return Err(ProxyError::ConfigError(
            "图片连接已变化，未提交生成请求".into(),
        ));
    }
    selected_provider(state, uri)?;
    Ok(())
}

pub(super) async fn provider(
    state: &ProxyState,
    uri: &Uri,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Provider, ProxyError> {
    let primary = selected_provider(state, uri)?;
    if !uri.path().starts_with("/imagegen/") {
        return Ok(primary);
    }
    let surface = provider_namespace(uri)?;
    let expected = reference(state, surface)?;
    let (primary, welfare) = crate::commands::imagegen_core_providers(&state.db, surface)
        .map_err(ProxyError::ConfigError)?
        .ok_or_else(|| ProxyError::ConfigError("请先配置图片分组".into()))?;
    let Some(welfare) = welfare else {
        return Ok(primary);
    };
    let model = request_model(headers, body.clone()).await?;
    let client = http_client::image_client().map_err(ProxyError::ConfigError)?;
    let use_welfare = choose_welfare(
        &client,
        &Catalog::for_provider(&primary)?,
        &Catalog::for_provider(&welfare)?,
        &model,
    )
    .await?;
    check_unchanged(state, uri, &expected)?;
    Ok(if use_welfare { welfare } else { primary })
}

async fn choose_welfare(
    client: &reqwest::Client,
    primary: &Catalog,
    welfare: &Catalog,
    model: &str,
) -> Result<bool, ProxyError> {
    if primary.models(client).await?.iter().any(|id| id == model) {
        return Ok(false);
    }
    if welfare.models(client).await?.iter().any(|id| id == model) {
        return Ok(true);
    }
    Err(ProxyError::InvalidRequest(
        "生图和视频及福利分组均未提供所请求的图片模型，未提交生成请求".into(),
    ))
}

pub(super) async fn catalog(state: &ProxyState, uri: &Uri) -> Result<Vec<String>, ProxyError> {
    selected_provider(state, uri)?;
    let surface = provider_namespace(uri)?;
    let expected = reference(state, surface)?;
    let (primary, welfare) = crate::commands::imagegen_core_providers(&state.db, surface)
        .map_err(ProxyError::ConfigError)?
        .ok_or_else(|| ProxyError::ConfigError("请先配置图片分组".into()))?;
    let client = http_client::image_client().map_err(ProxyError::ConfigError)?;
    let mut models: BTreeSet<_> = Catalog::for_provider(&primary)?
        .models(&client)
        .await?
        .into_iter()
        .collect();
    if let Some(welfare) = welfare {
        models.extend(Catalog::for_provider(&welfare)?.models(&client).await?);
    }
    check_unchanged(state, uri, &expected)?;
    Ok(models.into_iter().collect())
}

async fn request_model(headers: &HeaderMap, body: Bytes) -> Result<String, ProxyError> {
    let invalid = || ProxyError::InvalidRequest("图片请求必须包含唯一有效的 model 字段".into());
    if headers.contains_key("content-encoding") {
        return Err(invalid());
    }
    let content_type = headers
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(invalid)?;
    let mime = content_type.split(';').next().unwrap_or("").trim();
    let model = if mime.eq_ignore_ascii_case("application/json") {
        // A typed field rejects duplicate `model` keys, including escaped keys,
        // without allocating image data or changing the original JSON bytes.
        #[derive(serde::Deserialize)]
        struct Request {
            model: String,
        }
        serde_json::from_slice::<Request>(&body)
            .map_err(|_| invalid())?
            .model
    } else if mime.eq_ignore_ascii_case("multipart/form-data") {
        let boundary = multer::parse_boundary(content_type).map_err(|_| invalid())?;
        let constraints = multer::Constraints::new().size_limit(
            multer::SizeLimit::new()
                .whole_stream(IMAGE_REQUEST_LIMIT as u64)
                .for_field("model", 256),
        );
        let stream = futures::stream::once(async move { Ok::<_, std::convert::Infallible>(body) });
        let mut form = multer::Multipart::with_constraints(stream, boundary, constraints);
        let mut model = None;
        while let Some(mut field) = form.next_field().await.map_err(|_| invalid())? {
            if field.name() == Some("model") {
                if model.is_some() || field.file_name().is_some() {
                    return Err(invalid());
                }
                let bytes = field.bytes().await.map_err(|_| invalid())?;
                model = Some(String::from_utf8(bytes.to_vec()).map_err(|_| invalid())?);
            } else {
                while field.chunk().await.map_err(|_| invalid())?.is_some() {}
            }
        }
        model.ok_or_else(invalid)?
    } else {
        return Err(invalid());
    };
    if model.is_empty()
        || model.len() > 256
        || model.trim() != model
        || model.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    Ok(model)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::StatusCode, routing::any};
    use std::sync::{Arc, Mutex};

    type Calls = Arc<Mutex<Vec<(String, String, Bytes)>>>;
    struct Upstream {
        origin: String,
        calls: Calls,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Upstream {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn upstream(
        primary: (u16, Value),
        welfare: (u16, Value),
        generation_status: u16,
    ) -> Upstream {
        let calls: Calls = Default::default();
        let recorded = calls.clone();
        let router = Router::new().route(
            "/*path",
            any(move |uri: Uri, headers: HeaderMap, body: Bytes| {
                let calls = recorded.clone();
                let primary = primary.clone();
                let welfare = welfare.clone();
                async move {
                    calls.lock().unwrap().push((
                        uri.path().into(),
                        headers
                            .get("authorization")
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .into(),
                        body,
                    ));
                    let (code, value) = match uri.path() {
                        "/primary/models" => primary,
                        "/welfare/models" => welfare,
                        _ => (generation_status, json!({"error":"synthetic-generation"})),
                    };
                    (StatusCode::from_u16(code).unwrap(), Json(value))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Upstream {
            origin,
            calls,
            task,
        }
    }

    fn catalog(server: &Upstream, group: &str) -> Catalog {
        Catalog {
            url: format!("{}/{group}/models", server.origin),
            headers: HeaderMap::from_iter([(
                axum::http::header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer sk-{group}")).unwrap(),
            )]),
        }
    }

    fn models(ids: &[&str]) -> (u16, Value) {
        (
            200,
            json!({"data": ids.iter().map(|id| json!({"id":id})).collect::<Vec<_>>()}),
        )
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn primary_model_always_wins_and_missing_exact_id_uses_only_welfare() {
        let server = upstream(
            models(&["gpt-image-1", "vendor/gpt-image-2"]),
            models(&["gpt-image-1", "gpt-image-2"]),
            200,
        )
        .await;
        let primary = catalog(&server, "primary");
        let welfare = catalog(&server, "welfare");
        assert!(
            !choose_welfare(&client(), &primary, &welfare, "gpt-image-1")
                .await
                .unwrap()
        );
        assert_eq!(server.calls.lock().unwrap().len(), 1);
        assert!(
            !choose_welfare(&client(), &primary, &welfare, "vendor/gpt-image-2")
                .await
                .unwrap()
        );
        assert!(choose_welfare(&client(), &primary, &welfare, "gpt-image-2")
            .await
            .unwrap());
        assert!(choose_welfare(&client(), &primary, &welfare, "gpt-image-3")
            .await
            .is_err());
        let calls = server.calls.lock().unwrap();
        assert!(calls.iter().all(|(path, auth, body)| body.is_empty()
            && auth
                == if path.starts_with("/primary/") {
                    "Bearer sk-primary"
                } else {
                    "Bearer sk-welfare"
                }));
        assert_eq!(
            calls
                .iter()
                .filter(|(p, _, _)| p.starts_with("/welfare/"))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn failed_or_invalid_primary_catalog_never_becomes_model_absence() {
        for primary in [
            (401, json!({})),
            (403, json!({})),
            (429, json!({})),
            (500, json!({})),
            (503, json!({})),
            (302, json!({})),
            (200, json!({"data":[{}]})),
        ] {
            let server = upstream(primary, models(&["gpt-image-1"]), 200).await;
            assert!(choose_welfare(
                &client(),
                &catalog(&server, "primary"),
                &catalog(&server, "welfare"),
                "gpt-image-1"
            )
            .await
            .is_err());
            assert_eq!(server.calls.lock().unwrap().len(), 1);
        }
        let server = upstream(models(&[]), (403, json!({})), 200).await;
        assert!(choose_welfare(
            &client(),
            &catalog(&server, "primary"),
            &catalog(&server, "welfare"),
            "gpt-image-1"
        )
        .await
        .is_err());
        assert_eq!(server.calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn selected_group_generation_failure_is_single_attempt_and_body_is_unchanged() {
        for fallback in [false, true] {
            for status in [200, 401, 402, 403, 429, 500, 503] {
                let server = upstream(
                    models(if fallback { &[] } else { &["gpt-image-1"] }),
                    models(&["gpt-image-1"]),
                    status,
                )
                .await;
                let primary = catalog(&server, "primary");
                let welfare = catalog(&server, "welfare");
                let selected = choose_welfare(&client(), &primary, &welfare, "gpt-image-1")
                    .await
                    .unwrap();
                assert_eq!(selected, fallback);
                let group = if selected { "welfare" } else { "primary" };
                let payload =
                    Bytes::from_static(b"{ \"model\":\"gpt-image-1\", \"prompt\":\"synthetic\" }");
                let response = send_once(
                    &client(),
                    &format!("{}/{group}/images/generations", server.origin),
                    catalog(&server, group).headers,
                    payload.clone(),
                    Duration::from_secs(2),
                    1024,
                )
                .await;
                assert_eq!(response.status().as_u16(), status);
                let _ = axum::body::to_bytes(response.into_body(), 1024)
                    .await
                    .unwrap();
                let calls = server.calls.lock().unwrap();
                assert_eq!(calls.len(), if fallback { 3 } else { 2 });
                assert_eq!(
                    calls.last().unwrap().0,
                    format!("/{group}/images/generations")
                );
                assert_eq!(calls.last().unwrap().2, payload);
            }
        }
    }

    fn headers(content_type: &str) -> HeaderMap {
        HeaderMap::from_iter([(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_str(content_type).unwrap(),
        )])
    }

    #[tokio::test]
    async fn extracts_only_unique_valid_model_without_modifying_json_or_multipart() {
        let json_headers = headers("application/json; charset=utf-8");
        let json = Bytes::from_static(br#"{ "images":[{"image_url":"data:image/png;base64,AA=="}],"model":"vendor/gpt-image-2" }"#);
        assert_eq!(
            request_model(&json_headers, json.clone()).await.unwrap(),
            "vendor/gpt-image-2"
        );
        for invalid in [
            r#"{}"#,
            r#"{"model":"gpt-image-1","model":"gpt-image-2"}"#,
            r#"{"model":"gpt-image-1","mo\u0064el":"gpt-image-2"}"#,
            r#"{"model":1}"#,
            r#"{"model":" gpt-image-1"}"#,
            r#"{"model":"gpt-image-1\n"}"#,
        ] {
            assert!(
                request_model(&json_headers, Bytes::copy_from_slice(invalid.as_bytes()))
                    .await
                    .is_err()
            );
        }
        let part =
            "--boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\ngpt-image-2\r\n";
        let image = "--boundary\r\nContent-Disposition: form-data; name=\"image\"; filename=\"model.png\"\r\nContent-Type: image/png\r\n\r\nimage-content\r\n";
        let multipart_headers = headers("multipart/form-data; boundary=boundary");
        for raw in [
            format!("{part}{image}--boundary--\r\n"),
            format!("{image}{part}--boundary--\r\n"),
        ] {
            let bytes = Bytes::from(raw.clone());
            assert_eq!(
                request_model(&multipart_headers, bytes.clone())
                    .await
                    .unwrap(),
                "gpt-image-2"
            );
            assert_eq!(bytes.as_ref(), raw.as_bytes());
        }
        for raw in [
            format!("{part}{part}--boundary--\r\n"),
            format!("{image}--boundary--\r\n"),
            format!("{part}truncated"),
        ] {
            assert!(request_model(&multipart_headers, Bytes::from(raw))
                .await
                .is_err());
        }
        let mut encoded = json_headers.clone();
        encoded.insert("content-encoding", HeaderValue::from_static("gzip"));
        assert!(request_model(&encoded, json).await.is_err());
    }

    #[test]
    #[serial_test::serial]
    fn connection_change_or_disabled_skill_during_catalog_check_prevents_submission() {
        let (cleanup, db, entries) = crate::imagegen_core::test_support::fixture();
        crate::imagegen_core::replace(&db, &entries).unwrap();
        let state = super::super::tests::state(Arc::new(db));
        let uri: Uri = "/imagegen/dsh/v1/images/generations".parse().unwrap();
        let old = reference(&state, "dsh").unwrap();
        assert!(check_unchanged(&state, &uri, &old).is_ok());
        crate::commands::imagegen_test_support::enable(&state.db, "dsh", false);
        assert!(check_unchanged(&state, &uri, &old).is_err());
        crate::commands::imagegen_test_support::enable(&state.db, "dsh", true);
        crate::commands::imagegen_connection_test_support::install_welfare(
            &state.db,
            "dsh",
            "sk-new-primary",
            "sk-welfare",
        );
        assert!(check_unchanged(&state, &uri, &old).is_err());
        drop(cleanup);
    }
}
