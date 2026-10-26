//! Automatic recovery requires evidence that the previous Core has stopped.
//! A failed management request alone never grants permission to replace it.
use super::{candidate_ports, runtime_record_path, CoreRuntimeRecord, ProxyConfig};
use std::error::Error;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessState {
    Alive,
    Exited,
    Unknown,
}

#[cfg(unix)]
fn process_state(pid: u32) -> ProcessState {
    let Some(pid) = i32::try_from(pid).ok().filter(|pid| *pid > 0) else {
        return ProcessState::Unknown;
    };
    // Signal 0 only observes existence/permission; it never signals the process.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return ProcessState::Alive;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => ProcessState::Exited,
        Some(libc::EPERM) => ProcessState::Alive,
        _ => ProcessState::Unknown,
    }
}

#[cfg(windows)]
fn process_state(pid: u32) -> ProcessState {
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    if pid == 0 {
        return ProcessState::Unknown;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return if GetLastError() == ERROR_INVALID_PARAMETER {
                ProcessState::Exited
            } else {
                ProcessState::Unknown
            };
        }
        let wait = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        match wait {
            WAIT_TIMEOUT => ProcessState::Alive,
            WAIT_OBJECT_0 => ProcessState::Exited,
            _ => ProcessState::Unknown,
        }
    }
}

fn require_exited(pid: u32, state: ProcessState) -> Result<(), String> {
    match state {
        ProcessState::Exited => Ok(()),
        ProcessState::Alive => Err(format!("stage=process pid={pid} state=alive")),
        ProcessState::Unknown => Err(format!("stage=process pid={pid} state=unknown")),
    }
}

async fn require_runtime_and_ports_stopped(
    config_dir: &Path,
    config: &ProxyConfig,
    inspect_process: impl Fn(u32) -> ProcessState,
) -> Result<(), String> {
    match std::fs::read(runtime_record_path(config_dir)) {
        Ok(bytes) => {
            let record: CoreRuntimeRecord = serde_json::from_slice(&bytes)
                .map_err(|_| "stage=runtime state=invalid".to_string())?;
            require_exited(record.pid, inspect_process(record.pid))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!("stage=runtime state=unknown io={:?}", error.kind()));
        }
    }
    for (address, port) in candidate_ports(config_dir, config) {
        let address = match address.as_str() {
            "0.0.0.0" | "localhost" => "127.0.0.1",
            "::" => "::1",
            value => value,
        };
        let ip: IpAddr = address
            .parse()
            .map_err(|_| "stage=tcp state=unknown reason=invalid_address".to_string())?;
        if port == 0 {
            return Err("stage=tcp state=unknown reason=invalid_port".into());
        }
        match tokio::time::timeout(
            Duration::from_millis(350),
            tokio::net::TcpStream::connect(SocketAddr::new(ip, port)),
        )
        .await
        {
            Ok(Ok(_stream)) => return Err(format!("stage=tcp port={port} state=listening")),
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => {}
            Ok(Err(error)) => {
                return Err(format!(
                    "stage=tcp port={port} state=unknown io={:?}",
                    error.kind()
                ));
            }
            Err(_) => {
                return Err(format!(
                    "stage=tcp port={port} state=unknown reason=timeout"
                ))
            }
        }
    }
    Ok(())
}

pub(super) async fn require_stopped(config_dir: &Path, config: &ProxyConfig) -> Result<(), String> {
    require_runtime_and_ports_stopped(config_dir, config, process_state).await?;
    #[cfg(target_os = "macos")]
    {
        match inspect_launchd(config_dir, &super::launchd_domain(), &mut run_launchctl)? {
            LaunchdState::Absent | LaunchdState::Registered { pid: None } => {}
            LaunchdState::Registered { pid: Some(pid) } => {
                require_exited(pid, process_state(pid))?;
            }
        }
    }
    Ok(())
}

