import React from 'react';

interface LogoProps {
  className?: string;
  isFull?: boolean;
}

const Logo: React.FC<LogoProps> = ({ className = 'h-12 w-12', isFull = false }) => {
  const mark = (
    <img
      src="/logo.webp"
      alt="AnkiLearning"
      draggable={false}
      className={`${className} shrink-0 select-none rounded-[24%] object-cover shadow-[0_10px_26px_rgba(5,150,105,0.30)] ring-1 ring-black/5 dark:ring-white/15`}
    />
  );

  if (!isFull) return mark;

  return (
    <div className="flex flex-col items-center gap-3">
      {mark}
      <div className="text-center">
        <div className="brand-gradient-text text-xl font-bold md:text-2xl">AnkiLearning</div>
        <p className="mt-1 text-xs font-medium text-zinc-500">Học thông minh với thẻ ghi nhớ</p>
      </div>
    </div>
  );
};

export default Logo;
