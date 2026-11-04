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
// `on_new_window` / `on_navigation` handlers: WebView2 denies page-requested
// windows by default, which silently breaks `window.open` popups.
//
// Sign-in (shell 1.0.2): neither the popup nor the redirect flavour of the
// Google sign-in proved reliable inside the embedded WebView2 on user
// machines (the popup opened, spun once and fell back to the login screen),
// so the flow now leaves the webview entirely:
//   1. The web app (which knows it runs in this shell via the `?shell=tauri`
//      marker the splash page adds) navigates to `.../__desktop_auth`.
//   2. `on_navigation` below intercepts that URL, cancels the navigation and
//      opens `.../desktop-auth` in the system browser instead.
//   3. After signing in, the browser hands the result back through the
//      `ankilearning://auth#t=<token>` deep link; the shell extracts the
//      token and navigates the main window to the app with `?glink=<token>`.
// On Windows/Linux a deep link for an already-running app arrives as the CLI
// arguments of a second process — the single-instance plugin (registered
// FIRST, as its docs require) forwards them to `handle_auth_deep_link`;
// a cold start is covered by `deep_link().get_current()` in `setup`, and
// `on_open_url` covers macOS and any platform-delivered events.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{webview::NewWindowResponse, Manager, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

const APP_HOME: &str = "https://learning-with-trunghieu.vercel.app";
/// In-webview URL the web app navigates to when the user asks to sign in
/// inside the shell. Never actually loaded — see `on_navigation` in `setup`.
const DESKTOP_AUTH_TRIGGER: &str =
    "https://learning-with-trunghieu.vercel.app/__desktop_auth";
/// System-browser page that performs the Google sign-in and finishes by
/// calling the `ankilearning://auth#t=<token>` deep link.
const DESKTOP_AUTH_PAGE: &str = "https://learning-with-trunghieu.vercel.app/desktop-auth";
const DEEP_LINK_PREFIX: &str = "ankilearning://auth";

/// Extract the sign-in token from an `ankilearning://auth#t=<token>` deep
/// link. Returns `None` for anything that does not match the expected shape
/// (other args in a launch command line, unrelated links, empty tokens).
fn extract_auth_token(raw_url: &str) -> Option<String> {
    let raw_url = raw_url.trim();
    // Scheme/host are case-insensitive; the token itself is not, so only the
    // prefix check runs on a lowercased copy and slicing uses the original.
    if !raw_url.to_ascii_lowercase().starts_with(DEEP_LINK_PREFIX) {
        return None;
    }
    let fragment = raw_url.split('#').nth(1)?;
    for pair in fragment.split('&') {
        if let Some(token) = pair.strip_prefix("t=") {
            let token = token.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }
    None
}

/// Bring the main window back to the front (used when a second launch or a
/// deep link targets the already-running instance).
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Handle a possible sign-in deep link: on a matching token, focus the app
/// and hand the token to the web app as the `?glink=` query parameter (a query change forces a full
/// the web side expects it. Non-matching URLs are ignored.
fn handle_auth_deep_link(app: &tauri::AppHandle, raw_url: &str) {
    let Some(token) = extract_auth_token(raw_url) else {
        return;
    };
    focus_main_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let target = format!("{APP_HOME}/?glink={token}");
        if let Ok(url) = target.parse::<tauri::Url>() {
            let _ = window.navigate(url);
        }
    }
}

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
        // MUST stay the first registered plugin: on Windows/Linux the OS
        // starts a new process for a deep link, and only this plugin lets
        // that process hand its arguments to the running instance (and exit)
        // instead of opening a second copy of the app.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            focus_main_window(app);
            for arg in &args {
                handle_auth_deep_link(app, arg);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Build the "main" window from its tauri.conf.json entry (see the
            // note at the top of this file) so the window handlers can be
            // attached. Everything else about the window (size, maximized
            // start, user agent, ...) still comes from the config file.
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main");
            if let Some(window_config) = window_config {
                let nav_handle = app.handle().clone();
                WebviewWindowBuilder::from_config(app.handle(), window_config)?
                    // Allow windows the page asks to open (window.open /
                    // target=_blank). With WebView2's default implementation
                    // the popup keeps the size/placement the page requested.
                    .on_new_window(|_url, _features| NewWindowResponse::Allow)
                    // Sign-in leaves the webview: cancel the in-app
                    // navigation to the trigger URL and open the real
                    // sign-in page in the system browser instead. Every
                    // other navigation proceeds untouched.
                    .on_navigation(move |url| {
                        if url.as_str().starts_with(DESKTOP_AUTH_TRIGGER) {
                            let _ = nav_handle
                                .opener()
                                .open_url(DESKTOP_AUTH_PAGE, None::<&str>);
                            return false;
                        }
                        true
                    })
                    .build()?;
            }

            // Deep links that launched the app (cold start).
            if let Ok(Some(urls)) = app.handle().deep_link().get_current() {
                for url in &urls {
                    handle_auth_deep_link(app.handle(), url.as_str());
                }
            }
            // Deep links delivered while the app is already running
            // (macOS always; elsewhere the single-instance callback above
            // covers them — registering both is harmless).
            let deep_link_handle = app.handle().clone();
            app.handle().deep_link().on_open_url(move |event| {
                for url in event.urls().iter() {
                    handle_auth_deep_link(&deep_link_handle, url.as_str());
                }
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                check_for_shell_update(handle).await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AnkiLearning");
}
