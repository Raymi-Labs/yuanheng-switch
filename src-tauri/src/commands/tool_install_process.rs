//! Own the native install process tree, not merely the shell or UI promise.
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::process::{Output, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub(super) const CANCELLED: &str =
    "[INSTALL_CANCELLED] 安装已停止；已写入的文件不会回滚，请先重新检测工具再决定是否重试。";
pub(super) const TIMED_OUT: &str = "[INSTALL_TIMEOUT] 安装超过 10 分钟，已停止本次安装进程。请检查网络与依赖，重新检测工具后再决定是否重试。";
const OUTPUT_LIMIT: usize = 64 * 1024;
// Only structured, non-sensitive progress crosses IPC; never installer output.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub stage: &'static str,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub activity: bool,
}

#[derive(Clone)]
pub(super) struct ProgressReporter(pub Option<tauri::ipc::Channel<InstallProgress>>);
impl ProgressReporter {
    pub fn stage(&self, stage: &'static str) {
        self.send(InstallProgress {
            stage,
            downloaded_bytes: None,
            total_bytes: None,
            activity: true,
        });
    }
    fn send(&self, progress: InstallProgress) {
        if let Some(channel) = &self.0 {
            let _ = channel.send(progress);
        }
    }
}

fn read_small(path: &std::path::Path, limit: u64) -> String {
    use std::io::Read;
    let mut value = String::new();
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.take(limit).read_to_string(&mut value);
    }
    value
}

fn download_total(headers: &str) -> Option<u64> {
    let mut total = None;
    for line in headers.lines() {
        if line.starts_with("HTTP/") {
            total = None;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                total = value.trim().parse::<u64>().ok().filter(|n| *n > 0);
            }
        }
    }
    total
}

fn progress_snapshot(stage_dir: Option<&std::path::Path>, activity: bool) -> InstallProgress {
    let mut result = InstallProgress {
        stage: "executing",
        downloaded_bytes: None,
        total_bytes: None,
        activity,
    };
    if let Some(dir) = stage_dir {
        result.stage = match read_small(&dir.join("phase"), 64).trim() {
            "download" => "download",
            "checksum" => "checksum",
            "extract" => "extract",
            "package" => "package",
            "verify" => "verify",
            _ => "preparing",
        };
        if result.stage == "download" {
            result.downloaded_bytes = ["runtime.tar.gz", "runtime.zip"]
                .iter()
                .find_map(|name| std::fs::metadata(dir.join(name)).ok().map(|m| m.len()));
            result.total_bytes = download_total(&read_small(&dir.join("download.headers"), 8192))
                .filter(|total| result.downloaded_bytes.unwrap_or(0) <= *total);
        }
    }
    result
}

static OPERATIONS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub(super) struct Operation {
    id: String,
    pub cancelled: Arc<AtomicBool>,
}
impl Operation {
    pub fn register(id: String) -> Result<Self, String> {
        uuid::Uuid::parse_str(&id).map_err(|_| "无效的安装任务标识".to_string())?;
        let mut operations = OPERATIONS
            .lock()
            .map_err(|_| "安装状态不可用".to_string())?;
        if operations.contains_key(&id) {
            return Err("安装任务标识已占用".to_string());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        operations.insert(id.clone(), cancelled.clone());
        Ok(Self { id, cancelled })
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut operations) = OPERATIONS.lock() {
            operations.remove(&self.id);
        }
    }
}
pub(super) fn cancel(id: &str) -> Result<bool, String> {
    let operations = OPERATIONS
        .lock()
        .map_err(|_| "安装状态不可用".to_string())?;
    if let Some(cancelled) = operations.get(id) {
        cancelled.store(true, Ordering::SeqCst);
        Ok(true)
    } else {
        Ok(false)
    }
}

