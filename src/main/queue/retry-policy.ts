import { isAutoRetryable, type ErrorCode } from '@shared/errors';

/**
 * Retry policy — spec section 8: "3 attempts, exponential backoff at
 * 2s / 8s / 30s with jitter. Retry only on transient errors … Never retry on
 * 404, private, deleted, region-blocked, or unsupported media."
 *
 * Interpretation worth confirming: three delays are listed, so this treats it
 * as three *retries* after the initial attempt (four executions at worst),
 * with each retry taking the next delay. Reading it as three total executions
 * would leave the 30s delay unreachable. MAX_RETRIES is the single constant to
 * change if the other reading is intended.
 *
 * Which errors retry is not decided here — it is read from the taxonomy's
 * `autoRetry` flag, so there is exactly one place that knows a deleted video
 * must never consume a retry.
 */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 30_000];
export const MAX_RETRIES = RETRY_DELAYS_MS.length;

/** Proportion of the delay to jitter by, ± — spreads a batch's retries out. */
const JITTER_RATIO = 0.2;

export interface RetryDecision {
  readonly retry: boolean;
  /** Milliseconds to wait before the next attempt; 0 when not retrying. */
  readonly delayMs: number;
  readonly reason: string;
}

/**
 * @param attemptCount how many attempts have already failed, including the one
 *                     that just did (so the first failure passes 1).
 */
export function decideRetry(
  code: ErrorCode,
  attemptCount: number,
  random: () => number = Math.random,
): RetryDecision {
  if (!isAutoRetryable(code)) {
    return { retry: false, delayMs: 0, reason: `${code} is terminal; retrying would waste the rate budget` };
  }

  if (attemptCount >= MAX_RETRIES + 1) {
    return { retry: false, delayMs: 0, reason: `gave up after ${attemptCount} attempts` };
  }

  const base = RETRY_DELAYS_MS[Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1)] as number;
  const offset = (random() * 2 - 1) * base * JITTER_RATIO;
  return {
    retry: true,
    delayMs: Math.max(0, Math.round(base + offset)),
    reason: `attempt ${attemptCount} of ${MAX_RETRIES + 1}`,
  };
}
