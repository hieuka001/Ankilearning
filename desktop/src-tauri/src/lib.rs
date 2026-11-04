// AnkiLearning native shell (desktop + iOS).
//
// The window shows a local splash page (desktop/dist-fallback) that redirects
// to the live web app, so content/features are always the latest web deploy —
// no shell update needed for app changes. This shell only needs updating when
// the wrapper itself changes.
//
// On desktop, the updater check asks GitHub Releases for a newer shell, shows
// a native "update now?" prompt, then downloads, installs and relaunches.
// The updater and single-instance plugins are desktop-only, so both their
// dependencies and every use site are gated out of mobile builds.
//
// The main window is declared in tauri.conf.json with `"create": false`, so
// Tauri does NOT build it automatically. Building it by hand in `setup` below
// — from that very same config — lets us attach the navigation handler on all
// platforms and, on desktop, the `on_new_window` handler: WebView2 denies
// page-requested windows by default, which silently breaks `window.open`
// popups. If no `main` config is present (for example a future generated
// mobile project shape), setup falls back to a default main window instead
// of panicking.
//
// Sign-in (shell 1.0.2+): neither the popup nor the redirect flavour of the
// Google sign-in proved reliable inside the embedded desktop WebView2 (the
// popup opened, spun once and fell back to the login screen), so the flow
// leaves the webview entirely:
//   1. The web app (which knows it runs in this shell via the `?shell=tauri`
//      marker the splash page adds) navigates to `.../__desktop_auth`.
//   2. `on_navigation` below intercepts that URL, cancels the navigation and
//      opens `.../desktop-auth` in the system browser instead.
//   3. After signing in, the browser hands the result back through the
//      `ankilearning://auth#t=<token>` deep link; the shell extracts the
//      token and navigates the main window to the app with `?glink=<token>`.
//
// On Windows/Linux a deep link for an already-running app arrives as the CLI
// arguments of a second process — the single-instance plugin (registered
// FIRST on desktop, as its docs require) forwards them to
// `handle_auth_deep_link`; a cold start is covered by
// `deep_link().get_current()` in `setup`, and `on_open_url` covers macOS,
// iOS and any other platform-delivered events. On iOS, `on_open_url` /
// `get_current` are the delivery paths because there is no second process.

use tauri::{Manager, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(desktop)]
use tauri::webview::NewWindowResponse;
#[cfg(desktop)]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

const APP_HOME: &str = "https://learning-with-trunghieu.vercel.app";
/// In-webview URL the web app navigates to when the user asks to sign in
/// inside the shell. Never actually loaded — see the navigation handler.
const DESKTOP_AUTH_TRIGGER: &str = "https://learning-with-trunghieu.vercel.app/__desktop_auth";
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

/// Bring the main window back to the front where the platform has that
/// concept (used when a second launch or a deep link targets the
/// already-running instance). Mobile has no minimise/taskbar model, so only
/// the focus request is shared.
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(desktop)]
        {
            let _ = window.show();
            let _ = window.unminimize();
        }
        let _ = window.set_focus();
    }
}

/// Handle a possible sign-in deep link: on a matching token, focus the app
/// and hand the token to the web app as the `?glink=` query parameter (a
/// query change forces a full page load, unlike a fragment-only change, so
/// the web side's token-consumption effect always reruns). Non-matching URLs
/// are ignored.
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

/// Navigation policy shared by desktop and mobile: sign-in leaves the
/// webview — cancel the in-app navigation to the trigger URL and open the
/// real sign-in page in the system browser instead. Every other navigation
/// proceeds untouched. The opener plugin has the same Rust API on iOS
/// (`open_url(url, None::<&str>)` opens the default browser there).
fn navigation_handler(app_handle: tauri::AppHandle) -> impl Fn(&tauri::Url) -> bool {
    move |url| {
        if url.as_str().starts_with(DESKTOP_AUTH_TRIGGER) {
            let _ = app_handle
                .opener()
                .open_url(DESKTOP_AUTH_PAGE, None::<&str>);
            return false;
        }
        true
    }
}

/// Build the `main` window in setup (config says `"create": false`).
///
/// Desktop additionally allows page-requested windows (`window.open` /
/// target=_blank); `on_new_window` is documented as unsupported on iOS, so
/// it is attached on desktop only. On mobile the same config is consumed via
/// `WebviewWindowBuilder::from_config` (available on iOS); if the config
/// entry is missing, a default main window loading the bundled splash page
/// is created instead of panicking.
fn build_main_window(app: &tauri::App) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }

    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main");

    if let Some(window_config) = window_config {
        let builder = WebviewWindowBuilder::from_config(app.handle(), window_config)?;
        // Allow windows the page asks to open. With WebView2's default
        // implementation the popup keeps the size/placement the page
        // requested. Desktop only: not supported on Android/iOS.
        #[cfg(desktop)]
        let builder = builder.on_new_window(|_url, _features| NewWindowResponse::Allow);
        builder
            .on_navigation(navigation_handler(app.handle().clone()))
            .build()?;
    } else {
        let builder = WebviewWindowBuilder::new(
            app.handle(),
            "main",
            tauri::WebviewUrl::default(),
        );
        #[cfg(desktop)]
        let builder = builder.on_new_window(|_url, _features| NewWindowResponse::Allow);
        builder
            .on_navigation(navigation_handler(app.handle().clone()))
            .build()?;
    }

    Ok(())
}

#[cfg(desktop)]
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Desktop only — MUST stay the first registered plugin on desktop: on
    // Windows/Linux the OS starts a new process for a deep link, and only
    // this plugin lets that process hand its arguments to the running
    // instance (and exit) instead of opening a second copy of the app.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        focus_main_window(app);
        for arg in &args {
            handle_auth_deep_link(app, arg);
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init());

    // Desktop only: the Tauri updater supports Windows/Linux/macOS, and the
    // dialog plugin is only used for its update prompt.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            build_main_window(app)?;

            // Deep links that launched the app (cold start).
            if let Ok(Some(urls)) = app.handle().deep_link().get_current() {
                for url in &urls {
                    handle_auth_deep_link(app.handle(), url.as_str());
                }
            }
            // Deep links delivered while the app is already running. This is
            // the primary runtime path on macOS and iOS; on Windows/Linux the
            // single-instance callback above covers them — registering both
            // is harmless.
            let deep_link_handle = app.handle().clone();
            app.handle().deep_link().on_open_url(move |event| {
                for url in event.urls().iter() {
                    handle_auth_deep_link(&deep_link_handle, url.as_str());
                }
            });

            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    check_for_shell_update(handle).await;
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AnkiLearning");
}
