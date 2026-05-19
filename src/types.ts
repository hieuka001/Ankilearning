export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  totalCardsLearned: number;
  streak: number;
  lastStudyDate: string;
  totalExp?: number;
  level?: number;
  streakDays?: number;
  totalCardsReviewed?: number;
  totalQuizzesCompleted?: number;
  totalStudyTimeMinutes?: number;
  rankScore?: number;
  lastMissionDate?: string;
  lastQuizCompletedAt?: string;
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
  xp?: number;
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

export type DailyMissionType = 'study_cards' | 'complete_quiz' | 'online_time';

export interface DailyMission {
  id: string;
  type: DailyMissionType;
  target: number;
  progress: number;
  completed: boolean;
  rewardExp: number;
  claimed: boolean;
  resetAt: string;
}

export interface DailyMissionDocument {
  id: string;
  userId: string;
  dateKey: string;
  missions: DailyMission[];
  completedAll: boolean;
  createdAt: string;
  updatedAt: string;
  resetAt: string;
}

export interface LeaderboardEntry {
  id: string;
  userId: string;
  username: string;
  avatar?: string;
  level: number;
  totalExp: number;
  streakDays: number;
  totalCardsReviewed: number;
  rankScore: number;
  updatedAt: string;
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
  mindmap?: string;
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
  imageUrl?: string;
  backImageUrl?: string;
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
