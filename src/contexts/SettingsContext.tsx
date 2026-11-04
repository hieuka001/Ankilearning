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

export type ThemePreference = 'light' | 'dark' | 'system';

interface Settings {
  /** Resolved effective dark mode (derived from `theme`); kept for consumers. */
  darkMode: boolean;
  /** User's theme preference: profile setting → local → operating system. */
  theme: ThemePreference;
  soundEffects: boolean;
  backgroundMusic: boolean;
  volume: number;
  language: string;
  /**
   * Session-only mirrors of the Gemini keys. The canonical copies live in
   * the Firestore profile; they are NEVER written to localStorage anymore.
   */
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
  theme: 'system',
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

const isThemePreference = (value: unknown): value is ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system';

/**
 * Remove secrets before anything touches localStorage. API keys live in the
 * Firestore profile (+ this session's memory) only — never on disk here.
 */
const stripSecrets = (settings: Settings): Record<string, unknown> => {
  const { geminiApiKey: _geminiApiKey, aiApiKey: _aiApiKey, ...safe } = settings;
  return safe;
};

const readSavedSettings = (): Settings => {
  try {
    const saved = localStorage.getItem('anki_settings');
    if (!saved) return defaultSettings;

    const parsed = JSON.parse(saved) as Partial<Settings> & Record<string, unknown>;
    // Legacy local copies may still contain API keys: ignore them on read.
    delete parsed.geminiApiKey;
    delete parsed.aiApiKey;

    const theme: ThemePreference = isThemePreference(parsed.theme)
      ? parsed.theme
      : typeof parsed.darkMode === 'boolean'
        ? parsed.darkMode
          ? 'dark'
          : 'light'
        : defaultSettings.theme;

    return {
      ...defaultSettings,
      ...parsed,
      geminiApiKey: '',
      aiApiKey: '',
      theme,
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

const systemPrefersDark = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

interface SettingsProviderProps {
  children: React.ReactNode;
  /**
   * Theme from the Firestore profile (profile.settings.theme). Priority:
   * profile theme → localStorage theme → operating-system preference.
   * Adopted until the user changes the theme locally in this session.
   */
  initialTheme?: ThemePreference;
}

export const SettingsProvider: React.FC<SettingsProviderProps> = ({ children, initialTheme }) => {
  const [baseSettings, setBaseSettings] = useState<Settings>(readSavedSettings);
  const [theme, setTheme] = useState<ThemePreference>(() => readSavedSettings().theme);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);
  const persistTimerRef = useRef<number | null>(null);
  const userTouchedThemeRef = useRef(false);
  const adoptedProfileThemeRef = useRef<ThemePreference | undefined>(undefined);

  // Adopt the profile theme (async Firestore load) until the user overrides
  // it locally; afterwards the local choice wins for this session.
  useEffect(() => {
    if (!initialTheme || userTouchedThemeRef.current) return;
    if (adoptedProfileThemeRef.current === initialTheme) return;
    adoptedProfileThemeRef.current = initialTheme;
    setTheme(initialTheme);
  }, [initialTheme]);

  // Real 'system' support: follow OS changes while theme === 'system'.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolvedDarkMode = theme === 'dark' || (theme === 'system' && systemDark);

  const settings = useMemo<Settings>(
    () => ({ ...baseSettings, theme, darkMode: resolvedDarkMode }),
    [baseSettings, theme, resolvedDarkMode],
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedDarkMode);
  }, [resolvedDarkMode]);

  useEffect(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = window.setTimeout(() => {
      try {
        localStorage.setItem('anki_settings', JSON.stringify(stripSecrets(settings)));
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
    if (newSettings.theme !== undefined || newSettings.darkMode !== undefined) {
      userTouchedThemeRef.current = true;
    }
    if (isThemePreference(newSettings.theme)) {
      setTheme(newSettings.theme);
    } else if (newSettings.darkMode !== undefined) {
      // Legacy boolean writes map onto an explicit theme choice.
      setTheme(newSettings.darkMode ? 'dark' : 'light');
    }

    setBaseSettings((prev) => ({
      ...prev,
      ...newSettings,
      volume: newSettings.volume === undefined ? prev.volume : Math.min(Math.max(newSettings.volume, 0), 1),
      scheduler: newSettings.scheduler === undefined ? prev.scheduler : normalizeSchedulerConfig(newSettings.scheduler),
    }));
  }, []);

  const toggleDarkMode = useCallback(() => {
    userTouchedThemeRef.current = true;
    setTheme((prev) => {
      const isDark = prev === 'dark' || (prev === 'system' && systemPrefersDark());
      return isDark ? 'light' : 'dark';
    });
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
