import { Component, useEffect, useRef, useState, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { getRedirectResult, onAuthStateChanged, signInWithCredential, signInWithPopup, signInWithRedirect, GoogleAuthProvider, signOut, User } from 'firebase/auth';
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { StudySession, UserProfile } from './types';
import { countCardsReviewedToday } from './lib/studySessions';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { motion } from 'motion/react';
import {
  Activity,
  ArrowRight,
  BrainCircuit,
  LayoutDashboard,
  Library,
  LogOut,
  Menu,
  Mic,
  PlusCircle,
  RefreshCw,
  Search as SearchIcon,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { SettingsProvider } from './contexts/SettingsContext';
import BackgroundMusic from './components/BackgroundMusic';
import Logo from './components/Logo';
import NotificationCenter from './components/NotificationCenter';
import { BADGES, getXpProgress, type BadgeUnlock } from './lib/gamification';
import { useServiceWorkerUpdate } from './lib/swUpdate';
import { isDesktopShell, markShellFromUrl } from './lib/isDesktop';
import DesktopAuth from './pages/DesktopAuth';

// Marks "a Google sign-in redirect is in flight" in sessionStorage. Set right
// before signInWithRedirect navigates away, consumed once on the next app
// start to surface redirect errors via getRedirectResult. sessionStorage
// survives the same-tab round trip to Google and back.
const AUTH_REDIRECT_FLAG = 'ankilearning:auth-redirect';

// Guards the one-shot consumption of a Google ID token handed back by the
// desktop shell (`#glink=<token>` — see the effect below). A module-level
// flag, not state: React StrictMode mounts effects twice, and the token
// must be exchanged exactly once.
let desktopLinkTokenConsumed = false;

// Same string as BADGE_UNLOCKED_EVENT in services/gamificationService — kept
// as a local literal so this shell does not statically import the sync stack
// (Dexie/ts-fsrs) into the entry chunk; the flush functions are loaded
// lazily below via dynamic import().
const BADGE_UNLOCKED_EVENT = 'ankilearning:badge';

type ProfileWithProgress = UserProfile & { xp?: number; level?: number };

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Decks = lazy(() => import('./pages/Decks'));
const Study = lazy(() => import('./pages/Study'));
const CreateDeck = lazy(() => import('./pages/CreateDeck'));
const DeckDetail = lazy(() => import('./pages/DeckDetail'));
const AIHelper = lazy(() => import('./pages/AIHelper'));
const Search = lazy(() => import('./pages/Search'));
const Settings = lazy(() => import('./pages/Settings'));
const Assessment = lazy(() => import('./pages/Assessment'));
const VoiceToCard = lazy(() => import('./pages/VoiceToCard'));

const navItems = [
  { to: '/', label: 'Tổng quan', icon: <LayoutDashboard size={17} /> },
  { to: '/decks', label: 'Bộ thẻ', icon: <Library size={17} /> },
  { to: '/create-deck', label: 'Tạo bộ thẻ', icon: <PlusCircle size={17} /> },
  { to: '/voice-to-card', label: 'Thẻ từ giọng nói', icon: <Mic size={17} /> },
  { to: '/assessment', label: 'Kiểm tra', icon: <BrainCircuit size={17} /> },
  { to: '/ai-helper', label: 'Trợ lý AI', icon: <Sparkles size={17} /> },
  { to: '/search', label: 'Tìm kiếm', icon: <SearchIcon size={17} /> },
  { to: '/settings', label: 'Cài đặt', icon: <SettingsIcon size={17} /> },
];

const bottomNavItems = [
  { to: '/', label: 'Tổng quan', icon: <LayoutDashboard size={20} /> },
  { to: '/decks', label: 'Bộ thẻ', icon: <Library size={20} /> },
  { to: '/create-deck', label: 'Tạo thẻ', icon: <PlusCircle size={20} /> },
  { to: '/settings', label: 'Cài đặt', icon: <SettingsIcon size={20} /> },
];

const pageMeta: { prefix: string; title: string; description: string }[] = [
  { prefix: '/study', title: 'Học thẻ', description: 'Tập trung ôn các thẻ đến hạn hôm nay.' },
  { prefix: '/decks/', title: 'Chi tiết bộ thẻ', description: 'Quản lý thẻ, tiến độ và lịch ôn của bộ này.' },
  { prefix: '/decks', title: 'Bộ thẻ', description: 'Tất cả bộ thẻ của bạn và của cộng đồng.' },
  { prefix: '/create-deck', title: 'Tạo bộ thẻ', description: 'Tạo thẻ thủ công, bằng AI hoặc nhập từ Anki.' },
  { prefix: '/voice-to-card', title: 'Thẻ từ giọng nói', description: 'Nói và để AI chuyển thành thẻ ghi nhớ.' },
  { prefix: '/assessment', title: 'Kiểm tra', description: 'Luyện đề trắc nghiệm từ chính bộ thẻ của bạn.' },
  { prefix: '/ai-helper', title: 'Trợ lý AI', description: 'Hỏi đáp, tạo thẻ và sơ đồ tư duy bằng Gemini.' },
  { prefix: '/search', title: 'Tìm kiếm', description: 'Tìm thẻ và bộ thẻ trong toàn bộ thư viện.' },
  { prefix: '/settings', title: 'Cài đặt', description: 'Thuật toán ôn tập, tài khoản, âm thanh và nhắc học.' },
];

function getPageMeta(pathname: string) {
  if (pathname === '/') {
    return { title: 'Tổng quan', description: 'Tiến độ học, chuỗi ngày học và gợi ý cho hôm nay.' };
  }
  return pageMeta.find((item) => pathname.startsWith(item.prefix))
    || { title: 'AnkiLearning', description: 'Học thông minh với thẻ ghi nhớ.' };
}

function PageLoader() {
  return (
    <div className="flex min-h-[420px] w-full items-center justify-center">
      <div className="loader-ring" />
    </div>
  );
}

class AppErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.error('Route render error:', error, errorInfo);
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="premium-panel mx-auto flex min-h-[360px] max-w-xl flex-col items-center justify-center p-8 text-center">
          <BrainCircuit className="mb-4 h-9 w-9 text-primary" />
          <h2 className="text-xl font-semibold text-zinc-950 dark:text-white">Trang này chưa tải được</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Dữ liệu hoặc kết nối vừa trả về trạng thái bất thường. Bạn có thể thử lại mà không cần đăng nhập lại.
          </p>
          <Button onClick={() => this.setState({ hasError: false })} className="mt-6">
            Thử lại
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [cardsReviewedToday, setCardsReviewedToday] = useState(0);
  const [recentSessions, setRecentSessions] = useState<StudySession[]>([]);

  useEffect(() => {
    if (!user?.uid) return;
    // Lazy: the queue-sync stack (Dexie, ts-fsrs) is only needed after login,
    // so it stays out of the entry chunk via dynamic import.
    import('./services/gamificationService')
      .then(({ flushGamificationQueue }) => flushGamificationQueue())
      .catch((error) => console.warn('Gamification queue sync failed.', error));
    import('./review/firebaseSync')
      .then(({ flushReviewQueue }) => flushReviewQueue())
      .catch((error) => console.warn('Review queue sync failed.', error));
  }, [user?.uid]);

  // Inside the desktop/iOS shell, hand the study-reminder schedule to the
  // shell once per session (after the profile — which carries the reminder
  // config — has loaded) so it can post local notifications on the device.
  // No-op in a regular browser/PWA; Settings re-syncs with force on save.
  const shellReminderSyncedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!user?.uid || !profile) return;
    if (shellReminderSyncedForRef.current === user.uid) return;
    shellReminderSyncedForRef.current = user.uid;
    const reminderConfig = profile.settings?.studyReminder || {
      enabled: false,
      time: '21:00',
      timezone: 'Asia/Bangkok',
    };
    import('./lib/shellReminders')
      .then(({ syncShellReminders }) => syncShellReminders(null, reminderConfig))
      .catch((error) => console.warn('Shell reminder sync failed.', error));
  }, [user?.uid, profile]);

  // Celebrate freshly unlocked badges (gamificationService dispatches
  // 'ankilearning:badge' for every badge unlocked by an activity).
  useEffect(() => {
    const onBadge = (event: Event) => {
      const badge = (event as CustomEvent<BadgeUnlock>).detail;
      if (!badge?.title) return;
      const definition = BADGES.find((item) => item.id === badge.id);
      toast.success(`🏆 Huy hiệu mới: ${badge.title}`, {
        description: definition?.description || 'Tiếp tục phát huy nhé!',
      });
    };
    window.addEventListener(BADGE_UNLOCKED_EVENT, onBadge);
    return () => window.removeEventListener(BADGE_UNLOCKED_EVENT, onBadge);
  }, []);

  // Shell 1.0.2+ opens the web app with `?shell=tauri`; plant the durable
  // localStorage marker before anything asks isDesktopShell().
  useEffect(() => {
    markShellFromUrl();
  }, []);

  // Desktop-shell sign-in completion. Neither the popup nor the redirect
  // flow can finish inside the WebView2 shell, so the shell sends the user
  // to their system browser (pages/DesktopAuth) and bounces the resulting
  // Google ID token back into this window as `#glink=<token>` (a `?glink=`
  // variant is accepted too). Exchange it for a Firebase session exactly
  // once; onAuthStateChanged then takes over as usual. The token is
  // scrubbed from the URL whether the exchange succeeds or not — ID tokens
  // are short-lived and must not linger in history.
  useEffect(() => {
    if (desktopLinkTokenConsumed) return;
    desktopLinkTokenConsumed = true;

    let token: string | null = null;
    try {
      token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('glink')
        || new URLSearchParams(window.location.search).get('glink');
    } catch {
      token = null;
    }
    if (!token) return;

    try {
      const url = new URL(window.location.href);
      url.hash = '';
      url.searchParams.delete('glink');
      window.history.replaceState(null, '', url.toString());
    } catch {
      // URL cleanup is best-effort; the sign-in attempt still proceeds.
    }

    signInWithCredential(auth, GoogleAuthProvider.credential(token)).catch((error) => {
      console.error('Desktop browser sign-in error:', error);
      toast.error('Phiên đăng nhập từ trình duyệt đã hết hạn, thử lại nhé');
    });
  }, []);

  // Complete a redirect-based Google sign-in started before the page
  // navigated away (desktop shell, or popup-blocked fallback). Only runs when
  // the session flag is present — a plain page load never touches
  // getRedirectResult. A successful result needs no handling here:
  // onAuthStateChanged picks the user up. The flag is cleared either way.
  useEffect(() => {
    let flagged = false;
    try {
      flagged = sessionStorage.getItem(AUTH_REDIRECT_FLAG) === '1';
      if (flagged) sessionStorage.removeItem(AUTH_REDIRECT_FLAG);
    } catch {
      flagged = false;
    }
    if (!flagged) return;

    getRedirectResult(auth).catch((error) => {
      console.error('Redirect sign-in error:', error);
      toast.error('Đăng nhập bằng Google thất bại. Vui lòng thử lại.');
    });
  }, []);

  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;
    let unsubscribeSessions: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);

      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }
      if (unsubscribeSessions) {
        unsubscribeSessions();
        unsubscribeSessions = null;
      }

      try {
        if (firebaseUser) {
          setUser(firebaseUser);
          const userDoc = doc(db, 'users', firebaseUser.uid);
          const userSnap = await getDoc(userDoc);

          let currentProfile: UserProfile;
          if (!userSnap.exists()) {
            currentProfile = {
              uid: firebaseUser.uid,
              displayName: firebaseUser.displayName || 'User',
              email: firebaseUser.email || '',
              photoURL: firebaseUser.photoURL || '',
              totalCardsLearned: 0,
              streak: 0,
              totalCardsReviewed: 0,
              totalQuizzesCompleted: 0,
              totalStudyTimeMinutes: 0,
              lastStudyDate: new Date().toISOString(),
              settings: {
                dailyGoal: 20,
                theme: 'light',
                language: 'vi',
                geminiApiKey: '',
                aiApiKey: '',
                studyReminder: {
                  enabled: false,
                  time: '21:00',
                  timezone: 'Asia/Bangkok',
                },
              },
            };
            await setDoc(userDoc, currentProfile);
          } else {
            currentProfile = userSnap.data() as UserProfile;
          }

          setProfile(currentProfile);
          unsubscribeProfile = onSnapshot(userDoc, (snap) => {
            if (snap.exists()) setProfile(snap.data() as UserProfile);
          });

          const sessionsQuery = query(
            collection(db, `users/${firebaseUser.uid}/sessions`),
            orderBy('timestamp', 'desc'),
            limit(200)
          );

          unsubscribeSessions = onSnapshot(
            sessionsQuery,
            (snap) => {
              const sessions = snap.docs.map((sessionDoc) => ({
                id: sessionDoc.id,
                ...sessionDoc.data(),
              } as StudySession));
              setRecentSessions(sessions);
              setCardsReviewedToday(countCardsReviewedToday(sessions));
            },
            () => {
              setRecentSessions([]);
              setCardsReviewedToday(0);
            }
          );
        } else {
          setUser(null);
          setProfile(null);
          setCardsReviewedToday(0);
          setRecentSessions([]);
        }
      } catch (error) {
        console.error('Auth/Profile error:', error);
        toast.error('Không thể tải thông tin người dùng.');
      } finally {
        setLoading(false);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeProfile) unsubscribeProfile();
      if (unsubscribeSessions) unsubscribeSessions();
    };
  }, []);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();

    // Redirect flow: navigates the whole page to Google and back. Only a
    // fallback for regular browsers whose popup was blocked — inside the
    // desktop shell neither popup nor redirect can complete (see below).
    const startRedirectLogin = async () => {
      try {
        sessionStorage.setItem(AUTH_REDIRECT_FLAG, '1');
      } catch {
        // Storage unavailable — the redirect still works, only the
        // startup error-surfacing via getRedirectResult is skipped.
      }
      await signInWithRedirect(auth, provider);
    };

    if (isDesktopShell()) {
      // Desktop shell: sign-in must happen in the user's system browser.
      // The popup's child window cannot hand its result back to the shell
      // window, and the redirect round trip loses it too — both dead-end
      // here. Instead, navigate to a magic path the shell intercepts: it
      // opens /desktop-auth in the system browser, the user signs in
      // there, and the resulting Google ID token deep-links back into this
      // window (consumed by the `#glink=` effect above).
      window.location.assign('/__desktop_auth');
      return;
    }

    try {
      await signInWithPopup(auth, provider);
      toast.success('Đăng nhập thành công.');
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? '';
      if (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request') {
        // The browser/webview refused to open the popup — fall back to the
        // full-page redirect flow instead of dead-ending the user.
        try {
          await startRedirectLogin();
          return;
        } catch (redirectError) {
          console.error(redirectError);
          toast.error('Đăng nhập thất bại.');
          return;
        }
      }
      if (code === 'auth/popup-closed-by-user') {
        // The user closed the account chooser themselves — not an error,
        // and definitely not a reason to yank them into a redirect.
        return;
      }
      console.error(error);
      toast.error('Đăng nhập thất bại.');
    }
  };

  const handleLogout = async () => {
    // Wipe local data (review cache, offline queues, local settings) so the
    // next account on this machine starts clean. Cleanup failures must never
    // trap the user in the session, hence try/catch around each step.
    try {
      const { clearReviewCache } = await import('./review/localDB');
      await clearReviewCache();
    } catch (error) {
      console.warn('Không dọn được bộ nhớ đệm học tập khi đăng xuất.', error);
    }
    try {
      localStorage.removeItem('anki_settings');
    } catch (error) {
      console.warn('Không xoá được cài đặt cục bộ khi đăng xuất.', error);
    }
    try {
      await signOut(auth);
      toast.info('Đã đăng xuất.');
    } catch (error) {
      console.error(error);
      toast.error('Đăng xuất thất bại, vui lòng thử lại.');
    }
  };

  // The desktop shell sends users to /desktop-auth in their system browser
  // to sign in there (see pages/DesktopAuth). The page is standalone: it
  // must render regardless of this browser profile's own auth state, so it
  // bypasses both the loading gate and the login gate below.
  if (window.location.pathname === '/desktop-auth') {
    return (
      <>
        <DesktopAuth />
        <Toaster position="top-center" richColors />
      </>
    );
  }

  if (loading) {
    return (
      <div className="app-surface flex h-screen items-center justify-center">
        <div className="loader-ring" />
      </div>
    );
  }

  if (!user) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  const dailyGoal = Math.max(1, profile?.settings?.dailyGoal || 20);
  const sidebarDailyProgress = Math.min(100, (cardsReviewedToday / dailyGoal) * 100);
  const sidebarDisplayName = profile?.displayName || user.displayName || 'User';
  const sidebarPhotoURL = profile?.photoURL || user.photoURL || '';
  const sidebarInitial = (sidebarDisplayName.trim()[0] || 'U').toUpperCase();

  const xpProgress = getXpProgress((profile as ProfileWithProgress | null)?.xp ?? 0);

  return (
    <SettingsProvider initialTheme={profile?.settings?.theme}>
      <BackgroundMusic />
      <Router>
        <div className="app-shell font-sans text-foreground">
          {sidebarOpen && (
            <button
              aria-label="Đóng menu"
              className="fixed inset-0 z-30 bg-zinc-950/40 backdrop-blur-sm md:hidden"
              onClick={() => setSidebarOpen(false)}
            />
          )}

          <aside className={`app-sidebar ${sidebarCollapsed ? 'app-sidebar-collapsed' : ''} ${sidebarOpen ? 'translate-x-0 sidebar-pinned-open' : '-translate-x-full md:translate-x-0'}`}>
            <div className="sidebar-brand">
              <Logo className="h-10 w-10" />
              <div className="sidebar-text min-w-0">
                <p className="brand-gradient-text truncate text-sm font-bold">AnkiLearning</p>
                <p className="truncate text-[11px] text-white/50">Học thông minh với thẻ ghi nhớ</p>
              </div>
              <button
                type="button"
                aria-label="Thu gọn sidebar"
                className="sidebar-collapse-button ml-auto hidden h-8 w-8 items-center justify-center rounded-lg text-white/55 transition hover:bg-white/10 hover:text-white md:flex"
                onClick={() => setSidebarCollapsed((value) => !value)}
              >
                <Menu size={16} />
              </button>
            </div>

            <nav className="flex-1 space-y-1.5 px-3 py-5">
              <p className="sidebar-text px-3 pb-2 text-[10px] font-semibold uppercase text-white/50">Không gian học tập</p>
              {navItems.map((item) => (
                <SidebarLink
                  key={item.to}
                  to={item.to}
                  icon={item.icon}
                  label={item.label}
                  onClick={() => setSidebarOpen(false)}
                />
              ))}
            </nav>

            <div className="space-y-3 border-t border-sidebar-border p-4">
              <div className="sidebar-metric">
                <div className="flex items-center gap-2 text-white">
                  <Activity size={15} />
                  <span className="sidebar-expanded-only text-xs font-semibold">Hôm nay</span>
                </div>
                <div className="sidebar-expanded-only mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="xp-gradient h-full rounded-full"
                    style={{ width: `${sidebarDailyProgress}%` }}
                  />
                </div>
                <p className="sidebar-expanded-only mt-2 text-xs text-white/60">
                  {cardsReviewedToday}/{dailyGoal} thẻ
                </p>
              </div>

              <div className="sidebar-metric">
                <div className="flex items-center justify-between gap-2 text-white">
                  <div className="flex items-center gap-2">
                    <Sparkles size={15} />
                    <span className="sidebar-expanded-only text-xs font-semibold">Cấp {xpProgress.level}</span>
                  </div>
                  <span className="sidebar-expanded-only text-[11px] font-medium text-white/60">{xpProgress.xp} XP</span>
                </div>
                <div className="sidebar-expanded-only mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="xp-gradient h-full rounded-full"
                    style={{ width: `${Math.round(xpProgress.progress * 100)}%` }}
                  />
                </div>
                <p className="sidebar-expanded-only mt-2 text-xs text-white/60">
                  Còn {Math.max(0, xpProgress.xpForNextLevel - xpProgress.xpIntoLevel)} XP để lên cấp {xpProgress.level + 1}
                </p>
              </div>

              <div className="sidebar-user-card">
                {sidebarPhotoURL ? (
                  <img
                    src={sidebarPhotoURL}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-9 w-9 rounded-full border border-white/10 object-cover"
                  />
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/10 text-sm font-semibold text-white">
                    {sidebarInitial}
                  </div>
                )}
                <div className="sidebar-expanded-only min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">{sidebarDisplayName}</p>
                </div>
              </div>

              <button onClick={handleLogout} className="sidebar-logout" title="Đăng xuất">
                <LogOut size={16} />
                <span className="sidebar-expanded-only">Đăng xuất</span>
              </button>
            </div>
          </aside>

          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <header className="app-topbar">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  aria-label="Mở menu"
                  className="topbar-menu-button"
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                >
                  {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
                </button>
                <TopbarHeading />
              </div>
              <NotificationCenter user={user} profile={profile} />
            </header>

            <div className="smooth-scroll min-w-0 flex-1 overflow-y-auto">
              <div className="page-shell">
                <Suspense fallback={<PageLoader />}>
                  <AnimatedRoutes user={user} profile={profile} recentSessions={recentSessions} />
                </Suspense>
              </div>
            </div>
          </main>

          <BottomNav />

          <SwUpdateBanner />

          <Toaster position="top-center" richColors />
        </div>
      </Router>
    </SettingsProvider>
  );
}