/// Preserve the failure stage, elapsed time and safe transport cause, never
/// response text, credentials, redirect destinations or raw error-chain text.
pub(super) fn probe_error(
    stage: &str,
    port: u16,
    started: Instant,
    error: &reqwest::Error,
) -> String {
    let kind = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_decode() {
        "decode"
    } else if error.is_body() {
        "body"
    } else if error.is_builder() {
        "builder"
    } else {
        "request"
    };
    let mut diagnostic = format!(
        "Core 状态探测失败: stage={stage} port={port} kind={kind} elapsed_ms={}",
        started.elapsed().as_millis()
    );
    let mut source = error.source();
    for _ in 0..12 {
        let Some(current) = source else { break };
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            diagnostic.push_str(&format!(" io={:?}", io.kind()));
            if let Some(code) = io.raw_os_error() {
                diagnostic.push_str(&format!(" os={code}"));
            }
            break;
        }
        source = current.source();
    }
    diagnostic
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct LaunchctlOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[cfg(target_os = "macos")]
impl LaunchctlOutput {
    fn checked(self, action: &str) -> Result<(), String> {
        if self.code == Some(0) {
            Ok(())
        } else {
            // launchctl stderr is not needed to decide whether a process lives.
            // Its numeric exit code is sufficient and avoids dumping job data.
            Err(format!(
                "stage=launchctl action={action} exit={:?}",
                self.code
            ))
        }
    }
}

#[cfg(target_os = "macos")]
fn run_launchctl(args: &[&str]) -> Result<LaunchctlOutput, String> {
    let output = std::process::Command::new("launchctl")
        .args(args)
        .output()
        .map_err(|error| format!("stage=launchctl action={} io={:?}", args[0], error.kind()))?;
    Ok(LaunchctlOutput {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq, Eq)]
enum LaunchdState {
    Absent,
    Registered { pid: Option<u32> },
}

#[cfg(target_os = "macos")]
fn same_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

#[cfg(target_os = "macos")]
fn inspect_launchd(
    config_dir: &Path,
    domain: &str,
    run: &mut impl FnMut(&[&str]) -> Result<LaunchctlOutput, String>,
) -> Result<LaunchdState, String> {
    let service = format!("{domain}/{}", super::launchd_label());
    let output = run(&["print", &service])?;
    if output.code == Some(113)
        && output.stderr.contains(&format!(
            "Could not find service \"{}\"",
            super::launchd_label()
        ))
    {
        return Ok(LaunchdState::Absent);
    }
    if output.code != Some(0) {
        return Err(format!(
            "stage=launchctl action=print state=unknown exit={:?}",
            output.code
        ));
    }
    let mut lines = output.stdout.lines().map(str::trim);
    let arguments: Vec<_> = lines
        .by_ref()
        .skip_while(|line| *line != "arguments = {")
        .skip(1)
        .take_while(|line| *line != "}")
        .collect();
    let executable = super::current_core_path(config_dir);
    if arguments.len() != 4
        || !same_path(Path::new(arguments[0]), &executable)
        || arguments[1] != "run"
        || arguments[2] != "--config-dir"
        || !same_path(Path::new(arguments[3]), config_dir)
    {
        return Err(
            "stage=launchctl state=config_mismatch；保留已有服务，请完成配置目录切换后重启应用"
                .into(),
        );
    }
    let pid_text = output
        .stdout
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("pid = "));
    let pid = match pid_text {
        Some(text) => Some(
            text.parse::<u32>()
                .ok()
                .filter(|pid| *pid > 0)
                .ok_or_else(|| "stage=launchctl state=unknown reason=invalid_pid".to_string())?,
        ),
        None => None,
    };
    if pid.is_none() {
        let state = output
            .stdout
            .lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix("state = "));
        if !matches!(
            state,
            Some("not running" | "waiting" | "exited" | "spawn scheduled")
        ) {
            return Err("stage=launchctl state=unknown reason=missing_pid".into());
        }
    }
    Ok(LaunchdState::Registered { pid })
}

#[cfg(target_os = "macos")]
pub(super) fn validate_launchd_config(config_dir: &Path) -> Result<(), String> {
    inspect_launchd(config_dir, &super::launchd_domain(), &mut run_launchctl).map(|_| ())
}

#[cfg(target_os = "macos")]
pub(super) fn start_launchd(config_dir: &Path, domain: &str, plist: &Path) -> Result<(), String> {
    start_launchd_with(config_dir, domain, plist, run_launchctl, std::thread::sleep)
}

