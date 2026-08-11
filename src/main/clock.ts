import { AppError } from '@shared/errors';

/**
 * Time, injected.
 *
 * The queue's two most important timing behaviours — a 2s/8s/30s retry
 * backoff and a 1.5s gap between outbound requests — are exactly the things a
 * test must not actually wait for. Injecting the clock means the retry suite
 * asserts the delays rather than sitting through 40 seconds of them, and the
 * assertions are about the schedule itself instead of wall-clock luck.
 */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AppError('CANCELLED', 'sleep aborted'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new AppError('CANCELLED', 'sleep aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
