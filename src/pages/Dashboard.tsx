import { useState, useEffect } from 'react';
import { collection, query, where, limit, orderBy, onSnapshot, updateDoc, doc, getDocs } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { User } from 'firebase/auth';
import { UserProfile, Deck, StudySession, ExamResult } from '../types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { 
  Trophy, 
  Flame, 
  Calendar, 
  ArrowRight, 
  Clock,
  BookOpen,
  CheckCircle2,
  Sparkles,
  Loader2,
  BrainCircuit,
  FileText,
  TrendingUp,
  BarChart3,
  Zap,
  Target
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { format, subDays, startOfDay, addDays } from 'date-fns';
import { vi } from 'date-fns/locale';
import { motion } from 'motion/react';
import { lazy, Suspense } from 'react';

const DashboardChart = lazy(() => import('../components/charts/DashboardChart'));

import { suggestStudyPath } from '../services/aiService';
import { calculateLevel, calculateLevelProgress, ACHIEVEMENTS } from '../lib/gamification';

interface DashboardProps {
  user: User | null;
  profile: UserProfile | null;
}

export default function Dashboard({ user, profile }: DashboardProps) {
  const [recentDecks, setRecentDecks] = useState<(Deck & { dueCount: number })[]>([]);
  const [totalDeckCount, setTotalDeckCount] = useState(0);
  const [recentSessions, setRecentSessions] = useState<StudySession[]>([]);
  const [recentExams, setRecentExams] = useState<ExamResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [isGeneratingSuggestion, setIsGeneratingSuggestion] = useState(false);
  const [chartData, setChartData] = useState<any[]>([]);
  const [forecastData, setForecastData] = useState<any[]>([]);

  useEffect(() => {
    // Process session data for chart
    if (recentSessions.length > 0) {
      const last7Days = Array.from({ length: 7 }, (_, i) => {
        const date = subDays(new Date(), i);
        return {
          date: format(date, 'dd/MM'),
          fullDate: startOfDay(date),
          count: 0
        };
      }).reverse();

      recentSessions.forEach(session => {
        const sessionDate = startOfDay(new Date(session.timestamp));
        const dayMatch = last7Days.find(d => d.fullDate.getTime() === sessionDate.getTime());
        if (dayMatch) {
          dayMatch.count += session.cardsReviewed;
        }
      });

      setChartData(last7Days);
    }
  }, [recentSessions]);

  useEffect(() => {
    if (!user || recentDecks.length === 0) return;

    const calculateForecast = async () => {
      try {
        const next7Days = Array.from({ length: 7 }, (_, i) => {
          const date = addDays(new Date(), i);
          return {
            date: format(date, 'dd/MM'),
            fullDate: startOfDay(date),
            count: 0
          };
        });

        // Simplified for dashboard: fetch all cards from recent decks or a sample
        // For real logic, we'd query all due dates across all decks
        for (const deck of recentDecks) {
          const cardsSnap = await getDocs(collection(db, `decks/${deck.id}/cards`));
          cardsSnap.docs.forEach(doc => {
            const data = doc.data();
            if (data.nextReview) {
              const reviewDate = startOfDay(new Date(data.nextReview));
              const dayMatch = next7Days.find(d => d.fullDate.getTime() === reviewDate.getTime());
              if (dayMatch) dayMatch.count++;
            }
          });
        }
        setForecastData(next7Days);
      } catch (error) {
        // Forecast error ignored for brevity
      }
    };

    calculateForecast();
  }, [user]);

  useEffect(() => {
    if (!user) return;
    
    setLoading(true);
    
    // Streak reset logic
    if (profile) {
      const checkStreak = async () => {
        const lastStudyStr = profile.lastStudyDate;
        if (!lastStudyStr) return;
        
        const lastStudyDate = new Date(lastStudyStr);
        const today = new Date();
        
        const lastDate = new Date(lastStudyDate.getFullYear(), lastStudyDate.getMonth(), lastStudyDate.getDate());
        const currentDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        
        const diffTime = currentDate.getTime() - lastDate.getTime();
        const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
        
        if (diffDays > 1 && profile.streak > 0) {
          try {
            await updateDoc(doc(db, 'users', user.uid), {
              streak: 0
            });
          } catch (error) {
            // Streak reset error ignored
          }
        }
      };
      checkStreak();
    }
    
    // Fetch recent decks with onSnapshot
    const decksQuery = query(
      collection(db, 'decks'),
      where('ownerId', '==', user.uid)
    );

    const unsubscribeDecks = onSnapshot(decksQuery, async (snap) => {
      setTotalDeckCount(snap.size);
      const decksData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Deck));
      
      // Sort and fetch due counts for the top ones
      decksData.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
      const topDecks = decksData.slice(0, 3);
      const decksWithDue = await Promise.all(topDecks.map(async (deck) => {
        const cardsSnap = await getDocs(query(
          collection(db, `decks/${deck.id}/cards`),
          where('nextReview', '<=', new Date().toISOString())
        ));
        return { ...deck, dueCount: cardsSnap.size };
      }));

      setRecentDecks(decksWithDue);
      setLoading(false);
    }, () => {
      // Error fetching decks ignored
    });

    // Fetch recent sessions
    const sessionsQuery = query(
      collection(db, `users/${user.uid}/sessions`),
      limit(200) // Increased for heatmap
    );

    const unsubscribeSessions = onSnapshot(sessionsQuery, (snap) => {
      const sessionsData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as StudySession));
      sessionsData.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setRecentSessions(sessionsData); // Keep more sessions for heatmap
    }, () => {
      // Error fetching sessions ignored
    });

    return () => {
      unsubscribeDecks();
      unsubscribeSessions();
    };
  }, [user]);

  const handleGetAiSuggestion = async () => {
    if (!profile) return;
    setIsGeneratingSuggestion(true);
    try {
      const suggestion = await suggestStudyPath({
        totalCardsLearned: profile.totalCardsLearned,
        streak: profile.streak,
        recentSessions: recentSessions.length
      }, { geminiApiKey: profile.settings?.geminiApiKey || profile.settings?.aiApiKey });
      setAiSuggestion(suggestion);
    } catch (error) {
      console.error(error);
    } finally {
      setIsGeneratingSuggestion(false);
    }
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6">
      <div className="relative">
        <div className="h-16 w-16 rounded-full border-4 border-primary/10 border-t-primary animate-spin" />
        <BrainCircuit className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-primary/50" size={24} />
      </div>
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] animate-pulse">Đang tải dữ liệu...</p>
    </div>
  );

  const cardsToday = recentSessions
    .filter(session => {
      const sessionDate = startOfDay(new Date(session.timestamp));
      const today = startOfDay(new Date());
      return sessionDate.getTime() === today.getTime();
    })
    .reduce((sum, session) => sum + session.cardsReviewed, 0);

  const dailyProgress = profile ? Math.min((cardsToday / profile.settings.dailyGoal) * 100, 100) : 0;
  const rawProgress = profile ? (cardsToday / profile.settings.dailyGoal) * 100 : 0;
  const userLevel = calculateLevel(profile?.xp || 0);
  const levelProgress = calculateLevelProgress(profile?.xp || 0);

  return (
    <div className="max-w-6xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-8 duration-700 font-sans pt-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-slate-200 dark:border-white/5 pb-8">
        <div className="space-y-4">
          <div className="space-y-1">
            <h1 className="text-4xl md:text-6xl font-black text-slate-900 dark:text-white tracking-tighter">Dashboard</h1>
            <p className="text-slate-500 dark:text-slate-400 text-lg md:text-xl font-medium">Chào mừng trở lại, <span className="text-primary font-bold">{profile?.displayName}</span>.</p>
          </div>
          
          {/* Level Progress Bar */}
          <div className="flex flex-col gap-2 max-w-md w-full">
            <div className="flex justify-between items-end">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-black text-xs shadow-lg shadow-indigo-500/20">
                  {userLevel}
                </div>
                <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">CẤP ĐỘ HIỆN TẠI</span>
              </div>
              <span className="text-[10px] font-black text-slate-400 font-mono tracking-widest">{Math.round(levelProgress)}% EXP</span>
            </div>
            <div className="h-2 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${levelProgress}%` }}
                className="h-full bg-gradient-to-r from-indigo-600 to-primary shadow-[0_0_15px_rgba(94,106,210,0.4)]"
              />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-col items-start md:items-end">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] mb-1">Học tập liên tục</span>
            <div className="flex items-center gap-3 px-5 py-2 bg-orange-500/10 text-orange-500 rounded-2xl border border-orange-500/20 shadow-lg shadow-orange-500/5">
              <Flame size={20} fill="currentColor" />
              <span className="text-2xl font-black font-mono tracking-tighter">{profile?.streak || 0}</span>
            </div>
          </div>
          <div className="w-px h-12 bg-slate-200 dark:bg-white/10 mx-2" />
          <div className="flex flex-col items-end">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] mb-1">Tổng số thẻ</span>
            <div className="flex items-center gap-3 px-5 py-2 bg-primary/10 text-primary rounded-2xl border border-primary/20 shadow-lg shadow-primary/5">
              <Trophy size={20} />
              <span className="text-2xl font-black font-mono tracking-tighter">{profile?.totalCardsLearned || 0}</span>
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
        {/* Analytics Card - Bento Style */}
        <div className="md:col-span-8 flex flex-col gap-8">
          <Card className="overflow-hidden border border-slate-200 dark:border-white/5 shadow-2xl bg-white dark:bg-[#0C0D0E] rounded-[3rem]">
            <CardHeader className="p-10 pb-2">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <span className="text-[10px] font-black text-primary uppercase tracking-[0.3em]">Phân tích học tập</span>
                  <CardTitle className="text-3xl font-black tracking-tight">Xu hướng 7 ngày</CardTitle>
                </div>
                <div className="h-12 w-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
                  <TrendingUp size={24} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0 pt-4 h-[400px] w-full overflow-hidden flex flex-col items-center justify-center">
              <Suspense fallback={<div className="h-full w-full flex items-center justify-center animate-pulse bg-slate-100 dark:bg-white/5 rounded-2xl" />}>
                <DashboardChart data={chartData} />
              </Suspense>
            </CardContent>
          </Card>

          {/* Heatmap Card */}
          <Card className="border border-slate-200 dark:border-white/5 shadow-2xl bg-white dark:bg-[#0C0D0E] rounded-[3rem] p-10">
            <div className="flex items-center justify-between mb-8">
              <div className="space-y-1">
                <span className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.3em]">Consistency</span>
                <h3 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Lịch sử học tập</h3>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Ít</span>
                <div className="flex gap-1">
                  <div className="w-3 h-3 rounded-sm bg-slate-100 dark:bg-white/5" />
                  <div className="w-3 h-3 rounded-sm bg-primary/30" />
                  <div className="w-3 h-3 rounded-sm bg-primary/60" />
                  <div className="w-3 h-3 rounded-sm bg-primary" />
                </div>
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Nhiều</span>
              </div>
            </div>
            <LearningHeatmap sessions={recentSessions} />
          </Card>
        </div>

        {/* Quick Stats - Bento Style */}
        <div className="md:col-span-4 grid grid-cols-1 gap-8">
          {/* SR Forecast Card */}
          <Card className="border border-slate-200 dark:border-white/5 shadow-2xl bg-white dark:bg-[#0C0D0E] rounded-[3rem] p-8 flex flex-col gap-6 group hover:border-orange-500/30 transition-all">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <span className="text-[9px] font-black text-orange-500 uppercase tracking-[0.3em]">Theo dõi định kỳ</span>
                <p className="font-bold text-slate-800 dark:text-slate-200">Dự báo ôn tập</p>
              </div>
              <div className="h-10 w-10 rounded-xl bg-orange-500/10 text-orange-500 flex items-center justify-center">
                <Zap size={20} />
              </div>
            </div>
            
            <div className="flex-1 flex items-end gap-1 h-32">
              {forecastData.map((d, i) => {
                const max = Math.max(...forecastData.map(fd => fd.count), 1);
                const height = (d.count / max) * 100;
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-2 group/bar">
                    <div className="w-full relative flex items-end justify-center h-full">
                      <motion.div 
                        initial={{ height: 0 }}
                        animate={{ height: `${height || 5}%` }}
                        className={`w-full rounded-t-lg transition-all ${i === 0 ? 'bg-orange-500' : 'bg-slate-200 dark:bg-white/10 group-hover/bar:bg-orange-200'}`}
                      />
                    </div>
                    <span className="text-[8px] font-black text-slate-400 font-mono">{d.date}</span>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="border border-slate-200 dark:border-white/5 shadow-2xl bg-white dark:bg-[#0C0D0E] rounded-[3rem] p-8 flex flex-col justify-between group hover:border-emerald-500/30 transition-all relative overflow-hidden">
            <div className="absolute -top-10 -right-10 opacity-5 pointer-events-none group-hover:opacity-10 transition-opacity">
              <CheckCircle2 size={160} className="text-emerald-500" />
            </div>
            <div className="space-y-1 relative z-10">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Thành tích</span>
              <p className="text-xl font-bold text-slate-800 dark:text-slate-200">Thẻ đã học</p>
            </div>
            <div className="flex items-end justify-between mt-8 relative z-10">
              <span className="text-6xl font-black font-mono tracking-tighter text-slate-900 dark:text-white group-hover:text-emerald-500 transition-colors">{profile?.totalCardsLearned || 0}</span>
              <div className="h-16 w-16 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center shadow-inner group-hover:scale-110 transition-transform">
                <CheckCircle2 size={32} />
              </div>
            </div>
          </Card>
        </div>

        {/* AI Suggestion Card - Wide Bento */}
        <Card className="md:col-span-12 border border-slate-200 dark:border-white/5 shadow-2xl bg-white dark:bg-[#0C0D0E] overflow-hidden relative rounded-[3rem] min-h-[300px] flex flex-col justify-center group">
          <div className="absolute top-0 right-0 p-12 opacity-5 pointer-events-none group-hover:opacity-10 transition-opacity duration-700">
            <BrainCircuit size={300} className="text-primary" />
          </div>
          <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_20%_30%,rgba(94,106,210,0.08),transparent_50%)] pointer-events-none" />
          
          <CardHeader className="relative z-10 p-6 md:p-12 pb-4 md:pb-6">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/10 border border-primary/20 rounded-full text-[9px] md:text-[10px] font-black uppercase tracking-[0.3em] text-primary mb-4 md:mb-6 shadow-sm">
              <Sparkles size={14} />
              AI Personal Assistant
            </div>
            <CardTitle className="text-3xl md:text-5xl lg:text-6xl font-black tracking-tighter leading-[0.9] max-w-3xl text-slate-900 dark:text-white">
              Lộ trình học tập <br/><span className="text-primary italic">cá nhân hóa</span> của bạn.
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 md:p-12 pt-0 relative z-10">
            {aiSuggestion ? (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="glass p-6 md:p-10 rounded-3xl md:rounded-[2.5rem] max-w-3xl shadow-2xl"
              >
                <p className="text-lg md:text-2xl leading-relaxed font-medium text-slate-700 dark:text-slate-200">{aiSuggestion}</p>
                <Button 
                  variant="link" 
                  onClick={() => setAiSuggestion(null)} 
                  className="text-primary p-0 h-auto mt-6 md:mt-8 text-[10px] md:text-xs font-black uppercase tracking-[0.2em] hover:text-slate-900 dark:hover:text-white transition-colors"
                >
                  Làm mới phân tích
                </Button>
              </motion.div>
            ) : (
              <div className="flex flex-col items-start">
                <p className="text-slate-500 dark:text-slate-400 mb-6 md:mb-10 max-w-lg text-base md:text-lg font-medium leading-relaxed">AI phân tích thói quen và tiến độ của bạn để tối ưu hóa thời gian học tập, giúp bạn đạt được mục tiêu nhanh hơn.</p>
                <Button 
                  onClick={handleGetAiSuggestion} 
                  disabled={isGeneratingSuggestion}
                  className="bg-primary hover:bg-primary/90 text-white font-black px-8 md:px-12 h-14 md:h-20 rounded-2xl md:rounded-[2rem] shadow-2xl shadow-primary/30 text-lg md:text-xl transition-all active:scale-[0.98] group"
                >
                  {isGeneratingSuggestion ? <Loader2 className="animate-spin mr-3 md:mr-4 w-5 h-5 md:w-7 md:h-7" /> : <Sparkles className="mr-3 md:mr-4 group-hover:animate-pulse w-5 h-5 md:w-7 md:h-7" />}
                  BẮT ĐẦU PHÂN TÍCH
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Daily Goal Card */}
        <Card className="md:col-span-6 overflow-hidden border border-slate-200 dark:border-white/5 shadow-2xl bg-white dark:bg-[#0C0D0E] rounded-3xl md:rounded-[3rem]">
          <CardHeader className="p-6 md:p-10 pb-4 md:pb-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <span className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Tiến độ hôm nay</span>
                <CardTitle className="text-2xl md:text-3xl font-black tracking-tight">Mục tiêu hàng ngày</CardTitle>
              </div>
              <div className="text-left sm:text-right">
                <span className="text-3xl md:text-5xl font-black text-slate-900 dark:text-white font-mono tracking-tighter">
                  {cardsToday}
                </span>
                <span className="text-base md:text-lg font-bold text-slate-400 ml-2">
                  / {profile?.settings.dailyGoal || 20}
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6 md:p-10 pt-2 md:pt-4 space-y-6 md:space-y-8">
            <div className="space-y-5">
              <div className="h-4 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden p-1 shadow-inner">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${dailyProgress}%` }}
                  transition={{ duration: 2, ease: "circOut" }}
                  className="h-full bg-primary rounded-full shadow-[0_0_20px_rgba(94,106,210,0.6)] relative"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                </motion.div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-slate-400 font-black uppercase tracking-[0.4em]">Hiệu suất học tập</span>
                <span className="text-sm font-mono font-black text-primary tracking-widest">{Math.round(rawProgress)}% COMPLETE</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quick Stats - Technical Style */}
        <div className="md:col-span-6 grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-8">
          <Card className="border border-slate-200 dark:border-white/5 shadow-2xl bg-white dark:bg-[#0C0D0E] rounded-3xl md:rounded-[3rem] p-6 md:p-10 flex flex-col justify-between group hover:border-primary/30 transition-all">
            <div className="space-y-1">
              <span className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Thư viện</span>
              <p className="text-sm md:text-base font-bold text-slate-600 dark:text-slate-400">Tổng số bộ thẻ</p>
            </div>
            <div className="flex items-end justify-between mt-4 md:mt-6">
              <span className="text-4xl md:text-6xl font-black font-mono tracking-tighter text-slate-900 dark:text-white group-hover:text-primary transition-colors">{totalDeckCount}</span>
              <div className="h-12 w-12 md:h-16 md:w-16 rounded-2xl md:rounded-[1.5rem] bg-primary/10 text-primary flex items-center justify-center shadow-inner group-hover:scale-110 transition-transform">
                <BookOpen className="w-6 h-6 md:w-8 md:h-8" />
              </div>
            </div>
          </Card>

          <Card className="border border-slate-200 dark:border-white/5 shadow-2xl bg-white dark:bg-[#0C0D0E] rounded-3xl md:rounded-[3rem] p-6 md:p-10 flex flex-col justify-between group hover:border-emerald-500/30 transition-all">
            <div className="space-y-1">
              <span className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Thành tích</span>
              <p className="text-sm md:text-base font-bold text-slate-600 dark:text-slate-400">Thẻ đã thuộc</p>
            </div>
            <div className="flex items-end justify-between mt-4 md:mt-6">
              <span className="text-4xl md:text-6xl font-black font-mono tracking-tighter text-slate-900 dark:text-white group-hover:text-emerald-500 transition-colors">{profile?.totalCardsLearned || 0}</span>
              <div className="h-12 w-12 md:h-16 md:w-16 rounded-2xl md:rounded-[1.5rem] bg-emerald-500/10 text-emerald-500 flex items-center justify-center shadow-inner group-hover:scale-110 transition-transform">
                <CheckCircle2 className="w-6 h-6 md:w-8 md:h-8" />
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* AI Assessment Highlights */}
      <section className="space-y-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-white/5 pb-6">
          <h2 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">Kiểm tra & Thi thử AI</h2>
          <Link to="/assessment" className="text-[10px] font-black text-primary hover:text-slate-900 dark:hover:text-white transition-colors flex items-center gap-2 uppercase tracking-[0.3em]">
            TRUY CẬP <ArrowRight size={14} />
          </Link>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Link to="/assessment" className="group">
            <Card className="h-full border-none shadow-xl hover:shadow-2xl transition-all duration-500 bg-gradient-to-br from-indigo-600 to-violet-700 text-white overflow-hidden rounded-[2.5rem] relative">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-3xl -mr-16 -mt-16 animate-pulse" />
              <CardContent className="p-8 space-y-6">
                <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center group-hover:scale-110 transition-transform duration-500">
                  <BrainCircuit size={28} />
                </div>
                <div className="space-y-1">
                  <h3 className="text-2xl font-black tracking-tight">Thi Theo Bộ Thẻ</h3>
                  <p className="text-indigo-100 text-sm font-medium">Đề thi sát nội dung bộ thẻ với dẫn chứng y khoa sâu.</p>
                </div>
                <div className="flex items-center gap-2 text-white font-black uppercase text-[10px] tracking-widest bg-white/10 py-2 px-4 rounded-full w-fit">
                  Bắt đầu ngay <ArrowRight size={14} />
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link to="/assessment" className="group">
            <Card className="h-full border-none shadow-xl hover:shadow-2xl transition-all duration-500 bg-slate-900 text-white overflow-hidden rounded-[2.5rem] relative border-2 border-transparent hover:border-primary/20">
              <div className="absolute bottom-0 left-0 w-32 h-32 bg-primary/20 rounded-full blur-3xl -ml-16 -mb-16" />
              <CardContent className="p-8 space-y-6">
                <div className="w-14 h-14 rounded-2xl bg-white/10 text-emerald-400 flex items-center justify-center group-hover:scale-110 transition-transform duration-500">
                  <Sparkles size={28} />
                </div>
                <div className="space-y-1">
                  <h3 className="text-2xl font-black tracking-tight">Thi Tổng Hợp</h3>
                  <p className="text-slate-400 text-sm font-medium">Thi theo chuyên khoa Nội, Ngoại, Sản, Nhi từ AI.</p>
                </div>
                <div className="flex items-center gap-2 text-primary font-black uppercase text-[10px] tracking-widest bg-white/5 py-2 px-4 rounded-full w-fit">
                  Khám phá ngay <ArrowRight size={14} />
                </div>
              </CardContent>
            </Card>
          </Link>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 pt-6">
        {/* Recent Decks - Grid Style */}
        <section className="lg:col-span-7 space-y-8">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-white/5 pb-6">
            <h2 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">Bộ thẻ gần đây</h2>
            <Link to="/decks" className="text-[10px] font-black text-primary hover:text-slate-900 dark:hover:text-white transition-colors flex items-center gap-2 uppercase tracking-[0.3em]">
              Xem tất cả <ArrowRight size={16} />
            </Link>
          </div>
          <div className="grid grid-gap-4 md:grid-gap-6">
            {recentDecks.length > 0 ? (
              recentDecks.map((deck, idx) => (
                <motion.div
                  key={deck.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.1 }}
                >
                  <Link to={`/decks/${deck.id}`}>
                    <div className="group flex items-center gap-4 md:gap-8 p-5 md:p-8 bg-white dark:bg-[#0C0D0E] border border-slate-200 dark:border-white/5 rounded-[2rem] md:rounded-[2.5rem] hover:border-primary/50 transition-all duration-500 hover:shadow-2xl hover:-translate-y-1">
                      <div className="h-14 w-14 md:h-20 md:w-20 rounded-2xl md:rounded-[1.5rem] bg-slate-50 dark:bg-white/5 flex items-center justify-center text-slate-400 group-hover:bg-primary group-hover:text-white transition-all duration-500 shadow-inner">
                        <BookOpen className="w-7 h-7 md:w-9 md:h-9" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-lg md:text-2xl font-black text-slate-900 dark:text-white group-hover:text-primary transition-colors tracking-tight truncate">{deck.name}</h3>
                          {deck.dueCount > 0 && (
                            <span className="flex-shrink-0 px-2 py-0.5 bg-orange-500 text-white text-[8px] font-black rounded-full animate-pulse">
                              {deck.dueCount} DUE
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 md:gap-4">
                          <span className="text-[9px] md:text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{deck.cardCount} cards</span>
                          <div className="w-1.5 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800" />
                          <span className="text-[9px] md:text-[10px] font-black text-primary uppercase tracking-[0.2em] truncate">{deck.category}</span>
                        </div>
                      </div>
                      <div className="flex-shrink-0">
                        {deck.dueCount > 0 ? (
                          <Button 
                            className="bg-orange-500 hover:bg-orange-600 text-white font-black text-[10px] h-10 md:h-12 px-6 rounded-2xl shadow-lg shadow-orange-200 dark:shadow-none transition-all active:scale-95"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              window.location.href = `/study/${deck.id}`;
                            }}
                          >
                            HỌC NGAY
                          </Button>
                        ) : (
                          <div className="h-10 w-10 md:h-12 md:w-12 rounded-full border border-slate-100 dark:border-white/5 flex items-center justify-center text-slate-300 dark:text-slate-700 group-hover:border-primary group-hover:text-primary transition-all duration-500">
                            <ArrowRight className="w-4.5 h-4.5 md:w-6 md:h-6" />
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                </motion.div>
              ))
            ) : (
              <div className="text-center py-24 bg-white dark:bg-[#0C0D0E] rounded-[3rem] border-2 border-dashed border-slate-200 dark:border-white/10">
                <div className="p-8 bg-slate-50 dark:bg-white/5 rounded-full inline-flex mb-6 text-slate-300 dark:text-slate-700">
                  <BookOpen size={64} />
                </div>
                <p className="text-slate-500 font-black uppercase tracking-[0.3em] text-sm">Chưa có bộ thẻ nào</p>
                <Link to="/create-deck">
                  <Button variant="link" className="text-primary font-black uppercase tracking-[0.2em] text-xs mt-4 hover:text-slate-900 dark:hover:text-white">Tạo bộ thẻ đầu tiên</Button>
                </Link>
              </div>
            )}
          </div>
        </section>

        {/* Recent Activity - Data Grid Style */}
        <section className="lg:col-span-5 space-y-12">
          <div className="space-y-8">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-white/5 pb-6">
              <h2 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">Hoạt động học</h2>
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Lịch sử ôn tập</span>
            </div>
            <div className="bg-white dark:bg-[#0C0D0E] border border-slate-200 dark:border-white/5 rounded-[3rem] overflow-hidden shadow-2xl">
              {recentSessions.length > 0 ? (
                <div className="divide-y divide-slate-100 dark:divide-white/5">
                  {recentSessions.slice(0, 5).map((session, idx) => (
                    <motion.div 
                      key={session.id} 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className="p-8 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-white/5 transition-all cursor-default group"
                    >
                      <div className="flex items-center gap-5">
                        <div className="h-14 w-14 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center shadow-inner group-hover:scale-110 transition-transform">
                          <CheckCircle2 size={24} />
                        </div>
                        <div>
                          <p className="text-lg font-black text-slate-900 dark:text-white tracking-tight">Đã học {session.cardsReviewed} thẻ</p>
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mt-1">
                            {format(new Date(session.timestamp), 'dd/MM/yyyy • HH:mm', { locale: vi })}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-xl font-mono font-black text-slate-900 dark:text-white tracking-tighter">{Math.round(session.duration / 60)}m</p>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-[0.3em]">Thời gian</p>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="py-20 text-center">
                  <p className="text-slate-500 font-black uppercase tracking-[0.3em] text-xs">Chưa có hoạt động</p>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function LearningHeatmap({ sessions }: { sessions: StudySession[] }) {
  const today = new Date();
  const days = 14 * 7; // ~3 months (14 weeks)
  const calendarDays = Array.from({ length: days }, (_, i) => {
    const date = subDays(today, days - 1 - i);
    const dateStr = format(date, 'yyyy-MM-dd');
    const sessionCount = sessions.filter(s => format(new Date(s.timestamp), 'yyyy-MM-dd') === dateStr).length;
    return { date, dateStr, count: sessionCount };
  });

  return (
    <div className="flex flex-wrap gap-2 justify-start">
      {calendarDays.map((day, i) => (
        <div
          key={i}
          title={`${day.dateStr}: ${day.count} sessions`}
          className={`w-4 h-4 md:w-5 md:h-5 rounded-md transition-all hover:scale-125 hover:shadow-md ${
            day.count === 0 ? 'bg-slate-100 dark:bg-white/5' :
            day.count === 1 ? 'bg-primary/30' :
            day.count === 2 ? 'bg-primary/60' : 'bg-primary shadow-[0_0_10px_rgba(94,106,210,0.4)]'
          }`}
        />
      ))}
    </div>
  );
}
