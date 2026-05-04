import React, { useEffect, useRef } from 'react';
import { useSettings } from '../contexts/SettingsContext';

const BackgroundMusic: React.FC = () => {
  const { settings } = useSettings();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Preferred music sources
  const musicSources = [
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3"
  ];
  const [currentSourceIndex, setCurrentSourceIndex] = React.useState(0);

  useEffect(() => {
    const playAudio = () => {
      if (audioRef.current && settings.backgroundMusic) {
        audioRef.current.volume = settings.volume;
        audioRef.current.play().catch(err => {
          if (err.name === 'NotAllowedError') {
            console.warn("Autoplay was prevented. User interaction required.");
          } else {
            console.error("Error playing background music:", err.message);
            // Try next source if current one fails
            if (currentSourceIndex < musicSources.length - 1) {
              setCurrentSourceIndex(prev => prev + 1);
            }
          }
        });
      } else if (audioRef.current && !settings.backgroundMusic) {
        audioRef.current.pause();
      }
    };

    playAudio();

    // Re-try play on any click to bypass autoplay restrictions
    const handleInteraction = () => {
      if (audioRef.current?.paused && settings.backgroundMusic) {
        playAudio();
      }
    };

    window.addEventListener('click', handleInteraction);
    return () => window.removeEventListener('click', handleInteraction);
  }, [settings.backgroundMusic, settings.volume, currentSourceIndex]);

  const handleAudioError = (e: any) => {
    console.warn(`Background music error with source: ${musicSources[currentSourceIndex]}`);
    if (currentSourceIndex < musicSources.length - 1) {
      setCurrentSourceIndex(prev => prev + 1);
    }
  };

  return (
    <audio
      ref={audioRef}
      src={musicSources[currentSourceIndex]}
      loop
      onError={handleAudioError}
      style={{ display: 'none' }}
    />
  );
};

export default BackgroundMusic;
