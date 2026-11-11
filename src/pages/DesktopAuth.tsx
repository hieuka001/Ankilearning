import { useEffect, useState } from 'react';
import { ArrowRight, Loader2, MonitorSmartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Logo from '../components/Logo';

/**
 * Shell sign-in landing page (`/desktop-auth`).
 *
 * The installed shell (Tauri/WebView2 on desktop, WKWebView on iOS) cannot
 * complete a Google sign-in inside its own webview, so the shell opens THIS
 * page in the user's real system browser instead. The token handoff back to
 * the app goes through the `ankilearning://` deep link, and the app
 * exchanges the Google ID token for a Firebase session via
 * `signInWithCredential` (see the `#glink=`/`?glink=` consumer in App.tsx).
 *
 * The page has two return modes. App mode (default) is the shell flow
 * above. Web mode (`?return=web`) serves plain iOS Safari in a normal
 * browser tab, where `signInWithPopup` fails the same way it does in
 * the webview: App.tsx sends those users here, and on success the token
 * goes back to the web app itself as `#glink=` on the site root (the
 * fragment keeps it out of server logs) instead of via the deep link.
 * The mode cannot ride on the Google round trip — the registered
 * `redirect_uri` must stay exactly `${origin}/desktop-auth` with no
 * query string — so `startSignIn` plants it in sessionStorage next to
 * the state/nonce and the return load reads it back from there.
 *
 * This page deliberately does NOT use the Firebase Auth SDK: its
 * `signInWithPopup` hangs forever in iOS Safari (the popup never returns).
 * Instead it runs a manual OAuth 2.0 implicit flow — a full-page redirect to
 * Google with `response_type=id_token` — and validates the returned token's
 * `state` and `nonce` against values planted in sessionStorage before the
 * redirect. The Google ID token itself is handed to the app untouched; the
 * app-side Firebase sign-in verifies it.
 */

// Public OAuth client identifier (not a secret) for the web sign-in flow.
const GOOGLE_CLIENT_ID =
  '369032392339-onq00t4eiq8574ev77ehnpop3f1ah24k.apps.googleusercontent.com';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const STATE_STORAGE_KEY = 'ankilearning:oauth-state';
const NONCE_STORAGE_KEY = 'ankilearning:oauth-nonce';
const RETURN_STORAGE_KEY = 'ankilearning:oauth-return';

type ReturnMode = 'app' | 'web';

type Status = 'idle' | 'working' | 'sent' | 'error';

type HashOutcome =
  | { kind: 'none' }
  | { kind: 'provider-error'; error: string }
  | { kind: 'token'; idToken: string; valid: boolean };

/** 16 random bytes rendered as 32 lowercase hex characters. */
function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decode a JWT payload (base64url, UTF-8 safe). Returns null on any failure. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const binary = atob(padded);
    const utf8 = decodeURIComponent(
      Array.from(binary, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    );
    return JSON.parse(utf8) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Inspect the URL fragment Google redirected back with. Pure reads only —
 * the side effects (clearing storage/URL, firing the deep link) happen in
 * the component's effect.
 */
function inspectHash(): HashOutcome {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return { kind: 'none' };
  const params = new URLSearchParams(raw);

  const error = params.get('error');
  if (error) return { kind: 'provider-error', error };

  const idToken = params.get('id_token');
  if (!idToken) return { kind: 'none' };

  const expectedState = sessionStorage.getItem(STATE_STORAGE_KEY);
  const expectedNonce = sessionStorage.getItem(NONCE_STORAGE_KEY);
  const stateOk = !!expectedState && params.get('state') === expectedState;
  const payload = decodeJwtPayload(idToken);
  const nonceOk = !!expectedNonce && !!payload && payload.nonce === expectedNonce;
  return { kind: 'token', idToken, valid: stateOk && nonceOk };
}

function buildDeepLink(idToken: string): string {
  return `ankilearning://auth#t=${encodeURIComponent(idToken)}`;
}

export default function DesktopAuth() {
  // Evaluate the return-from-Google hash exactly once, before first paint,
  // so a completed sign-in never flashes the idle button.
  const [outcome] = useState<HashOutcome>(inspectHash);
  // Return mode, also resolved once at mount. A fresh start page reads it
  // from its own `?return=` parameter; a return-from-Google load has no
  // such parameter (the registered redirect_uri carries no query), so it
  // reads the flag `startSignIn` planted in sessionStorage instead.
  const [returnMode] = useState<ReturnMode>(() => {
    if (outcome.kind !== 'none') {
      try {
        return sessionStorage.getItem(RETURN_STORAGE_KEY) === 'web' ? 'web' : 'app';
      } catch {
        return 'app';
      }
    }
    return new URLSearchParams(window.location.search).get('return') === 'web'
      ? 'web'
      : 'app';
  });
  const [status, setStatus] = useState<Status>(() => {
    if (outcome.kind === 'token') return outcome.valid ? 'sent' : 'error';
    if (outcome.kind === 'provider-error') return 'error';
    return 'idle';
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(() => {
    if (outcome.kind === 'token' && !outcome.valid) {
      return 'Phiên đăng nhập không hợp lệ, thử lại nhé';
    }
    if (outcome.kind === 'provider-error') {
      return outcome.error === 'access_denied'
        ? 'Bạn đã hủy đăng nhập Google. Bấm nút bên dưới để thử lại.'
        : 'Đăng nhập bằng Google không hoàn tất. Vui lòng thử lại.';
    }
    return null;
  });
  const [deepLink] = useState<string | null>(() =>
    outcome.kind === 'token' && outcome.valid && returnMode === 'app'
      ? buildDeepLink(outcome.idToken)
      : null,
  );

  // One-shot side effects for a return-from-Google load: drop the stored
  // state/nonce/return flag, scrub the token out of the address bar, and
  // — only for a fully validated token — hand it to its destination: the
  // installed app via deep link, or (web mode) the web app itself at the
  // site root with the token in the fragment.
  useEffect(() => {
    if (outcome.kind === 'none') return;
    sessionStorage.removeItem(STATE_STORAGE_KEY);
    sessionStorage.removeItem(NONCE_STORAGE_KEY);
    sessionStorage.removeItem(RETURN_STORAGE_KEY);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    if (outcome.kind === 'token' && outcome.valid) {
      if (returnMode === 'web') {
        window.location.replace(
          `${window.location.origin}/#glink=${encodeURIComponent(outcome.idToken)}`,
        );
      } else {
        window.location.href = buildDeepLink(outcome.idToken);
      }
    }
    // `outcome` and `returnMode` are mount-time constants by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startSignIn = () => {
    setErrorMsg(null);
    setStatus('working');

    const state = randomHex();
    const nonce = randomHex();
    sessionStorage.setItem(STATE_STORAGE_KEY, state);
    sessionStorage.setItem(NONCE_STORAGE_KEY, nonce);
    // The `return` parameter cannot survive the Google round trip (the
    // redirect_uri below must match the registered one exactly, query
    // included), so the mode travels in sessionStorage instead and is
    // cleared together with state/nonce when the flow returns.
    if (returnMode === 'web') {
      sessionStorage.setItem(RETURN_STORAGE_KEY, 'web');
    } else {
      sessionStorage.removeItem(RETURN_STORAGE_KEY);
    }

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: `${window.location.origin}/desktop-auth`,
      response_type: 'id_token',
      scope: 'openid email profile',
      nonce,
      state,
      prompt: 'select_account',
    });
    window.location.assign(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`);
  };

  return (
    <div className="app-surface aurora-bg flex min-h-screen items-center justify-center p-4 font-sans text-foreground">
      <span className="aurora-blob aurora-blob-1" aria-hidden="true" />
      <span className="aurora-blob aurora-blob-2" aria-hidden="true" />
      <span className="aurora-blob aurora-blob-3" aria-hidden="true" />

      <main className="premium-panel w-full max-w-md p-8 text-center">
        <div className="mb-5 flex items-center justify-center gap-3">
          <Logo className="h-12 w-12" />
          <div className="text-left">
            <p className="brand-gradient-text text-lg font-bold">AnkiLearning</p>
            <p className="text-xs text-muted-foreground">Học thông minh với thẻ ghi nhớ</p>
          </div>
        </div>

        <span className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
          <MonitorSmartphone size={20} />
        </span>

        <h1 className="text-xl font-semibold text-zinc-950 dark:text-white">
          Đăng nhập để mở AnkiLearning
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {returnMode === 'web'
            ? 'Đăng nhập bằng Google ngay tại trình duyệt này. Hoàn tất xong, bạn sẽ được đưa trở lại AnkiLearning trong trạng thái đã đăng nhập.'
            : 'Đăng nhập bằng Google ngay tại trình duyệt này. Hoàn tất xong, ứng dụng AnkiLearning sẽ tự mở ra trong trạng thái đã đăng nhập.'}
        </p>

        {status === 'sent' ? (
          <div className="mt-7">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
              <Loader2 size={16} className="animate-spin" />
              {returnMode === 'web' ? 'Đang quay lại AnkiLearning…' : 'Đang mở lại ứng dụng…'}
            </p>
            {returnMode === 'app' && (
              <>
                {deepLink && (
                  <a
                    href={deepLink}
                    className="mt-4 block text-sm font-medium text-emerald-700 underline underline-offset-4 transition hover:text-emerald-600 dark:text-emerald-300 dark:hover:text-emerald-200"
                  >
                    Nếu ứng dụng không tự mở, bấm vào đây
                  </a>
                )}
                <p className="mt-4 text-xs leading-5 text-muted-foreground">
                  Bạn có thể đóng tab này sau khi app mở.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="mt-7">
            <Button
              onClick={startSignIn}
              disabled={status === 'working'}
              className="btn-press h-11 w-full gap-2"
            >
              {status === 'working' ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Đang chuyển tới Google…
                </>
              ) : (
                <>
                  Đăng nhập với Google
                  <ArrowRight size={16} />
                </>
              )}
            </Button>
            {errorMsg && (
              <p role="alert" className="mt-4 text-sm leading-6 text-red-600 dark:text-red-400">
                {errorMsg}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
