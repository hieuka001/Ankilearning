import { useEffect, useRef, useState } from 'react';
import { Loader2, Pause, Volume2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface AudioButtonProps {
  src: string;
  label?: string;
  className?: string;
  size?: 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm';
  variant?: 'ghost' | 'outline' | 'default';
}

export default function AudioButton({
  src,
  label = 'Phát audio',
  className,
  size = 'icon',
  variant = 'ghost',
}: AudioButtonProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const stopAudio = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setIsPlaying(false);
    setIsLoading(false);
  };

  const playAudio = async () => {
    if (!src) return;

    if (isPlaying) {
      stopAudio();
      return;
    }

    stopAudio();
    setIsLoading(true);

    const audio = new Audio(src);
    audio.preload = 'auto';
    audioRef.current = audio;
    audio.onended = stopAudio;
    audio.onerror = stopAudio;
    audio.onpause = () => setIsPlaying(false);
    audio.onplay = () => {
      setIsLoading(false);
      setIsPlaying(true);
    };

    try {
      await audio.play();
    } catch {
      stopAudio();
    }
  };

  return (
    <Button
      type="button"
      data-no-card-swipe="true"
      variant={variant}
      size={size}
      className={className}
      title={isPlaying ? 'Dừng audio' : label}
      aria-label={isPlaying ? 'Dừng audio' : label}
      onClick={(event) => {
        event.stopPropagation();
        playAudio();
      }}
    >
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : isPlaying ? (
        <Pause className="h-4 w-4 text-primary" />
      ) : (
        <Volume2 className="h-4 w-4" />
      )}
    </Button>
  );
}
