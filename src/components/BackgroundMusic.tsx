import { useCallback, useEffect, useRef } from 'react';
import { useSettings } from '../contexts/SettingsContext';

const AMBIENT_CONTROL_EVENT = 'learning-card:ambient-control';

type AmbientNode = {
  context: AudioContext;
  master: GainNode;
  oscillators: OscillatorNode[];
};

type AmbientControlDetail = {
  enabled: boolean;
  volume: number;
};

const clampVolume = (volume: number) => Math.min(Math.max(volume, 0), 1);

const getTargetVolume = (volume: number) => clampVolume(volume) * 0.36;

const createAmbientLayer = (volume: number): AmbientNode => {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const context = new AudioContextClass() as AudioContext;
  const master = context.createGain();
  const filter = context.createBiquadFilter();
  const compressor = context.createDynamicsCompressor();

  master.gain.value = 0;
  filter.type = 'lowpass';
  filter.frequency.value = 760;
  filter.Q.value = 0.38;

  compressor.threshold.value = -34;
  compressor.knee.value = 18;
  compressor.ratio.value = 2.1;
  compressor.attack.value = 0.08;
  compressor.release.value = 0.72;

  filter.connect(compressor);
  compressor.connect(master);
  master.connect(context.destination);

  const baseFrequencies = [110, 146.83, 196];
  const oscillators = baseFrequencies.map((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const pan = typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : null;

    oscillator.type = index === 1 ? 'triangle' : 'sine';
    oscillator.frequency.value = frequency;
    oscillator.detune.value = index === 0 ? -4 : index === 1 ? 3 : 7;
    gain.gain.value = 0.05 - index * 0.008;

    oscillator.connect(gain);
    if (pan) {
      pan.pan.value = index === 0 ? -0.32 : index === 1 ? 0.22 : 0.04;
      gain.connect(pan);
      pan.connect(filter);
    } else {
      gain.connect(filter);
    }

    oscillator.start();
    return oscillator;
  });

  master.gain.linearRampToValueAtTime(getTargetVolume(volume), context.currentTime + 0.7);

  return { context, master, oscillators };
};

export { AMBIENT_CONTROL_EVENT };

export default function BackgroundMusic() {
  const { settings } = useSettings();
  const ambientRef = useRef<AmbientNode | null>(null);
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const stopAmbient = useCallback(() => {
    const ambient = ambientRef.current;
    if (!ambient) return;

    const now = ambient.context.currentTime;
    ambient.master.gain.cancelScheduledValues(now);
    ambient.master.gain.setValueAtTime(ambient.master.gain.value, now);
    ambient.master.gain.linearRampToValueAtTime(0.0001, now + 0.45);

    window.setTimeout(() => {
      ambient.oscillators.forEach((oscillator) => {
        try {
          oscillator.stop();
        } catch {
          // Already stopped by the browser.
        }
      });
      ambient.context.close().catch(() => undefined);
    }, 520);

    ambientRef.current = null;
  }, []);

  const startAmbient = useCallback(async (volumeOverride?: number) => {
    const volume = volumeOverride ?? settingsRef.current.volume;

    if (!ambientRef.current) {
      ambientRef.current = createAmbientLayer(volume);
    }

    const ambient = ambientRef.current;
    const now = ambient.context.currentTime;
    ambient.master.gain.cancelScheduledValues(now);
    ambient.master.gain.setTargetAtTime(getTargetVolume(volume), now, 0.22);

    if (ambient.context.state === 'suspended') {
      await ambient.context.resume();
    }
  }, []);

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
    const ambient = ambientRef.current;
    if (!ambient) return;

    const now = ambient.context.currentTime;
    ambient.master.gain.cancelScheduledValues(now);
    ambient.master.gain.setTargetAtTime(getTargetVolume(settings.volume), now, 0.22);
  }, [settings.volume]);

  useEffect(() => stopAmbient, [stopAmbient]);

  return null;
}