fn append_tail(tail: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.len() >= OUTPUT_LIMIT {
        tail.clear();
        tail.extend_from_slice(&bytes[bytes.len() - OUTPUT_LIMIT..]);
    } else {
        let excess = (tail.len() + bytes.len()).saturating_sub(OUTPUT_LIMIT);
        tail.drain(..excess);
        tail.extend_from_slice(bytes);
    }
}
async fn drain(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    activity: Arc<AtomicBool>,
) -> Vec<u8> {
    let mut tail = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => return tail,
            Ok(n) => {
                append_tail(&mut tail, &chunk[..n]);
                activity.store(true, Ordering::Relaxed);
            }
        }
    }
}

struct PipeReader(tokio::task::JoinHandle<Vec<u8>>);
impl Drop for PipeReader {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(unix)]
struct Tree(Option<i32>);
#[cfg(unix)]
impl Tree {
    fn terminate(&mut self) -> std::io::Result<()> {
        let Some(group) = self.0 else {
            return Ok(());
        };
        // Negative PID targets only the group created for this child.
        let result = unsafe { libc::kill(-group, libc::SIGKILL) };
        if result == 0 {
            self.0 = None;
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            self.0 = None;
            Ok(())
        } else {
            Err(error)
        }
    }
}
#[cfg(unix)]
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

#[cfg(windows)]
struct Tree(windows_sys::Win32::Foundation::HANDLE);
// The handle is owned by the supervisor, never shared with another task.
#[cfg(windows)]
unsafe impl Send for Tree {}
#[cfg(windows)]
impl Tree {
    fn new(child: &tokio::process::Child) -> std::io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = Self(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(
                    handle,
                    child
                        .raw_handle()
                        .ok_or_else(std::io::Error::last_os_error)? as _,
                ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
    }
    fn terminate(&mut self) -> std::io::Result<()> {
        if unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1) } == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    fn empty(&self) -> std::io::Result<bool> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            if QueryInformationJobObject(
                self.0,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(info.ActiveProcesses == 0)
        }
    }
}
#[cfg(windows)]
impl Drop for Tree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Windows command must start with our stdin gate; callers never supply commands via IPC.
/// Unix creates the group before exec. Always kill remaining descendants, even on success.
#[cfg(test)]
pub(super) async fn run(
    command: tokio::process::Command,
    cancelled: Arc<AtomicBool>,
    timeout: Duration,
) -> Result<Output, String> {
    run_with_progress(command, cancelled, timeout, ProgressReporter(None), None).await
}

