use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<ApkInstaller<R>> {
    Ok(ApkInstaller(app.clone()))
}

/// Access to the apk-installer APIs. There is no desktop implementation:
/// the system package installer only exists on Android.
pub struct ApkInstaller<R: Runtime>(AppHandle<R>);

impl<R: Runtime> ApkInstaller<R> {
    pub fn install_apk(&self, _payload: InstallApkRequest) -> crate::Result<InstallApkResponse> {
        Err(crate::Error::Unsupported)
    }
}
