// AnkiLearning desktop shell.
//
// The window shows a local splash page (desktop/dist-fallback) that redirects
// to the live web app, so content/features are always the latest web deploy —
// no shell update needed for app changes. This shell only needs updating when
// the wrapper itself changes; that is what the updater check below is for:
// on startup it asks GitHub Releases for a newer shell, shows a native
// "update now?" prompt, then downloads, installs and relaunches.
//
// The main window is declared in tauri.conf.json with `"create": false`, so
// Tauri does NOT build it automatically (its runtime builds config windows
// with `create: true` before the setup hook runs). Building it by hand in
// `setup` below — from that very same config — is what lets us attach the
// `on_new_window` handler: WebView2 denies page-requested windows by default,
// which silently breaks `window.open` popups such as the Google sign-in flow.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{webview::NewWindowResponse, WebviewWindowBuilder};
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
            // Build the "main" window from its tauri.conf.json entry (see the
            // note at the top of this file) so the new-window handler can be
            // attached. Everything else about the window (size, maximized
            // start, user agent, ...) still comes from the config file.
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main");
            if let Some(window_config) = window_config {
                WebviewWindowBuilder::from_config(app.handle(), window_config)?
                    // Allow windows the page asks to open (window.open /
                    // target=_blank). With WebView2's default implementation
                    // the popup keeps the size/placement the page requested —
                    // exactly what the Google sign-in popup needs.
                    .on_new_window(|_url, _features| NewWindowResponse::Allow)
                    .build()?;
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                check_for_shell_update(handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AnkiLearning");
}