pub(super) async fn run_with_progress(
    mut command: tokio::process::Command,
    cancelled: Arc<AtomicBool>,
    timeout: Duration,
    progress: ProgressReporter,
    stage_dir: Option<&std::path::Path>,
) -> Result<Output, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err(CANCELLED.to_string());
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        command.process_group(0).stdin(Stdio::null());
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000).stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动安装进程，请检查系统环境与执行权限".to_string())?;
    #[cfg(unix)]
    let mut tree = Tree(Some(child.id().expect("new child has PID") as i32));
    #[cfg(windows)]
    let mut tree = match Tree::new(&child) {
        Ok(tree) => tree,
        Err(_) => {
            let _ = child.kill().await;
            return Err("无法隔离安装进程，已拒绝执行，请检查系统权限".to_string());
        }
    };
    #[cfg(windows)]
    {
        use tokio::io::AsyncWriteExt;
        let mut input = child.stdin.take().expect("piped stdin");
        if input.write_all(b"YUANHENG_GO\r\n").await.is_err() {
            let _ = tree.terminate();
            let _ = child.kill().await;
            return Err("无法启动受控安装任务".to_string());
        }
    }
    let activity = Arc::new(AtomicBool::new(false));
    let mut stdout = PipeReader(tokio::spawn(drain(
        child.stdout.take().expect("piped stdout"),
        activity.clone(),
    )));
    let mut stderr = PipeReader(tokio::spawn(drain(
        child.stderr.take().expect("piped stderr"),
        activity.clone(),
    )));
    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_report = tokio::time::Instant::now() - Duration::from_secs(1);
    let mut previous = None;
    let outcome = loop {
        if last_report.elapsed() >= Duration::from_millis(500) {
            let mut next = progress_snapshot(stage_dir, false);
            let changed = previous.as_ref() != Some(&next);
            let output_activity = activity.swap(false, Ordering::Relaxed);
            previous = Some(next.clone());
            if changed || output_activity {
                next.activity = true;
                progress.send(next);
            }
            last_report = tokio::time::Instant::now();
        }
        if cancelled.load(Ordering::SeqCst) {
            break Err(CANCELLED.to_string());
        }
        if tokio::time::Instant::now() >= deadline {
            break Err(TIMED_OUT.to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
            Err(_) => break Err("无法读取安装进程状态".to_string()),
        }
    };
    let cleanup = tree.terminate();
    let reaped = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    #[cfg(windows)]
    let cleanup = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut result = cleanup;
        while result.is_ok() {
            match tree.empty() {
                Ok(true) => break,
                Ok(false) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(25)).await
                }
                _ => {
                    result = Err(std::io::Error::other("job did not stop"));
                    break;
                }
            }
        }
        result
    };
    // A detached process must never keep a pipe reader or the UI alive indefinitely.
    let read_out = tokio::time::timeout(Duration::from_secs(2), &mut stdout.0).await;
    let read_err = tokio::time::timeout(Duration::from_secs(2), &mut stderr.0).await;
    if cleanup.is_err() || !matches!(reaped, Ok(Ok(_))) {
        return Err(
            "[INSTALL_CLEANUP_FAILED] 无法确认安装进程已停止，请退出客户端并检查安装进程后再重试"
                .to_string(),
        );
    }
    let status = outcome?;
    if cancelled.load(Ordering::SeqCst) {
        return Err(CANCELLED.to_string());
    }
    let stdout = read_out
        .map_err(|_| "安装输出未正常关闭".to_string())?
        .map_err(|_| "安装输出读取失败".to_string())?;
    let stderr = read_err
        .map_err(|_| "安装输出未正常关闭".to_string())?
        .map_err(|_| "安装输出读取失败".to_string())?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(windows)]
pub(super) const GATE: &str = "@echo off\r\nset \"YUANHENG_INSTALL_GATE=\"\r\nset /p YUANHENG_INSTALL_GATE=\r\nif not \"%YUANHENG_INSTALL_GATE%\"==\"YUANHENG_GO\" exit /b 87\r\n";

#[cfg(test)]
mod tests {
    use super::*;

    fn command(script: &str) -> (tempfile::TempDir, tokio::process::Command) {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        let command = {
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", script]).current_dir(dir.path());
            command
        };
        #[cfg(windows)]
        let command = {
            let path = dir.path().join("test.bat");
            std::fs::write(&path, format!("{GATE}{script}")).unwrap();
            let mut command = tokio::process::Command::new("cmd");
            command.args(["/D", "/C"]).arg(path).current_dir(dir.path());
            command
        };
        (dir, command)
    }

