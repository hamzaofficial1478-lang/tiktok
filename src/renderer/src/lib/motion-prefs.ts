import { useEffect, useState } from 'react';
import { useAppStore } from '../store/app-store';

/**
 * The single answer to "should this move?".
 *
 * Two independent signals fold into one boolean: the OS-level
 * `prefers-reduced-motion` and the app's own "Reduce effects" toggle. Either
 * one being set is enough — a user who asked for less motion in either place
 * has asked, and the app should not make them ask twice.
 *
 * Every animated surface reads this, so there is exactly one place to check
 * when something moves that should not.
 */
export function usePrefersReducedMotion(): boolean {
  const reduceEffects = useAppStore((s) => s.config?.reduceEffects ?? false);
  const [systemPrefers, setSystemPrefers] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent): void => setSystemPrefers(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return systemPrefers || reduceEffects;
}

/**
 * Spring config from section 10. Used everywhere rather than per-component
 * numbers, so surfaces move as one system.
 */
export const SPRING = { type: 'spring', stiffness: 300, damping: 30 } as const;

/** Rows stagger in at ~30ms when a batch lands (section 10). */
export const STAGGER_MS = 30;

/** Collapses to an instant transition when motion is unwanted. */
export function transition(reduced: boolean): Record<string, unknown> {
  return reduced ? { duration: 0 } : SPRING;
}

/**
 * Modal entrance — "scale in from 0.94 with a slight upward drift", which is
 * the section 10 "pop-up feel".
 */
export function modalVariants(reduced: boolean): {
  initial: Record<string, number>;
  animate: Record<string, number>;
  exit: Record<string, number>;
} {
  if (reduced) {
    return { initial: { opacity: 1, scale: 1, y: 0 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 1 } };
  }
  return {
    initial: { opacity: 0, scale: 0.94, y: 12 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.97, y: 6 },
  };
}
