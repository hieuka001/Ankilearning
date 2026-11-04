// AnkiLearning native shell (desktop + iOS + Android).
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
// On Android there is no store/updater to lean on, so the shell updates
// itself the sideload way (see `check_for_android_update` below): on startup
// it polls a tiny JSON manifest hosted in the fixed `android-latest` GitHub
// release, and when the manifest announces a newer shell version it shows
// the same native prompt as desktop. Accepting downloads the new APK into
// the app cache and opens the Android system package installer for it via
// the project-local apk-installer plugin — the user confirms with one tap
// on the system install screen, which is as automatic as Android allows an
// app outside Google Play to be.
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
// `handle_deep_link` (which routes to the auth and reminders handlers); a
// cold start is covered by `deep_link().get_current()` in `setup`, and
// `on_open_url` covers macOS, iOS and any other platform-delivered events.
// On iOS, `on_open_url` / `get_current` are the delivery paths because
// there is no second process.

// Study reminders (shell 1.0.3+): the web app syncs its reminder schedule
// through `ankilearning://reminders#d=<base64url(JSON)>` deep links, and the
// shell turns them into real local notifications with the device's own
// notification system (the official Tauri notification plugin), so a
// reminder can fire at its set time even while the app is closed — the
// in-webview service worker cannot do that inside a native shell. Every
// sync replaces the previous set placed by this feature.

use tauri::{Manager, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::{NotificationExt, PermissionState, Schedule};
use tauri_plugin_opener::OpenerExt;

#[cfg(desktop)]
use tauri::webview::NewWindowResponse;
#[cfg(any(desktop, target_os = "android"))]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
#[cfg(target_os = "android")]
use tauri_plugin_apk_installer::ApkInstallerExt;

const APP_HOME: &str = "https://learning-with-trunghieu.vercel.app";
/// In-webview URL the web app navigates to when the user asks to sign in
/// inside the shell. Never actually loaded — see the navigation handler.
const DESKTOP_AUTH_TRIGGER: &str = "https://learning-with-trunghieu.vercel.app/__desktop_auth";
/// System-browser page that performs the Google sign-in and finishes by
/// calling the `ankilearning://auth#t=<token>` deep link.
const DESKTOP_AUTH_PAGE: &str = "https://learning-with-trunghieu.vercel.app/desktop-auth";
const DEEP_LINK_PREFIX: &str = "ankilearning://auth";
const REMINDERS_DEEP_LINK_PREFIX: &str = "ankilearning://reminders";
/// Notification ids owned by the study-reminder feature. Every sync cancels
/// this range (on platforms whose plugin can cancel) before placing the new
/// set, so reminders from an older schedule never survive an update.
const REMINDER_ID_FIRST: i32 = 2000;
const REMINDER_ID_LAST: i32 = 2099;
/// Contract cap from the web side: at most 20 reminder items per sync.
const REMINDER_MAX_ITEMS: usize = 20;

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

/// The reminder schedule exactly as the web app sends it in the
/// `ankilearning://reminders#d=` payload. `at` values are wall-clock times
/// in the device's own timezone ("2026-11-05T21:00:00"), not UTC instants.
#[derive(serde::Deserialize)]
struct ReminderSyncPayload {
    v: u32,
    items: Vec<ReminderSyncItem>,
}

#[derive(serde::Deserialize)]
struct ReminderSyncItem {
    at: String,
    title: String,
    body: String,
}

/// Decode base64url, tolerating missing padding (and stripping any padding
/// that is present). Returns `None` on invalid input.
fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    // A fragment value may arrive percent-encoded; `=` is the only escaped
    // character that can legitimately appear in base64url output.
    let value = value.replace("%3D", "=").replace("%3d", "=");
    let cleaned: String = value
        .trim()
        .trim_end_matches('=')
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cleaned)
        .ok()
}

