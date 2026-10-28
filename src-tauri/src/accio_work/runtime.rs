//! Core-owned process identity; persisted `active` is never sufficient to authorize.
#[cfg(any(target_os = "macos", all(test, unix)))]
use super::{activate_revision, load};
use super::{load_active, revoke, Database, Profile};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tokio::process::Child;
#[cfg(any(target_os = "macos", all(test, unix)))]
use tokio::process::Command;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchRequest {
    pub path: PathBuf,
    pub revision: String,
}

impl LaunchRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        let path = self.path.to_str().ok_or("Accio 应用路径无效")?;
        if !self.path.is_absolute()
            || self.path.extension().is_none_or(|s| s != "app")
            || path.len() > 4096
            || path.chars().any(char::is_control)
            || self.revision.len() != 64
            || !self.revision.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Accio 启动参数无效".into());
        }
        Ok(())
    }
}

struct OwnedProcess {
    capability: String,
    child: Child,
}

/// Only the manually invoked native acceptance test can obtain this guard.
/// Its separate process group prevents cleanup from targeting the test runner,
/// the installed Core or an unrelated user's app.
#[cfg(all(test, feature = "accio-work-experimental", target_os = "macos"))]
pub(crate) struct Native035Probe {
    pub(crate) pid: u32,
    armed: bool,
}

#[cfg(all(test, feature = "accio-work-experimental", target_os = "macos"))]
impl Drop for Native035Probe {
    fn drop(&mut self) {
        if self.armed {
            // SAFETY: pid came directly from the child spawned with pgroup=0.
            // No fixture, environment variable or persisted PID can select it.
            unsafe { libc::kill(-(self.pid as libc::pid_t), libc::SIGKILL) };
        }
    }
}

#[derive(Default)]
pub(crate) struct Runtime {
    #[cfg(target_os = "macos")]
    launch_gate: tokio::sync::Mutex<()>,
    owned: Mutex<Option<OwnedProcess>>,
    stopped: AtomicBool,
}

impl Runtime {
    fn reap_locked(owned: &mut Option<OwnedProcess>, db: &Database) -> Result<(), String> {
        let ended = match owned.as_mut() {
            Some(process) => match process.child.try_wait() {
                Ok(None) => false,
                Ok(Some(_)) | Err(_) => true,
            },
            None => false,
        };
        if ended {
            // Remove in-memory authority first, even if persistence is unavailable.
            let process = owned.take().ok_or("Accio 运行状态不可用")?;
            revoke(db, &process.capability)?;
        }
        Ok(())
    }

    pub(crate) fn reap(&self, db: &Database) -> Result<(), String> {
        let mut owned = self.owned.lock().map_err(|_| "Accio 运行状态不可用")?;
        Self::reap_locked(&mut owned, db)
    }

    pub(crate) fn authorized_profile(&self, db: &Database) -> Result<Profile, String> {
        let mut owned = self.owned.lock().map_err(|_| "Accio 运行状态不可用")?;
        if self.stopped.load(Ordering::Acquire) {
            return Err("Accio 本地路由已停止".into());
        }
        Self::reap_locked(&mut owned, db)?;
        let profile = load_active(db)?;
        if !owned
            .as_ref()
            .is_some_and(|process| profile.authorizes(&process.capability))
        {
            return Err("Accio 连接已失效，请保存工作并从元衡重新启动".into());
        }
        Ok(profile)
    }

    /// Revoking a route never terminates the user's official app or unsaved work.
    pub(crate) fn invalidate(&self, db: &Database) -> Result<(), String> {
        let mut owned = self.owned.lock().map_err(|_| "Accio 运行状态不可用")?;
        self.stopped.store(true, Ordering::Release);
        if let Some(process) = owned.take() {
            revoke(db, &process.capability)?;
        }
        Ok(())
    }

