import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { User } from 'firebase/auth';
import { collection, doc, getDocs, limit, onSnapshot, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { addDays, format, startOfDay, subDays } from 'date-fns';
import { vi } from 'date-fns/locale';
import { motion } from 'motion/react';
import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  Clock,
  Flame,
  Layers3,
  Loader2,
  Plus,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { db } from '../firebase';
import { Deck, StudySession, UserProfile } from '../types';
import { calculateLevel, calculateLevelProgress } from '../lib/gamification';
import { suggestStudyPath } from '../services/aiService';
import { getCardDueDate, isCardDue } from '../lib/spacedRepetition';

const DashboardChart = lazy(() => import('../components/charts/DashboardChart'));

interface DashboardProps {
  user: User | null;
  profile: UserProfile | null;
}

interface DayPoint {
  date: string;
  fullDate: Date;
  count: number;
}

const cardMotion = {
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
};

export default function Dashboard({ user, profile }: DashboardProps) {
  const userId = user?.uid;
  const [recentDecks, setRecentDecks] = useState<(Deck & { dueCount: number })[]>([]);
  const [totalDeckCount, setTotalDeckCount] = useState(0);
  const [recentSessions, setRecentSessions] = useState<StudySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [isGeneratingSuggestion, setIsGeneratingSuggestion] = useState(false);
  const [chartData, setChartData] = useState<DayPoint[]>([]);
  const [forecastData, setForecastData] = useState<DayPoint[]>([]);

  useEffect(() => {
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = subDays(new Date(), 6 - i);
      return {
        date: format(date, 'dd/MM'),
        fullDate: startOfDay(date),
        count: 0,
      };
    });

    recentSessions.forEach((session) => {
      const sessionDate = startOfDay(new Date(session.timestamp));
      const dayMatch = last7Days.find((day) => day.fullDate.getTime() === sessionDate.getTime());
      if (dayMatch) dayMatch.count += session.cardsReviewed;
    });

    setChartData(last7Days);
  }, [recentSessions]);

  useEffect(() => {
    if (!userId || recentDecks.length === 0) {
      setForecastData(buildForecastShell());
      return;
    }

    let cancelled = false;

    const calculateForecast = async () => {
      const next7Days = buildForecastShell();

      try {
        for (const deck of recentDecks) {
          const cardsSnap = await getDocs(collection(db, `decks/${deck.id}/cards`));
          cardsSnap.docs.forEach((cardDoc) => {
            const data = cardDoc.data();
            if (!data.dueDate && !data.nextReview) return;

            const reviewDate = startOfDay(new Date(getCardDueDate(data)));
            const dayMatch = next7Days.find((day) => day.fullDate.getTime() === reviewDate.getTime());
            if (dayMatch) dayMatch.count += 1;
          });
        }
      } catch {
        // Keep the empty forecast shell if Firestore rejects the optional query.
      }

      if (!cancelled) setForecastData(next7Days);
    };

    calculateForecast();

    return () => {
      cancelled = true;
    };
  }, [userId, recentDecks]);

  useEffect(() => {
    if (!userId || !profile?.lastStudyDate || !profile.streak) return;

    const lastStudyDate = new Date(profile.lastStudyDate);
    const today = new Date();
    const lastDate = new Date(lastStudyDate.getFullYear(), lastStudyDate.getMonth(), lastStudyDate.getDate());
    const currentDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diffDays = Math.round((currentDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays > 1) {
      updateDoc(doc(db, 'users', userId), { streak: 0 }).catch(() => undefined);
    }
  }, [profile?.lastStudyDate, profile?.streak, userId]);

  useEffect(() => {
    if (!userId) {
      setRecentDecks([]);
      setRecentSessions([]);
      setTotalDeckCount(0);
      setLoading(false);
      return;
    }

    setLoading(true);

    const decksQuery = query(collection(db, 'decks'), where('ownerId', '==', userId));
    const unsubscribeDecks = onSnapshot(
      decksQuery,
      async (snap) => {
        setTotalDeckCount(snap.size);
        const decksData = snap.docs.map((deckDoc) => ({ id: deckDoc.id, ...deckDoc.data() } as Deck));
        decksData.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        const topDecks = decksData.slice(0, 4);
        const decksWithDue = await Promise.all(
          topDecks.map(async (deck) => {
            const cardsSnap = await getDocs(collection(db, `decks/${deck.id}/cards`));
            const dueCount = cardsSnap.docs.filter((cardDoc) => isCardDue(cardDoc.data())).length;
            return { ...deck, dueCount };
          })
        );

        setRecentDecks(decksWithDue);
        setLoading(false);
      },
      () => setLoading(false)
    );

    const sessionsQuery = query(collection(db, `users/${userId}/sessions`), orderBy('timestamp', 'desc'), limit(200));
    const unsubscribeSessions = onSnapshot(sessionsQuery, (snap) => {
      const sessionsData = snap.docs.map((sessionDoc) => ({ id: sessionDoc.id, ...sessionDoc.data() } as StudySession));
      sessionsData.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setRecentSessions(sessionsData);
    });

    return () => {
      unsubscribeDecks();
      unsubscribeSessions();
    };
  }, [userId]);

  const cardsToday = useMemo(
    () =>
      recentSessions
        .filter((session) => startOfDay(new Date(session.timestamp)).getTime() === startOfDay(new Date()).getTime())
        .reduce((sum, session) => sum + session.cardsReviewed, 0),
    [recentSessions]
  );

  const dailyGoal = Math.max(profile?.settings?.dailyGoal || 20, 1);
  const dailyProgress = Math.min((cardsToday / dailyGoal) * 100, 100);
  const userLevel = calculateLevel(profile?.xp || 0);
  const levelProgress = calculateLevelProgress(profile?.xp || 0);
  const dueToday = recentDecks.reduce((sum, deck) => sum + deck.dueCount, 0);

  const handleGetAiSuggestion = async () => {
    if (!profile) return;
    setIsGeneratingSuggestion(true);
    try {
      const suggestion = await suggestStudyPath(
        {
          totalCardsLearned: profile.totalCardsLearned,
          streak: profile.streak,
          recentSessions: recentSessions.length,
          dueToday,
        },
        { geminiApiKey: profile.settings?.geminiApiKey || profile.settings?.aiApiKey }
      );
      setAiSuggestion(suggestion);
    } catch {
      setAiSuggestion('Gemini chưa phản hồi. Kiểm tra API key trong Cài đặt rồi thử lại.');
    } finally {
      setIsGeneratingSuggestion(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[64vh] items-center justify-center">
        <div className="premium-panel flex items-center gap-4 rounded-lg px-5 py-4">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <p className="text-sm font-medium text-muted-foreground">Đang đồng bộ dữ liệu học tập...</p>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial="initial"
      animate="animate"
      transition={{ staggerChildren: 0.045 }}
      className="space-y-6"
    >
      <motion.section
        variants={cardMotion}
        transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
        className="premium-panel overflow-hidden rounded-lg"
      >
        <div className="grid gap-0 lg:grid-cols-[1.35fr_0.65fr]">
          <div className="border-b border-black/[0.07] p-6 dark:border-white/10 md:p-8 lg:border-b-0 lg:border-r">
            <div className="mb-8 flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-black/[0.08] bg-white/70 px-3 py-1 text-xs font-medium text-zinc-600 shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Gemini 2.5 Flash active
              </span>
              <span className="rounded-full bg-zinc-950 px-3 py-1 text-xs font-medium text-white">
                Level {userLevel}
              </span>
            </div>

            <div className="max-w-3xl">
              <p className="mb-2 text-sm font-medium text-muted-foreground">
                Chào mừng trở lại, <span className="text-zinc-950 dark:text-white">{profile?.displayName || 'bạn'}</span>
              </p>
              <h1 className="max-w-2xl text-balance text-3xl font-semibold text-zinc-950 dark:text-white md:text-4xl">
                Bảng điều khiển học tập gọn, sắc và tập trung vào tiến độ thật.
              </h1>
            </div>

            <div className="mt-8 grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
              <div>
                <div className="mb-2 flex items-center justify-between gap-4">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    Hôm nay: {cardsToday}/{dailyGoal} thẻ
                  </p>
                  <p className="font-mono text-xs font-semibold text-muted-foreground">{Math.round(dailyProgress)}%</p>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${dailyProgress}%` }}
                    transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
                    className="h-full rounded-full bg-zinc-950 dark:bg-white"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <Link to="/create-deck">
                  <Button className="h-10 gap-2 bg-zinc-950 px-4 text-white hover:bg-zinc-800">
                    <Plus size={16} />
                    Tạo thẻ
                  </Button>
                </Link>
                <Link to="/assessment">
                  <Button variant="outline" className="h-10 gap-2 bg-white/70 px-4">
                    <BrainCircuit size={16} />
                    Luyện đề
                  </Button>
                </Link>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 divide-x divide-y divide-black/[0.07] dark:divide-white/10">
            <StatTile label="Đến hạn" value={dueToday} icon={<Target size={18} />} tone="blue" />
            <StatTile label="Chuỗi ngày" value={profile?.streak || 0} icon={<Flame size={18} />} tone="amber" />
            <StatTile label="Bộ thẻ" value={totalDeckCount} icon={<Layers3 size={18} />} tone="neutral" />
            <StatTile label="Đã học" value={profile?.totalCardsLearned || 0} icon={<CheckCircle2 size={18} />} tone="emerald" />
          </div>
        </div>
      </motion.section>

      <div className="grid gap-6 xl:grid-cols-[1.45fr_0.85fr]">
        <motion.div variants={cardMotion} transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}>
          <Card className="premium-panel overflow-hidden border-0 bg-transparent">
            <CardHeader className="flex flex-row items-start justify-between gap-4 p-6 pb-0">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase text-primary">Analytics</p>
                <CardTitle className="text-xl font-semibold">Nhịp học 7 ngày</CardTitle>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <TrendingUp size={20} />
              </div>
            </CardHeader>
            <CardContent className="h-[340px] p-4 pt-6 md:p-6">
              <Suspense fallback={<div className="h-full animate-pulse rounded-lg bg-black/[0.04]" />}>
                <DashboardChart data={chartData} />
              </Suspense>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div variants={cardMotion} transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}>
          <Card className="premium-panel h-full border-0 bg-transparent">
            <CardHeader className="p-6 pb-2">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase text-amber-700 dark:text-amber-300">Forecast</p>
                  <CardTitle className="text-xl font-semibold">Dự báo ôn tập</CardTitle>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300">
                  <Clock size={20} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-6 pt-4">
              <ForecastBars data={forecastData} />
            </CardContent>
          </Card>
        </motion.div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <motion.div variants={cardMotion} transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}>
          <Card className="premium-panel h-full border-0 bg-transparent">
            <CardHeader className="flex flex-row items-start justify-between gap-4 p-6 pb-3">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase text-emerald-700 dark:text-emerald-300">Focus</p>
                <CardTitle className="text-xl font-semibold">Bộ thẻ gần đây</CardTitle>
              </div>
              <Link to="/decks">
                <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
                  Xem tất cả
                  <ArrowRight size={15} />
                </Button>
              </Link>
            </CardHeader>
            <CardContent className="p-4 pt-0 md:p-6 md:pt-0">
              <RecentDecksList decks={recentDecks} />
            </CardContent>
          </Card>
        </motion.div>

        <motion.div variants={cardMotion} transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}>
          <Card className="premium-panel h-full border-0 bg-transparent">
            <CardHeader className="flex flex-row items-start justify-between gap-4 p-6 pb-3">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase text-zinc-500">Timeline</p>
                <CardTitle className="text-xl font-semibold">Hoạt động học</CardTitle>
              </div>
              <div className="hidden items-center gap-1 sm:flex">
                <LearningHeatmap sessions={recentSessions} compact />
              </div>
            </CardHeader>
            <CardContent className="p-4 pt-0 md:p-6 md:pt-0">
              <ActivityList sessions={recentSessions} />
            </CardContent>
          </Card>
        </motion.div>
      </div>

      <motion.section variants={cardMotion} transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}>
        <Card className="premium-panel overflow-hidden border-0 bg-transparent">
          <CardContent className="grid gap-6 p-6 md:grid-cols-[0.9fr_1.1fr] md:p-8">
            <div className="space-y-4">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Sparkles size={20} />
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase text-primary">AI Coach</p>
                <h2 className="text-2xl font-semibold text-zinc-950 dark:text-white">Gợi ý học tập cá nhân</h2>
              </div>
              <p className="max-w-md text-sm leading-6 text-muted-foreground">
                Gemini phân tích dữ liệu ôn tập và đề xuất ưu tiên học tiếp theo.
              </p>
              <Button onClick={handleGetAiSuggestion} disabled={isGeneratingSuggestion} className="gap-2 bg-zinc-950 text-white hover:bg-zinc-800">
                {isGeneratingSuggestion ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles size={16} />}
                Phân tích ngay
              </Button>
            </div>

            <div className="rounded-lg border border-black/[0.07] bg-white/[0.62] p-5 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
              {aiSuggestion ? (
                <motion.p
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="whitespace-pre-line text-sm leading-7 text-zinc-700 dark:text-zinc-200"
                >
                  {aiSuggestion}
                </motion.p>
              ) : (
                <div className="flex h-full min-h-40 items-center justify-center text-center text-sm leading-6 text-muted-foreground">
                  Chưa có phân tích mới. Bấm phân tích để Gemini đề xuất lộ trình học tiếp theo.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </motion.section>
    </motion.div>
  );
}

function buildForecastShell() {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(new Date(), i);
    return {
      date: format(date, 'dd/MM'),
      fullDate: startOfDay(date),
      count: 0,
    };
  });
}

function StatTile({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  tone: 'blue' | 'amber' | 'emerald' | 'neutral';
}) {
  const toneClass = {
    blue: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
    amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    emerald: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    neutral: 'bg-zinc-950/[0.06] text-zinc-700 dark:bg-white/10 dark:text-white',
  }[tone];

  return (
    <div className="min-h-36 p-5">
      <div className={`mb-5 flex h-9 w-9 items-center justify-center rounded-lg ${toneClass}`}>
        {icon}
      </div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-3xl font-semibold text-zinc-950 dark:text-white">{value}</p>
    </div>
  );
}

function ForecastBars({ data }: { data: DayPoint[] }) {
  const max = Math.max(...data.map((item) => item.count), 1);

  return (
    <div className="space-y-5">
      <div className="flex h-40 items-end gap-2">
        {data.map((item, index) => {
          const height = Math.max((item.count / max) * 100, 8);
          return (
            <div key={item.date} className="group flex flex-1 flex-col items-center gap-2">
              <div className="flex h-32 w-full items-end rounded-lg bg-black/[0.035] p-1 dark:bg-white/[0.055]">
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: `${height}%` }}
                  transition={{ delay: index * 0.035, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                  className={`w-full rounded-md ${index === 0 ? 'bg-zinc-950 dark:bg-white' : 'bg-primary/60 group-hover:bg-primary'}`}
                />
              </div>
              <span className="font-mono text-[10px] font-medium text-muted-foreground">{item.date}</span>
            </div>
          );
        })}
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        {data.reduce((sum, item) => sum + item.count, 0)} thẻ dự kiến cần ôn trong 7 ngày tới.
      </p>
    </div>
  );
}

function RecentDecksList({ decks }: { decks: (Deck & { dueCount: number })[] }) {
  if (decks.length === 0) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-black/[0.08] bg-white/[0.45] text-center dark:border-white/10 dark:bg-white/[0.03]">
        <BookOpen className="mb-3 h-7 w-7 text-muted-foreground" />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Chưa có bộ thẻ</p>
        <Link to="/create-deck" className="mt-2 text-sm font-medium text-primary hover:text-zinc-950">
          Tạo bộ thẻ đầu tiên
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {decks.map((deck, index) => (
        <motion.div
          key={deck.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.04, duration: 0.32 }}
        >
          <Link
            to={`/decks/${deck.id}`}
            className="group flex items-center gap-4 rounded-lg border border-transparent p-3 transition-all hover:border-black/[0.07] hover:bg-white/70 hover:shadow-sm dark:hover:border-white/10 dark:hover:bg-white/[0.04]"
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-white transition-transform group-hover:scale-[1.03]">
              <BookOpen size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-semibold text-zinc-950 dark:text-white">{deck.name}</p>
                {deck.dueCount > 0 && (
                    <span className="rounded-full bg-amber-500/[0.12] px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                    {deck.dueCount} đến hạn
                  </span>
                )}
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {deck.cardCount} thẻ · {deck.category || 'Chưa phân loại'}
              </p>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
          </Link>
        </motion.div>
      ))}
    </div>
  );
}

function ActivityList({ sessions }: { sessions: StudySession[] }) {
  if (sessions.length === 0) {
    return (
      <div className="flex min-h-56 items-center justify-center rounded-lg border border-dashed border-black/[0.08] bg-white/[0.45] text-sm text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]">
        Chưa có hoạt động học gần đây.
      </div>
    );
  }

  return (
    <div className="divide-y divide-black/[0.06] overflow-hidden rounded-lg border border-black/[0.07] bg-white/48 dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
      {sessions.slice(0, 5).map((session, index) => (
        <motion.div
          key={session.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.04, duration: 0.32 }}
          className="flex items-center justify-between gap-4 p-4"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 size={17} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-zinc-900 dark:text-white">Đã học {session.cardsReviewed} thẻ</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {format(new Date(session.timestamp), 'dd/MM/yyyy · HH:mm', { locale: vi })}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-mono text-sm font-semibold text-zinc-900 dark:text-white">{Math.round(session.duration / 60)}m</p>
            <p className="text-[10px] text-muted-foreground">thời gian</p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function LearningHeatmap({ sessions, compact = false }: { sessions: StudySession[]; compact?: boolean }) {
  const days = compact ? 28 : 98;
  const today = new Date();
  const calendarDays = Array.from({ length: days }, (_, i) => {
    const date = subDays(today, days - 1 - i);
    const dateStr = format(date, 'yyyy-MM-dd');
    const sessionCount = sessions.filter((session) => format(new Date(session.timestamp), 'yyyy-MM-dd') === dateStr).length;
    return { dateStr, count: sessionCount };
  });

  return (
    <div className={`flex flex-wrap justify-end gap-1 ${compact ? 'max-w-40' : ''}`}>
      {calendarDays.map((day) => (
        <div
          key={day.dateStr}
          title={`${day.dateStr}: ${day.count} phiên`}
          className={`h-2.5 w-2.5 rounded-[3px] transition-transform hover:scale-125 ${
            day.count === 0
              ? 'bg-black/[0.08] dark:bg-white/10'
              : day.count === 1
                ? 'bg-primary/35'
                : day.count === 2
                ? 'bg-primary/[0.65]'
                  : 'bg-primary'
          }`}
        />
      ))}
    </div>
  );
}