/// Extract and decode the reminder payload from an
/// `ankilearning://reminders#d=<base64url(JSON)>` deep link. Returns `None`
/// for anything else (auth links, unrelated args, malformed payloads).
fn extract_reminders_payload(raw_url: &str) -> Option<ReminderSyncPayload> {
    let raw_url = raw_url.trim();
    if !raw_url
        .to_ascii_lowercase()
        .starts_with(REMINDERS_DEEP_LINK_PREFIX)
    {
        return None;
    }
    let fragment = raw_url.split('#').nth(1)?;
    for pair in fragment.split('&') {
        if let Some(data) = pair.strip_prefix("d=") {
            let bytes = decode_base64url(data)?;
            return serde_json::from_slice(&bytes).ok();
        }
    }
    None
}

/// Parse a "YYYY-MM-DDTHH:MM:SS" wall-clock time in the device's local
/// timezone into an absolute instant. Returns `None` when the string does
/// not parse or the calendar date does not exist. If the local UTC offset
/// cannot be determined (rare; the platforms this shell ships on all
/// provide it), UTC is used as a fallback rather than failing the sync.
fn parse_local_datetime(value: &str) -> Option<time::OffsetDateTime> {
    let (date_part, time_part) = value.trim().split_once('T')?;
    let mut date_fields = date_part.split('-');
    let year: i32 = date_fields.next()?.parse().ok()?;
    let month: u8 = date_fields.next()?.parse().ok()?;
    let day: u8 = date_fields.next()?.parse().ok()?;
    if date_fields.next().is_some() {
        return None;
    }
    let mut time_fields = time_part.split(':');
    let hour: u8 = time_fields.next()?.parse().ok()?;
    let minute: u8 = time_fields.next()?.parse().ok()?;
    // Seconds are part of the contract format but tolerated when absent or
    // followed by fractional digits.
    let second: u8 = time_fields
        .next()
        .map(|field| {
            field
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
        })
        .and_then(|digits| digits.parse().ok())
        .unwrap_or(0);
    let date = time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day)
        .ok()?;
    let time_of_day = time::Time::from_hms(hour, minute, second).ok()?;
    let offset = time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC);
    Some(time::PrimitiveDateTime::new(date, time_of_day).assume_offset(offset))
}

/// Handle a possible reminder-sync deep link: replace the notifications
/// this feature scheduled earlier with the new set from the payload.
///
/// Reminders are auxiliary — every step is best-effort and swallows its
/// errors, so a malformed payload or a platform refusal can never crash
/// the shell or surface a dialog. Platform notes (Tauri notification
/// plugin v2, verified against docs.rs):
/// - Permission: `permission_state` / `request_permission` exist on both
///   families. On desktop they always resolve to Granted without a prompt;
///   on iOS the request is what shows the system permission alert.
/// - Scheduling uses the builder's `Schedule::At { date, repeating,
///   allow_while_idle }`. Scheduling is only implemented on mobile; the
///   desktop implementation ignores the schedule and delivers the
///   notification immediately, so on Windows/macOS a sync surfaces the
///   reminders right away instead of at their set times.
/// - Cancelling the previous set is only possible on mobile: the desktop
///   `Notification` API has no `pending` / `cancel` at all.
fn handle_reminders_deep_link(app: &tauri::AppHandle, raw_url: &str) {
    // Scheduling exists only on mobile: the notification plugin delivers
    // immediately and cannot cancel on desktop, so ignore reminder links there.
    #[cfg(not(mobile))]
    {
        let _ = (app, raw_url);
        return;
    }
    let Some(payload) = extract_reminders_payload(raw_url) else {
        return;
    };
    if payload.v != 1 {
        return;
    }

    let notifications = app.notification();

    // Ask for the notification permission if it was not granted yet.
    match notifications.permission_state() {
        Ok(PermissionState::Granted) => {}
        _ => {
            let _ = notifications.request_permission();
        }
    }

    // Cancel the pending notifications this feature placed previously.
    // Mobile only — see the platform notes above.
    #[cfg(mobile)]
    {
        if let Ok(pending) = notifications.pending() {
            let stale_ids: Vec<i32> = pending
                .iter()
                .map(|notification| notification.id())
                .filter(|id| (REMINDER_ID_FIRST..=REMINDER_ID_LAST).contains(id))
                .collect();
            if !stale_ids.is_empty() {
                let _ = notifications.cancel(stale_ids);
            }
        }
    }

    // Place the new set. Past-due and unparseable items are skipped; ids
    // ascend from REMINDER_ID_FIRST so the next sync can cancel exactly
    // this feature's range again.
    let now = time::OffsetDateTime::now_utc();
    let mut next_id = REMINDER_ID_FIRST;
    for item in payload.items.iter().take(REMINDER_MAX_ITEMS) {
        let Some(when) = parse_local_datetime(&item.at) else {
            continue;
        };
        if when <= now {
            continue;
        }
        let _ = notifications
            .builder()
            .id(next_id)
            .title(item.title.clone())
            .body(item.body.clone())
            .schedule(Schedule::At {
                date: when,
                repeating: false,
                allow_while_idle: false,
            })
            .show();
        next_id += 1;
    }
}

