import React from 'react';

interface LogoProps {
  className?: string;
  isFull?: boolean;
}

const Logo: React.FC<LogoProps> = ({ className = 'h-12 w-12', isFull = false }) => {
  const mark = (
    <div className={`${className} logo-mark`}>
      <div className="absolute inset-[1px] rounded-[7px] bg-[linear-gradient(145deg,rgba(255,255,255,0.20),rgba(255,255,255,0.04)_42%,rgba(14,17,18,0.70))]" />
      <div className="absolute left-[21%] top-[24%] h-[46%] w-[43%] rounded-[5px] border border-white/[0.28] bg-white/[0.08] shadow-[0_10px_18px_rgba(0,0,0,0.22)]" />
      <div className="absolute left-[36%] top-[34%] h-[42%] w-[43%] rounded-[5px] border border-white/[0.22] bg-white/[0.12] shadow-[0_10px_18px_rgba(0,0,0,0.18)]" />
      <div className="absolute left-[44%] top-[17%] h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.72)]" />
      <div className="absolute inset-0 rounded-lg ring-1 ring-white/14" />
    </div>
  );

  if (!isFull) return mark;

  return (
    <div className="flex flex-col items-center gap-3">
      {mark}
      <div className="text-center">
        <h1 className="text-xl font-semibold text-zinc-950 dark:text-white md:text-2xl">Learning Card</h1>
        <p className="mt-1 text-xs font-medium text-zinc-500">Học thẻ thông minh với Gemini</p>
      </div>
    </div>
  );
};

export default Logo;
