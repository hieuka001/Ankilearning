import React, { useState } from 'react';
import { Volume2, VolumeX, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { speechLanguageForText } from '../lib/language';

interface SpeechButtonProps {
  text: string;
  className?: string;
  size?: 'default' | 'sm' | 'lg' | 'icon';
  variant?: 'ghost' | 'outline' | 'default';
}

const SpeechButton: React.FC<SpeechButtonProps> = ({ text, className, size = 'icon', variant = 'ghost' }) => {
  const [isPlaying, setIsPlaying] = useState(false);

  const speak = () => {
    if ('speechSynthesis' in window) {
      // Cancel any ongoing speech
      window.speechSynthesis.cancel();

      // Strip markdown syntax for cleaner speech
      const cleanText = text
        .replace(/(\*\*|__)(.*?)\1/g, '$2') // Bold
        .replace(/(\*|_)(.*?)\1/g, '$2')    // Italic
        .replace(/\[(.*?)\]\(.*?\)/g, '$1') // Links
        .replace(/#+\s+(.*)/g, '$1')        // Headers
        .replace(/`{1,3}.*?`{1,3}/g, '')    // Code
        .replace(/>\s+(.*)/g, '$1');        // Blockquotes

      const utterance = new SpeechSynthesisUtterance(cleanText);
      
      // Auto-detect language: Check if text contains Vietnamese specific characters
      const containsVietnamese = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(cleanText);
      utterance.lang = speechLanguageForText(cleanText, 'vi');

      utterance.onstart = () => setIsPlaying(true);
      utterance.onend = () => setIsPlaying(false);
      utterance.onerror = () => setIsPlaying(false);

      window.speechSynthesis.speak(utterance);
    }
  };

  const stop = () => {
    window.speechSynthesis.cancel();
    setIsPlaying(false);
  };

  return (
    <Button
      variant={variant}
      size={size}
      onClick={(e) => {
        e.stopPropagation();
        isPlaying ? stop() : speak();
      }}
      className={`${className} transition-all active:scale-90`}
      title={isPlaying ? "Dừng" : "Phát âm thanh"}
    >
      {isPlaying ? (
        <VolumeX className="w-4 h-4 text-primary animate-pulse" />
      ) : (
        <Volume2 className="w-4 h-4" />
      )}
    </Button>
  );
};

export default SpeechButton;
