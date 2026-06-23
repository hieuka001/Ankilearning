import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  DEFAULT_SCHEDULER_CONFIG,
  normalizeSchedulerConfig,
  type SchedulerConfig,
} from '../lib/spacedRepetition';

interface Settings {
  darkMode: boolean;
  soundEffects: boolean;
  backgroundMusic: boolean;
  volume: number;
  language: string;
  geminiApiKey: string;
  aiApiKey?: string;
  studyReminder: {
    enabled: boolean;
    time: string;
    timezone: string;
    lastSentDate?: string;
  };
  scheduler: SchedulerConfig;
}

interface SettingsContextType {
  settings: Settings;
  updateSettings: (newSettings: Partial<Settings>) => void;
  toggleDarkMode: () => void;
}

const defaultSettings: Settings = {
  darkMode: false,
  soundEffects: true,
  backgroundMusic: false,
  volume: 0.5,
  language: 'vi',
  geminiApiKey: '',
  aiApiKey: '',
  studyReminder: {
    enabled: false,
    time: '21:00',
    timezone: 'Asia/Bangkok',
  },
  scheduler: DEFAULT_SCHEDULER_CONFIG,
};

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

const readSavedSettings = (): Settings => {
  try {
    const saved = localStorage.getItem('anki_settings');
    if (!saved) return defaultSettings;

    const parsed = JSON.parse(saved) as Partial<Settings>;
    return {
      ...defaultSettings,
      ...parsed,
      volume: typeof parsed.volume === 'number' ? Math.min(Math.max(parsed.volume, 0), 1) : defaultSettings.volume,
      scheduler: normalizeSchedulerConfig(parsed.scheduler),
    };
  } catch {
    try {
      localStorage.removeItem('anki_settings');
    } catch {
      // Storage can be blocked in private or restricted browser contexts.
    }
    return defaultSettings;
  }
};

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<Settings>(readSavedSettings);
  const persistTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (settings.darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [settings.darkMode]);

  useEffect(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = window.setTimeout(() => {
      try {
        localStorage.setItem('anki_settings', JSON.stringify(settings));
      } catch {
        // Keep the app usable even when storage is blocked.
      }
    }, 250);

    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
    };
  }, [settings]);

  const updateSettings = useCallback((newSettings: Partial<Settings>) => {
    setSettings((prev) => ({
      ...prev,
      ...newSettings,
      volume: newSettings.volume === undefined ? prev.volume : Math.min(Math.max(newSettings.volume, 0), 1),
      scheduler: newSettings.scheduler === undefined ? prev.scheduler : normalizeSchedulerConfig(newSettings.scheduler),
    }));
  }, []);

  const toggleDarkMode = useCallback(() => {
    setSettings((prev) => ({ ...prev, darkMode: !prev.darkMode }));
  }, []);

  const value = useMemo(
    () => ({ settings, updateSettings, toggleDarkMode }),
    [settings, toggleDarkMode, updateSettings],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};
