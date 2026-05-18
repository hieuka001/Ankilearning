import React from 'react';

interface LogoProps {
  className?: string;
  isFull?: boolean;
}

const Logo: React.FC<LogoProps> = ({ className = 'h-12 w-12', isFull = false }) => (
  <div className="flex flex-col items-center gap-2">
    <div className={`${className} relative shrink-0 rounded-lg bg-[#101114] shadow-[0_18px_44px_rgba(0,0,0,0.24)]`}>
      <div className="absolute inset-0 rounded-lg bg-[linear-gradient(135deg,rgba(255,255,255,0.22),rgba(255,255,255,0.03)_42%,rgba(37,99,235,0.18))]" />
      <div className="absolute left-[22%] top-[24%] h-[46%] w-[48%] rounded-[5px] border border-white/[0.30] bg-white/[0.07] shadow-[0_8px_18px_rgba(0,0,0,0.22)]" />
      <div className="absolute left-[32%] top-[33%] h-[46%] w-[48%] rounded-[5px] border border-white/[0.22] bg-white/[0.12] shadow-[0_8px_18px_rgba(0,0,0,0.18)]" />
      <div className="absolute left-[42%] top-[18%] h-1.5 w-1.5 rounded-full bg-[#7DD3FC] shadow-[0_0_18px_rgba(125,211,252,0.72)]" />
      <div className="absolute inset-0 rounded-lg ring-1 ring-white/[0.12]" />
    </div>
    {isFull && (
      <div className="mt-2 text-center">
        <h1 className="text-xl font-semibold text-zinc-950 dark:text-white md:text-2xl">Learning Card</h1>
        <p className="mt-1 text-xs font-medium text-zinc-500">Học thẻ thông minh với Gemini</p>
      </div>
    )}
  </div>
);

export default Logo;
