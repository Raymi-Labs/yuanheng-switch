#[cfg(desktop)]
use serde_json::json;
use serde_json::Value;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_yuanheng_native);

pub struct Native<R: Runtime> {
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(desktop)]
    marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Native<R> {
    pub fn call(&self, name: &str, data: Value) -> Result<Value, String> {
        #[cfg(mobile)]
        {
            self.handle
                .run_mobile_plugin(name, data)
                .map_err(|_| "系统安全存储或相册操作失败，请检查系统权限后重试".to_string())
        }
        #[cfg(desktop)]
        {
            let _ = data;
            match name {
                "readSession" => Ok(json!({"value": null})),
                "clearSession" => Ok(json!({})),
                _ => Err("此操作需要在 Android 或 iPhone 原生应用中完成".into()),
            }
        }
    }
}

pub trait NativeExt<R: Runtime> {
    fn native(&self) -> &Native<R>;
}
impl<R: Runtime, T: Manager<R>> NativeExt<R> for T {
    fn native(&self) -> &Native<R> {
        self.state::<Native<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("yuanheng-native")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let handle = _api.register_android_plugin(
                "com.nanashiwang.yuanheng.nativebridge",
                "YuanhengPlugin",
            )?;
            #[cfg(target_os = "ios")]
            let handle = _api.register_ios_plugin(init_plugin_yuanheng_native)?;
            app.manage(Native::<R> {
                #[cfg(mobile)]
                handle,
                #[cfg(desktop)]
                marker: std::marker::PhantomData,
            });
            Ok(())
        })
        .build()
}
