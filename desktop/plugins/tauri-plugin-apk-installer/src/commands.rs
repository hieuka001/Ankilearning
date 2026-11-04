use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::ApkInstallerExt;
use crate::Result;

#[command]
pub(crate) async fn install_apk<R: Runtime>(
    app: AppHandle<R>,
    payload: InstallApkRequest,
) -> Result<InstallApkResponse> {
    app.apk_installer().install_apk(payload)
}
