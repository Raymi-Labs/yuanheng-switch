//! Offline maintenance entry point using the exact desktop recovery implementation.
//! cargo run --example recover_codex_projects -- [--apply] [--config-dir /path]
#[path = "../src/session_sync/projects/codex_local_map.rs"]
mod recovery;
mod codex_config {
    pub fn get_codex_config_dir() -> std::path::PathBuf {
        let args: Vec<String> = std::env::args().collect();
        if let Some(i) = args.iter().position(|v| v == "--config-dir") {
            return std::path::PathBuf::from(
                args.get(i + 1).expect("--config-dir needs a directory"),
            );
        }
        dirs::home_dir()
            .expect("home directory unavailable")
            .join(".codex")
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let preview = recovery::repair_codex_project_map(None)?;
    if std::env::args().any(|a| a == "--apply") {
        if let Some(reason) = preview.blocked_reason {
            return Err(reason);
        }
        let result = recovery::repair_codex_project_map(Some(preview.fingerprint))?;
        if let Some(reason) = result.blocked_reason {
            return Err(reason);
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
        );
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&preview).map_err(|e| e.to_string())?
        );
    }
    Ok(())
}
