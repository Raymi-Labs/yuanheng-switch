//! Safe, bounded transport diagnostics. Never return raw source-chain text:
//! connector errors can contain proxy credentials, URL paths or query strings.

use super::error::ProxyError;
use std::error::Error;
use std::io::ErrorKind;

struct Diagnostic {
    kind: &'static str,
    io_kind: Option<ErrorKind>,
    os_code: Option<i32>,
}

fn classify(error: &(dyn Error + 'static)) -> Diagnostic {
    let mut current = Some(error);
    let mut diagnostic = Diagnostic {
        kind: "unknown",
        io_kind: None,
        os_code: None,
    };
    let mut dns = false;
    let mut tls = false;
    let mut tunnel = false;
    // Limit depth and inspect text only for known categories, never output it.
    for _ in 0..12 {
        let Some(source) = current else { break };
        if let Some(io) = source.downcast_ref::<std::io::Error>() {
            diagnostic.io_kind = Some(io.kind());
            diagnostic.os_code = io.raw_os_error();
        }
        let text = source
            .to_string()
            .chars()
            .take(1024)
            .collect::<String>()
            .to_ascii_lowercase();
        dns |= [
            "dns error",
            "failed to lookup address",
            "name or service not known",
            "nodename nor servname",
            "getaddrinfo",
        ]
        .iter()
        .any(|term| text.contains(term));
        tls |= [
            "certificate",
            "tls handshake",
            "ssl handshake",
            "invalid peer",
        ]
        .iter()
        .any(|term| text.contains(term));
        tunnel |= [
            "unsuccessful tunnel",
            "tunnel error",
            "proxy authentication required",
            "proxyconnect",
        ]
        .iter()
        .any(|term| text.contains(term));
        current = source.source();
    }
    diagnostic.kind = if dns {
        "dns"
    } else if tls {
        "tls"
    } else if tunnel {
        "proxy_tunnel"
    } else {
        match diagnostic.io_kind {
            Some(ErrorKind::ConnectionRefused) => "connection_refused",
            Some(
                ErrorKind::ConnectionReset
                | ErrorKind::ConnectionAborted
                | ErrorKind::BrokenPipe
                | ErrorKind::UnexpectedEof,
            ) => "connection_closed",
            Some(ErrorKind::TimedOut) => "timeout",
            Some(
                ErrorKind::NetworkUnreachable
                | ErrorKind::HostUnreachable
                | ErrorKind::AddrNotAvailable,
            ) => "network_unreachable",
            _ => "unknown",
        }
    };
    diagnostic
}

impl Diagnostic {
    fn summary(&self) -> String {
        let mut detail = format!("network={}", self.kind);
        if let Some(kind) = self.io_kind {
            detail.push_str(&format!("; io={kind:?}"));
        }
        if let Some(code) = self.os_code {
            detail.push_str(&format!("; os={code}"));
        }
        detail
    }

    fn hint(&self) -> &'static str {
        match self.kind {
            "dns" => "请检查 DNS 解析及代理的域名分流规则",
            "tls" => "请检查证书信任、系统时间及代理 TLS 连接",
            "proxy_tunnel" => "请检查出站代理的认证、节点及 CONNECT 隧道",
            "connection_refused" => "请检查出站代理或目标服务是否启动、端口是否正确",
            "network_unreachable" => "请检查当前网络和出站代理路由",
            "connection_closed" => "连接被中断，请检查出站代理节点及网络稳定性",
            _ => "请检查 DNS、出站代理及目标域名的分流规则",
        }
    }
}

pub(super) fn map_send_error(error: reqwest::Error) -> ProxyError {
    let mut diagnostic = classify(&error);
    if error.is_timeout() {
        diagnostic.kind = "timeout";
    }
    let official_codex = error.url().is_some_and(|url| {
        url.host_str() == Some("chatgpt.com") && url.path().starts_with("/backend-api/codex")
    });
    let hint = if official_codex
        && error.is_connect()
        && !matches!(
            diagnostic.kind,
            "tls" | "proxy_tunnel" | "connection_refused"
        ) {
        "请检查代理中 chatgpt.com 的域名规则和 DNS 解析，确认没有误分流为直连"
    } else {
        diagnostic.hint()
    };
    let prefix = if error.is_timeout() {
        "上游请求超时"
    } else if error.is_connect() {
        "上游连接失败"
    } else {
        "上游请求发送失败"
    };
    let detail = format!("{prefix} [{}]；{hint}", diagnostic.summary());
    if error.is_timeout() {
        ProxyError::Timeout(detail)
    } else {
        ProxyError::ForwardFailed(detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Wrapped(&'static str, Option<Box<dyn Error + Send + Sync>>);
    impl std::fmt::Display for Wrapped {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }
    impl Error for Wrapped {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            self.1.as_deref().map(|e| e as _)
        }
    }

    #[test]
    fn classifies_nested_causes_without_disclosing_raw_errors() {
        for (raw, expected) in [
            ("dns error: failed to lookup address secret.example", "dns"),
            (
                "invalid peer certificate for https://user:password@example/key?token=secret",
                "tls",
            ),
            (
                "unsuccessful tunnel https://user:password@example",
                "proxy_tunnel",
            ),
            ("unknown connector failure Bearer private-token", "unknown"),
        ] {
            let error = Wrapped("error sending request", Some(Box::new(Wrapped(raw, None))));
            let diagnostic = classify(&error);
            assert_eq!(diagnostic.kind, expected);
            let output = format!("{} {}", diagnostic.summary(), diagnostic.hint());
            for sensitive in [
                "secret",
                "password",
                "Bearer",
                "example",
                "private-token",
                "https://",
            ] {
                assert!(!output.contains(sensitive), "{output}");
            }
        }
    }

    #[test]
    fn preserves_io_kind_and_os_code_from_nested_cause() {
        let io = std::io::Error::from_raw_os_error(if cfg!(windows) {
            10061
        } else if cfg!(target_os = "macos") {
            61
        } else {
            111
        });
        let code = io.raw_os_error();
        let diagnostic = classify(&Wrapped("connect", Some(Box::new(io))));
        assert_eq!(diagnostic.kind, "connection_refused");
        assert_eq!(diagnostic.os_code, code);
        assert_eq!(diagnostic.io_kind, Some(ErrorKind::ConnectionRefused));
    }

    #[tokio::test]
    async fn actual_refused_connection_is_502_without_url_secrets() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let error = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{addr}/private-key?token=secret"))
            .send()
            .await
            .unwrap_err();
        let mapped = map_send_error(error);
        assert!(matches!(mapped, ProxyError::ForwardFailed(_)));
        assert!(mapped.to_string().contains("connection_refused"));
        assert!(!mapped.to_string().contains("secret"));
        assert!(!mapped.to_string().contains("private-key"));
        use axum::response::IntoResponse;
        assert_eq!(mapped.into_response().status(), 502);
    }

    #[tokio::test]
    async fn actual_timeout_keeps_504_and_does_not_replay() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let error = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_millis(100))
            .build()
            .unwrap()
            .post(format!("http://{addr}/private-key"))
            .body("private body")
            .send()
            .await
            .unwrap_err();
        let mapped = map_send_error(error);
        assert!(matches!(mapped, ProxyError::Timeout(_)));
        assert!(mapped.to_string().contains("network=timeout"));
        use axum::response::IntoResponse;
        assert_eq!(mapped.into_response().status(), 504);
        let _first = listener.accept().await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }
}
