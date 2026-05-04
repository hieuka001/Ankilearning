const sounds = {
  flip: 'https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3',
  correct: 'https://assets.mixkit.co/active_storage/sfx/1435/1435-preview.mp3',
  wrong: 'https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3',
  success: 'https://assets.mixkit.co/active_storage/sfx/1435/1435-preview.mp3', // Reuse correct for now
};

export const playSound = (type: keyof typeof sounds, volume: number = 0.5) => {
  const settings = JSON.parse(localStorage.getItem('anki_settings') || '{}');
  if (settings.soundEffects === false) return;

  const audio = new Audio(sounds[type]);
  audio.volume = volume;
  audio.play().catch(err => {
    // Only log if it's not a common "blocked" or "not supported" error in restricted environments
    if (err.name !== 'NotSupportedError' && err.name !== 'NotAllowedError') {
      console.error("Sound play failed:", err);
    }
  });
};
