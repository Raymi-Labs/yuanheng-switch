use super::*;
fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let p = dir.path();
    fs::create_dir_all(p.join(".codex-plugin")).unwrap();
    fs::create_dir_all(p.join("skills/hello")).unwrap();
    fs::write(
        p.join(".codex-plugin/plugin.json"),
        br#"{"name":"hello","version":"1.0.0","skills":"./skills/","license":"MIT"}"#,
    )
    .unwrap();
    fs::write(
        p.join("skills/hello/SKILL.md"),
        "---\nname: hello\ndescription: Synthetic offline test\n---\nReply hello.",
    )
    .unwrap();
    dir
}
#[test]
fn validates_identity_and_rejects_path_escape() {
    let dir = fixture();
    let p = inspect(dir.path()).unwrap();
    assert_eq!(p.info.skills, 1);
    assert!(!p.info.has_mcp);
    assert_eq!(p.info.license, "MIT");
    fs::write(
        dir.path().join(".codex-plugin/plugin.json"),
        br#"{"name":"hello","version":"1.0.0","skills":"./../../escape"}"#,
    )
    .unwrap();
    assert!(inspect(dir.path()).is_err());
    for name in ["a/b", "../escape", "a@other", "a.b", "UPPER", ""] {
        assert!(!package::identifier(name));
    }
}
#[test]
fn detects_changes_and_never_overwrites_a_snapshot() {
    let dir = fixture();
    let output = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let package = inspect(dir.path()).unwrap();
    stage(&package, &output.path().join("copy")).unwrap();
    assert_eq!(
        inspect(&output.path().join("copy")).unwrap().info.digest,
        package.info.digest
    );
    fs::write(output.path().join("copy/skills/hello/SKILL.md"), "modified").unwrap();
    assert!(stage(&package, &output.path().join("copy")).is_err());
}
#[test]
fn blocks_credentials_and_marks_executable_components() {
    let dir = fixture();
    fs::write(dir.path().join("run.py"), "print('hello')").unwrap();
    assert_eq!(inspect(dir.path()).unwrap().info.executable_files, 1);
    fs::write(dir.path().join(".env"), "SECRET=synthetic").unwrap();
    assert!(inspect(dir.path()).is_err());
}
#[cfg(unix)]
#[test]
fn rejects_links_and_special_files() {
    use std::os::unix::fs::symlink;
    let dir = fixture();
    symlink("/etc/hosts", dir.path().join("escape")).unwrap();
    assert!(inspect(dir.path()).is_err());
}
#[test]
fn portable_manifest_and_missing_references() {
    let dir = fixture();
    fs::write(dir.path().join("plugin.json"),br#"{"name":"hello","version":"1.0.0","extensions":{"com.openai":{"hooks":"./missing.json"}}}"#).unwrap();
    assert!(inspect(dir.path()).is_err());
}
#[test]
fn corrupt_registry_never_selects_paths() {
    let d = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let t = Target {
        home: d.path().into(),
        root: d.path().join("managed"),
        binary: "codex".into(),
        id: "test".into(),
    };
    prepare_root(&t).unwrap();
    fs::write(t.root.join("registry.json"),r#"[{"info":{"name":"../../x","version":"1","digest":"evil","description":""},"market":"other","pending":null}]"#).unwrap();
    assert!(load(&t).is_err());
}
#[test]
fn builtin_sources_are_local_and_declare_network() {
    let d = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let a = inspect(&builtin(d.path(), "review").unwrap()).unwrap();
    let b = inspect(&builtin(d.path(), "docs").unwrap()).unwrap();
    assert!(!a.info.has_mcp);
    assert!(b.info.has_mcp);
    assert_eq!(a.info.executable_files, 0);
    assert!(!b.info.has_hooks);
}

// Explicit opt-in, only synthetic CODEX_HOME. Never uses personal login or a model request.
#[tokio::test]
#[ignore = "requires installed native Codex; run with YH_PLUGIN_TEST_BINARY pointing to the engine"]
async fn native_roundtrip_without_model_or_real_credentials() {
    let binary =
        PathBuf::from(std::env::var("YH_PLUGIN_TEST_BINARY").expect("test engine required"));
    let d = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let home = d.path().join("home");
    fs::create_dir(&home).unwrap();
    let t = Target {
        home: home.clone(),
        binary,
        root: home.join("yuanheng-native-plugins"),
        id: "synthetic".into(),
    };
    prepare_root(&t).unwrap();
    let source = fixture();
    let p = inspect(source.path()).unwrap();
    let e = Entry {
        info: PackageInfoRecord {
            name: p.info.name.clone(),
            version: p.info.version.clone(),
            description: "test".into(),
            digest: p.info.digest.clone(),
        },
        market: market(&p.info.digest),
        pending: None,
    };
    let root = root_for(&t, &e);
    stage(&p, &root.join("package")).unwrap();
    let cp = catalog_path(&t, &e);
    fs::create_dir_all(cp.parent().unwrap()).unwrap();
    fs::write(&cp,serde_json::to_vec(&json!({"name":e.market,"plugins":[{"name":"hello","source":{"source":"local","path":"./package"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}]})).unwrap()).unwrap();
    fs::write(home.join("config.toml"),"model_provider = \"synthetic\"\n[model_providers.synthetic]\nname = \"Synthetic\"\nbase_url = \"http://127.0.0.1:9/v1\"\nwire_api = \"responses\"\n").unwrap();
    let mut rpc = open(&t).await.unwrap();
    let result = async {
        let cfg = check_owner(&mut rpc, &t, &e, true).await?;
        config_write(
            &mut rpc,
            &t,
            format!("marketplaces.{}", e.market),
            json!({"source_type":"local","source":root}),
            &cfg,
        )
        .await?;
        rpc.call(
            "plugin/install",
            json!({"pluginName":"hello","marketplacePath":cp}),
        )
        .await?;
        let detail = native_read(&mut rpc, &t, &e).await?;
        assert_eq!(summary(&detail)?["installed"], true);
        cached_content_unchanged(&t, &e)?;
        let skills = rpc
            .call("skills/list", json!({"cwds":[t.root],"forceReload":true}))
            .await?;
        assert!(skills["data"][0]["skills"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["pluginId"] == native_id(&e)));
        for enabled in [false, true] {
            let cfg = check_owner(&mut rpc, &t, &e, false).await?;
            config_write(
                &mut rpc,
                &t,
                format!("plugins.\"{}\".enabled", native_id(&e)),
                json!(enabled),
                &cfg,
            )
            .await?;
            let detail = native_read(&mut rpc, &t, &e).await?;
            assert_eq!(summary(&detail)?["enabled"], enabled);
        }
        let stale_cfg = check_owner(&mut rpc, &t, &e, false).await?;
        let cfg_path = home.join("config.toml");
        let mut text = fs::read_to_string(&cfg_path).unwrap();
        text.push_str("\n[user_edit]\nkeep = true\n");
        fs::write(&cfg_path, &text).unwrap();
        assert!(config_write(
            &mut rpc,
            &t,
            format!("plugins.\"{}\".enabled", native_id(&e)),
            json!(false),
            &stale_cfg
        )
        .await
        .is_err());
        assert_eq!(fs::read_to_string(&cfg_path).unwrap(), text);
        rpc.call("plugin/uninstall", json!({"pluginId":native_id(&e)}))
            .await?;
        assert_eq!(
            summary(&native_read(&mut rpc, &t, &e).await?)?["installed"],
            false
        );
        rpc.call(
            "plugin/install",
            json!({"pluginName":"hello","marketplacePath":cp}),
        )
        .await?;
        assert_eq!(
            summary(&native_read(&mut rpc, &t, &e).await?)?["installed"],
            true
        );
        assert!(fs::read_to_string(home.join("config.toml"))
            .unwrap()
            .contains("model_provider = \"synthetic\""));
        assert!(!home.join("auth.json").exists());
        Ok::<(), String>(())
    }
    .await;
    rpc.close().await;
    result.unwrap();
}

#[test]
fn rejects_changed_marketplace_and_preserves_modified_installed_files() {
    let d = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let t = Target {
        home: d.path().into(),
        root: d.path().join("managed"),
        binary: "codex".into(),
        id: "test".into(),
    };
    let src = fixture();
    let p = inspect(src.path()).unwrap();
    let e = Entry {
        info: PackageInfoRecord {
            name: p.info.name.clone(),
            version: p.info.version.clone(),
            digest: p.info.digest.clone(),
            description: "".into(),
        },
        market: market(&p.info.digest),
        pending: None,
    };
    stage(&p, &root_for(&t, &e).join("package")).unwrap();
    let cp = catalog_path(&t, &e);
    fs::create_dir_all(cp.parent().unwrap()).unwrap();
    fs::write(&cp, serde_json::to_vec(&catalog(&e)).unwrap()).unwrap();
    assert!(trusted_snapshot(&t, &e));
    fs::write(&cp, br#"{"name":"other","plugins":[]}"#).unwrap();
    assert!(!trusted_snapshot(&t, &e));
    let cache = t
        .home
        .join("plugins/cache")
        .join(&e.market)
        .join(&e.info.name)
        .join(&e.info.version);
    stage(&p, &cache).unwrap();
    assert!(cached_content_unchanged(&t, &e).is_ok());
    fs::write(cache.join("skills/hello/SKILL.md"), "user modification").unwrap();
    assert!(cached_content_unchanged(&t, &e).is_err());
    assert!(cache.join("skills/hello/SKILL.md").exists());
}
#[test]
fn inspects_overlay_mcp_and_never_exposes_credentials_in_addresses() {
    let d = fixture();
    fs::write(
        d.path().join("plugin.json"),
        br#"{"name":"hello","version":"1.0.0"}"#,
    )
    .unwrap();
    fs::write(
        d.path().join(".codex-plugin/plugin.json"),
        br#"{"name":"hello","version":"1.0.0","mcpServers":"./servers.json"}"#,
    )
    .unwrap();
    fs::write(
        d.path().join("servers.json"),
        br#"{"mcpServers":{"docs":{"url":"https://example.com/mcp?secret=must-not-display"}}}"#,
    )
    .unwrap();
    let p = inspect(d.path()).unwrap();
    assert!(p.info.has_mcp);
    assert_eq!(p.info.connections, vec!["https://example.com"]);
    fs::write(
        d.path().join("servers.json"),
        br#"{"mcpServers":{"docs":{"url":"https://user:password@example.com/mcp"}}}"#,
    )
    .unwrap();
    assert!(inspect(d.path()).is_err());
}
#[cfg(unix)]
#[test]
fn executable_script_snapshot_is_stable() {
    use std::os::unix::fs::PermissionsExt;
    let d = fixture();
    let script = d.path().join("helper");
    fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let p = inspect(d.path()).unwrap();
    assert_eq!(p.info.executable_files, 1);
    let out = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    stage(&p, &out.path().join("copy")).unwrap();
    assert_eq!(
        inspect(&out.path().join("copy")).unwrap().info.digest,
        p.info.digest
    );
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn resolves_npm_native_engine_without_launching_a_shell_or_node() {
    let d = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let root = d.path().join("codex");
    fs::create_dir_all(root.join("bin")).unwrap();
    let entry = root.join("bin/codex.js");
    fs::write(&entry, "not executed").unwrap();
    assert!(engine_from_entry(&entry).is_none());
    let bin =
        root.join("node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex");
    fs::create_dir_all(bin.parent().unwrap()).unwrap();
    fs::write(&bin, "native fixture").unwrap();
    assert_eq!(engine_from_entry(&entry), Some(bin));
}
