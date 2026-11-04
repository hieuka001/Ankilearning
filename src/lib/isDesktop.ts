/**
 * Detects whether the web app is running inside the AnkiLearning desktop
 * shell (Tauri / WebView2) instead of a regular browser.
 *
 * Two signals, either is enough:
 *  - the shell appends the token `AnkiLearningDesktop` to the webview
 *    User-Agent string, or
 *  - Tauri injected its runtime globals (`__TAURI_INTERNALS__` / the legacy
 *    `__TAURI__`) into the page.
 *
 * The desktop shell needs a different Google sign-in flow: WebView2 blocks
 * the `signInWithPopup` window, so inside the shell auth must go through
 * `signInWithRedirect` instead (see App.tsx). The result is cached — neither
 * the UA nor the Tauri globals can appear/disappear during a session.
 */

let cached: boolean | null = null;

export function isDesktopShell(): boolean {
  if (cached !== null) return cached;

  if (typeof window === 'undefined') {
    cached = false;
    return cached;
  }

  const ua = window.navigator?.userAgent ?? '';
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };

  cached =
    ua.includes('AnkiLearningDesktop') ||
    w.__TAURI_INTERNALS__ !== undefined ||
    w.__TAURI__ !== undefined;

  return cached;
}
