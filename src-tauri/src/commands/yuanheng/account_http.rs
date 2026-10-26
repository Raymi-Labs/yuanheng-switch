//! Account reads may recover once from transport failure. Never replay writes,
//! HTTP/permission errors, redirects or malformed responses, or change origin.

use reqwest::{header::HeaderMap, Method, RequestBuilder, Response};
use serde_json::Value;
use std::time::Duration;

use crate::proxy::transport_error::{account_error, is_retryable_account_read};

pub(super) enum ReadError {
    Transport(reqwest::Error),
    Response(String),
}

impl ReadError {
    pub(super) fn message(&self, context: &str) -> String {
        match self {
            Self::Transport(error) => format!("{context}：{}", account_error(error)),
            Self::Response(message) => message.clone(),
        }
    }
}

pub(super) async fn parse_response(
    response: Response,
    http_error: Option<&str>,
) -> Result<(Value, HeaderMap), ReadError> {
    let status = response.status();
    if let Some(context) = http_error.filter(|_| !status.is_success()) {
        // Token catalog errors must never echo an upstream credential/error page.
        return Err(ReadError::Response(format!(
            "{context}（HTTP {}）",
            status.as_u16()
        )));
    }
    let headers = response.headers().clone();
    let body = response.text().await.map_err(|error| {
        if status.is_success() {
            ReadError::Transport(error)
        } else {
            // Receiving an HTTP error ends recovery even if its body is broken.
            ReadError::Response(format!("元衡请求失败 (HTTP {status})"))
        }
    })?;
    let value: Value = serde_json::from_str(&body)
        .map_err(|_| ReadError::Response(format!("元衡返回了非 JSON 响应 (HTTP {status})")))?;
    if !status.is_success() {
        return Err(ReadError::Response(
            super::response_message(&value)
                .unwrap_or_else(|| format!("元衡请求失败 (HTTP {status})")),
        ));
    }
    Ok((value, headers))
}