#[cfg(target_os = "macos")]
fn start_launchd_with(
    config_dir: &Path,
    domain: &str,
    plist: &Path,
    mut run: impl FnMut(&[&str]) -> Result<LaunchctlOutput, String>,
    mut delay: impl FnMut(Duration),
) -> Result<(), String> {
    let service = format!("{domain}/{}", super::launchd_label());
    let plist = plist.to_string_lossy();
    let mut bootstrap_error = None;
    for attempt in 0..3 {
        match inspect_launchd(config_dir, domain, &mut run) {
            Ok(LaunchdState::Registered { .. }) => {
                // Without -k launchd preserves an already-running instance.
                return run(&["kickstart", &service])?.checked("kickstart");
            }
            Ok(LaunchdState::Absent) => {}
            Err(error) => {
                return Err(match bootstrap_error {
                    Some(previous) => format!("{previous}；{error}"),
                    None => error,
                });
            }
        }
        match run(&["bootstrap", domain, &plist])?.checked("bootstrap") {
            Ok(()) => return Ok(()),
            Err(error) => bootstrap_error = Some(error),
        }
        if attempt < 2 {
            delay(Duration::from_millis(150));
        }
    }
    Err(bootstrap_error.unwrap_or_else(|| "stage=launchctl action=bootstrap state=unknown".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(port: u16) -> ProxyConfig {
        ProxyConfig {
            listen_address: "127.0.0.1".into(),
            listen_port: port,
            ..ProxyConfig::default()
        }
    }

    fn runtime(dir: &Path, pid: u32, port: u16) {
        std::fs::create_dir_all(super::super::core_root(dir)).unwrap();
        std::fs::write(
            runtime_record_path(dir),
            serde_json::to_vec(&CoreRuntimeRecord {
                pid,
                address: "127.0.0.1".into(),
                port,
                binary_id: "synthetic".into(),
                updated_at: String::new(),
            })
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn process_probe_observes_self_and_rejects_unknown() {
        assert_eq!(process_state(std::process::id()), ProcessState::Alive);
        assert_eq!(process_state(0), ProcessState::Unknown);
        assert!(require_exited(42, ProcessState::Unknown).is_err());
        assert!(require_exited(42, ProcessState::Exited).is_ok());
    }

    #[tokio::test]
    async fn live_runtime_pid_prevents_recovery_even_without_listener() {
        let dir = tempfile::tempdir().unwrap();
        runtime(dir.path(), std::process::id(), 1);
        let error = require_runtime_and_ports_stopped(dir.path(), &config(1), process_state)
            .await
            .unwrap_err();
        assert!(error.contains("state=alive"));
    }

    #[tokio::test]
    async fn corrupt_runtime_is_not_treated_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(super::super::core_root(dir.path())).unwrap();
        std::fs::write(runtime_record_path(dir.path()), b"secret-not-json").unwrap();
        let error = require_runtime_and_ports_stopped(dir.path(), &config(1), process_state)
            .await
            .unwrap_err();
        assert!(error.contains("stage=runtime state=invalid"));
        assert!(!error.contains("secret"));
    }

    #[tokio::test]
    async fn exited_runtime_still_requires_every_candidate_port_to_be_closed() {
        let dir = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed_port = closed.local_addr().unwrap().port();
        drop(closed);
        runtime(dir.path(), 42, closed_port);
        let error =
            require_runtime_and_ports_stopped(dir.path(), &config(port), |_| ProcessState::Exited)
                .await
                .unwrap_err();
        assert!(error.contains("state=listening"));
        drop(listener);
        assert!(
            require_runtime_and_ports_stopped(dir.path(), &config(port), |_| {
                ProcessState::Exited
            })
            .await
            .is_ok()
        );
    }

    #[cfg(target_os = "macos")]
    mod launchd {
        use super::*;
        use std::collections::VecDeque;

        fn output(code: i32, stdout: &str, stderr: &str) -> LaunchctlOutput {
            LaunchctlOutput {
                code: Some(code),
                stdout: stdout.into(),
                stderr: stderr.into(),
            }
        }

        fn absent() -> LaunchctlOutput {
            output(
                113,
                "",
                &format!(
                    "Could not find service \"{}\"",
                    super::super::super::launchd_label()
                ),
            )
        }

        fn registered(dir: &Path, pid: Option<u32>) -> LaunchctlOutput {
            output(
                0,
                &format!(
                    "state = {}\narguments = {{\n{}\nrun\n--config-dir\n{}\n}}\n{}",
                    if pid.is_some() {
                        "running"
                    } else {
                        "not running"
                    },
                    super::super::super::current_core_path(dir).display(),
                    dir.display(),
                    pid.map(|pid| format!("pid = {pid}")).unwrap_or_default()
                ),
                "",
            )
        }

        #[test]
        fn registered_job_is_kickstarted_without_killing_or_bootout() {
            let dir = tempfile::tempdir().unwrap();
            let mut calls = Vec::new();
            start_launchd_with(
                dir.path(),
                "gui/42",
                Path::new("fixture.plist"),
                |args| {
                    calls.push(args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
                    Ok(if args[0] == "print" {
                        registered(dir.path(), Some(123))
                    } else {
                        output(0, "", "")
                    })
                },
                |_| panic!("registered services need no bootstrap retry"),
            )
            .unwrap();
            assert_eq!(calls.len(), 2);
            assert_eq!(calls[1][0], "kickstart");
            assert_eq!(calls[1].len(), 2);
        }

        #[test]
        fn bootstrap_retries_are_bounded_and_never_bootout() {
            let dir = tempfile::tempdir().unwrap();
            let mut calls = Vec::new();
            let mut delays = 0;
            let error = start_launchd_with(
                dir.path(),
                "gui/42",
                Path::new("fixture.plist"),
                |args| {
                    calls.push(args[0].to_string());
                    Ok(if args[0] == "print" {
                        absent()
                    } else {
                        output(5, "", "")
                    })
                },
                |_| delays += 1,
            )
            .unwrap_err();
            assert_eq!(
                calls,
                [
                    "print",
                    "bootstrap",
                    "print",
                    "bootstrap",
                    "print",
                    "bootstrap"
                ]
            );
            assert_eq!(delays, 2);
            assert!(error.contains("action=bootstrap exit=Some(5)"));
        }

        #[test]
        fn bootstrap_failure_recovers_if_job_appears_during_retry() {
            let dir = tempfile::tempdir().unwrap();
            let mut results = VecDeque::from([
                absent(),
                output(5, "", ""),
                registered(dir.path(), None),
                output(0, "", ""),
            ]);
            let mut calls = Vec::new();
            start_launchd_with(
                dir.path(),
                "gui/42",
                Path::new("fixture.plist"),
                |args| {
                    calls.push(args[0].to_string());
                    Ok(results.pop_front().unwrap())
                },
                |_| {},
            )
            .unwrap();
            assert_eq!(calls, ["print", "bootstrap", "print", "kickstart"]);
        }

        #[test]
        fn different_config_or_unknown_launchd_status_never_mutates_service() {
            let dir = tempfile::tempdir().unwrap();
            let other = tempfile::tempdir().unwrap();
            for result in [
                registered(other.path(), Some(123)),
                output(5, "", "unavailable"),
            ] {
                let mut result = Some(result);
                let mut calls = Vec::new();
                assert!(start_launchd_with(
                    dir.path(),
                    "gui/42",
                    Path::new("fixture.plist"),
                    |args| {
                        calls.push(args[0].to_string());
                        Ok(result.take().unwrap())
                    },
                    |_| panic!("unknown service must be preserved"),
                )
                .is_err());
                assert_eq!(calls, ["print"]);
            }
        }

        #[test]
        fn explicitly_removed_service_can_bootstrap_new_config() {
            let dir = tempfile::tempdir().unwrap();
            let mut calls = Vec::new();
            start_launchd_with(
                dir.path(),
                "gui/42",
                Path::new("fixture.plist"),
                |args| {
                    calls.push(args[0].to_string());
                    Ok(if args[0] == "print" {
                        absent()
                    } else {
                        output(0, "", "")
                    })
                },
                |_| panic!("successful bootstrap needs no delay"),
            )
            .unwrap();
            assert_eq!(calls, ["print", "bootstrap"]);
        }
    }
}
