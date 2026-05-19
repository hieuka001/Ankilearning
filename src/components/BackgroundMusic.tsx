import { useCallback, useEffect, useRef } from 'react';
import { useSettings } from '../contexts/SettingsContext';

const AMBIENT_CONTROL_EVENT = 'learning-card:ambient-control';
const BACKGROUND_MUSIC_SRC = '/audio/background-music.mp3';

type AmbientControlDetail = {
  enabled: boolean;
  volume: number;
};

const clampVolume = (volume: number) => Math.min(Math.max(volume, 0), 1);
const getTargetVolume = (volume: number) => clampVolume(volume) * 0.42;

export { AMBIENT_CONTROL_EVENT };

export default function BackgroundMusic() {
  const { settings } = useSettings();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const settingsRef = useRef(settings);
  const shouldPlayRef = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;

    const audio = new Audio(BACKGROUND_MUSIC_SRC);
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = 0;
    audioRef.current = audio;

    return audio;
  }, []);

  const stopAmbient = useCallback(() => {
    shouldPlayRef.current = false;

    const audio = audioRef.current;
    if (!audio) return;

    const fade = window.setInterval(() => {
      audio.volume = Math.max(0, audio.volume - 0.055);
      if (audio.volume <= 0.01) {
        window.clearInterval(fade);
        audio.pause();
        audio.currentTime = 0;
        audio.volume = 0;
      }
    }, 40);
  }, []);

  const startAmbient = useCallback(async (volumeOverride?: number) => {
    shouldPlayRef.current = true;

    const audio = ensureAudio();
    const targetVolume = getTargetVolume(volumeOverride ?? settingsRef.current.volume);
    audio.volume = targetVolume;

    try {
      await audio.play();
    } catch {
      // Browsers only allow music after a real user gesture. The interaction
      // listeners below will call startAmbient again when the user taps or types.
    }
  }, [ensureAudio]);

  useEffect(() => {
    const handleControl = (event: Event) => {
      const detail = (event as CustomEvent<AmbientControlDetail>).detail;
      if (!detail) return;

      if (detail.enabled) {
        startAmbient(detail.volume).catch(() => undefined);
      } else {
        stopAmbient();
      }
    };

    window.addEventListener(AMBIENT_CONTROL_EVENT, handleControl);
    return () => window.removeEventListener(AMBIENT_CONTROL_EVENT, handleControl);
  }, [startAmbient, stopAmbient]);

  useEffect(() => {
    if (!settings.backgroundMusic) {
      stopAmbient();
      return undefined;
    }

    const handleInteraction = () => {
      startAmbient().catch(() => undefined);
    };

    window.addEventListener('pointerdown', handleInteraction, { passive: true });
    window.addEventListener('keydown', handleInteraction);
    startAmbient().catch(() => undefined);

    return () => {
      window.removeEventListener('pointerdown', handleInteraction);
      window.removeEventListener('keydown', handleInteraction);
    };
  }, [settings.backgroundMusic, startAmbient, stopAmbient]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.volume = shouldPlayRef.current ? getTargetVolume(settings.volume) : 0;
  }, [settings.volume]);

  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      audioRef.current = null;
    };
  }, []);

  return null;
}