    #[test]
    fn progress_reads_only_known_stages_and_actual_download_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        std::fs::write(path.join("phase"), "download\n").unwrap();
        std::fs::write(path.join("runtime.tar.gz"), [0; 25]).unwrap();
        std::fs::write(path.join("download.headers"), "HTTP/1.1 200 Connection established\r\nContent-Length: 500\r\n\r\nHTTP/2 200\r\ncontent-length: 100\r\nx-private: secret\r\n").unwrap();
        let progress = progress_snapshot(Some(path), false);
        assert_eq!(progress.downloaded_bytes, Some(25));
        assert_eq!(progress.total_bytes, Some(100));
        assert!(!serde_json::to_string(&progress).unwrap().contains("secret"));
        std::fs::write(path.join("phase"), "package").unwrap();
        let progress = progress_snapshot(Some(path), false);
        assert_eq!(progress.stage, "package");
        assert_eq!(progress.downloaded_bytes, None);
        assert_eq!(progress.total_bytes, None);
        std::fs::write(path.join("phase"), "secret-path").unwrap();
        assert_eq!(progress_snapshot(Some(path), false).stage, "preparing");
        assert_eq!(
            download_total("HTTP/1.1 200\nContent-Length: 500\nHTTP/2 200\n"),
            None
        );
        assert_eq!(download_total("Content-Length: 0"), None);
        assert_eq!(download_total("Content-Length: nonsense"), None);
    }

    #[tokio::test]
    async fn live_child_download_and_stage_changes_reach_the_channel() {
        #[cfg(unix)]
        let script = "echo download > phase; echo bytes > runtime.tar.gz; sleep 1; echo extract > phase; sleep 1";
        #[cfg(windows)]
        let script = "echo download>phase\r\necho bytes>runtime.zip\r\nping -n 2 127.0.0.1 >nul\r\necho extract>phase\r\nping -n 2 127.0.0.1 >nul";
        let (dir, cmd) = command(script);
        std::fs::write(
            dir.path().join("download.headers"),
            "HTTP/2 200\r\nContent-Length: 100\r\n",
        )
        .unwrap();
        let messages = Arc::new(Mutex::new(Vec::new()));
        let recorded = messages.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                recorded
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str::<serde_json::Value>(&json).unwrap());
            }
            Ok(())
        });
        run_with_progress(
            cmd,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
            ProgressReporter(Some(channel)),
            Some(dir.path()),
        )
        .await
        .unwrap();
        let messages = messages.lock().unwrap();
        assert!(messages.iter().any(|m| m["stage"] == "download"
            && m["downloadedBytes"].as_u64().unwrap_or(0) > 0
            && m["totalBytes"] == 100));
        assert!(messages
            .iter()
            .any(|m| m["stage"] == "extract" && m["totalBytes"].is_null()));
    }

    #[tokio::test]
    async fn output_activity_is_reported_without_exposing_output() {
        let (mut writer, reader) = tokio::io::duplex(1024);
        let activity = Arc::new(AtomicBool::new(false));
        use tokio::io::AsyncWriteExt;
        writer.write_all(b"private-token-and-path").await.unwrap();
        drop(writer);
        assert_eq!(
            drain(reader, activity.clone()).await,
            b"private-token-and-path"
        );
        assert!(activity.load(Ordering::Relaxed));
        let messages = Arc::new(Mutex::new(Vec::new()));
        let recorded = messages.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                recorded.lock().unwrap().push(json);
            }
            Ok(())
        });
        let (_dir, cmd) = command("echo private-token-and-path");
        run_with_progress(
            cmd,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
            ProgressReporter(Some(channel)),
            None,
        )
        .await
        .unwrap();
        let messages = messages.lock().unwrap();
        assert!(!messages.is_empty());
        assert!(messages
            .iter()
            .all(|m| !m.contains("private-token-and-path")));
    }

    #[tokio::test]
    async fn real_process_success_failure_and_bounded_output() {
        let (_dir, cmd) = command("echo installation-test");
        let out = run(
            cmd,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("installation-test"));
        #[cfg(unix)]
        let failure = "echo failure >&2; exit 7";
        #[cfg(windows)]
        let failure = "echo failure 1>&2\r\nexit /b 7";
        let (_dir, cmd) = command(failure);
        let out = run(
            cmd,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(out.status.code(), Some(7));
        assert!(String::from_utf8_lossy(&out.stderr).contains("failure"));
        #[cfg(unix)]
        let flood = "i=0; while [ $i -lt 12000 ]; do echo 0123456789abcdef; i=$((i+1)); done";
        #[cfg(windows)]
        let flood = "for /L %%i in (1,1,12000) do @echo 0123456789abcdef";
        let (_dir, cmd) = command(flood);
        let out = run(
            cmd,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(20),
        )
        .await
        .unwrap();
        assert!(out.status.success());
        assert_eq!(out.stdout.len(), OUTPUT_LIMIT);
    }

    #[tokio::test]
    async fn timeout_and_cancel_terminate_real_descendant_before_it_can_write() {
        for cancel_requested in [false, true] {
            #[cfg(unix)]
            let script = "(sleep 2; echo escaped > escaped.txt) & wait";
            #[cfg(windows)]
            let script = "powershell -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 2; Set-Content escaped.txt escaped\"";
            let (dir, cmd) = command(script);
            let cancelled = Arc::new(AtomicBool::new(false));
            let signal = cancelled.clone();
            let canceller = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                if cancel_requested {
                    signal.store(true, Ordering::SeqCst);
                }
            });
            let error = run(cmd, cancelled, Duration::from_millis(400))
                .await
                .unwrap_err();
            canceller.await.unwrap();
            assert!(error.contains(if cancel_requested {
                "[INSTALL_CANCELLED]"
            } else {
                "[INSTALL_TIMEOUT]"
            }));
            tokio::time::sleep(Duration::from_millis(2200)).await;
            assert!(!dir.path().join("escaped.txt").exists());
        }
    }

    #[tokio::test]
    async fn cancellation_before_spawn_and_invalid_executable_do_not_start_tasks() {
        let (dir, cmd) = command("echo started > started.txt");
        assert!(
            run(cmd, Arc::new(AtomicBool::new(true)), Duration::from_secs(1))
                .await
                .unwrap_err()
                .contains("[INSTALL_CANCELLED]")
        );
        assert!(!dir.path().join("started.txt").exists());
        assert!(run(
            tokio::process::Command::new(dir.path().join("nonexistent")),
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(1)
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn successful_shell_exit_also_reclaims_background_children() {
        #[cfg(unix)]
        let script = "(sleep 2; echo escaped > escaped.txt) & exit 0";
        #[cfg(windows)]
        let script = "start \"\" /B powershell -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 2; Set-Content escaped.txt escaped\"\r\nexit /b 0";
        let (dir, cmd) = command(script);
        let out = run(
            cmd,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(out.status.success());
        tokio::time::sleep(Duration::from_millis(2200)).await;
        assert!(!dir.path().join("escaped.txt").exists());
    }

    #[test]
    fn late_cancel_cannot_target_a_new_operation_or_reuse_an_active_id() {
        let first = Operation::register(uuid::Uuid::new_v4().to_string()).unwrap();
        let id = first.id.clone();
        assert!(Operation::register(id.clone()).is_err());
        assert!(cancel(&id).unwrap());
        assert!(first.cancelled.load(Ordering::SeqCst));
        drop(first);
        let second = Operation::register(uuid::Uuid::new_v4().to_string()).unwrap();
        assert!(!cancel(&id).unwrap());
        assert!(!second.cancelled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn stopping_one_job_does_not_kill_an_unrelated_process() {
        #[cfg(unix)]
        let mut unrelated = {
            let mut command = tokio::process::Command::new("/bin/sleep");
            command.arg("20");
            command
        };
        #[cfg(windows)]
        let mut unrelated = {
            let mut command = tokio::process::Command::new("ping");
            command.args(["-n", "20", "127.0.0.1"]);
            command
        };
        let mut unrelated = unrelated
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        #[cfg(unix)]
        let script = "sleep 5";
        #[cfg(windows)]
        let script = "ping -n 6 127.0.0.1 >nul";
        let (_dir, cmd) = command(script);
        let result = run(
            cmd,
            Arc::new(AtomicBool::new(false)),
            Duration::from_millis(100),
        )
        .await;
        let still_running = unrelated.try_wait().unwrap().is_none();
        unrelated.kill().await.unwrap();
        assert!(result.unwrap_err().contains("[INSTALL_TIMEOUT]"));
        assert!(still_running);
    }
}
