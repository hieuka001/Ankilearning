type SoundType = 'flip' | 'correct' | 'wrong' | 'success';

const getAudioContext = () => {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  return new AudioContextClass() as AudioContext;
};

const readSettings = () => {
  try {
    return JSON.parse(localStorage.getItem('anki_settings') || '{}');
  } catch {
    return {};
  }
};

const tone = (
  context: AudioContext,
  destination: AudioNode,
  frequency: number,
  start: number,
  duration: number,
  gainValue: number,
  type: OscillatorType = 'sine'
) => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
};

const clickNoise = (context: AudioContext, destination: AudioNode, start: number, volume: number) => {
  const bufferSize = Math.floor(context.sampleRate * 0.045);
  const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < bufferSize; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }

  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();

  filter.type = 'highpass';
  filter.frequency.value = 1600;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume * 0.045, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.045);

  source.buffer = buffer;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  source.start(start);
};

export const playSound = (type: SoundType, volume = 0.5) => {
  const settings = readSettings();
  if (settings.soundEffects === false) return;

  const configuredVolume = typeof settings.volume === 'number' ? settings.volume : volume;
  const finalVolume = Math.min(Math.max(configuredVolume, 0), 1);

  try {
    const context = getAudioContext();
    const master = context.createGain();
    const filter = context.createBiquadFilter();
    const now = context.currentTime;

    filter.type = 'lowpass';
    filter.frequency.value = type === 'wrong' ? 900 : 3200;
    master.gain.value = 0.88;
    filter.connect(master);
    master.connect(context.destination);

    if (type === 'flip') {
      clickNoise(context, filter, now, finalVolume);
      tone(context, filter, 740, now + 0.012, 0.07, finalVolume * 0.035, 'triangle');
    }

    if (type === 'correct') {
      tone(context, filter, 523.25, now, 0.12, finalVolume * 0.04);
      tone(context, filter, 783.99, now + 0.07, 0.14, finalVolume * 0.045);
    }

    if (type === 'wrong') {
      tone(context, filter, 220, now, 0.16, finalVolume * 0.04, 'triangle');
      tone(context, filter, 164.81, now + 0.05, 0.2, finalVolume * 0.03, 'sine');
    }

    if (type === 'success') {
      tone(context, filter, 392, now, 0.16, finalVolume * 0.035);
      tone(context, filter, 493.88, now + 0.055, 0.18, finalVolume * 0.035);
      tone(context, filter, 659.25, now + 0.11, 0.22, finalVolume * 0.04);
    }

    window.setTimeout(() => {
      context.close().catch(() => undefined);
    }, 520);
  } catch (error) {
    if (error instanceof Error && error.name !== 'NotAllowedError') {
      console.warn('Sound play failed:', error.message);
    }
  }
};
