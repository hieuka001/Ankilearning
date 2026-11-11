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

export interface UaSignals {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

/**
 * Pure core of `isIosSafari()` — separated so tests can feed it captured
 * UA strings without stubbing `window`.
 *
 * iOS hardware means an iPhone/iPad/iPod UA token, OR the iPadOS 13+
 * desktop-mode disguise: the UA claims to be a Mac (`platform` is
 * `MacIntel`), but a real Mac reports `maxTouchPoints === 0` while every
 * iPad has a touchscreen.
 *
 * On top of that the browser must be the one that calls itself plain
 * Safari: third-party iOS browsers (Chrome `CriOS`, Firefox `FxiOS`,
 * Edge `EdgiOS`, Opera `OPiOS`) identify themselves in the UA even
 * though they are WebKit under the hood, and they keep the standard
 * Firebase popup flow — only plain Safari is routed elsewhere.
 */
export function detectIosSafari(signals: UaSignals): boolean {
  const ua = signals.userAgent;

  const onIosHardware =
    ua.includes('iPhone') ||
    ua.includes('iPad') ||
    ua.includes('iPod') ||
    (signals.platform === 'MacIntel' && signals.maxTouchPoints > 1);
  if (!onIosHardware) return false;

  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
  return ua.includes('Safari');
}

/**
 * Detects Safari on iOS/iPadOS in a regular browser tab.
 *
 * Why it matters: Firebase Auth's `signInWithPopup` cannot complete
 * there — the `*.firebaseapp.com` handler page stalls (especially on a
 * weak connection) and the popup result never makes it back, so the
 * user silently lands on the login screen again. `handleLogin` in
 * App.tsx therefore routes these users to `/desktop-auth?return=web`,
 * which runs the same manual full-page OAuth flow the shell uses and
 * hands the token back as `#glink=` on the site root. Callers must check
 * `isDesktopShell()` first — the shell has its own sign-in route and
 * takes priority.
 */
export function isIosSafari(): boolean {
  if (typeof window === 'undefined') return false;

  const nav = window.navigator;
  if (!nav) return false;

  return detectIosSafari({
    userAgent: nav.userAgent ?? '',
    platform: nav.platform ?? '',
    maxTouchPoints: nav.maxTouchPoints ?? 0,
  });
}
