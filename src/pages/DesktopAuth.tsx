import { useState } from 'react';
import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { ArrowRight, Loader2, MonitorSmartphone } from 'lucide-react';
import { auth } from '../firebase';
import { Button } from '@/components/ui/button';
import Logo from '../components/Logo';

/**
 * Desktop-shell sign-in landing page (`/desktop-auth`).
 *
 * The Tauri/WebView2 shell cannot complete a Google sign-in inside its own
 * webview (the popup child window cannot hand its result back, and the
 * redirect round trip loses it), so the shell opens THIS page in the user's
 * real system browser instead. Here the normal popup flow works; once we
 * have the Google ID token we hand it back to the installed app through the
 * `ankilearning://` deep link, and the app exchanges it for a Firebase
 * session via `signInWithCredential` (see the `#glink=` consumer in App.tsx).
 */

type Status = 'idle' | 'working' | 'sent' | 'error';

export default function DesktopAuth() {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);

  const startBrowserSignIn = async () => {
    setErrorMsg(null);
    setStatus('working');

    // Start from a clean slate so the account the user picks here is the
    // one that ends up in the desktop app, even if this browser profile was
    // still signed in as someone else. A failed sign-out is not fatal.
    try {
      await signOut(auth);
    } catch {
      // Ignore — continue with the popup either way.
    }

    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      const idToken = credential?.idToken;
      if (!idToken) {
        setStatus('error');
        setErrorMsg('Không lấy được mã đăng nhập từ Google. Vui lòng thử lại.');
        return;
      }

      const link = `ankilearning://auth#t=${encodeURIComponent(idToken)}`;
      setDeepLink(link);
      setStatus('sent');
      // Hand the token back to the installed app. If the protocol handler
      // is missing (app uninstalled), the manual link below stays visible.
      window.location.href = link;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? '';
      setStatus('error');
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setErrorMsg('Bạn đã đóng cửa sổ đăng nhập Google. Bấm nút bên dưới để thử lại.');
      } else if (code === 'auth/popup-blocked') {
        setErrorMsg('Trình duyệt đã chặn cửa sổ đăng nhập. Hãy cho phép cửa sổ bật lên (popup) cho trang này rồi thử lại.');
      } else {
        console.error('Desktop browser sign-in error:', error);
        setErrorMsg('Đăng nhập bằng Google thất bại. Vui lòng thử lại.');
      }
    }
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
          Đăng nhập để mở AnkiLearning trên máy tính
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Đăng nhập bằng Google ngay tại trình duyệt này. Hoàn tất xong, ứng dụng
          AnkiLearning trên máy tính sẽ tự mở ra trong trạng thái đã đăng nhập.
        </p>

        {status === 'sent' ? (
          <div className="mt-7">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
              <Loader2 size={16} className="animate-spin" />
              Đang mở lại ứng dụng…
            </p>
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
          </div>
        ) : (
          <div className="mt-7">
            <Button
              onClick={startBrowserSignIn}
              disabled={status === 'working'}
              className="btn-press h-11 w-full gap-2"
            >
              {status === 'working' ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Đang chờ đăng nhập Google…
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
