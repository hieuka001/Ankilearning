import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import {
  decideScrollAction,
  loadScrollPositions,
  persistScrollPositions,
  rememberScrollPosition,
  routeScrollKey,
  type ScrollPositionStorage,
} from '../lib/scrollRestoration';

/**
 * Keeps the main scroll container's position in sync with navigation.
 *
 * The shell's scrollable area is a plain div (`[data-scroll-root]` in
 * App.tsx); React Router never scrolls it, so page changes used to keep
 * the previous page's offset and open halfway down. This component applies
 * the decisions from lib/scrollRestoration: new routes start at the top
 * (instantly — a smooth scroll would read as the page sliding away), Back
 * /Forward restore where the route was left, and positions persist in
 * sessionStorage so a light reload keeps them too.
 *
 * Rendered once inside the Router, next to the routed content. Renders
 * nothing itself.
 */

const SCROLL_ROOT_SELECTOR = '[data-scroll-root]';

export function getMainScrollRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(SCROLL_ROOT_SELECTOR);
}

function sessionStorageOrNull(): ScrollPositionStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    // Storage can throw on access in locked-down contexts.
    return null;
  }
}

/**
 * Instant positioning. Direct assignment is used on purpose: the
 * container carries CSS `scroll-behavior: smooth`, and a scrollTo with
 * behavior 'auto' would inherit that and animate — exactly what a route
 * change must not do.
 */
function setScrollTopInstant(root: HTMLElement | null, top: number): void {
  if (root) {
    root.scrollTop = top;
  } else {
    window.scrollTo({ top, behavior: 'instant' });
  }
}

/**
 * Smooth-scroll the main container back to the top — the "re-tap the
 * active tab" pattern (Appllama/HIG). Called by the bottom nav and the
 * sidebar when the user taps the destination they are already on.
 * Honors prefers-reduced-motion by jumping instantly instead: the CSS
 * kill-switch cannot cover this because the smoothness here comes from
 * the scrollTo behavior parameter, not from a stylesheet.
 */
export function scrollMainContentToTop(): void {
  const root = getMainScrollRoot();
  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    setScrollTopInstant(root, 0);
    return;
  }
  if (root) {
    root.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

export default function ScrollManager() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const key = routeScrollKey(location.pathname, location.search);

  const positionsRef = useRef<Map<string, number> | null>(null);
  if (positionsRef.current === null) {
    positionsRef.current = loadScrollPositions(sessionStorageOrNull());
  }
  const previousKeyRef = useRef<string | null>(null);
  const currentKeyRef = useRef(key);

  // Record the offset of the page being read, under the key of the route
  // on screen when the scroll happened. The Map write runs on every
  // scroll event (cheap); the sessionStorage write is debounced, because
  // storage I/O per scroll frame would jank the scroll itself.
  useEffect(() => {
    const root = getMainScrollRoot();
    if (!root) return;
    let timer: number | undefined;
    const onScroll = () => {
      const positions = positionsRef.current;
      if (!positions) return;
      rememberScrollPosition(positions, currentKeyRef.current, root.scrollTop);
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        persistScrollPositions(sessionStorageOrNull(), positions);
      }, 400);
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // Apply each navigation's decision in a layout effect so the new page
  // is positioned before the browser paints — it never flashes at the
  // previous page's offset.
  useLayoutEffect(() => {
    const positions = positionsRef.current;
    if (!positions) return undefined;
    const action = decideScrollAction({
      navigationType,
      previousKey: previousKeyRef.current,
      nextKey: key,
      saved: positions,
    });
    previousKeyRef.current = key;
    currentKeyRef.current = key;

    let raf = 0;
    if (action.type === 'reset') {
      setScrollTopInstant(getMainScrollRoot(), 0);
    } else if (action.type === 'restore') {
      setScrollTopInstant(getMainScrollRoot(), action.top);
      // Lazy routes can keep growing after this paint (Suspense chunks,
      // images). If the page was still too short to reach the saved
      // offset, retry once on the next frame.
      raf = requestAnimationFrame(() => {
        const el = getMainScrollRoot();
        if (el && el.scrollTop < action.top) el.scrollTop = action.top;
      });
    }
    persistScrollPositions(sessionStorageOrNull(), positions);
    return raf ? () => cancelAnimationFrame(raf) : undefined;
  }, [key, navigationType]);

  return null;
}