/// Single entry point for every deep link the shell receives, whatever the
/// delivery path: each `ankilearning://…` family has its own handler and
/// silently ignores URLs that are not theirs.
fn handle_deep_link(app: &tauri::AppHandle, raw_url: &str) {
    handle_auth_deep_link(app, raw_url);
    handle_reminders_deep_link(app, raw_url);
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

/// Fixed GitHub release that always carries `android-latest.json`, the
/// manifest the Android shell polls for updates. A separate versioned
/// release (`android-v<version>`) holds each APK the manifest points to.
#[cfg(target_os = "android")]
const ANDROID_UPDATE_MANIFEST_URL: &str =
    "https://github.com/hieuka001/Ankilearning/releases/download/android-latest/android-latest.json";

/// Shape of `android-latest.json`, published by the Android build workflow.
#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct AndroidUpdateManifest {
    version: String,
    #[serde(rename = "apkUrl")]
    apk_url: String,
    #[serde(default)]
    notes: String,
}

/// Split a dotted version ("1.0.4", tolerating a leading "v" and
/// non-numeric suffixes) into numeric parts for comparison.
#[cfg(target_os = "android")]
fn parse_version_parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect()
}

/// True when `candidate` is strictly newer than `current`.
#[cfg(target_os = "android")]
fn version_is_newer(candidate: &str, current: &str) -> bool {
    let candidate_parts = parse_version_parts(candidate);
    let current_parts = parse_version_parts(current);
    for i in 0..candidate_parts.len().max(current_parts.len()) {
        let candidate_part = candidate_parts.get(i).copied().unwrap_or(0);
        let current_part = current_parts.get(i).copied().unwrap_or(0);
        if candidate_part != current_part {
            return candidate_part > current_part;
        }
    }
    false
}

/// Android self-update check, mirroring the desktop updater's behaviour:
/// poll the manifest, and only if it announces a strictly newer shell
/// version, ask the user with a native dialog. Runs on a background thread;
/// every network or parse failure is swallowed silently, exactly like the
/// desktop check, so an offline start never surfaces anything.
#[cfg(target_os = "android")]
fn check_for_android_update(app: tauri::AppHandle) {
    let manifest = (|| -> Option<AndroidUpdateManifest> {
        let body = ureq::get(ANDROID_UPDATE_MANIFEST_URL)
            .timeout(std::time::Duration::from_secs(20))
            .call()
            .ok()?
            .into_string()
            .ok()?;
        serde_json::from_str(&body).ok()
    })();
    let Some(manifest) = manifest else {
        return;
    };
    if !version_is_newer(&manifest.version, env!("CARGO_PKG_VERSION")) {
        return;
    }

    let notes = if manifest.notes.trim().is_empty() {
        String::new()
    } else {
        format!("\n{}", manifest.notes.trim())
    };
    let message = format!(
        "Đã có phiên bản AnkiLearning {} mới cho Android.{}\nBạn có muốn cập nhật ngay không?",
        manifest.version, notes
    );
    let apk_url = manifest.apk_url.clone();
    let dialog_app = app.clone();
    app.dialog()
        .message(message)
        .title("Cập nhật AnkiLearning")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Cập nhật ngay".to_string(),
            "Để sau".to_string(),
        ))
        .show(move |accepted| {
            if accepted {
                let download_app = dialog_app.clone();
                let download_url = apk_url.clone();
                std::thread::spawn(move || {
                    download_and_install_android_update(download_app, download_url);
                });
            }
        });
}

