export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  totalCardsLearned: number;
  streak: number;
  lastStudyDate: string;
  settings: {
    dailyGoal: number;
    theme: 'light' | 'dark' | 'system';
    language: string;
    geminiApiKey?: string;
    aiApiKey?: string;
  };
  role?: 'admin' | 'user';
  xp?: number;
  level?: number;
  achievements?: {
    id: string;
    unlockedAt: string;
    title: string;
  }[];
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
  repetitions: number;
  nextReview: string;
  createdAt: string;
  customStyles?: {
    backgroundColor?: string;
    fontSize?: string;
    textColor?: string;
  };
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