pub(super) async fn get_json(
    builder: RequestBuilder,
    context: &str,
    http_error: Option<&str>,
) -> Result<(Value, HeaderMap), String> {
    let (client, request) = builder.build_split();
    let request = request.map_err(|error| format!("{context}：{}", account_error(&error)))?;
    if request.method() != Method::GET || request.body().is_some() {
        return Err("账号读取恢复仅支持无正文的 GET 请求".to_string());
    }
    for attempt in 0..2 {
        let next = request
            .try_clone()
            .ok_or_else(|| "无法重新构建账号读取请求".to_string())?;
        let result = match client.execute(next).await {
            Ok(response) => parse_response(response, http_error).await,
            Err(error) => Err(ReadError::Transport(error)),
        };
        match result {
            Ok(value) => return Ok(value),
            Err(ReadError::Transport(error))
                if attempt == 0 && is_retryable_account_read(&error) =>
            {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(error) => return Err(error.message(context)),
        }
    }
    unreachable!("the final attempt always returns")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Server {
        origin: String,
        requests: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn server(replies: Vec<String>) -> Server {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut byte = [0; 1];
                    if socket.read(&mut byte).await.unwrap() == 0 {
                        break;
                    }
                    bytes.push(byte[0]);
                }
                let index = {
                    let mut seen = seen.lock().unwrap();
                    seen.push(String::from_utf8(bytes).unwrap());
                    seen.len() - 1
                };
                let reply = &replies[index.min(replies.len() - 1)];
                // Empty reply closes before headers; an oversized Content-Length
                // closes during the body. Both exercise real reqwest errors.
                socket.write_all(reply.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
        });
        Server {
            origin,
            requests,
            task,
        }
    }

    fn reply(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
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
    async fn catalog_recovers_connection_and_body_once_without_changing_identity() {
        for failure in [
            String::new(),
            "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{".into(),
        ] {
            let server = server(vec![
                failure,
                reply("200 OK", r#"{"success":true,"data":["gpt-5.6-luna"]}"#),
            ])
            .await;
            let group = "OpenAI · 独享账号 + & /";
            let models = super::super::fetch_user_models_at(
                &client(),
                &server.origin,
                "session=test-secret",
                "synthetic-user",
                Some(group),
            )
            .await
            .unwrap();
            assert_eq!(models, ["gpt-5.6-luna"]);
            let requests = server.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0], requests[1]);
            let target = requests[0].split_whitespace().nth(1).unwrap();
            let url = reqwest::Url::parse(&format!("{}{target}", server.origin)).unwrap();
            assert_eq!(
                url.query_pairs().collect::<Vec<_>>(),
                [("group".into(), group.into())]
            );
            assert!(requests[0].contains("cookie: session=test-secret\r\n"));
            assert!(requests[0].contains("new-api-user: synthetic-user\r\n"));
        }
    }

    #[tokio::test]
    async fn persistent_failure_is_bounded_and_redacted() {
        let server = server(vec![String::new()]).await;
        let error = super::super::fetch_user_models_at(
            &client(),
            &server.origin,
            "session=test-secret",
            "synthetic-user",
            Some("private-group"),
        )
        .await
        .unwrap_err();
        assert_eq!(server.requests.lock().unwrap().len(), 2);
        assert!(error.contains("读取账号模型失败"));
        for secret in [
            "127.0.0.1",
            "/api/user",
            "test-secret",
            "synthetic-user",
            "private-group",
        ] {
            assert!(!error.contains(secret), "{error}");
        }
    }

    #[tokio::test]
    async fn http_business_parse_and_empty_catalog_results_are_never_retried() {
        for response in [
            reply(
                "401 Unauthorized",
                r#"{"success":false,"message":"expired"}"#,
            ),
            reply("403 Forbidden", r#"{"success":false}"#),
            reply("429 Too Many Requests", r#"{"success":false}"#),
            reply("503 Service Unavailable", r#"{"success":false}"#),
            reply("302 Found", ""),
            reply("200 OK", r#"{"success":false,"message":"denied"}"#),
            reply("200 OK", "invalid json"),
            reply("200 OK", r#"{"success":true,"data":[]}"#),
            reply("200 OK", r#"{"success":true,"data":["different-model"]}"#),
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{".into(),
        ] {
            let server = server(vec![response]).await;
            let _ = super::super::fetch_user_models_at(
                &client(),
                &server.origin,
                "session=test",
                "user",
                Some("group"),
            )
            .await;
            assert_eq!(server.requests.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn token_catalog_recovers_but_http_errors_do_not_echo_body() {
        let server = server(vec![
            String::new(),
            reply("200 OK", r#"{"data":[{"id":"test-model"}]}"#),
            reply("403 Forbidden", "sk-secret-must-not-be-exposed"),
        ])
        .await;
        assert_eq!(
            super::super::fetch_api_models_at(&client(), &server.origin, "sk-test")
                .await
                .unwrap(),
            ["test-model"]
        );
        let error = super::super::fetch_api_models_at(&client(), &server.origin, "sk-test")
            .await
            .unwrap_err();
        assert_eq!(server.requests.lock().unwrap().len(), 3);
        assert!(error.contains("HTTP 403"));
        assert!(!error.contains("sk-"));
    }

    #[tokio::test]
    async fn writes_are_never_replayed_or_accepted_by_read_recovery() {
        let server = server(vec![String::new()]).await;
        let client = client();
        let body = serde_json::json!({"name":"synthetic-token"});
        assert!(
            super::super::post_json(&client, &server.origin, &body, None, None)
                .await
                .is_err()
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert!(get_json(client.post(&server.origin), "test", None)
            .await
            .is_err());
        assert!(
            get_json(client.get(&server.origin).body("unexpected"), "test", None)
                .await
                .is_err()
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}
