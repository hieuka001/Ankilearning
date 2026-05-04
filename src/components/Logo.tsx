import React from 'react';

interface LogoProps {
  className?: string;
  isFull?: boolean;
}

const Logo: React.FC<LogoProps> = ({ className = "h-12 w-12", isFull = false }) => (
  <div className="flex flex-col items-center gap-2">
    <div className={`${className} relative flex items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-all duration-300`}>
      <div className="flex h-full w-full items-center justify-center rounded-lg border border-white/15">
        <span className="text-lg md:text-xl font-black leading-none">
          LC
        </span>
      </div>
    </div>
    {isFull && (
      <div className="text-center mt-2">
        <h1 className="text-xl md:text-2xl font-semibold text-zinc-950 dark:text-white">Learning Card</h1>
        <p className="text-xs font-medium text-zinc-500 mt-1">Hoc the thong minh voi Gemini</p>
      </div>
    )}
  </div>
);

export default Logo;
