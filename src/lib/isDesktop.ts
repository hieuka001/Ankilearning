/**
 * Detects whether the web app is running inside the AnkiLearning desktop
 * shell (Tauri / WebView2) instead of a regular browser.
 *
 * Signals (any is enough):
 *  - the shell appends the token `AnkiLearningDesktop` to the webview
 *    User-Agent string, or
 *  - Tauri injected its runtime globals (`__TAURI_INTERNALS__` / the legacy
 *    `__TAURI__`) into the page, or
 *  - a localStorage marker previously planted by `markShellFromUrl()` —
 *    shell 1.0.2+ hands the web app off with `?shell=tauri` in the URL,
 *    which survives later in-app navigations that lose the query string.
 *
 * Why it matters: inside the webview neither `signInWithPopup` (the child
 * window cannot hand its result back) nor `signInWithRedirect` (the round
 * trip loses the result) can complete a Google sign-in. The shell flow
 * instead bounces the user out to their system browser — see the
 * `/__desktop_auth` interception in App.tsx and `pages/DesktopAuth.tsx`.
 * The detection result is cached; `markShellFromUrl()` invalidates the
 * cache so a marker planted at startup is never masked by an earlier
 * negative detection.
 */

const SHELL_STORAGE_KEY = 'ankilearning:shell';

let cached: boolean | null = null;

/**
 * If the current URL carries `?shell=tauri` (how shell 1.0.2+ opens the web
 * app), remember it in localStorage so detection keeps working after the
 * router strips the query string. Call once at app startup.
 */
export function markShellFromUrl(): void {
  if (typeof window === 'undefined') return;

  try {
    const shell = new URLSearchParams(window.location.search).get('shell');
    if (shell !== 'tauri') return;
    window.localStorage.setItem(SHELL_STORAGE_KEY, '1');
    // Detection may already have run (and cached `false`) before the
    // marker existed — force re-detection on the next call.
    cached = null;
  } catch {
    // Storage/URL unavailable — the UA and Tauri-global signals still work.
  }
}

export function isDesktopShell(): boolean {
  if (cached !== null) return cached;

  if (typeof window === 'undefined') {
    cached = false;
    return cached;
  }

  let marked = false;
  try {
    marked = window.localStorage.getItem(SHELL_STORAGE_KEY) === '1';
  } catch {
    marked = false;
  }

  const ua = window.navigator?.userAgent ?? '';
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };

  cached =
    marked ||
    ua.includes('AnkiLearningDesktop') ||
    w.__TAURI_INTERNALS__ !== undefined ||
    w.__TAURI__ !== undefined;

  return cached;
}
