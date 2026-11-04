import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { User } from 'firebase/auth';
import { collection, doc, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { addDays, format, startOfDay, subDays } from 'date-fns';
import { vi } from 'date-fns/locale';
import { motion } from 'motion/react';
import {
  ArrowRight,
  Award,
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
import { suggestStudyPath } from '../services/aiService';
import { fetchMultipleDeckInsights, mergeForecastCounts } from '../lib/deckAnalytics';
import { buildSessionCountByDay } from '../lib/studySessions';
import { getXpProgress } from '../lib/gamification';

type ProfileWithProgress = UserProfile & { xp?: number; level?: number };

const DashboardChart = lazy(() => import('../components/charts/DashboardChart'));

interface DashboardProps {
  user: User | null;
  profile: UserProfile | null;
  recentSessions: StudySession[];
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

export default function Dashboard({ user, profile, recentSessions }: DashboardProps) {
  const userId = user?.uid;
  const [recentDecks, setRecentDecks] = useState<(Deck & { dueCount: number })[]>([]);
  const [totalDeckCount, setTotalDeckCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [isGeneratingSuggestion, setIsGeneratingSuggestion] = useState(false);
  const [forecastData, setForecastData] = useState<DayPoint[]>(() => buildForecastShell());
  const deckInsightsRequestRef = useRef(0);
  const hasAnimatedRef = useRef(false);

  const chartData = useMemo(() => {
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

    return last7Days;
  }, [recentSessions]);

  const sessionCountByDay = useMemo(
    () => buildSessionCountByDay(recentSessions),
    [recentSessions],
  );

  useEffect(() => {
    if (!userId || !profile?.lastStudyDate) return;

    const lastStudyDate = new Date(profile.lastStudyDate);
    const today = new Date();
    const lastDate = new Date(lastStudyDate.getFullYear(), lastStudyDate.getMonth(), lastStudyDate.getDate());
    const currentDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diffDays = Math.round((currentDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays > 1) {
      // Reset BOTH streak fields: the UI reads streakDays ?? streak, so
      // clearing only one of them leaves the broken streak on screen.
      updateDoc(doc(db, 'users', userId), { streak: 0, streakDays: 0 }).catch(() => undefined);
    }
  }, [profile?.lastStudyDate, profile?.streak, userId]);

  useEffect(() => {
    if (!userId) {
      setRecentDecks([]);
      setTotalDeckCount(0);
      setForecastData(buildForecastShell());
      setLoading(false);
      return;
    }

    setLoading(true);

    const decksQuery = query(collection(db, 'decks'), where('ownerId', '==', userId));
    const unsubscribeDecks = onSnapshot(
      decksQuery,
      async (snap) => {
        const requestId = deckInsightsRequestRef.current + 1;
        deckInsightsRequestRef.current = requestId;

        setTotalDeckCount(snap.size);
        const decksData = snap.docs.map((deckDoc) => ({ id: deckDoc.id, ...deckDoc.data() } as Deck));
        decksData.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        const topDecks = decksData.slice(0, 4);
        const forecastShell = buildForecastShell();
        const forecastDayKeys = new Set(forecastShell.map((day) => day.fullDate.getTime()));

        if (topDecks.length === 0) {
          setRecentDecks([]);
          setForecastData(forecastShell);
          setLoading(false);
          return;
        }

        try {
          const insightsByDeck = await fetchMultipleDeckInsights(
            topDecks.map((deck) => deck.id),
            forecastDayKeys,
          );

          if (deckInsightsRequestRef.current !== requestId) return;

          const decksWithDue = topDecks.map((deck) => ({
            ...deck,
            dueCount: insightsByDeck.get(deck.id)?.dueCount || 0,
          }));
          const forecastCounts = mergeForecastCounts(
            insightsByDeck.values(),
            forecastShell.map((day) => day.fullDate.getTime()),
          );

          setRecentDecks(decksWithDue);
          setForecastData(
            forecastShell.map((day, index) => ({
              ...day,
              count: forecastCounts[index] || 0,
            })),
          );
        } catch {
          if (deckInsightsRequestRef.current !== requestId) return;
          setRecentDecks(topDecks.map((deck) => ({ ...deck, dueCount: 0 })));
          setForecastData(forecastShell);
        } finally {
          if (deckInsightsRequestRef.current === requestId) {
            setLoading(false);
          }
        }
      },
      () => setLoading(false),
    );

    return () => {
      unsubscribeDecks();
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
  const dueToday = recentDecks.reduce((sum, deck) => sum + deck.dueCount, 0);
  const streakDays = profile?.streakDays ?? profile?.streak ?? 0;
  const cardsReviewed = profile?.totalCardsReviewed ?? profile?.totalCardsLearned ?? 0;
  const xpProgress = getXpProgress((profile as ProfileWithProgress | null)?.xp ?? 0);
  // "Study time" comes from real session data (sum of StudySession.duration
  // in seconds across the loaded recent sessions), not the profile counter
  // that never increased. Fall back to the profile value only when it is a
  // real positive number; otherwise show a dash instead of a wrong 0.
  const sessionStudyMinutes = useMemo(
    () =>
      recentSessions.reduce((sum, session) => {
        const duration = typeof session.duration === 'number' && Number.isFinite(session.duration) ? session.duration : 0;
        return sum + duration;
      }, 0) / 60,
    [recentSessions],
  );
  const profileStudyMinutes = profile?.totalStudyTimeMinutes ?? 0;
  const studyTimeLabel = sessionStudyMinutes > 0
    ? `${Math.round(sessionStudyMinutes)} phút`
    : profileStudyMinutes > 0
      ? `${Math.round(profileStudyMinutes)} phút`
      : '—';
  const milestoneItems = [
    { label: '100 thẻ đầu tiên', done: cardsReviewed >= 100, value: Math.min(cardsReviewed, 100), target: 100 },
    { label: '500 thẻ đầu tiên', done: cardsReviewed >= 500, value: Math.min(cardsReviewed, 500), target: 500 },
    { label: 'Chuỗi 7 ngày', done: streakDays >= 7, value: Math.min(streakDays, 7), target: 7 },
    { label: 'Chuỗi 30 ngày', done: streakDays >= 30, value: Math.min(streakDays, 30), target: 30 },
  ];

  // Welcome banner: greeting follows the local time of day; the CTA jumps
  // straight into the first deck that still has due cards when one is known.
  const greetingHour = new Date().getHours();
  const greetingLabel = greetingHour < 12 ? 'Chào buổi sáng' : greetingHour < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';
  const greetingName = profile?.displayName || 'bạn';
  const firstDueDeck = recentDecks.find((deck) => deck.dueCount > 0);
  const studyNowTarget = firstDueDeck ? `/study/${firstDueDeck.id}` : '/decks';

  const handleGetAiSuggestion = async () => {
    if (!profile) return;
    setIsGeneratingSuggestion(true);
    try {
      const suggestion = await suggestStudyPath(
        {
          totalCardsLearned: cardsReviewed,
          streak: streakDays,
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
      <div className="space-y-6" aria-label="Đang tải dữ liệu học tập">
        <div className="skeleton-block h-64 w-full" />
        <div className="grid gap-6 xl:grid-cols-[1.45fr_0.85fr]">
          <div className="skeleton-block h-[340px] w-full" />
          <div className="skeleton-block h-[340px] w-full" />
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="skeleton-block h-56 w-full" />
          <div className="skeleton-block h-56 w-full" />
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={hasAnimatedRef.current ? false : 'initial'}
      animate="animate"
      onAnimationComplete={() => {
        hasAnimatedRef.current = true;
      }}
      transition={{ staggerChildren: 0.045 }}
      className="space-y-6"
    >
      <motion.section
        variants={cardMotion}
        transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
        className="relative overflow-hidden rounded-2xl text-white shadow-xl shadow-emerald-600/25"
      >
        <img
          src="/img/bg-study.webp"
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-600/85 via-emerald-500/75 to-teal-500/85" />
        <div className="relative flex items-center gap-6 p-6 md:p-8">
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-bold md:text-3xl">
              {greetingLabel}, {greetingName}!
            </h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-white/85">
              {dueToday > 0
                ? `Hôm nay bạn có ${dueToday} thẻ đến hạn. Ôn ngay khi trí nhớ còn tươi nhé!`
                : 'Bạn đang giữ nhịp học rất tốt. Bắt đầu một phiên học mới nào!'}
            </p>
            <Link to={studyNowTarget} className="mt-5 inline-block">
              <Button className="btn-press h-11 gap-2 bg-white px-5 font-semibold text-emerald-700 shadow-lg shadow-emerald-900/20 hover:bg-emerald-50">
                Học ngay
                <ArrowRight size={16} />
              </Button>
            </Link>
          </div>
          <img
            src="/img/login-hero.webp"
            alt=""
            aria-hidden="true"
            loading="lazy"
            className="hidden w-52 shrink-0 rounded-2xl object-cover shadow-lg shadow-emerald-900/25 ring-1 ring-white/30 md:block lg:w-64"
          />
        </div>
      </motion.section>

      <motion.section
        variants={cardMotion}
        transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
        className="study-hero premium-panel overflow-hidden rounded-lg"
      >
        <div className="grid gap-0 lg:grid-cols-[1.35fr_0.65fr]">
          <div className="border-b border-black/[0.07] p-6 dark:border-white/10 md:p-8 lg:border-b-0 lg:border-r">
            <div className="mb-8 flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-black/[0.08] bg-white/70 px-3 py-1 text-xs font-medium text-zinc-600 shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Gemini 2.5 Flash đang hoạt động
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
                    className="xp-gradient h-full rounded-full"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <Link to="/create-deck">
                  <Button className="btn-press h-10 gap-2 px-4">
                    <Plus size={16} />
                    Tạo thẻ
                  </Button>
                </Link>
                <Link to="/assessment">
                  <Button variant="outline" className="btn-press h-10 gap-2 bg-white/70 px-4">
                    <BrainCircuit size={16} />
                    Luyện đề
                  </Button>
                </Link>
              </div>
            </div>
          </div>

          <div className="stagger-children grid grid-cols-2 divide-x divide-y divide-black/[0.07] dark:divide-white/10">
            <StatTile label="Đến hạn" value={dueToday} icon={<Target size={18} />} tone="blue" />
            <StatTile label="Chuỗi ngày học" value={streakDays} icon={<Flame size={18} />} tone="amber" />
            <StatTile label="Bộ thẻ" value={totalDeckCount} icon={<Layers3 size={18} />} tone="neutral" />
            <StatTile label="Đã học" value={cardsReviewed} icon={<CheckCircle2 size={18} />} tone="emerald" />
          </div>
        </div>
      </motion.section>

      <motion.section
        variants={cardMotion}
        transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
        className="premium-panel flex flex-col gap-4 p-5 md:flex-row md:items-center md:gap-8"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            <Sparkles size={19} />
          </div>
          <div>
            <p className="text-sm font-semibold text-zinc-950 dark:text-white">Cấp {xpProgress.level}</p>
            <p className="text-xs text-muted-foreground">{xpProgress.xp} XP tích lũy</p>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center justify-between gap-4">
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
              Còn {Math.max(0, xpProgress.xpForNextLevel - xpProgress.xpIntoLevel)} XP để lên cấp {xpProgress.level + 1}
            </p>
            <p className="font-mono text-xs font-semibold text-muted-foreground">
              {xpProgress.xpIntoLevel}/{xpProgress.xpForNextLevel} XP
            </p>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.round(xpProgress.progress * 100)}%` }}
              transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
              className="xp-gradient h-full rounded-full"
            />
          </div>
        </div>
        <div className="flex items-center gap-3 md:border-l md:border-black/[0.07] md:pl-8 dark:md:border-white/10">
          <Clock className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold text-zinc-950 dark:text-white">{studyTimeLabel}</p>
            <p className="text-xs text-muted-foreground">Thời gian học (các phiên gần đây)</p>
          </div>
        </div>
      </motion.section>

      <div className="grid gap-6 xl:grid-cols-[1.45fr_0.85fr]">
        <motion.div variants={cardMotion} transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}>
          <Card className="premium-panel overflow-hidden border-0 bg-transparent">
            <CardHeader className="flex flex-row items-start justify-between gap-4 p-6 pb-0">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase text-primary">Thống kê</p>
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
                  <p className="mb-2 text-xs font-semibold uppercase text-amber-700 dark:text-amber-300">Dự báo</p>
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

      <motion.section variants={cardMotion} transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}>
        <Card className="premium-panel overflow-hidden border-0 bg-transparent">
          <CardContent className="grid gap-6 p-6 xl:grid-cols-[1.15fr_0.85fr]">
            <div>
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase text-primary">Bản đồ học tập</p>
                  <h2 className="text-xl font-semibold text-zinc-950 dark:text-white">Heatmap 90 ngày gần nhất</h2>
                </div>
                <div className="achievement-badge">
                  <Flame size={14} />
                  {streakDays} ngày
                </div>
              </div>
              <LearningHeatmap sessionCountByDay={sessionCountByDay} />
            </div>
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Cột mốc</p>
              {milestoneItems.map((item) => {
                const progress = Math.min(100, (item.value / item.target) * 100);
                return (
                  <div key={item.label} className="workflow-step p-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Award className={item.done ? 'h-4 w-4 text-emerald-600' : 'h-4 w-4 text-muted-foreground'} />
                        <p className="text-sm font-semibold text-zinc-950 dark:text-white">{item.label}</p>
                      </div>
                      <span className={item.done ? 'achievement-badge' : 'text-xs font-semibold text-muted-foreground'}>
                        {item.done ? 'Đạt' : `${item.value}/${item.target}`}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }}
                        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                        className="xp-gradient h-full rounded-full"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </motion.section>

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <motion.div variants={cardMotion} transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}>
          <Card className="premium-panel h-full border-0 bg-transparent">
            <CardHeader className="flex flex-row items-start justify-between gap-4 p-6 pb-3">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase text-emerald-700 dark:text-emerald-300">Tập trung</p>
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
                <p className="mb-2 text-xs font-semibold uppercase text-zinc-500">Dòng thời gian</p>
                <CardTitle className="text-xl font-semibold">Hoạt động học</CardTitle>
              </div>
              <div className="hidden items-center gap-1 sm:flex">
                <LearningHeatmap sessionCountByDay={sessionCountByDay} compact />
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
                <p className="mb-2 text-xs font-semibold uppercase text-primary">Huấn luyện viên AI</p>
                <h2 className="text-2xl font-semibold text-zinc-950 dark:text-white">Gợi ý học tập cá nhân</h2>
              </div>
              <p className="max-w-md text-sm leading-6 text-muted-foreground">
                Gemini phân tích dữ liệu ôn tập và đề xuất ưu tiên học tiếp theo.
              </p>
              <Button onClick={handleGetAiSuggestion} disabled={isGeneratingSuggestion} className="btn-press gap-2 bg-zinc-950 text-white hover:bg-zinc-800">
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
    blue: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    emerald: 'bg-teal-500/10 text-teal-700 dark:text-teal-300',
    neutral: 'bg-zinc-950/[0.06] text-zinc-700 dark:bg-white/10 dark:text-white',
  }[tone];

  return (
    <div className="stat-tile card-hover">
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

function LearningHeatmap({
  sessionCountByDay,
  compact = false,
}: {
  sessionCountByDay: Map<string, number>;
  compact?: boolean;
}) {
  const days = compact ? 28 : 90;
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const calendarDays = useMemo(
    () => {
      const today = new Date();
      return Array.from({ length: days }, (_, i) => {
        const date = subDays(today, days - 1 - i);
        const dateStr = format(date, 'yyyy-MM-dd');
        return { dateStr, count: sessionCountByDay.get(dateStr) || 0 };
      });
    },
    [days, sessionCountByDay, todayKey],
  );

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
                ? 'bg-emerald-400/35'
                : day.count === 2
                ? 'bg-emerald-500/[0.65]'
                  : 'bg-emerald-600'
          }`}
        />
      ))}
    </div>
  );
}