function TopbarHeading() {
  const location = useLocation();
  const meta = getPageMeta(location.pathname);

  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{meta.title}</p>
      <p className="hidden truncate text-xs text-muted-foreground sm:block">
        {meta.description}
      </p>
    </div>
  );
}

function SwUpdateBanner() {
  const { updateAvailable, applyUpdate, dismiss } = useServiceWorkerUpdate();

  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-24 z-50 flex items-center gap-3 rounded-2xl border border-emerald-200 bg-white/95 p-3.5 shadow-xl shadow-emerald-950/10 backdrop-blur-md animate-page-in dark:border-emerald-500/30 dark:bg-zinc-900/95 md:inset-x-auto md:right-6 md:bottom-6 md:w-96"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
        <RefreshCw size={19} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-zinc-950 dark:text-white">
          Có phiên bản mới của AnkiLearning
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          Tải lại để dùng các tính năng và bản sửa lỗi mới nhất.
        </p>
        <button
          onClick={applyUpdate}
          className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 active:scale-[0.98]"
        >
          <RefreshCw size={13} />
          Tải lại ngay
        </button>
      </div>
      <button
        onClick={dismiss}
        aria-label="Để sau"
        className="shrink-0 self-start rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
      >
        <X size={16} />
      </button>
    </div>
  );
}