    /// No await between activation, spawn and ownership publication. The calling
    /// Core task is detached from the HTTP request's lifetime, including errors.
    #[cfg(any(target_os = "macos", all(test, unix)))]
    fn spawn_owned(
        &self,
        db: &Database,
        revision: &str,
        mut command: Command,
        port: u16,
    ) -> Result<Profile, String> {
        let mut owned = self.owned.lock().map_err(|_| "Accio 运行状态不可用")?;
        if self.stopped.load(Ordering::Acquire) {
            return Err("Accio 本地路由已停止，请重新打开元衡".into());
        }
        Self::reap_locked(&mut owned, db)?;
        if owned.is_some() {
            return Err("Accio 已在运行，请先保存工作并完整退出".into());
        }
        let profile = activate_revision(db, revision)?;
        let no_proxy = format!(
            "127.0.0.1,localhost,::1,{}",
            std::env::var("NO_PROXY")
                .or_else(|_| std::env::var("no_proxy"))
                .unwrap_or_default()
        );
        let child = command
            .env(
                "GATEWAY_BASE_URL",
                super::gateway_origin(port, &profile.capability),
            )
            .env("NO_PROXY", &no_proxy)
            .env("no_proxy", &no_proxy)
            .env_remove("ACCIO_GATEWAY_URL")
            .env_remove("ADK_BASE_URL")
            .env_remove("ELECTRON_RUN_AS_NODE")
            .env_remove("NODE_OPTIONS")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        match child {
            Ok(child) => {
                *owned = Some(OwnedProcess {
                    capability: profile.capability.clone(),
                    child,
                });
                Ok(profile)
            }
            Err(_) => {
                revoke(db, &profile.capability)?;
                Err("Accio 启动失败；未回退官方启动".into())
            }
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) async fn launch(
        &self,
        db: &Database,
        request: LaunchRequest,
        port: u16,
    ) -> Result<(), String> {
        if !super::EXPERIMENTAL_ENABLED || port == 0 {
            return Err("当前 Core 未启用 Accio 接入".into());
        }
        request.validate()?;
        // Reject overlapping requests instead of queuing delayed app launches.
        let _guard = self
            .launch_gate
            .try_lock()
            .map_err(|_| "Accio 正在启动，请稍后查看")?;
        if load(db)?.ok_or("请先配置 Accio")?.revision()? != request.revision {
            return Err("Accio 配置已变化，请重新选择后启动".into());
        }
        let path = super::installation::verify(&request.path).await?;
        let mut running = Command::new("/usr/bin/pgrep");
        running.args(["-x", "Accio"]);
        match super::bounded_output(&mut running).await?.status.code() {
            Some(1) => {}
            Some(0) => return Err("请先保存工作并完整退出 Accio，再从元衡启动".into()),
            _ => return Err("无法确认 Accio 是否正在运行，已停止启动".into()),
        }
        // The revision is compared again under the database lock after all awaits.
        let profile = self.spawn_owned(
            db,
            &request.revision,
            Command::new(path.join("Contents/MacOS/Accio")),
            port,
        )?;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if !self
            .authorized_profile(db)
            .is_ok_and(|p| p.authorizes(&profile.capability))
        {
            return Err("Accio 启动后退出或配置已失效，请检查后重新启动".into());
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    pub(crate) async fn launch(
        &self,
        _db: &Database,
        _request: LaunchRequest,
        _port: u16,
    ) -> Result<(), String> {
        Err("当前平台的 Accio 主模型接入尚未验收".into())
    }

    #[cfg(all(test, unix))]
    pub(crate) fn synthetic_child(&self, db: &Database) {
        let mut command = Command::new("/bin/sleep");
        command.arg("10").kill_on_drop(true);
        let profile = load(db).unwrap().unwrap();
        self.spawn_owned(db, &profile.revision().unwrap(), command, 15721)
            .unwrap();
    }

    /// A deliberately separate test-only entry point; the product compatibility
    /// list is defined by installation.rs. Identity, version and pre-existing app
    /// checks still run against the genuine bundle before any child is created.
    #[cfg(all(test, feature = "accio-work-experimental", target_os = "macos"))]
    pub(crate) async fn native035probe_launch(
        &self,
        db: &Database,
        path: PathBuf,
        port: u16,
    ) -> Result<Native035Probe, String> {
        if !super::EXPERIMENTAL_ENABLED || port == 0 {
            return Err("Native 0.35.2 probe requires an experimental test server".into());
        }
        let profile = load(db)?.ok_or("Native probe profile is missing")?;
        let request = LaunchRequest {
            path,
            revision: profile.revision()?,
        };
        request.validate()?;
        let _gate = self
            .launch_gate
            .try_lock()
            .map_err(|_| "Native probe launch is already in progress")?;
        let path = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio::fs::canonicalize(&request.path),
        )
        .await
        .map_err(|_| "Native probe path check timed out")?
        .map_err(|_| "Native probe bundle is unavailable")?;
        let mut verify = Command::new("/usr/bin/codesign");
        verify.args(["--verify", "--deep", "--strict", "-R",
            "=anchor apple generic and identifier \"com.accio.desktop\" and certificate leaf[subject.OU] = \"P75YXKHHMH\""]).arg(&path);
        if !super::bounded_output(&mut verify).await?.status.success() {
            return Err("Native probe rejected the official bundle identity".into());
        }
        let mut version = Command::new("/usr/libexec/PlistBuddy");
        version
            .args(["-c", "Print :CFBundleShortVersionString"])
            .arg(path.join("Contents/Info.plist"));
        let version = super::bounded_output(&mut version).await?;
        if !version.status.success()
            || !matches!(
                String::from_utf8_lossy(&version.stdout).trim(),
                "0.35.2" | "0.35.3"
            )
        {
            return Err("Native probe requires an inspected Accio 0.35.2 or 0.35.3".into());
        }
        let mut running = Command::new("/usr/bin/pgrep");
        running.args(["-x", "Accio"]);
        match super::bounded_output(&mut running).await?.status.code() {
            Some(1) => {}
            Some(0) => {
                return Err("Native probe requires all existing Accio apps to be closed".into())
            }
            _ => return Err("Native probe could not verify that Accio is closed".into()),
        }
        let mut command = Command::new(path.join("Contents/MacOS/Accio"));
        command.process_group(0).kill_on_drop(true);
        self.spawn_owned(db, &request.revision, command, port)?;
        let owned = self
            .owned
            .lock()
            .map_err(|_| "Native probe ownership unavailable")?;
        let pid = owned
            .as_ref()
            .and_then(|process| process.child.id())
            .ok_or("Native probe exited before ownership was recorded")?;
        if pid <= 1 || pid > i32::MAX as u32 {
            return Err("Native probe returned an invalid process identity".into());
        }
        Ok(Native035Probe { pid, armed: true })
    }

    #[cfg(all(test, feature = "accio-work-experimental", target_os = "macos"))]
    pub(crate) async fn native035probe_stop(
        &self,
        db: &Database,
        probe: &mut Native035Probe,
    ) -> Result<(), String> {
        let process = {
            let mut owned = self
                .owned
                .lock()
                .map_err(|_| "Native probe ownership unavailable")?;
            if owned
                .as_ref()
                .is_some_and(|p| p.child.id() != Some(probe.pid))
            {
                return Err("Native probe cleanup refused a different owned process".into());
            }
            owned.take()
        };
        // Target the freshly created process group, including Electron helpers.
        // The guard also kills this group if an assertion unwinds the test.
        unsafe { libc::kill(-(probe.pid as libc::pid_t), libc::SIGTERM) };
        let mut revoke_result = Ok(());
        if let Some(mut process) = process {
            revoke_result = revoke(db, &process.capability);
            if tokio::time::timeout(std::time::Duration::from_secs(2), process.child.wait())
                .await
                .is_err()
            {
                unsafe { libc::kill(-(probe.pid as libc::pid_t), libc::SIGKILL) };
                tokio::time::timeout(std::time::Duration::from_secs(2), process.child.wait())
                    .await
                    .map_err(|_| "Native probe child did not exit")?
                    .map_err(|_| "Native probe child could not be reaped")?;
            }
        }
        unsafe { libc::kill(-(probe.pid as libc::pid_t), libc::SIGKILL) };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let alive = unsafe { libc::kill(-(probe.pid as libc::pid_t), 0) } == 0;
            if !alive {
                probe.armed = false;
                return revoke_result;
            }
            if std::time::Instant::now() >= deadline {
                return Err("Native probe helpers remain in the test process group".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    #[cfg(all(test, unix))]
    pub(crate) async fn stop_synthetic_child(&self, db: &Database) {
        let process = self.owned.lock().unwrap().take();
        if let Some(mut process) = process {
            process.child.kill().await.unwrap();
            process.child.wait().await.unwrap();
            revoke(db, &process.capability).unwrap();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn accio_stopped_core_rejects_late_launch() {
        let db = Database::memory().unwrap();
        super::super::save(&db, &super::super::synthetic_profile()).unwrap();
        let runtime = Runtime::default();
        let revision = load(&db).unwrap().unwrap().revision().unwrap();
        runtime.invalidate(&db).unwrap();
        assert!(runtime
            .spawn_owned(&db, &revision, Command::new("/usr/bin/true"), 15721)
            .is_err());
        assert!(runtime.authorized_profile(&db).is_err());
    }

    #[tokio::test]
    async fn accio_core_owns_child_and_does_not_adopt_persisted_capability() {
        let db = Database::memory().unwrap();
        let persisted = super::super::synthetic_profile();
        super::super::save(&db, &persisted).unwrap();
        let runtime = Runtime::default();
        assert!(runtime.authorized_profile(&db).is_err());
        runtime.synthetic_child(&db);
        let active = runtime.authorized_profile(&db).unwrap();
        assert_ne!(active.capability, persisted.capability);
        assert!(Runtime::default().authorized_profile(&db).is_err());
        // Dropping the caller's handle is unrelated to the runtime's Child.
        let mut next = active.clone();
        next.reasoning = "low".into();
        super::super::save_configuration(&db, next).unwrap();
        assert_eq!(runtime.authorized_profile(&db).unwrap().reasoning, "low");
        runtime.stop_synthetic_child(&db).await;
        assert!(runtime.authorized_profile(&db).is_err());
        assert!(!load(&db).unwrap().unwrap().active);
    }

    #[tokio::test]
    async fn accio_dead_child_revokes_old_lease_without_touching_reconfigured_owner() {
        let db = Database::memory().unwrap();
        super::super::save(&db, &super::super::synthetic_profile()).unwrap();
        let runtime = Runtime::default();
        runtime.synthetic_child(&db);
        let old = runtime.authorized_profile(&db).unwrap();
        let mut next = old.clone();
        next.owner = "different-owner".into();
        super::super::save_configuration(&db, next).unwrap();
        let replacement = load(&db).unwrap().unwrap();
        assert_ne!(replacement.capability, old.capability);
        assert!(runtime.authorized_profile(&db).is_err());
        runtime.stop_synthetic_child(&db).await;
        assert_eq!(
            load(&db).unwrap().unwrap().capability,
            replacement.capability
        );
    }

    #[tokio::test]
    async fn accio_exit_spawn_failure_and_stale_revision_fail_closed() {
        let db = Database::memory().unwrap();
        super::super::save(&db, &super::super::synthetic_profile()).unwrap();
        let runtime = Runtime::default();
        let stale = load(&db).unwrap().unwrap().revision().unwrap();
        super::super::reset_for_core_start(&db).unwrap();
        assert!(runtime
            .spawn_owned(&db, &stale, Command::new("/usr/bin/true"), 15721)
            .is_err());
        let revision = load(&db).unwrap().unwrap().revision().unwrap();
        assert!(runtime
            .spawn_owned(
                &db,
                &revision,
                Command::new("/nonexistent-accio-test-program"),
                15721
            )
            .is_err());
        assert!(!load(&db).unwrap().unwrap().active);
        let revision = load(&db).unwrap().unwrap().revision().unwrap();
        runtime
            .spawn_owned(&db, &revision, Command::new("/usr/bin/true"), 15721)
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while runtime.authorized_profile(&db).is_ok() {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(!load(&db).unwrap().unwrap().active);
        runtime.stop_synthetic_child(&db).await;
    }

    #[tokio::test]
    async fn accio_core_owner_survives_a_cancelled_caller_and_rejects_second_spawn() {
        let db = std::sync::Arc::new(Database::memory().unwrap());
        super::super::save(&db, &super::super::synthetic_profile()).unwrap();
        let runtime = std::sync::Arc::new(Runtime::default());
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let owner = runtime.clone();
        let owned_db = db.clone();
        let caller = tokio::spawn(async move {
            // The actual handler detaches work into the Core; dropping this
            // caller or its response receiver does not own the process.
            tokio::spawn(async move {
                owner.synthetic_child(&owned_db);
                let _ = ready_tx.send(());
            })
            .await
            .unwrap();
            std::future::pending::<()>().await;
        });
        ready_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        let live = runtime.authorized_profile(&db).unwrap();
        let revision = live.revision().unwrap();
        assert!(runtime
            .spawn_owned(&db, &revision, Command::new("/usr/bin/true"), 15721)
            .is_err());
        assert_eq!(
            runtime.authorized_profile(&db).unwrap().capability,
            live.capability
        );
        runtime.stop_synthetic_child(&db).await;
        assert!(runtime.authorized_profile(&db).is_err());
    }
}
