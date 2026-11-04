use serde::{Deserialize, Serialize};

/// Payload for the `installApk` mobile command: the absolute filesystem
/// path of the downloaded APK inside the app's own storage (the generated
/// app's FileProvider covers its cache dir, which is where the shell
/// downloads update APKs).
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallApkRequest {
    pub path: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallApkResponse {
    /// True once the system installer activity has been started.
    pub opened: Option<bool>,
}
