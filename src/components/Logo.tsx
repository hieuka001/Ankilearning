import React from 'react';

interface LogoProps {
  className?: string;
  isFull?: boolean;
}

const Logo: React.FC<LogoProps> = ({ className = "h-12 w-12", isFull = false }) => (
  <div className="flex flex-col items-center gap-2">
    <div className={`${className} relative flex items-center justify-center rounded-lg bg-zinc-950 text-white shadow-[0_16px_36px_rgba(0,0,0,0.22)] transition-all duration-300 dark:bg-white dark:text-zinc-950`}>
      <div className="absolute inset-0 rounded-lg bg-[linear-gradient(135deg,rgba(255,255,255,0.22),transparent_44%)]" />
      <div className="relative flex h-full w-full items-center justify-center rounded-lg border border-white/[0.12] dark:border-black/10">
        <span className="text-lg md:text-xl font-semibold leading-none">
          LC
        </span>
      </div>
    </div>
    {isFull && (
      <div className="text-center mt-2">
        <h1 className="text-xl md:text-2xl font-semibold text-zinc-950 dark:text-white">Learning Card</h1>
        <p className="text-xs font-medium text-zinc-500 mt-1">Học thẻ thông minh với Gemini</p>
      </div>
    )}
  </div>
);

export default Logo;
