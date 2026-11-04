export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  totalCardsLearned: number;
  streak: number;
  lastStudyDate: string;
  streakDays?: number;
  totalCardsReviewed?: number;
  totalQuizzesCompleted?: number;
  totalStudyTimeMinutes?: number;
  lastQuizCompletedAt?: string;
  /** Gamification totals written by gamificationService (see src/lib/gamification). */
  xp?: number;
  level?: number;
  updatedAt?: string;
  settings: {
    dailyGoal: number;
    theme: 'light' | 'dark' | 'system';
    language: string;
    geminiApiKey?: string;
    aiApiKey?: string;
    studyReminder?: StudyReminderSettings;
    scheduler?: {
      desiredRetention?: number;
      initialStability?: {
        again?: number;
        hard?: number;
        good?: number;
        easy?: number;
      };
      initialDifficulty?: number;
      minimumDifficulty?: number;
      maximumDifficulty?: number;
      maximumInterval?: number;
      learningSteps?: { amount: number; unit: 'minute' | 'day' }[];
      relearningSteps?: { amount: number; unit: 'minute' | 'day' }[];
      newCardsPerDay?: number;
      reviewsPerDay?: number;
      leechThreshold?: number;
      burySiblings?: boolean;
      intervalModifier?: number;
      graduatingInterval?: number;
      easyInterval?: number;
      hardMultiplier?: number;
      easyBonus?: number;
      minimumEaseFactor?: number;
    };
  };
  role?: 'admin' | 'user';
  achievements?: {
    id: string;
    unlockedAt: string;
    title: string;
  }[];
  badges?: {
    id: string;
    unlockedAt: string;
    title: string;
  }[];
}

export interface StudyReminderSettings {
  enabled: boolean;
  time: string;
  timezone: string;
  lastSentDate?: string;
}

export interface InAppNotification {
  id: string;
  userId: string;
  type: 'study-reminder' | 'system';
  title: string;
  message: string;
  createdAt: string;
  dateKey?: string;
  readAt?: string;
  actionLabel?: string;
  actionPath?: string;
}

/**
 * Per-deck scheduler overrides (đợt 3A). Every field is optional: a field
 * that is absent inherits the user's global scheduler config. Resolution
 * lives in src/lib/deckOptions.ts (resolveDeckSchedulerConfig).
 */
export interface DeckOptions {
  newCardsPerDay?: number;
  reviewsPerDay?: number;
  desiredRetention?: number;
  leechThreshold?: number;
}

export interface Deck {
  id: string;
  ownerId: string;
  authorName?: string;
  name: string;
  description: string;
  category: string;
  cardCount: number;
  createdAt: string;
  isPublic: boolean;
  /** Per-deck scheduler overrides; absent fields inherit the global config. */
  options?: DeckOptions;
  mindmap?: string;
  /** AI-generated mindmap kept separate from the user's own `mindmap` notes. */
  aiMindmap?: string;
  color?: string;
  tags?: string[];
}

export interface Flashcard {
  id: string;
  deckId: string;
  ownerId: string;
  front: string;
  back: string;
  type?: 'basic' | 'cloze';
  /**
   * Loại ghi chú kiểu Anki (hợp đồng đợt 1A). Thẻ cũ không có field này = 'basic'.
   * - 'reversed': hai thẻ vật lý cùng noteId, một thẻ hoán đổi front↔back.
   * - 'cloze': thẻ sinh từ clozeText, kiểm tra chỉ số clozeIndex.
   */
  cardType?: 'basic' | 'reversed' | 'cloze';
  /** Văn bản gốc chứa cú pháp {{cN::đáp án::gợi ý}} — chỉ có ở thẻ cardType='cloze'. */
  clozeText?: string;
  /** Chỉ số cloze (N) mà thẻ này kiểm tra — chỉ có ở thẻ cardType='cloze'. */
  clozeIndex?: number;
  imageUrl?: string;
  backImageUrl?: string;
  frontImages?: string[];
  backImages?: string[];
  frontAudio?: string[];
  backAudio?: string[];
  audioUrls?: string[];
  extraFields?: Record<string, string>;
  noteType?: string;
  tags: string[];
  interval: number;
  easeFactor: number;
  state?: 'new' | 'learning' | 'review' | 'relearning';
  due?: string;
  stability?: number;
  difficulty?: number;
  retrievability?: number;
  elapsedDays?: number;
  scheduledDays?: number;
  stepIndex?: number;
  dueDate?: string;
  lapses?: number;
  reps?: number;
  suspended?: boolean;
  buriedUntil?: string;
  siblingKey?: string;
  noteId?: string;
  clozeGroupId?: string;
  repetitions: number;
  nextReview: string;
  lastReview?: string | ReviewLog;
  reviewHistory?: ReviewLog[];
  updatedAt?: string;
  createdAt: string;
  customStyles?: {
    backgroundColor?: string;
    fontSize?: string;
    textColor?: string;
  };
}

export interface ReviewLog {
  id: string;
  cardId: string;
  rating: 'again' | 'hard' | 'good' | 'easy';
  reviewTime: string;
  previousStability: number;
  newStability: number;
  previousDifficulty: number;
  newDifficulty: number;
  previousInterval: number;
  newInterval: number;
  elapsedDays: number;
  previousRetrievability: number;
  newRetrievability: number;
  previousState: 'new' | 'learning' | 'review' | 'relearning';
  newState: 'new' | 'learning' | 'review' | 'relearning';
  schedulerVersion: string;
}

export interface StudySession {
  id: string;
  userId: string;
  deckId: string;
  cardsReviewed: number;
  correctCount: number;
  duration: number;
  timestamp: string;
}

export interface ExamQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
}

export interface ExamResult {
  id: string;
  userId: string;
  mode: 'self' | 'ai';
  score: number;
  totalQuestions: number;
  duration: number;
  timestamp: string;
  deckIds: string[];
  questions?: ExamQuestion[];
  userAnswers?: (number | null)[];
}
