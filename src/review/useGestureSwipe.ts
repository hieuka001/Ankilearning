import { useCallback, useMemo, useRef, useState } from 'react';
import { useGesture } from '@use-gesture/react';
import { animate, useMotionValue, useTransform, type MotionValue } from 'motion/react';
import type { SchedulerRating } from '../lib/spacedRepetition';

const SWIPE_DISTANCE = 120;
const SWIPE_VELOCITY = 0.6;
const EXIT_DISTANCE = 620;
const SPRING = { stiffness: 300, damping: 25 };

type SwipeDirection = 'left' | 'right' | 'up' | 'down';

interface SwipeState {
  direction: SwipeDirection;
  rating: SchedulerRating;
  exitX: number;
  exitY: number;
}

interface UseGestureSwipeOptions {
  disabled?: boolean;
  onSwipe: (rating: SchedulerRating) => void | Promise<void>;
}

const directionForMovement = (mx: number, my: number): SwipeState => {
  if (Math.abs(mx) >= Math.abs(my)) {
    return mx < 0
      ? { direction: 'left', rating: 'again', exitX: -EXIT_DISTANCE, exitY: my }
      : { direction: 'right', rating: 'easy', exitX: EXIT_DISTANCE, exitY: my };
  }

  return my < 0
    ? { direction: 'up', rating: 'good', exitX: mx, exitY: -EXIT_DISTANCE }
    : { direction: 'down', rating: 'hard', exitX: mx, exitY: EXIT_DISTANCE };
};

function settle(value: MotionValue<number>, target: number) {
  return animate(value, target, { type: 'spring', ...SPRING }).finished;
}

export function useGestureSwipe({ disabled = false, onSwipe }: UseGestureSwipeOptions) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-220, 0, 220], [-15, 0, 15]);
  const opacity = useTransform(x, [-360, -120, 0, 120, 360], [0.45, 0.82, 1, 0.82, 0.45]);
  const [activeRating, setActiveRating] = useState<SchedulerRating | null>(null);
  const exitingRef = useRef(false);

  const reset = useCallback(() => {
    x.set(0);
    y.set(0);
    setActiveRating(null);
    exitingRef.current = false;
  }, [x, y]);

  useGesture({
    onDrag: async ({ down, movement: [mx, my], velocity: [vx, vy], event }) => {
      if (disabled || exitingRef.current) return;

      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-no-card-swipe="true"]')) return;

      const swipe = directionForMovement(mx, my);
      setActiveRating(Math.abs(mx) > 36 || Math.abs(my) > 36 ? swipe.rating : null);

      if (down) {
        x.set(mx);
        y.set(my);
        return;
      }

      const distance = Math.max(Math.abs(mx), Math.abs(my));
      const velocity = Math.max(vx, vy);
      const shouldSwipe = distance > SWIPE_DISTANCE || velocity > SWIPE_VELOCITY;

      if (!shouldSwipe) {
        await Promise.all([settle(x, 0), settle(y, 0)]);
        setActiveRating(null);
        return;
      }

      exitingRef.current = true;
      await Promise.all([
        animate(x, swipe.exitX, { duration: 0.22 }).finished,
        animate(y, swipe.exitY, { duration: 0.22 }).finished,
      ]);
      await onSwipe(swipe.rating);
      reset();
    },
  }, {
    target: targetRef,
    drag: {
      filterTaps: true,
      threshold: 4,
    },
  });

  const style = useMemo(() => ({ x, y, rotate, opacity }), [opacity, rotate, x, y]);

  return {
    targetRef,
    style,
    activeRating,
    reset,
  };
}
