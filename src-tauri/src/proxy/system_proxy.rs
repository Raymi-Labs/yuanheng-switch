//! Read the same native settings as reqwest 0.12 / hyper-util's system matcher.
//! These snapshots are compared only in memory, never logged or persisted.

#[cfg(target_os = "macos")]
pub(super) fn snapshot() -> Vec<Option<String>> {
    use system_configuration::core_foundation::{number::CFNumber, string::CFString};
    use system_configuration::dynamic_store::SCDynamicStoreBuilder;

    let proxies = SCDynamicStoreBuilder::new("yuanheng-proxy-settings")
        .build()
        .and_then(|store| store.get_proxies());
    [
        "HTTPEnable",
        "HTTPProxy",
        "HTTPPort",
        "HTTPSEnable",
        "HTTPSProxy",
        "HTTPSPort",
    ]
    .iter()
    .map(|key| {
        proxies.as_ref().and_then(|map| {
            map.find(CFString::new(key)).and_then(|value| {
                value
                    .downcast::<CFString>()
                    .map(|value| value.to_string())
                    .or_else(|| {
                        value
                            .downcast::<CFNumber>()
                            .and_then(|value| value.to_i32())
                            .map(|value| value.to_string())
                    })
            })
        })
    })
    .collect()
}

#[cfg(target_os = "windows")]
pub(super) fn snapshot() -> Vec<Option<String>> {
    let settings = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok();
    let enabled = settings
        .as_ref()
        .and_then(|key| key.get_value::<u32, _>("ProxyEnable").ok());
    let mut values = vec![enabled.map(|value| value.to_string())];
    for name in ["ProxyServer", "ProxyOverride"] {
        values.push(
            settings
                .as_ref()
                .and_then(|key| key.get_value::<String, _>(name).ok()),
        );
    }
    values
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn snapshot() -> Vec<Option<String>> {
    // reqwest uses environment variables only on these platforms.
    Vec::new()
}
