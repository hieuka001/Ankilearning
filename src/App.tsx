import { useState, useEffect, lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut, User } from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { auth, db } from './firebase';
import { UserProfile } from './types';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { motion } from 'motion/react';
import {
  LayoutDashboard,
  Library,
  PlusCircle,
  LogOut,
  BrainCircuit,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Menu,
  X,
  Mic,
  ArrowRight,
} from 'lucide-react';
import { SettingsProvider } from './contexts/SettingsContext';
import BackgroundMusic from './components/BackgroundMusic';
import Logo from './components/Logo';

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

function PageLoader() {
  return (
    <div className="flex min-h-[420px] w-full items-center justify-center">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);

      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
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
              lastStudyDate: new Date().toISOString(),
              settings: {
                dailyGoal: 20,
                theme: 'light',
                language: 'vi',
                geminiApiKey: '',
                aiApiKey: '',
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
        } else {
          setUser(null);
          setProfile(null);
        }
      } catch (error) {
        console.error('Auth/Profile error:', error);
        toast.error('Khong the tai thong tin nguoi dung.');
      } finally {
        setLoading(false);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeProfile) unsubscribeProfile();
    };
  }, []);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      toast.success('Dang nhap thanh cong.');
    } catch (error) {
      console.error(error);
      toast.error('Dang nhap that bai.');
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    toast.info('Da dang xuat.');
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center app-surface">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen app-surface p-4 md:p-8 font-sans text-foreground">
        <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl grid-cols-1 overflow-hidden rounded-xl border border-black/5 bg-white/85 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/80 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="flex flex-col justify-between border-b border-border/70 p-8 dark:border-white/10 lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-3">
              <Logo className="h-10 w-10" />
              <div>
                <p className="text-base font-semibold">Learning Card</p>
                <p className="text-xs text-muted-foreground">Gemini study workspace</p>
              </div>
            </div>

            <div className="py-14">
              <div className="mb-5 inline-flex items-center rounded-full border border-primary/15 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
                AI flashcards and practice exams
              </div>
              <h1 className="max-w-md text-4xl font-semibold leading-tight text-zinc-950 dark:text-white md:text-5xl">
                Mot khong gian hoc the gon, ro, va thong minh.
              </h1>
              <p className="mt-5 max-w-md text-base leading-7 text-muted-foreground">
                Tao bo the, on tap lap lai ngat quang, tao de thi va goi y lo trinh hoc bang Gemini.
              </p>
              <Button onClick={handleLogin} className="mt-8 h-11 w-full max-w-xs font-semibold shadow-sm">
                Dang nhap voi Google
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Du lieu dong bo Firebase theo tai khoan Google cua ban.
            </p>
          </section>

          <section className="bg-zinc-50/80 p-6 dark:bg-zinc-900/45 md:p-8">
            <div className="grid h-full content-center gap-4">
              <div className="rounded-lg border border-border bg-white p-5 shadow-sm dark:bg-zinc-950">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">On tap hom nay</p>
                    <p className="text-xs text-muted-foreground">12 the can xu ly</p>
                  </div>
                  <span className="rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                    84%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/10">
                  <div className="h-full w-4/5 rounded-full bg-primary" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg border border-border bg-white p-5 shadow-sm dark:bg-zinc-950">
                  <BrainCircuit className="mb-5 h-5 w-5 text-primary" />
                  <p className="text-2xl font-semibold">20</p>
                  <p className="text-xs text-muted-foreground">Cau hoi AI</p>
                </div>
                <div className="rounded-lg border border-border bg-white p-5 shadow-sm dark:bg-zinc-950">
                  <Library className="mb-5 h-5 w-5 text-emerald-600" />
                  <p className="text-2xl font-semibold">6</p>
                  <p className="text-xs text-muted-foreground">Bo the dang hoc</p>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-white p-5 shadow-sm dark:bg-zinc-950">
                <p className="mb-4 text-sm font-semibold">De thi mau</p>
                {['Chan doan phan biet dau nguc cap?', 'Xu tri ban dau soc nhiem khuan?', 'Tieu chuan chan doan hen phe quan?'].map((item) => (
                  <div key={item} className="flex items-center justify-between border-t border-border py-3 text-sm">
                    <span className="text-zinc-700 dark:text-zinc-200">{item}</span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <SettingsProvider>
      <BackgroundMusic />
      <Router>
        <div className="flex h-screen overflow-hidden app-surface font-sans text-foreground">
          {sidebarOpen && (
            <button
              aria-label="Dong menu"
              className="fixed inset-0 z-30 bg-black/20 backdrop-blur-sm md:hidden"
              onClick={() => setSidebarOpen(false)}
            />
          )}

          <button
            aria-label="Mo menu"
            className="fixed left-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card shadow-sm md:hidden"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>

          <aside
            className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-border bg-sidebar/95 shadow-sm backdrop-blur-xl transition-transform duration-300 md:relative md:translate-x-0 md:shadow-none ${
              sidebarOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
            <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-5">
              <Logo className="h-9 w-9" />
              <div>
                <p className="text-sm font-semibold text-sidebar-foreground">Learning Card</p>
                <p className="text-xs text-muted-foreground">Smart flashcards</p>
              </div>
            </div>

            <nav className="flex-1 space-y-1 p-3">
              <SidebarLink to="/" icon={<LayoutDashboard size={17} />} label="Tong quan" onClick={() => setSidebarOpen(false)} />
              <SidebarLink to="/decks" icon={<Library size={17} />} label="Bo the" onClick={() => setSidebarOpen(false)} />
              <SidebarLink to="/create-deck" icon={<PlusCircle size={17} />} label="Tao bo the" onClick={() => setSidebarOpen(false)} />
              <SidebarLink to="/voice-to-card" icon={<Mic size={17} />} label="Voice-to-Card" onClick={() => setSidebarOpen(false)} />
              <SidebarLink to="/assessment" icon={<BrainCircuit size={17} />} label="Kiem tra" onClick={() => setSidebarOpen(false)} />
              <SidebarLink to="/ai-helper" icon={<BrainCircuit size={17} />} label="AI Helper" onClick={() => setSidebarOpen(false)} />
              <SidebarLink to="/search" icon={<SearchIcon size={17} />} label="Tim kiem" onClick={() => setSidebarOpen(false)} />
              <SidebarLink to="/settings" icon={<SettingsIcon size={17} />} label="Cai dat" onClick={() => setSidebarOpen(false)} />
            </nav>

            <div className="border-t border-sidebar-border p-4">
              <div className="mb-3 flex items-center gap-3 rounded-lg border border-border bg-background/70 p-3">
                <img src={user.photoURL || ''} alt="" className="h-9 w-9 rounded-full border border-border object-cover" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{user.displayName}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-300"
              >
                <LogOut size={16} />
                Dang xuat
              </button>
            </div>
          </aside>

          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <header className="hidden h-16 shrink-0 items-center justify-between border-b border-border bg-background/70 px-6 backdrop-blur-xl md:flex">
              <div>
                <p className="text-sm font-semibold">Workspace</p>
                <p className="text-xs text-muted-foreground">Hoc, tao the va tao de thi trong cung mot noi.</p>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Gemini 2.5 Flash
              </div>
            </header>

            <div className="min-w-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-7xl p-4 pt-16 md:p-8 lg:p-10">
                <Suspense fallback={<PageLoader />}>
                  <Routes>
                    <Route path="/" element={<Dashboard user={user} profile={profile} />} />
                    <Route path="/decks" element={<Decks user={user} />} />
                    <Route path="/decks/:deckId" element={<DeckDetail user={user} profile={profile} />} />
                    <Route path="/study/:deckId" element={<Study user={user} />} />
                    <Route path="/create-deck" element={<CreateDeck user={user} profile={profile} />} />
                    <Route path="/voice-to-card" element={<VoiceToCard user={user} profile={profile} />} />
                    <Route path="/assessment" element={<Assessment user={user} profile={profile} />} />
                    <Route path="/ai-helper" element={<AIHelper user={user} profile={profile} />} />
                    <Route path="/search" element={<Search user={user} />} />
                    <Route path="/settings" element={<Settings user={user} profile={profile} />} />
                    <Route path="*" element={<Navigate to="/" />} />
                  </Routes>
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
  const isActive = location.pathname === to;

  return (
    <Link
      to={to}
      onClick={onClick}
      className={`relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
        isActive
          ? 'bg-primary text-primary-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      }`}
    >
      <span className="flex h-5 w-5 items-center justify-center">{icon}</span>
      <span>{label}</span>
      {isActive && (
        <motion.span
          layoutId="sidebar-active"
          className="absolute right-2 h-1.5 w-1.5 rounded-full bg-current"
          initial={false}
        />
      )}
    </Link>
  );
}
