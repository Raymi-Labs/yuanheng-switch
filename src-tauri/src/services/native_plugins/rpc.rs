use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

const MAX_LINE: usize = 4 * 1024 * 1024;
pub(super) struct Rpc {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    sequence: u32,
    #[cfg(unix)]
    group: Option<i32>,
    #[cfg(windows)]
    job: Job,
}
impl Rpc {
    pub async fn start(binary: &Path, home: &Path, cwd: &Path) -> Result<Self, String> {
        let mut cmd = Command::new(binary);
        cmd.args(["-c", "features.remote_plugin=false", "app-server"])
            .env("CODEX_HOME", home)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Do not pass gateway/API secrets into the plugin management child.
        for key in [
            "OPENAI_API_KEY",
            "META_API_KEY",
            "ANTHROPIC_API_KEY",
            "CODEX_API_KEY",
        ] {
            cmd.env_remove(key);
        }
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000);
        }
        let mut child = cmd
            .spawn()
            .map_err(|_| "无法启动 Codex 原生引擎，请先安装或更新 Codex".to_string())?;
        #[cfg(windows)]
        let job = match Job::new(&child) {
            Ok(job) => job,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err("无法隔离原生插件进程，已停止".into());
            }
        };
        let input = child.stdin.take().ok_or("原生输入不可用")?;
        let output = BufReader::new(child.stdout.take().ok_or("原生输出不可用")?);
        let mut rpc = Self {
            #[cfg(unix)]
            group: child.id().map(|id| id as i32),
            #[cfg(windows)]
            job,
            child,
            input,
            output,
            sequence: 0,
        };
        let init=rpc.call("initialize",json!({"clientInfo":{"name":"yuanheng_plugins","version":"1.0.0"},"capabilities":{"experimentalApi":true}})).await;
        if let Err(e) = init {
            rpc.close().await;
            return Err(e);
        }
        rpc.input
            .write_all(b"{\"method\":\"initialized\"}\n")
            .await
            .map_err(|_| "原生初始化失败")?;
        Ok(rpc)
    }
    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.call_with_timeout(method, params, Duration::from_secs(30))
            .await
    }
    async fn call_with_timeout(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.sequence += 1;
        let id = self.sequence;
        let raw = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))
            .map_err(|_| "请求编码失败")?;
        let result = tokio::time::timeout(timeout, async {
            self.input
                .write_all(&raw)
                .await
                .map_err(|_| "原生请求发送失败")?;
            self.input
                .write_all(b"\n")
                .await
                .map_err(|_| "原生请求发送失败")?;
            let mut total = 0usize;
            for _ in 0..200 {
                let mut line = Vec::new();
                loop {
                    let buf = self
                        .output
                        .fill_buf()
                        .await
                        .map_err(|_| "原生响应读取失败")?;
                    if buf.is_empty() {
                        return Err("原生引擎已退出".to_string());
                    }
                    let count = buf
                        .iter()
                        .position(|b| *b == b'\n')
                        .map(|p| p + 1)
                        .unwrap_or(buf.len());
                    if line.len() + count > MAX_LINE {
                        return Err("原生响应超过安全大小".into());
                    }
                    total += count;
                    if total > 8 * 1024 * 1024 {
                        return Err("原生响应总量超过限制".into());
                    }
                    line.extend_from_slice(&buf[..count]);
                    self.output.consume(count);
                    if line.last() == Some(&b'\n') {
                        break;
                    }
                }
                let value: Value =
                    serde_json::from_slice(&line).map_err(|_| "原生响应格式不兼容")?;
                if value.get("id") == Some(&json!(id)) && value.get("method").is_none() {
                    if value.get("error").is_some() {
                        return Err(
                            "Codex 拒绝操作或插件接口不兼容，请更新 Codex 并刷新检查；未自动重试"
                                .into(),
                        );
                    }
                    return value
                        .get("result")
                        .cloned()
                        .ok_or_else(|| "原生响应缺少结果".into());
                }
                // Never approve native prompts or external authentication requests automatically.
                if value.get("method").is_some() && value.get("id").is_some() {
                    let reply = json!({"id":value["id"], "error":{
                        "code":-32601, "message":"Interactive approval must be completed in Codex"
                    }});
                    let mut bytes = serde_json::to_vec(&reply).map_err(|_| "编码失败")?;
                    bytes.push(b'\n');
                    self.input
                        .write_all(&bytes)
                        .await
                        .map_err(|_| "原生请求发送失败")?;
                }
            }
            Err("原生通知过多，已停止操作".into())
        })
        .await;
        result
            .unwrap_or_else(|_| Err("原生操作超时，结果尚未确认；请刷新核对，不要重复安装".into()))
    }
    pub async fn close(&mut self) {
        self.stop_tree();
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        #[cfg(windows)]
        {
            debug_assert!(self.job.empty().unwrap_or(false));
        }
    }
    fn stop_tree(&mut self) {
        #[cfg(unix)]
        if let Some(id) = self.group.take() {
            unsafe {
                libc::kill(-id, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            let _ = self.job.terminate();
        }
    }
}
impl Drop for Rpc {
    fn drop(&mut self) {
        self.stop_tree();
        let _ = self.child.start_kill();
    }
}

// Same job-object ownership as the existing tool-install supervisor.
#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
// The handle is owned by the supervisor, never shared with another task.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
impl Job {
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
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};
    fn engine() -> tempfile::TempDir {
        let d = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let script = d.path().join("engine");
        fs::write(&script,r#"#!/usr/bin/python3
import sys,json,time,subprocess,pathlib
for line in sys.stdin:
 q=json.loads(line)
 if q.get('method')=='initialized':continue
 i=q.get('id');m=q.get('method')
 if m=='initialize':r={'id':i,'result':{}}
 elif m=='error':r={'id':i,'error':{'code':-1,'message':'SECRET_TOKEN private@example.com'}}
 elif m=='large':
  print('x'*(5*1024*1024),flush=True);continue
 elif m=='hang':
  c=subprocess.Popen(['/bin/sleep','60']);pathlib.Path('child.pid').write_text(str(c.pid));time.sleep(60);continue
 elif m=='approval':
  print(json.dumps({'id':'approval','method':'requestApproval','params':{}}),flush=True)
  denied=json.loads(sys.stdin.readline());r={'id':i,'result':{'denied': 'error' in denied}}
 else:r={'id':i,'result':{}}
 print(json.dumps(r),flush=True)
"#).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        d
    }
    #[tokio::test]
    async fn rejects_approval_redacts_errors_and_bounds_output() {
        let d = engine();
        let mut r = Rpc::start(&d.path().join("engine"), d.path(), d.path())
            .await
            .unwrap();
        let reply = r.call("approval", json!({})).await.unwrap();
        assert_eq!(reply["denied"], true);
        let err = r.call("error", json!({})).await.unwrap_err();
        assert!(!err.contains("SECRET_TOKEN"));
        assert!(!err.contains("private@example.com"));
        let err = r.call("large", json!({})).await.unwrap_err();
        assert!(err.contains("大小"));
        r.close().await;
        assert!(r.child.id().is_none());
    }
    #[tokio::test]
    async fn timeout_reaps_owned_engine_and_descendants() {
        let d = engine();
        let mut r = Rpc::start(&d.path().join("engine"), d.path(), d.path())
            .await
            .unwrap();
        assert!(r
            .call_with_timeout("hang", json!({}), Duration::from_millis(400))
            .await
            .is_err());
        let child: i32 = fs::read_to_string(d.path().join("child.pid"))
            .unwrap()
            .parse()
            .unwrap();
        r.close().await;
        assert!(r.child.id().is_none());
        let mut dead = false;
        for _ in 0..50 {
            if unsafe { libc::kill(child, 0) } != 0 {
                dead = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(dead, "owned descendant survived");
    }
}
