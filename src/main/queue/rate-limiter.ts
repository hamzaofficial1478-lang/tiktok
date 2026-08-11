import type { Clock } from '../clock';

export interface RateLimiterOptions {
  /** Read live so a Settings change takes effect mid-batch. */
  readonly minIntervalMs: () => number;
  readonly jitterMs: () => number;
  readonly clock: Clock;
  /** Injected for deterministic tests. */
  readonly random?: () => number;
}

/**
 * Global rate limiter — spec section 8: "global token bucket, default minimum
 * 1.5s between outbound resolution requests, ±400ms jitter."
 *
 * Two properties matter and both are tested:
 *
 *  - It is *global*. At concurrency 4 the workers share one limiter, otherwise
 *    raising concurrency would quadruple the request rate and get the user's
 *    IP throttled — the exact outcome section 2 warns about.
 *  - Acquisitions are serialised through a promise chain. Without it, four
 *    workers calling acquire() in the same tick all read the same
 *    `nextAllowedAt`, all compute a zero wait, and all fire at once.
 *
 * Jitter is applied as ±, as written in the brief, so the effective floor is
 * (interval - jitter). If a hard 1.5s minimum is wanted instead, make the
 * jitter additive here — it is a one-line change and the only place it lives.
 */
export class RateLimiter {
  private nextAllowedAt = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private acquired = 0;

  constructor(private readonly options: RateLimiterOptions) {}

  /** Resolves when the caller may make its outbound request. */
  async acquire(signal?: AbortSignal): Promise<void> {
    const run = this.chain.then(() => this.reserve(signal));
    // Keep the chain alive even when one waiter is cancelled, or a single
    // cancelled item would wedge the queue permanently.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async reserve(signal?: AbortSignal): Promise<void> {
    const { clock } = this.options;
    const wait = Math.max(0, this.nextAllowedAt - clock.now());
    if (wait > 0) await clock.sleep(wait, signal);

    const jitter = this.options.jitterMs();
    const random = this.options.random ?? Math.random;
    const offset = jitter > 0 ? (random() * 2 - 1) * jitter : 0;
    const gap = Math.max(0, this.options.minIntervalMs() + offset);

    this.nextAllowedAt = clock.now() + gap;
    this.acquired++;
  }

  /** Diagnostics for the harness and tests. */
  get acquireCount(): number {
    return this.acquired;
  }

  /** Lets a resumed queue start immediately rather than serving an old debt. */
  reset(): void {
    this.nextAllowedAt = 0;
  }
}