function BottomNav() {
  const location = useLocation();

  return (
    <nav className="bottom-nav" aria-label="Điều hướng chính trên di động">
      {bottomNavItems.map((item) => {
        const isActive = item.to === '/'
          ? location.pathname === '/'
          : location.pathname.startsWith(item.to);
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={isActive ? 'page' : undefined}
            className={`bottom-nav-item ${isActive ? 'bottom-nav-item-active' : ''}`}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const previewQuestions = [
    'Dấu hiệu X-quang gợi ý gãy cổ xương đùi?',
    'Chỉ định ECG nào cần xử trí cấp cứu?',
    'Khi nào thẻ quay lại bước học lại?',
  ];

  return (
    <div className="app-surface aurora-bg min-h-screen p-4 font-sans text-foreground [@media(min-width:768px)_and_(min-height:841px)]:p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-55 dark:opacity-25"
        style={{ backgroundImage: 'url(/img/bg-study.webp)', zIndex: -2 }}
      />
      <span className="aurora-blob aurora-blob-1" aria-hidden="true" />
      <span className="aurora-blob aurora-blob-2" aria-hidden="true" />
      <span className="aurora-blob aurora-blob-3" aria-hidden="true" />
      <div className="login-shell">
        <section className="flex min-h-[calc(100vh-4rem)] min-h-[calc(100dvh-4rem)] flex-col justify-between p-7 [@media(max-height:840px)]:min-h-[calc(100dvh-2rem)] [@media(max-height:840px)]:p-6 [@media(min-width:768px)_and_(min-height:841px)]:p-10">
          <div className="flex items-center gap-3">
            <Logo className="h-12 w-12" />
            <div>
              <p className="brand-gradient-text text-lg font-bold">AnkiLearning</p>
              <p className="text-xs text-muted-foreground">Học thông minh với thẻ ghi nhớ</p>
            </div>
          </div>

          <div className="py-12 [@media(max-height:840px)]:py-4">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-black/[0.08] bg-white/70 px-3 py-1 text-xs font-medium text-zinc-600 shadow-sm backdrop-blur-xl [@media(max-height:840px)]:mb-3 dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-300">
              <ShieldCheck size={14} />
              Học thẻ, tạo đề, luyện nhớ trong một không gian
            </div>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight text-zinc-950 [@media(min-width:768px)_and_(min-height:841px)]:text-5xl dark:text-white">
              Học thông minh với thẻ ghi nhớ.
            </h1>
            <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground [@media(max-height:840px)]:mt-3 [@media(max-height:840px)]:leading-6">
              Tạo bộ thẻ, ôn tập theo nhịp nhớ FSRS, luyện đề bằng AI và đồng bộ dữ liệu bằng tài khoản Google trên mọi thiết bị.
            </p>
            <Button onClick={onLogin} className="btn-press mt-8 h-11 w-full max-w-xs gap-2 [@media(max-height:840px)]:mt-5">
              Đăng nhập với Google
              <ArrowRight size={16} />
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">Dữ liệu được đồng bộ bằng Firebase theo tài khoản của bạn.</p>
        </section>

        <section className="login-preview [@media(max-height:840px)]:gap-3 [@media(max-height:840px)]:p-5">
          <img
            src="/img/login-hero.webp"
            alt="Minh hoạ học viên học cùng thẻ ghi nhớ AnkiLearning"
            className="w-full rounded-2xl object-cover shadow-xl shadow-emerald-900/10 ring-1 ring-black/5 [@media(max-height:640px)]:hidden [@media(max-height:720px)]:h-28 [@media(min-height:721px)_and_(max-height:840px)]:h-40 dark:ring-white/10"
            loading="lazy"
          />
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="premium-panel p-5 [@media(max-height:840px)]:p-4"
          >
            <div className="mb-5 flex items-center justify-between [@media(max-height:840px)]:mb-3">
              <div>
                <p className="text-sm font-semibold">Ôn tập hôm nay</p>
                <p className="text-xs text-muted-foreground">12 thẻ đến hạn, 1 đề luyện tập</p>
              </div>
              <span className="rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                84%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-950/[0.06] dark:bg-white/10">
              <motion.div
                className="h-full rounded-full bg-zinc-950 dark:bg-white"
                initial={{ width: 0 }}
                animate={{ width: '84%' }}
                transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
          </motion.div>

          <div className="grid grid-cols-2 gap-4 [@media(max-height:840px)]:gap-3">
            <PreviewStat icon={<BrainCircuit size={18} />} label="Câu hỏi AI" value="20" />
            <PreviewStat icon={<Library size={18} />} label="Bộ thẻ" value="6" />
          </div>

          <div className="premium-panel p-5 [@media(max-height:640px)]:hidden [@media(max-height:840px)]:p-4">
            <p className="mb-4 text-sm font-semibold [@media(max-height:840px)]:mb-2">Đề kiểm tra gợi ý</p>
            <div className="space-y-1">
              {previewQuestions.map((item, index) => (
                <div key={item} className={`group flex items-center justify-between rounded-md px-2 py-3 text-sm transition-colors hover:bg-zinc-950/[0.035] [@media(max-height:840px)]:py-2 dark:hover:bg-white/[0.05] ${index === 2 ? '[@media(max-height:760px)]:hidden' : ''}`}>
                  <span className="text-zinc-700 dark:text-zinc-200">{item}</span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1" />
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function PreviewStat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="premium-panel p-5 [@media(max-height:840px)]:p-4">
      <div className="mb-5 flex h-9 w-9 items-center justify-center rounded-md bg-zinc-950 text-white [@media(max-height:840px)]:mb-2 dark:bg-white dark:text-zinc-950">
        {icon}
      </div>
      <p className="font-mono text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function AnimatedRoutes({
  user,
  profile,
  recentSessions,
}: {
  user: User;
  profile: UserProfile | null;
  recentSessions: StudySession[];
}) {
  const location = useLocation();

  return (
    <AppErrorBoundary resetKey={location.pathname}>
      {/* No AnimatePresence/motion wrapper: the old mode="wait" exit (220ms)
          stacked on top of the CSS pageIn animation made every navigation
          wait ~0.45s. The keyed div restarts the CSS pageIn animation per
          route and content shows immediately. */}
      <div key={location.pathname} className="route-layer animate-page-in">
        <Routes location={location}>
          <Route path="/" element={<Dashboard user={user} profile={profile} recentSessions={recentSessions} />} />
          <Route path="/decks" element={<Decks user={user} />} />
          <Route path="/decks/:deckId" element={<DeckDetail user={user} profile={profile} />} />
          <Route path="/study/:deckId" element={<Study user={user} profile={profile} />} />
          <Route path="/create-deck" element={<CreateDeck user={user} profile={profile} />} />
          <Route path="/voice-to-card" element={<VoiceToCard user={user} profile={profile} />} />
          <Route path="/assessment" element={<Assessment user={user} profile={profile} />} />
          <Route path="/ai-helper" element={<AIHelper user={user} profile={profile} />} />
          <Route path="/search" element={<Search user={user} />} />
          <Route path="/settings" element={<Settings user={user} profile={profile} />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </div>
    </AppErrorBoundary>
  );
}

function SidebarLink({
  to,
  icon,
  label,
  onClick,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  const location = useLocation();
  const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);

  return (
    <Link to={to} onClick={onClick} title={label} className={`nav-item ${isActive ? 'nav-item-active' : ''}`}>
      <span className="nav-item-icon">{icon}</span>
      <span className="nav-label min-w-0 flex-1 truncate">{label}</span>
      {isActive && (
        <motion.span
          layoutId="sidebar-active"
          className="nav-active-dot"
          initial={false}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
        />
      )}
    </Link>
  );
}