/// Download the update APK into the app cache directory, then hand it to
/// the system package installer through the apk-installer plugin (which
/// wraps it in a FileProvider content URI with the apk MIME type — the
/// opener plugin cannot build that intent: it fires a bare ACTION_VIEW
/// with no type and no read grant). If the download or the plugin call
/// fails, fall back to opening the APK URL in the system browser, where
/// the user can download it and tap it to install. The system installer
/// itself asks the user to confirm the install (and, the first time, to
/// allow installs from AnkiLearning) — Android gives sideloaded apps no
/// quieter path, by design.
#[cfg(target_os = "android")]
fn download_and_install_android_update(app: tauri::AppHandle, apk_url: String) {
    let downloaded = (|| -> Option<std::path::PathBuf> {
        let response = ureq::get(&apk_url)
            .timeout(std::time::Duration::from_secs(300))
            .call()
            .ok()?;
        let cache_dir = app.path().app_cache_dir().ok()?;
        std::fs::create_dir_all(&cache_dir).ok()?;
        let apk_path = cache_dir.join("AnkiLearning-update.apk");
        let mut reader = response.into_reader();
        let mut file = std::fs::File::create(&apk_path).ok()?;
        std::io::copy(&mut reader, &mut file).ok()?;
        Some(apk_path)
    })();

    if let Some(apk_path) = downloaded {
        let request = tauri_plugin_apk_installer::InstallApkRequest {
            path: apk_path.to_string_lossy().into_owned(),
        };
        if app.apk_installer().install_apk(request).is_ok() {
            return;
        }
    }
    let _ = app.opener().open_url(&apk_url, None::<&str>);
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
            handle_deep_link(app, arg);
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    // Desktop and Android: the dialog plugin shows the shell-update prompt
    // on both (desktop: Tauri updater prompt; Android: this shell's own
    // manifest-check prompt). iOS has no shell-update prompt, so the plugin
    // stays out of the iOS graph.
    #[cfg(any(desktop, target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_dialog::init());

    // Desktop only: the Tauri updater supports Windows/Linux/macOS only.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // Android only: local plugin that opens the system package installer
    // for an update APK the shell downloaded (self-update flow below).
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_apk_installer::init());

    builder
        .setup(|app| {
            build_main_window(app)?;

            // Deep links that launched the app (cold start).
            if let Ok(Some(urls)) = app.handle().deep_link().get_current() {
                for url in &urls {
                    handle_deep_link(app.handle(), url.as_str());
                }
            }
            // Deep links delivered while the app is already running. This is
            // the primary runtime path on macOS and iOS; on Windows/Linux the
            // single-instance callback above covers them — registering both
            // is harmless.
            let deep_link_handle = app.handle().clone();
            app.handle().deep_link().on_open_url(move |event| {
                for url in event.urls().iter() {
                    handle_deep_link(&deep_link_handle, url.as_str());
                }
            });

            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    check_for_shell_update(handle).await;
                });
            }

            // Android self-update: poll the update manifest shortly after
            // startup on a background thread (ureq is blocking). The check
            // is silent unless a newer shell version actually exists.
            #[cfg(target_os = "android")]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    check_for_android_update(handle);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AnkiLearning");
}
