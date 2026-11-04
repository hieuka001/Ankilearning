// AnkiLearning desktop shell.
//
// The window shows a local splash page (desktop/dist-fallback) that redirects
// to the live web app, so content/features are always the latest web deploy —
// no shell update needed for app changes. This shell only needs updating when
// the wrapper itself changes; that is what the updater check below is for:
// on startup it asks GitHub Releases for a newer shell, shows a native
// "update now?" prompt, then downloads, installs and relaunches.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

async fn check_for_shell_update(app: tauri::AppHandle) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(_) => return,
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        _ => return,
    };

    let message = format!(
        "Đã có phiên bản AnkiLearning {} mới cho máy tính.\nBạn có muốn cập nhật ngay không?",
        update.version
    );
    let accepted = app
        .dialog()
        .message(message)
        .title("Cập nhật AnkiLearning")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Cập nhật ngay".to_string(),
            "Để sau".to_string(),
        ))
        .blocking_show();

    if accepted {
        if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
            app.restart();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                check_for_shell_update(handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AnkiLearning");
}
