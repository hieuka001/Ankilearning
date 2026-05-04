import React, { createContext, useContext, useState, useEffect } from 'react';

interface Settings {
  darkMode: boolean;
  soundEffects: boolean;
  backgroundMusic: boolean;
  volume: number;
  geminiApiKey: string;
  aiApiKey?: string;
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
  geminiApiKey: '',
  aiApiKey: '',
};

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<Settings>(() => {
    const saved = localStorage.getItem('anki_settings');
    return saved ? JSON.parse(saved) : defaultSettings;
  });

  useEffect(() => {
    localStorage.setItem('anki_settings', JSON.stringify(settings));
    
    // Apply dark mode
    if (settings.darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [settings]);

  const updateSettings = (newSettings: Partial<Settings>) => {
    setSettings(prev => ({ ...prev, ...newSettings }));
  };

  const toggleDarkMode = () => {
    setSettings(prev => ({ ...prev, darkMode: !prev.darkMode }));
  };

  return (
    <SettingsContext.Provider value={{ settings, updateSettings, toggleDarkMode }}>
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
