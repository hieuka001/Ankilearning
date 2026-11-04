import { useCallback, useMemo, useRef, useState } from 'react';
import { useGesture } from '@use-gesture/react';
import { animate, useMotionValue, useTransform, type MotionValue } from 'motion/react';
import type { SchedulerRating } from '../lib/spacedRepetition';

const SWIPE_DISTANCE = 120;
const SWIPE_VELOCITY = 0.6;
/** A fast flick still needs a minimum travel so plain taps/drags never rate. */
const FLICK_MIN_DISTANCE = 24;
const EXIT_DISTANCE = 620;
const SPRING = { stiffness: 300, damping: 25 };

type SwipeDirection = 'left' | 'right';

interface SwipeState {
  direction: SwipeDirection;
  rating: SchedulerRating;
  exitX: number;
}

interface UseGestureSwipeOptions {
  disabled?: boolean;
  onSwipe: (rating: SchedulerRating) => void | Promise<void>;
}

// Horizontal swipes only: left = Quên (again), right = Dễ (easy).
// The old up = Tốt / down = Khó mapping was removed on purpose: vertical
// drags collide with scrolling long card content, and a 4-way swipe map is
// too easy to trigger by accident. Hard/Good stay on the rating buttons
// (or keyboard 2/3).
const swipeForMovement = (mx: number): SwipeState =>
  mx < 0
    ? { direction: 'left', rating: 'again', exitX: -EXIT_DISTANCE }
    : { direction: 'right', rating: 'easy', exitX: EXIT_DISTANCE };

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
    onDrag: async ({ down, movement: [mx, my], velocity: [vx], event }) => {
      if (disabled || exitingRef.current) return;

      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-no-card-swipe="true"]')) return;

      // Only treat the drag as a card swipe when it is mostly horizontal;
      // vertical-dominant drags belong to the scrollable card content.
      const isHorizontal = Math.abs(mx) >= Math.abs(my);
      const swipe = swipeForMovement(mx);
      setActiveRating(isHorizontal && Math.abs(mx) > 36 ? swipe.rating : null);

      if (down) {
        x.set(isHorizontal ? mx : 0);
        y.set(0);
        return;
      }

      const distance = Math.abs(mx);
      const shouldSwipe = isHorizontal
        && (distance > SWIPE_DISTANCE || (vx > SWIPE_VELOCITY && distance > FLICK_MIN_DISTANCE));

      if (!shouldSwipe) {
        await settle(x, 0);
        y.set(0);
        setActiveRating(null);
        return;
      }

      exitingRef.current = true;
      await animate(x, swipe.exitX, { duration: 0.22 }).finished;
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
