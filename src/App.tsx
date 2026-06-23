import { Component, useEffect, useState, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut, User } from 'firebase/auth';
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { UserProfile } from './types';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { AnimatePresence, motion } from 'motion/react';
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
import { flushGamificationQueue } from './services/gamificationService';

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
  { to: '/voice-to-card', label: 'Voice-to-Card', icon: <Mic size={17} /> },
  { to: '/assessment', label: 'Kiểm tra', icon: <BrainCircuit size={17} /> },
  { to: '/ai-helper', label: 'Study Copilot', icon: <Sparkles size={17} /> },
  { to: '/search', label: 'Tìm kiếm', icon: <SearchIcon size={17} /> },
  { to: '/settings', label: 'Cài đặt', icon: <SettingsIcon size={17} /> },
];

function PageLoader() {
  return (
    <div className="flex min-h-[420px] w-full items-center justify-center">
      <div className="loader-ring" />
    </div>
  );
}

function isSameLocalDay(value: unknown, referenceDate = new Date()) {
  if (!value) return false;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return false;

  return (
    date.getFullYear() === referenceDate.getFullYear()
    && date.getMonth() === referenceDate.getMonth()
    && date.getDate() === referenceDate.getDate()
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

  useEffect(() => {
    if (!user?.uid) return;
    flushGamificationQueue().catch((error) => console.warn('Gamification queue sync failed.', error));
  }, [user?.uid]);

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
            limit(120)
          );

          unsubscribeSessions = onSnapshot(
            sessionsQuery,
            (snap) => {
              const today = new Date();
              const reviewedToday = snap.docs.reduce((sum, sessionDoc) => {
                const data = sessionDoc.data();
                return isSameLocalDay(data.timestamp, today)
                  ? sum + (typeof data.cardsReviewed === 'number' ? data.cardsReviewed : 0)
                  : sum;
              }, 0);

              setCardsReviewedToday(reviewedToday);
            },
            () => setCardsReviewedToday(0)
          );
        } else {
          setUser(null);
          setProfile(null);
          setCardsReviewedToday(0);
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
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      toast.success('Đăng nhập thành công.');
    } catch (error) {
      console.error(error);
      toast.error('Đăng nhập thất bại.');
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    toast.info('Đã đăng xuất.');
  };

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

  return (
    <SettingsProvider>
      <BackgroundMusic />
      <Router>
        <NotificationCenter user={user} profile={profile} />
        <div className="app-shell font-sans text-foreground">
          {sidebarOpen && (
            <button
              aria-label="Đóng menu"
              className="fixed inset-0 z-30 bg-zinc-950/40 backdrop-blur-sm md:hidden"
              onClick={() => setSidebarOpen(false)}
            />
          )}

          <button
            aria-label="Mở menu"
            className="mobile-menu-button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>

          <aside className={`app-sidebar ${sidebarCollapsed ? 'app-sidebar-collapsed' : ''} ${sidebarOpen ? 'translate-x-0 sidebar-pinned-open' : '-translate-x-full md:translate-x-0'}`}>
            <div className="sidebar-brand">
              <Logo className="h-10 w-10" />
              <div className="sidebar-text min-w-0">
                <p className="truncate text-sm font-semibold text-white">Learning Card</p>
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
              <p className="sidebar-text px-3 pb-2 text-[10px] font-semibold uppercase text-white/32">Study Workspace</p>
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
                <p className="sidebar-expanded-only mt-2 text-xs text-white/42">
                  {cardsReviewedToday}/{dailyGoal} thẻ
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
              <div className="min-w-0">
                <p className="text-sm font-semibold text-zinc-950 dark:text-white">Study Workspace</p>
                <p className="truncate text-xs text-muted-foreground">
                  Học, tạo thẻ và luyện đề trong một không gian tập trung.
                </p>
              </div>
            </header>

            <div className="smooth-scroll min-w-0 flex-1 overflow-y-auto">
              <div className="page-shell">
                <Suspense fallback={<PageLoader />}>
                  <AnimatedRoutes user={user} profile={profile} />
                </Suspense>
              </div>
            </div>
          </main>

          <Toaster position="top-center" richColors />
        </div>
      </Router>
    </SettingsProvider>
  );
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const previewQuestions = [
    'Dấu hiệu X-quang gợi ý gãy cổ xương đùi?',
    'Chỉ định ECG nào cần xử trí cấp cứu?',
    'Khi nào chuyển thẻ về relearning?',
  ];

  return (
    <div className="app-surface min-h-screen p-4 font-sans text-foreground md:p-8">
      <div className="login-shell">
        <section className="flex min-h-[calc(100vh-4rem)] flex-col justify-between p-7 md:p-10">
          <div className="flex items-center gap-3">
            <Logo className="h-11 w-11" />
            <div>
              <p className="text-base font-semibold text-zinc-950 dark:text-white">Learning Card</p>
              <p className="text-xs text-muted-foreground">Smart flashcards with Gemini</p>
            </div>
          </div>

          <div className="py-12">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-black/[0.08] bg-white/70 px-3 py-1 text-xs font-medium text-zinc-600 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-300">
              <ShieldCheck size={14} />
              Học thẻ, tạo đề, luyện nhớ trong một workspace
            </div>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight text-zinc-950 dark:text-white md:text-5xl">
              Không gian học tập tối giản, sắc nét và cá nhân hóa.
            </h1>
            <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground">
              Tạo bộ thẻ, ôn tập theo nhịp nhớ, luyện đề từ tài liệu y khoa và đồng bộ dữ liệu bằng tài khoản Google.
            </p>
            <Button onClick={onLogin} className="mt-8 h-11 w-full max-w-xs gap-2 bg-zinc-950 text-white hover:bg-zinc-800">
              Đăng nhập với Google
              <ArrowRight size={16} />
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">Dữ liệu được đồng bộ bằng Firebase theo tài khoản của bạn.</p>
        </section>

        <section className="login-preview">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="premium-panel p-5"
          >
            <div className="mb-5 flex items-center justify-between">
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

          <div className="grid grid-cols-2 gap-4">
            <PreviewStat icon={<BrainCircuit size={18} />} label="Câu hỏi AI" value="20" />
            <PreviewStat icon={<Library size={18} />} label="Bộ thẻ" value="6" />
          </div>

          <div className="premium-panel p-5">
            <p className="mb-4 text-sm font-semibold">Đề thi gợi ý</p>
            <div className="space-y-1">
              {previewQuestions.map((item) => (
                <div key={item} className="group flex items-center justify-between rounded-md px-2 py-3 text-sm transition-colors hover:bg-zinc-950/[0.035] dark:hover:bg-white/[0.05]">
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
    <div className="premium-panel p-5">
      <div className="mb-5 flex h-9 w-9 items-center justify-center rounded-md bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
        {icon}
      </div>
      <p className="font-mono text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function AnimatedRoutes({ user, profile }: { user: User; profile: UserProfile | null }) {
  const location = useLocation();

  return (
    <AppErrorBoundary resetKey={location.pathname}>
      <AnimatePresence mode="wait">
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 18, scale: 0.992, filter: 'blur(8px)' }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -10, scale: 0.996, filter: 'blur(5px)' }}
          transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
          className="route-layer"
        >
          <Routes location={location}>
            <Route path="/" element={<Dashboard user={user} profile={profile} />} />
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
        </motion.div>
      </AnimatePresence>
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
