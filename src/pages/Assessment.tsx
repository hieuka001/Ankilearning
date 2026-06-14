import { useState, useEffect, useRef } from 'react';
import { collection, query, where, limit, getDocs, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Deck, Flashcard, UserProfile } from '../types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { 
  BrainCircuit, 
  CheckCircle2, 
  XCircle, 
  ArrowRight, 
  RotateCcw,
  Trophy,
  Timer,
  Sparkles,
  FileText,
  ChevronRight,
  ChevronLeft,
  Check,
  X,
  Info,
  Library
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import { playSound } from '../lib/sounds';
import { useSettings } from '../contexts/SettingsContext';
import { generateExam, generateGeneralExam } from '../services/aiService';
import { trackQuizCompletion } from '../services/gamificationService';
import SpeechButton from '../components/SpeechButton';
import { lazy, Suspense } from 'react';

const AssessmentResultChart = lazy(() => import('../components/charts/AssessmentResultChart'));

import { User } from 'firebase/auth';

interface AssessmentProps {
  user: User | null;
  profile: UserProfile | null;
}

interface AIQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
  imageUrl?: string;
  imageAlt?: string;
}

export default function Assessment({ user, profile }: AssessmentProps) {
  const { settings } = useSettings();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [selectedDeckIds, setSelectedDeckIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [isStarted, setIsStarted] = useState(false);
  const [mode, setMode] = useState<'self' | 'ai' | 'general'>('self');
  const [generalSpecialty, setGeneralSpecialty] = useState<string>('all');
  const [difficulty, setDifficulty] = useState<string>('basic');
  
  // Self Assessment State
  const [testCards, setTestCards] = useState<Flashcard[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  
  // AI Exam State
  const [aiQuestions, setAiQuestions] = useState<AIQuestion[]>([]);
  const [userAnswers, setUserAnswers] = useState<(number | null)[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [questionCount, setQuestionCount] = useState(10);
  const [isPressureMode, setIsPressureMode] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const [flaggedQuestions, setFlaggedQuestions] = useState<number[]>([]);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const elapsedIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const aiQuestionsRef = useRef<AIQuestion[]>([]);
  const userAnswersRef = useRef<(number | null)[]>([]);
  const startTimeRef = useRef(0);
  const quizLoggedRef = useRef(false);
  
  const [score, setScore] = useState(0);
  const [isFinished, setIsFinished] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showReview, setShowReview] = useState(false);

  useEffect(() => {
    aiQuestionsRef.current = aiQuestions;
  }, [aiQuestions]);

  useEffect(() => {
    userAnswersRef.current = userAnswers;
  }, [userAnswers]);

  const clearTimers = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    if (elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
  };

  const startSessionClock = () => {
    if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current);
    const now = Date.now();
    startTimeRef.current = now;
    setElapsedSeconds(0);
    elapsedIntervalRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
  };

  const handleReset = () => {
    clearTimers();
    setIsStarted(false);
    setIsFinished(false);
    setShowReview(false);
    setCurrentIndex(0);
    setScore(0);
    setAiQuestions([]);
    setTestCards([]);
    setUserAnswers([]);
    aiQuestionsRef.current = [];
    userAnswersRef.current = [];
    quizLoggedRef.current = false;
  };

  const handleRetest = () => {
    if (mode === 'self') {
      startSelfTest();
    } else if (mode === 'ai') {
      startAIExam();
    } else {
      startGeneralExam();
    }
  };

  useEffect(() => {
    if (!user) return;
    
    setLoading(true);
    const q = query(collection(db, 'decks'), where('ownerId', '==', user.uid));
    
    const unsubscribe = onSnapshot(q, (snap) => {
      const fetchedDecks = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Deck));
      setDecks(fetchedDecks);
      setLoading(false);
    }, (error) => {
      console.error(error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user]);

  const toggleDeckSelection = (deckId: string) => {
    setSelectedDeckIds(prev => 
      prev.includes(deckId) 
        ? prev.filter(id => id !== deckId) 
        : [...prev, deckId]
    );
  };

  const startSelfTest = async () => {
    if (selectedDeckIds.length === 0) {
      toast.error("Vui lòng chọn ít nhất một bộ thẻ!");
      return;
    }

    setLoading(true);
    try {
      let allCards: Flashcard[] = [];
      for (const deckId of selectedDeckIds) {
        const q = query(collection(db, `decks/${deckId}/cards`));
        const snap = await getDocs(q);
        allCards = [...allCards, ...snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Flashcard))];
      }

      if (allCards.length === 0) {
        toast.error("Không có thẻ nào để kiểm tra!");
        return;
      }

      const shuffled = [...allCards].sort(() => Math.random() - 0.5);
      setTestCards(shuffled.slice(0, 50)); // Limit to 50 for performance, but much more than 20
      setMode('self');
      setIsStarted(true);
      setCurrentIndex(0);
      setScore(0);
      setIsFinished(false);
      setShowReview(false);
      quizLoggedRef.current = false;
      startSessionClock();
    } catch (error) {
      console.error(error);
      toast.error("Lỗi khi tải thẻ kiểm tra.");
    } finally {
      setLoading(false);
    }
  };

  const startAIExam = async () => {
    if (selectedDeckIds.length === 0) {
      toast.error("Vui lòng chọn ít nhất một bộ thẻ!");
      return;
    }

    setIsGenerating(true);
    try {
      let allCards: Flashcard[] = [];
      let allContext = "";
      let deckInfoString = "";
      
      for (const deckId of selectedDeckIds) {
        // Fetch cards
        const q = query(collection(db, `decks/${deckId}/cards`));
        const snap = await getDocs(q);
        allCards = [...allCards, ...snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Flashcard))];
        
        // Fetch deck mindmap/notes
        const deckDoc = await getDoc(doc(db, 'decks', deckId));
        if (deckDoc.exists()) {
          const deckData = deckDoc.data();
          deckInfoString += `${deckData.name}${deckData.description ? ` (${deckData.description})` : ""}; `;
          if (deckData.mindmap) {
            allContext += `\n--- Ghi chú từ bộ thẻ: ${deckData.name} ---\n${deckData.mindmap}\n`;
          }
        }
      }

      if (allCards.length === 0 && !allContext.trim()) {
        toast.error("Không có dữ liệu (thẻ hoặc ghi chú) để tạo đề thi!");
        return;
      }

      const questions = await generateExam(
        allCards, 
        questionCount, 
        { geminiApiKey: profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey }, 
        allContext.trim(),
        { name: deckInfoString.trim() },
        difficulty
      );
      
      if (questions.length === 0) {
        throw new Error("AI không thể tạo đề thi lúc này. Hãy thử lại hoặc kiểm tra API Key.");
      }

      const emptyAnswers = new Array(questions.length).fill(null);
      aiQuestionsRef.current = questions;
      userAnswersRef.current = emptyAnswers;
      setAiQuestions(questions);
      setUserAnswers(emptyAnswers);
      setMode('ai');
      setIsStarted(true);
      setCurrentIndex(0);
      setScore(0);
      setIsFinished(false);
      setShowReview(false);
      quizLoggedRef.current = false;
      startSessionClock();
      setFlaggedQuestions([]);
      if (isPressureMode) {
        const timeLimit = questionCount * 60; // 1 minute per question
        setTimeLeft(timeLimit);
        startTimer();
      }
    } catch (error: any) {
      console.error("General Exam Generation Error:", error);
      toast.error(`Lỗi khi tạo đề thi: ${error.message || "Không xác định"}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const startGeneralExam = async () => {
    setIsGenerating(true);
    try {
      const questions = await generateGeneralExam(
        generalSpecialty,
        questionCount,
        { geminiApiKey: profile?.settings?.geminiApiKey || profile?.settings?.aiApiKey },
        difficulty
      );

      if (!questions || questions.length === 0) {
        throw new Error("AI không thể tạo danh sách câu hỏi. Vui lòng kiểm tra lại API Key hoặc thử mức độ/chuyên khoa khác.");
      }

      const emptyAnswers = new Array(questions.length).fill(null);
      aiQuestionsRef.current = questions;
      userAnswersRef.current = emptyAnswers;
      setAiQuestions(questions);
      setUserAnswers(emptyAnswers);
      setMode('general');
      setIsStarted(true);
      setCurrentIndex(0);
      setScore(0);
      setIsFinished(false);
      setShowReview(false);
      quizLoggedRef.current = false;
      startSessionClock();
      setFlaggedQuestions([]);
      if (isPressureMode) {
        const timeLimit = questionCount * 60;
        setTimeLeft(timeLimit);
        startTimer();
      }
    } catch (error: any) {
      console.error("General Exam Generation Error:", error);
      toast.error(error.message || "Lỗi khi tạo đề thi tổng hợp.");
    } finally {
      setIsGenerating(false);
    }
  };

  const recordQuizCompletion = async (finalScore: number, totalQuestions: number, finalDuration: number) => {
    if (!user || quizLoggedRef.current || totalQuestions <= 0) return;
    quizLoggedRef.current = true;

    try {
      const result = await trackQuizCompletion(user.uid, {
        score: finalScore,
        totalQuestions,
        durationSeconds: finalDuration,
        mode,
        deckIds: selectedDeckIds,
      });

      if (result.awardedExp > 0) {
        toast.success(`+${result.awardedExp} EXP đã được ghi nhận.`);
      }
    } catch (error) {
      quizLoggedRef.current = false;
      console.warn('Quiz gamification tracking failed.', error);
      toast.error('Chưa đồng bộ được EXP bài kiểm tra. Vui lòng thử lại sau.');
    }
  };

  const handleSelfAnswer = async (correct: boolean) => {
    let newScore = score;
    if (correct) {
      newScore = score + 1;
      setScore(newScore);
      playSound('correct', settings.volume);
    } else {
      playSound('wrong', settings.volume);
    }
    
    if (currentIndex < testCards.length - 1) {
      setCurrentIndex(currentIndex + 1);
      setShowAnswer(false);
    } else {
      const finalDuration = Math.floor((Date.now() - startTimeRef.current) / 1000);
      clearTimers();
      setDuration(finalDuration);
      setIsFinished(true);
      void recordQuizCompletion(newScore, testCards.length, finalDuration);
    }
  };

  const handleAIAnswer = (optionIdx: number) => {
    const newAnswers = [...userAnswers];
    newAnswers[currentIndex] = optionIdx;
    userAnswersRef.current = newAnswers;
    setUserAnswers(newAnswers);
  };

  const startTimer = () => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          finishAIExam();
          toast.error("Hết thời gian làm bài!");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, []);

  const toggleFlag = (idx: number) => {
    setFlaggedQuestions(prev => 
      prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]
    );
  };

  const finishAIExam = async () => {
    clearTimers();
    let finalScore = 0;
    aiQuestionsRef.current.forEach((q, idx) => {
      if (userAnswersRef.current[idx] === q.correctAnswer) {
        finalScore++;
      }
    });
    setScore(finalScore);
    const finalDuration = Math.floor((Date.now() - startTimeRef.current) / 1000);
    setDuration(finalDuration);
    setIsFinished(true);
    void recordQuizCompletion(finalScore, aiQuestionsRef.current.length, finalDuration);
  };

  if (loading && !isStarted) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-6">
        <div className="relative">
          <div className="h-16 w-16 rounded-full border-4 border-primary/10 border-t-primary animate-spin" />
          <BrainCircuit className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-primary/50" size={24} />
        </div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] animate-pulse">Đang tải dữ liệu...</p>
      </div>
    );
  }

  if (isGenerating) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-8">
        <div className="relative">
          <motion.div 
            animate={{ rotate: 360 }}
            transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
            className="h-32 w-32 rounded-full border-2 border-dashed border-primary/30"
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <Sparkles className="text-primary animate-pulse" size={48} />
          </div>
        </div>
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-tighter">AI đang soạn đề thi...</h2>
          <p className="text-slate-500 dark:text-slate-400 font-medium">Việc này có thể mất vài giây để phân tích toàn bộ thẻ của bạn.</p>
        </div>
      </div>
    );
  }

  if (isFinished && !showReview) {
    const totalQuestions = mode === 'self' ? testCards.length : aiQuestions.length;
    const percentage = Math.round((score / totalQuestions) * 100);
    return (
      <div className="max-w-3xl mx-auto space-y-10 animate-in fade-in zoom-in duration-700 pt-10">
        <Card className="border border-slate-200 dark:border-white/5 shadow-2xl overflow-hidden rounded-[2rem] md:rounded-[3rem] bg-white dark:bg-[#0C0D0E]">
          <div className="h-2 md:h-3 bg-primary w-full" />
          <CardContent className="p-8 md:p-20 text-center space-y-8 md:space-y-10">
            <div className="flex justify-center">
              <motion.div 
                initial={{ scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 20 }}
                className="inline-flex p-6 md:p-10 bg-primary/10 text-primary rounded-full shadow-2xl shadow-primary/20"
              >
                <Trophy className="w-12 h-12 md:w-20 md:h-20" />
              </motion.div>
            </div>
            
            <div className="space-y-2 md:space-y-4">
              <h2 className="text-3xl md:text-5xl font-bold text-slate-900 dark:text-white tracking-normal">Kết quả {mode === 'ai' ? 'đề thi AI' : 'kiểm tra'}</h2>
              <p className="text-slate-500 dark:text-slate-400 text-lg md:text-xl font-medium">Bạn đã hoàn thành bài kiểm tra năng lực!</p>
            </div>
            
            <div className="grid grid-cols-2 gap-4 md:gap-6 py-2 md:py-4 font-mono">
              <div className="p-5 md:p-8 bg-slate-50 dark:bg-white/5 rounded-[1.5rem] md:rounded-[2.5rem] border border-slate-100 dark:border-white/5">
                <p className="text-3xl md:text-5xl font-bold text-primary">{score}/{totalQuestions}</p>
                <p className="text-[8px] md:text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mt-2 md:mt-3">Số câu đúng</p>
              </div>
              <div className="p-5 md:p-8 bg-slate-50 dark:bg-white/5 rounded-[1.5rem] md:rounded-[2.5rem] border border-slate-100 dark:border-white/5">
                <p className="text-3xl md:text-5xl font-bold text-emerald-500">{percentage}%</p>
                <p className="text-[8px] md:text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] mt-2 md:mt-3">Độ chính xác</p>
              </div>
            </div>

            <div className="bg-slate-50 dark:bg-white/5 p-6 md:p-8 rounded-[2rem] border border-slate-100 dark:border-white/5">
              <Suspense fallback={<div className="h-48 md:h-64 flex items-center justify-center animate-pulse bg-slate-100 dark:bg-white/5 rounded-xl" />}>
                <AssessmentResultChart score={score} total={totalQuestions} />
              </Suspense>
              <div className="mt-4 text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Phân tích tỷ lệ đáp án y học</div>
            </div>

            <div className="flex items-center justify-center gap-3 text-slate-400 font-mono text-sm bg-slate-50 dark:bg-white/5 py-3 px-6 rounded-full w-fit mx-auto">
              <Timer size={18} />
              <span>Thời gian: {Math.floor(duration / 60)}:{String(duration % 60).padStart(2, '0')}</span>
            </div>

            <div className="flex flex-col gap-5 pt-8">
              <div className="flex flex-col sm:flex-row gap-5">
                <Button 
                  onClick={handleReset} 
                  className="flex-1 h-16 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white text-lg font-black gap-3 shadow-xl"
                >
                  <RotateCcw size={22} /> Làm bài khác
                </Button>
                <Button 
                  onClick={handleRetest} 
                  className="flex-1 h-16 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white text-lg font-black gap-3 shadow-xl"
                >
                  <RotateCcw size={22} /> Thi lại
                </Button>
              </div>
              <div className="flex flex-col sm:flex-row gap-5">
                <Button 
                  onClick={() => {
                    setShowReview(true);
                    playSound('success', settings.volume);
                  }} 
                  variant="outline"
                  className="flex-1 h-16 rounded-2xl border-primary/30 text-primary text-lg font-black gap-3 hover:bg-primary/5"
                >
                  <FileText size={22} /> Xem đáp án {(mode === 'ai' || mode === 'general') ? '& Giải thích' : ''}
                </Button>
              </div>
              <Link to="/" className="w-full">
                <Button variant="ghost" className="w-full h-16 rounded-2xl text-slate-400 font-bold hover:bg-slate-50 dark:hover:bg-white/5">
                  Về trang chủ
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (showReview) {
    if (mode === 'ai' || mode === 'general') {
      return (
        <div className="max-w-4xl mx-auto space-y-10 animate-in fade-in slide-in-from-bottom-8 duration-700 pt-6 pb-20 font-serif">
          <div className="flex items-center justify-between sticky top-0 bg-background/80 backdrop-blur-md z-10 py-4 border-b border-slate-100 dark:border-white/5">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold text-slate-900 dark:text-white tracking-normal">Đáp án & Giải thích</h2>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">{mode === 'ai' ? 'Đề thi AI' : 'Thi tổng hợp'} — {score}/{aiQuestions.length} câu đúng</p>
            </div>
            <Button 
              onClick={() => setShowReview(false)}
              variant="ghost"
              className="h-12 px-6 rounded-xl font-black gap-2"
            >
              <ChevronLeft size={20} /> Quay lại kết quả
            </Button>
          </div>

          <div className="space-y-8">
            {aiQuestions.map((q, qIdx) => {
              const isCorrect = userAnswers[qIdx] === q.correctAnswer;
              return (
                <Card key={qIdx} className={`border-none shadow-xl rounded-[2.5rem] overflow-hidden bg-white dark:bg-[#0C0D0E] ${isCorrect ? 'ring-2 ring-emerald-500/20' : 'ring-2 ring-red-500/20'}`}>
                  <CardHeader className="p-8 md:p-10 border-b border-slate-50 dark:border-white/5">
                    <div className="flex items-start gap-4">
                      <div className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center font-black ${isCorrect ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>
                        {qIdx + 1}
                      </div>
                      <CardTitle className="text-xl md:text-2xl font-bold leading-tight tracking-normal pt-1">
                        {q.question}
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="p-8 md:p-10 space-y-8">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {q.options.map((option, oIdx) => {
                        const isUserChoice = userAnswers[qIdx] === oIdx;
                        const isCorrectChoice = q.correctAnswer === oIdx;
                        
                        let variantClass = "border-slate-100 dark:border-white/5 text-slate-600 dark:text-slate-400";
                        if (isCorrectChoice) variantClass = "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-500/20";
                        if (isUserChoice && !isCorrectChoice) variantClass = "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-400 ring-1 ring-red-500/20";

                        return (
                          <div key={oIdx} className={`p-5 rounded-2xl border-2 flex items-center gap-4 transition-all ${variantClass}`}>
                            <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-black ${
                              isCorrectChoice ? 'bg-emerald-500 text-white' : 
                              (isUserChoice && !isCorrectChoice) ? 'bg-red-500 text-white' : 'bg-slate-100 dark:bg-white/10'
                            }`}>
                              {String.fromCharCode(65 + oIdx)}
                            </div>
                            <span className="text-base font-bold">{option}</span>
                            {isUserChoice && <span className="ml-auto text-[10px] font-black uppercase tracking-widest opacity-60">{isCorrectChoice ? 'Lựa chọn của bạn' : 'Sai'}</span>}
                          </div>
                        );
                      })}
                    </div>

            <div className="space-y-8">
              <div className="flex items-center gap-2 text-primary">
                <Info size={20} />
                <h4 className="text-sm font-bold uppercase tracking-widest">GIẢI THÍCH & NGUỒN TÀI LIỆU</h4>
              </div>
              <div className="text-lg text-slate-700 dark:text-slate-300 font-medium leading-relaxed prose prose-slate dark:prose-invert max-w-none">
                        {q.explanation ? (
                          <ReactMarkdown>{q.explanation}</ReactMarkdown>
                        ) : (
                          <p className="italic text-slate-400">AI chưa cung cấp giải thích cho câu hỏi này.</p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div className="flex flex-col sm:flex-row justify-center gap-5 pt-10">
            <Button 
              onClick={handleReset} 
              variant="outline"
              className="h-16 px-12 rounded-2xl border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400 font-black text-lg gap-3"
            >
              <X size={22} /> Kết thúc
            </Button>
            <Button 
              onClick={handleRetest} 
              className="h-16 px-12 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-lg gap-3 shadow-xl"
            >
              <RotateCcw size={22} /> Thi lại đề này
            </Button>
          </div>
        </div>
      );
    } else {
      // Self review
      return (
        <div className="max-w-4xl mx-auto space-y-10 animate-in fade-in slide-in-from-bottom-8 duration-700 pt-6 pb-20 font-serif">
          <div className="flex items-center justify-between py-4 border-b border-slate-100 dark:border-white/5">
              <h2 className="text-2xl font-bold text-slate-900 dark:text-white leading-tight tracking-normal">Xem lại nội dung thẻ</h2>
            <div className="flex gap-3">
              <Button onClick={() => setShowReview(false)} variant="ghost" className="rounded-xl font-bold h-12 px-4 md:px-6">
                <ChevronLeft size={20} /> Quay lại
              </Button>
              <Button onClick={handleReset} variant="outline" className="rounded-xl font-black h-12 px-4 md:px-6 border-red-200 text-red-500 hover:bg-red-50">
                <X size={20} /> Thoát
              </Button>
            </div>
          </div>
          <div className="grid gap-6">
            {testCards.map((card, idx) => (
              <Card key={card.id} className="p-8 rounded-[2rem] border-none shadow-xl bg-white dark:bg-[#0C0D0E] overflow-hidden relative">
                <div className="absolute top-0 left-0 w-2 h-full bg-primary/20" />
                <div className="flex flex-col md:flex-row gap-8">
                  <div className="flex-1 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Mặt trước</span>
                      <SpeechButton text={card.front} size="sm" variant="ghost" />
                    </div>
                    <div className="text-xl font-black tracking-tight"><ReactMarkdown>{card.front}</ReactMarkdown></div>
                  </div>
                  <div className="flex-1 space-y-3 border-t md:border-t-0 md:border-l border-slate-100 dark:border-white/5 pt-6 md:pt-0 md:pl-8">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">Mặt sau (Đáp án)</span>
                      <SpeechButton text={card.back} size="sm" variant="ghost" />
                    </div>
                    <div className="text-xl font-bold text-slate-600 dark:text-slate-400 leading-relaxed"><ReactMarkdown>{card.back}</ReactMarkdown></div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      );
    }
  }

  if (isStarted) {
    if (mode === 'self') {
      const currentCard = testCards[currentIndex];
      return (
        <div className="max-w-4xl mx-auto space-y-10 animate-in fade-in slide-in-from-bottom-8 duration-700 pt-6 font-serif">
          <div className="flex items-center justify-between gap-10">
            <div className="flex-1 space-y-3">
              <div className="flex justify-between items-end">
                <h2 className="text-[10px] font-bold text-primary uppercase tracking-[0.2em]">Câu hỏi {currentIndex + 1}/{testCards.length}</h2>
                <span className="text-xs font-black text-slate-400 font-mono">{Math.round(((currentIndex + 1) / testCards.length) * 100)}%</span>
              </div>
              <div className="h-2 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${((currentIndex + 1) / testCards.length) * 100}%` }}
                  className="h-full bg-primary transition-all duration-500" 
                />
              </div>
            </div>
            <div className="flex items-center gap-3 text-slate-400 font-mono bg-slate-50 dark:bg-white/5 px-4 py-2 rounded-2xl border border-slate-100 dark:border-white/5">
              <Timer size={18} className="text-primary" />
              <span className="text-sm font-black">{elapsedSeconds}s</span>
            </div>
          </div>

          <div className="perspective-2000 min-h-[500px]">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentIndex + (showAnswer ? '-back' : '-front')}
                initial={{ opacity: 0, rotateY: 90, scale: 0.95 }}
                animate={{ opacity: 1, rotateY: 0, scale: 1 }}
                exit={{ opacity: 0, rotateY: -90, scale: 0.95 }}
                transition={{ duration: 0.5, type: "spring", damping: 20 }}
                className="w-full h-full"
              >
                <Card 
                  className={`w-full min-h-[400px] md:min-h-[500px] flex flex-col items-center justify-center p-8 md:p-20 text-center cursor-pointer shadow-2xl rounded-[2rem] md:rounded-[3rem] border border-slate-200 dark:border-white/5 relative overflow-hidden ${showAnswer ? 'bg-primary/5 dark:bg-primary/10' : 'bg-white dark:bg-[#0C0D0E]'}`}
                  style={{
                    backgroundColor: showAnswer ? undefined : currentCard.customStyles?.backgroundColor,
                    color: showAnswer ? undefined : currentCard.customStyles?.textColor,
                  }}
                >
                  <div className="absolute top-6 right-6 md:top-8 md:right-8 z-20">
                    <SpeechButton 
                      text={showAnswer ? currentCard.back : currentCard.front} 
                      className={showAnswer ? "bg-primary/10 hover:bg-primary/20 text-primary" : "bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-slate-400"}
                    />
                  </div>
                  <div className="absolute top-6 left-6 md:top-8 md:left-8 text-[9px] md:text-[10px] font-black text-slate-300 dark:text-slate-600 uppercase tracking-[0.3em]">
                    {showAnswer ? 'Mặt sau (Đáp án)' : 'Mặt trước (Câu hỏi)'}
                  </div>
                  
                  {currentCard.imageUrl && !showAnswer && (
                    <motion.div 
                      initial={{ y: 20, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      className="mb-8 md:mb-12 w-full max-w-2xl mx-auto rounded-[2.5rem] overflow-hidden shadow-2xl border-4 border-white dark:border-white/10"
                    >
                      <img 
                        src={currentCard.imageUrl} 
                        alt="Card" 
                        className="w-full h-auto object-contain bg-slate-50 dark:bg-white/5 min-h-[300px]"
                        referrerPolicy="no-referrer"
                      />
                    </motion.div>
                  )}
                  <div className="w-full">
                    <div className="font-bold leading-tight tracking-normal text-3xl md:text-4xl" style={{ fontSize: !showAnswer && currentCard.customStyles?.fontSize ? 'inherit' : undefined }}>
                      <ReactMarkdown>
                        {showAnswer ? currentCard.back : currentCard.front}
                      </ReactMarkdown>
                    </div>
                  </div>

                  {!showAnswer && (
                    <Button 
                      variant="ghost" 
                      onClick={() => {
                        setShowAnswer(true);
                        playSound('flip', settings.volume);
                      }}
                      className="mt-8 md:mt-14 text-primary hover:bg-primary/10 gap-2 md:gap-3 font-black text-base md:text-lg h-12 md:h-14 px-6 md:px-8 rounded-xl md:rounded-2xl transition-all hover:scale-105"
                    >
                      Xem đáp án <ArrowRight className="w-5 h-5 md:w-5.5 md:h-5.5" />
                    </Button>
                  )}
                </Card>
              </motion.div>
            </AnimatePresence>
          </div>

          {showAnswer && (
            <div className="grid grid-cols-2 gap-6 animate-in fade-in slide-in-from-top-8 duration-700">
              <Button 
                onClick={() => handleSelfAnswer(false)}
                className="h-24 rounded-[2rem] bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-500/20 border-2 border-rose-100 dark:border-rose-500/20 text-2xl font-black gap-4 shadow-xl shadow-rose-500/10 transition-all hover:scale-[1.02] active:scale-95"
              >
                <XCircle size={32} /> Sai rồi
              </Button>
              <Button 
                onClick={() => handleSelfAnswer(true)}
                className="h-24 rounded-[2rem] bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 border-2 border-emerald-100 dark:border-emerald-500/20 text-2xl font-black gap-4 shadow-xl shadow-emerald-500/10 transition-all hover:scale-[1.02] active:scale-95"
              >
                <CheckCircle2 size={32} /> Chính xác
              </Button>
            </div>
          )}
        </div>
      );
    } else {
      // AI Exam Mode
      const currentQ = aiQuestions[currentIndex];
      const isFlagged = flaggedQuestions.includes(currentIndex);

      return (
        <div className="max-w-4xl mx-auto space-y-10 animate-in fade-in slide-in-from-bottom-8 duration-700 pt-6 font-serif">
          <div className="flex items-center justify-between gap-10">
            <div className="flex-1 space-y-3">
              <div className="flex justify-between items-end">
                <h2 className="text-[10px] font-black text-primary uppercase tracking-[0.2em]">Câu hỏi {currentIndex + 1}/{aiQuestions.length}</h2>
                <span className="text-xs font-black text-slate-400 font-mono">{Math.round(((currentIndex + 1) / aiQuestions.length) * 100)}%</span>
              </div>
              <div className="h-2 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${((currentIndex + 1) / aiQuestions.length) * 100}%` }}
                  className="h-full bg-primary transition-all duration-500" 
                />
              </div>
            </div>
            <div className={`flex items-center gap-3 font-mono px-4 py-2 rounded-2xl border transition-all ${isPressureMode && timeLeft < 60 ? 'bg-rose-50 border-rose-200 text-rose-500 animate-pulse' : 'bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/5 text-slate-400'}`}>
              <Timer size={18} className={isPressureMode && timeLeft < 60 ? 'text-rose-500' : 'text-primary'} />
              <span className="text-sm font-black">
                {isPressureMode ? (
                  `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`
                ) : (
                  `${elapsedSeconds}s`
                )}
              </span>
            </div>
          </div>

          <Card className={`border shadow-2xl rounded-[2rem] md:rounded-[3rem] overflow-hidden bg-white dark:bg-[#0C0D0E] transition-all ${isFlagged ? 'border-orange-500/50 ring-4 ring-orange-500/10' : 'border-slate-200 dark:border-white/5'}`}>
            <CardContent className="p-8 md:p-16 space-y-8 md:space-y-10 relative">
              <div className="absolute top-6 right-6 z-20 flex gap-2">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={() => toggleFlag(currentIndex)}
                  className={`rounded-xl transition-all ${isFlagged ? 'bg-orange-500 text-white hover:bg-orange-600' : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10'}`}
                >
                  <Trophy size={20} className={isFlagged ? 'fill-current' : ''} />
                </Button>
                <SpeechButton text={currentQ.question} />
              </div>
              {currentQ.imageUrl && (
                <div className="flex justify-center mb-8 md:mb-12">
                  <img 
                    src={currentQ.imageUrl} 
                    alt={currentQ.imageAlt || "Question visual"}
                    className="max-h-[45vh] w-full max-w-2xl rounded-3xl border-4 border-white bg-slate-50 object-contain shadow-2xl dark:border-white/10 dark:bg-white/5"
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                </div>
              )}
              
              <h3 className="text-xl md:text-2xl lg:text-3xl font-bold text-slate-900 dark:text-white leading-tight tracking-normal text-center mb-8 md:mb-12">
                {currentQ.question}
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                {currentQ.options.map((option, idx) => (
                  <Button
                    key={idx}
                    variant={userAnswers[currentIndex] === idx ? 'default' : 'outline'}
                    onClick={() => handleAIAnswer(idx)}
                    className={`min-h-[4rem] md:min-h-[5rem] h-auto py-3 md:py-4 rounded-xl md:rounded-2xl text-left justify-start px-4 md:px-6 text-sm md:text-base font-bold transition-all whitespace-normal break-words flex items-center ${
                      userAnswers[currentIndex] === idx 
                        ? 'bg-primary text-white shadow-lg shadow-primary/20 scale-[1.02]' 
                        : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-white/5'
                    }`}
                  >
                    <span className="flex-shrink-0 w-6 h-6 md:w-8 md:h-8 rounded-full bg-slate-100 dark:bg-white/10 flex items-center justify-center mr-3 md:mr-4 text-[10px] md:text-xs font-black">
                      {String.fromCharCode(65 + idx)}
                    </span>
                    <span className="flex-1">{option}</span>
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between gap-6">
            <Button
              variant="ghost"
              disabled={currentIndex === 0}
              onClick={() => setCurrentIndex(currentIndex - 1)}
              className="h-14 px-8 rounded-2xl font-black text-slate-500 hover:text-primary gap-2"
            >
              <ChevronLeft size={20} /> Câu trước
            </Button>

            {currentIndex === aiQuestions.length - 1 ? (
              <Button
                onClick={finishAIExam}
                disabled={userAnswers.some(a => a === null)}
                className="h-16 px-12 rounded-2xl bg-primary hover:bg-primary/90 text-white font-black text-lg shadow-xl shadow-primary/20 gap-2"
              >
                Hoàn thành <Check size={22} />
              </Button>
            ) : (
              <Button
                onClick={() => setCurrentIndex(currentIndex + 1)}
                disabled={userAnswers[currentIndex] === null}
                className="h-14 px-8 rounded-2xl bg-slate-900 dark:bg-white text-white dark:text-black font-black gap-2"
              >
                Câu tiếp theo <ChevronRight size={20} />
              </Button>
            )}
          </div>
        </div>
      );
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-8 duration-700 pt-6">
      <header className="text-center max-w-3xl mx-auto space-y-4 md:space-y-6 px-4">
        <div className="inline-flex p-4 md:p-6 bg-primary/10 text-primary rounded-[1.5rem] md:rounded-[2rem] mb-2 shadow-2xl shadow-primary/10">
          <BrainCircuit className="w-8 h-8 md:w-12 md:h-12" />
        </div>
        <h1 className="text-3xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tighter">Kiểm tra năng lực</h1>
        <p className="text-slate-500 dark:text-slate-400 text-lg md:text-xl font-medium leading-relaxed">
          Đánh giá kiến thức của bạn thông qua các bài kiểm tra trắc nghiệm nhanh và hiệu quả.
        </p>
        <div className="grid grid-cols-1 gap-3 pt-4 text-left sm:grid-cols-2 lg:grid-cols-5">
          {[
            { name: 'Blitz Mode', meta: '20 câu nhanh' },
            { name: 'Exam Mode', meta: 'Mô phỏng thi thật' },
            { name: 'Survival Mode', meta: 'Sai quá giới hạn sẽ dừng' },
            { name: 'Adaptive Mode', meta: 'AI tăng giảm độ khó' },
            { name: 'Review Mode', meta: 'Ôn câu sai' },
          ].map((mode) => (
            <div key={mode.name} className="mode-chip p-4 transition hover:-translate-y-1 hover:border-primary/30">
              <p className="text-sm font-black text-slate-900 dark:text-white">{mode.name}</p>
              <p className="mt-1 text-xs font-medium text-slate-500 dark:text-slate-400">{mode.meta}</p>
            </div>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 pb-20">
        <div className="lg:col-span-5 space-y-8">
          <Card className="border border-slate-200 dark:border-white/5 shadow-2xl rounded-[3rem] overflow-hidden bg-white dark:bg-[#0C0D0E]">
            <CardHeader className="p-10 border-b border-slate-100 dark:border-white/5">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-primary/10 text-primary rounded-2xl">
                  <FileText size={24} />
                </div>
                <div>
                  <CardTitle className="text-2xl font-black tracking-tight">Cấu hình bài thi</CardTitle>
                  <CardDescription className="text-[10px] font-black uppercase tracking-widest text-slate-400">Thiết lập phạm vi và số lượng</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-10 space-y-10">
              <div className="space-y-4">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                  <Library size={14} />
                  Chọn bộ thẻ tham gia
                </label>
                <div className="grid grid-cols-1 gap-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                  <button 
                    onClick={() => setSelectedDeckIds(decks.map(d => d.id))}
                    className="text-[10px] font-black text-primary uppercase tracking-[0.3em] text-left hover:text-slate-900 dark:hover:text-white transition-colors mb-2"
                  >
                    Chọn tất cả bộ thẻ
                  </button>
                  {decks.map(deck => (
                    <div 
                      key={deck.id}
                      onClick={() => toggleDeckSelection(deck.id)}
                      className={`p-5 rounded-[1.5rem] border-2 transition-all cursor-pointer flex items-center justify-between group ${
                        selectedDeckIds.includes(deck.id)
                          ? 'bg-primary/5 border-primary/30 text-primary shadow-lg shadow-primary/5'
                          : 'border-slate-100 dark:border-white/5 text-slate-600 dark:text-slate-400 hover:border-primary/20'
                      }`}
                    >
                      <div className="flex items-center gap-4">
                        <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${
                          selectedDeckIds.includes(deck.id) ? 'bg-primary border-primary scale-110' : 'border-slate-300 dark:border-slate-700'
                        }`}>
                          {selectedDeckIds.includes(deck.id) && <Check size={14} className="text-white" />}
                        </div>
                        <span className="text-base font-bold tracking-tight">{deck.name}</span>
                      </div>
                      <span className="text-[10px] font-black opacity-50 uppercase tracking-widest">{deck.cardCount} thẻ</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Số lượng câu hỏi AI (Nếu dùng AI)</label>
                <div className="flex gap-3">
                  {[5, 10, 15, 20].map(count => (
                    <Button
                      key={count}
                      variant={questionCount === count ? 'default' : 'outline'}
                      onClick={() => setQuestionCount(count)}
                      className={`flex-1 h-12 rounded-xl font-bold ${questionCount === count ? 'bg-primary shadow-lg shadow-primary/20' : ''}`}
                    >
                      {count}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-4">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Mức độ đề thi AI</label>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { id: 'basic', label: 'Cơ bản' },
                    { id: 'advanced', label: 'Vận dụng chuyên sâu' }
                  ].map(d => (
                    <Button
                      key={d.id}
                      type="button"
                      variant={difficulty === d.id ? 'default' : 'outline'}
                      onClick={() => setDifficulty(d.id)}
                      className={`h-12 rounded-xl text-[10px] font-bold ${
                        difficulty === d.id ? 'bg-primary shadow-lg shadow-primary/20' : 'border-slate-100 dark:border-white/5'
                      }`}
                    >
                      {d.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="pt-6 border-t border-slate-100 dark:border-white/5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <p className="font-bold text-slate-800 dark:text-slate-200">Chế độ áp lực (Mock Exam)</p>
                    <p className="text-[10px] text-slate-400 font-medium italic">Có đồng hồ đếm ngược & không xem trước đáp án.</p>
                  </div>
                  <button 
                    onClick={() => setIsPressureMode(!isPressureMode)}
                    className={`w-12 h-6 rounded-full transition-all relative ${isPressureMode ? 'bg-rose-500' : 'bg-slate-200 dark:bg-white/10'}`}
                  >
                    <motion.div 
                      animate={{ x: isPressureMode ? 24 : 0 }}
                      className="absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow-md"
                    />
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-7 grid grid-cols-1 gap-8">
          <Card 
            onClick={startSelfTest}
            className="group cursor-pointer border-none shadow-xl hover:shadow-2xl transition-all duration-500 rounded-[3rem] bg-white dark:bg-[#0C0D0E] overflow-hidden border-2 border-transparent hover:border-primary/20"
          >
            <div className="p-10 md:p-14 space-y-6">
              <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center group-hover:scale-110 transition-transform duration-500">
                <RotateCcw size={32} />
              </div>
              <div className="space-y-2">
                <h3 className="text-3xl font-black tracking-tighter">Tự kiểm tra (Chớp nhoáng)</h3>
                <p className="text-slate-500 dark:text-slate-400 font-medium">Hệ thống sẽ lấy ngẫu nhiên 20 thẻ từ các bộ thẻ bạn đã chọn để bạn tự đánh giá.</p>
              </div>
              <div className="flex items-center gap-2 text-primary font-black uppercase text-xs tracking-widest">
                Bắt đầu ngay <ArrowRight size={16} />
              </div>
            </div>
          </Card>

          <Card 
            onClick={startAIExam}
            className="group cursor-pointer border-none shadow-xl hover:shadow-2xl transition-all duration-500 rounded-[3rem] bg-slate-900 dark:bg-indigo-950 text-white overflow-hidden"
          >
            <div className="p-10 md:p-14 space-y-6 relative overflow-hidden">
              <div className="absolute -top-10 -right-10 w-40 h-40 bg-primary/20 rounded-full blur-3xl animate-pulse" />
              <div className="w-16 h-16 rounded-2xl bg-white/10 text-white flex items-center justify-center group-hover:scale-110 transition-transform duration-500">
                <Sparkles size={32} />
              </div>
              <div className="space-y-2 relative z-10">
                <h3 className="text-3xl font-black tracking-tighter">Đề thi tạo bởi AI</h3>
                <p className="text-slate-300 font-medium">AI sẽ phân tích nội dung ghi chú và thẻ của bạn để tạo ra bộ câu hỏi trắc nghiệm hoàn toàn mới.</p>
              </div>
              <div className="flex items-center gap-2 text-primary font-black uppercase text-xs tracking-widest relative z-10">
                Tạo đề thi với AI <ArrowRight size={16} />
              </div>
            </div>
          </Card>

          <Card className="border border-slate-200 dark:border-white/5 shadow-2xl rounded-[3rem] bg-white dark:bg-[#0C0D0E] overflow-hidden">
            <div className="p-10 md:p-14 space-y-8">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                  <Library size={32} />
                </div>
                <div className="space-y-1">
                  <h3 className="text-3xl font-black tracking-tighter text-slate-900 dark:text-white">Thi Tổng Hợp (AI Knowledge)</h3>
                  <p className="text-slate-500 dark:text-slate-400 font-medium italic text-sm">Không cần bộ thẻ. Tạo đề thi từ kiến thức khổng lồ của AI.</p>
                </div>
              </div>

              <div className="space-y-4">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Chọn chuyên khoa chính</label>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {[
                    { id: 'internal', label: 'Nội khoa' },
                    { id: 'surgery', label: 'Ngoại khoa' },
                    { id: 'trauma_ortho', label: 'Chấn thương chỉnh hình' },
                    { id: 'ecg', label: 'ECG' },
                    { id: 'obgyn', label: 'Sản phụ khoa' },
                    { id: 'pediatrics', label: 'Nhi khoa' },
                    { id: 'all', label: 'Tổng hợp' }
                  ].map(s => (
                    <Button
                      key={s.id}
                      variant={generalSpecialty === s.id ? 'default' : 'outline'}
                      onClick={() => setGeneralSpecialty(s.id)}
                      className={`h-12 rounded-xl text-xs font-bold transition-all ${
                        generalSpecialty === s.id ? 'bg-primary shadow-lg shadow-primary/20' : 'border-slate-100 dark:border-white/5'
                      }`}
                    >
                      {s.label}
                    </Button>
                  ))}
                </div>
              </div>

              <Button 
                onClick={startGeneralExam}
                className="w-full h-16 rounded-2xl bg-slate-900 dark:bg-white text-white dark:text-black text-lg font-black gap-3 shadow-xl hover:scale-[1.01] active:scale-95 transition-all"
              >
                Bắt đầu thi tổng hợp <ArrowRight size={22} />
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
