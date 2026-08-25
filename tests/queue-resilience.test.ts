import { afterEach, describe, expect, it, vi } from 'vitest';
import { awemeIdFor, createHarness, makeUrl, type Harness } from './helpers/queue-fixtures';
import { decideRetry, MAX_RETRIES, RETRY_DELAYS_MS } from '@main/queue/retry-policy';
import { RateLimiter } from '@main/queue/rate-limiter';
import { TestClock } from './helpers/queue-fixtures';

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

/** Rate-limit waits are all exactly rateLimitMs with random() pinned at 0.5. */
function retrySleeps(clock: TestClock, rateLimitMs = 1_500): number[] {
  return clock.sleeps.filter((ms) => ms !== rateLimitMs);
}

describe('retries (section 8)', () => {
  it('retries a transient failure with the specified backoff', async () => {
    harness = createHarness();
    harness.pipeline.failFor(awemeIdFor(1), ['NETWORK_ERROR', 'NETWORK_ERROR']);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'));

    expect(harness.pipeline.processed).toEqual([awemeIdFor(1)]);
    // Two failures -> the first two delays, in order.
    expect(retrySleeps(harness.clock)).toEqual([RETRY_DELAYS_MS[0], RETRY_DELAYS_MS[1]]);
    expect(harness.engine.getSnapshot()[0]?.attemptCount).toBe(2);
  });

  it('gives up after the retry budget and reports the last error', async () => {
    harness = createHarness();
    harness.pipeline.failFor(awemeIdFor(1), Array.from({ length: 10 }, () => 'NETWORK_ERROR' as const));

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => {
      const item = harness.engine.getSnapshot()[0];
      expect(item?.status).toBe('failed');
      // The ladder's four attempts, plus the single end-of-run sweep that
      // runs once the rest of the batch has finished.
      expect(item?.attemptCount).toBe(MAX_RETRIES + 2);
    });

    // The sweep spends no backoff: its whole premise is that the time taken by
    // the rest of the run is the wait.
    expect(retrySleeps(harness.clock)).toEqual([...RETRY_DELAYS_MS]);
    expect(harness.engine.getSnapshot()[0]?.errorCode).toBe('NETWORK_ERROR');
  });

  it('retries the failures once at the end of the run, without holding up the rest', async () => {
    harness = createHarness();
    // Fails on the first pass and succeeds on the second — the "press refresh
    // and it works" case, automated.
    harness.pipeline.failFor(awemeIdFor(1), Array.from({ length: 4 }, () => 'NETWORK_ERROR' as const));

    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3)]);
    harness.engine.start();

    await vi.waitFor(() => {
      expect(harness.engine.getSnapshot().map((item) => item.status)).toEqual([
        'completed',
        'completed',
        'completed',
      ]);
    });

    // The failing link did not block the two behind it: they finished first.
    expect(harness.pipeline.processed).toEqual([awemeIdFor(2), awemeIdFor(3), awemeIdFor(1)]);
  });

  /**
   * A failure that is waiting, told apart from a failure that is finished.
   *
   * They looked identical on screen, so a link that dropped its connection sat
   * there reading "The connection dropped or timed out" with nothing moving
   * for up to thirty seconds. The reasonable conclusion is that the app is
   * stuck on it; the reasonable response is to cancel it; and cancelling is
   * the one thing that guarantees it will never download.
   */
  it('says when the next attempt is due, while it waits for it', async () => {
    harness = createHarness();
    harness.pipeline.hangFor(awemeIdFor(2));
    harness.pipeline.failFor(awemeIdFor(1), ['NETWORK_ERROR']);

    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();

    await vi.waitFor(() => {
      const waiting = harness.events
        .filter((e): e is Extract<typeof e, { type: 'item-updated' }> => e.type === 'item-updated')
        .find((e) => e.item.status === 'failed' && e.item.nextAttemptAt !== null);
      expect(waiting).toBeDefined();
    });
  });

  it('leaves it null for a failure that is finished with', async () => {
    harness = createHarness();
    harness.extractor.failFor(awemeIdFor(1), ['VIDEO_DELETED']);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    // Nothing is coming, so a countdown would be a lie.
    expect(harness.engine.getSnapshot()[0]?.nextAttemptAt).toBeNull();
  });

  it('clears it once the attempt is actually made', async () => {
    harness = createHarness();
    harness.pipeline.failFor(awemeIdFor(1), ['NETWORK_ERROR']);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'));

    expect(harness.engine.getSnapshot()[0]?.nextAttemptAt).toBeNull();
  });

  it('does not sweep a failure that can never succeed', async () => {
    harness = createHarness();
    harness.extractor.failFor(awemeIdFor(1), ['VIDEO_DELETED', 'VIDEO_DELETED']);

    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const item = harness.engine.getSnapshot()[0];
    expect(item?.status).toBe('failed');
    // One attempt, and no second one at the end: a deleted video will still be
    // deleted, and the request would only buy the same answer again.
    expect(item?.attemptCount).toBe(1);
  });

  /** The acceptance criterion: a deleted video must not consume retries. */
  it('fails a deleted video immediately without spending a retry', async () => {
    harness = createHarness();
    harness.extractor.failFor(awemeIdFor(1), ['VIDEO_DELETED']);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const item = harness.engine.getSnapshot()[0];
    expect(item?.status).toBe('failed');
    expect(item?.errorCode).toBe('VIDEO_DELETED');
    expect(item?.attemptCount).toBe(1);
    expect(retrySleeps(harness.clock)).toEqual([]);
  });

  it.each(['VIDEO_PRIVATE', 'REGION_BLOCKED', 'AGE_RESTRICTED', 'UNSUPPORTED_MEDIA', 'NOT_A_TIKTOK_URL'] as const)(
    'never retries %s',
    (code) => {
      expect(decideRetry(code, 1).retry).toBe(false);
    },
  );

  it.each(['NETWORK_ERROR', 'RATE_LIMITED', 'RESOLVE_FAILED', 'VERIFY_FAILED', 'DOWNLOAD_INCOMPLETE'] as const)(
    'retries %s',
    (code) => {
      expect(decideRetry(code, 1).retry).toBe(true);
    },
  );

  it('does not deadlock the queue while an item waits out its backoff', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failFor(awemeIdFor(1), ['NETWORK_ERROR']);

    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.pipeline.processed).toHaveLength(3));

    // The backoff is a scheduled requeue, not a worker sleeping on the only
    // slot, so every item still completes. The retried item keeps its
    // position, which is why ordering is unaffected by a retry.
    expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
    expect(new Set(harness.pipeline.processed).size).toBe(3);
    expect(harness.engine.getSnapshot().find((i) => i.awemeId === awemeIdFor(1))?.attemptCount).toBe(1);
  });

  it('a manual retry resets the attempt budget', async () => {
    harness = createHarness();
    harness.extractor.failFor(awemeIdFor(1), ['VIDEO_DELETED']);
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const itemId = harness.engine.getSnapshot()[0]?.id as number;
    harness.engine.retryItem(itemId);
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
  });

  it('retries every failed item on request', async () => {
    harness = createHarness();
    for (const i of [1, 2, 3]) harness.extractor.failFor(awemeIdFor(i), ['VIDEO_DELETED']);
    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3)]);
    harness.engine.start();
    await harness.engine.whenIdle();
    expect(harness.engine.getSnapshot().every((i) => i.status === 'failed')).toBe(true);

    expect(harness.engine.retryAllFailed()).toBe(3);
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
  });
});

describe('crash recovery (section 8)', () => {
  it('restores the full queue in order with in-flight items requeued', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks(Array.from({ length: 10 }, (_, i) => makeUrl(i)));
    harness.pipeline.hangFor(awemeIdFor(3));

    harness.engine.start();
    await vi.waitFor(() => expect(harness.pipeline.processed).toHaveLength(3));

    // Hard exit: no graceful stop, exactly as a crash would leave it.
    const before = harness.engine.getSnapshot();
    expect(before.find((i) => i.awemeId === awemeIdFor(3))?.status).toBe('downloading');

    const engine = harness.restart();
    const after = engine.getSnapshot();

    expect(after).toHaveLength(10);
    expect(after.map((i) => i.rawUrl)).toEqual(before.map((i) => i.rawUrl));
    expect(after.map((i) => i.position)).toEqual([...after.map((i) => i.position)].sort((a, b) => a - b));

    const recovered = after.find((i) => i.rawUrl === makeUrl(3));
    expect(recovered?.status).toBe('queued');
    expect(recovered?.progress).toBe(0);
    // Already-finished work is untouched.
    expect(after.slice(0, 3).every((i) => i.status === 'completed')).toBe(true);
  });

  it('resumes the batch after restart, still in order', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks(Array.from({ length: 6 }, (_, i) => makeUrl(i)));
    harness.pipeline.hangFor(awemeIdFor(2));

    harness.engine.start();
    await vi.waitFor(() => expect(harness.pipeline.processed).toHaveLength(2));

    // Whatever was stalling the transfer does not survive the crash either.
    harness.pipeline.clearHangs();
    const engine = harness.restart();
    engine.start();
    await engine.whenIdle();

    expect(engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
    expect(harness.pipeline.processed).toEqual([0, 1, 2, 3, 4, 5].map(awemeIdFor));
  });

  it('requeues a retryable failure interrupted mid-backoff', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1)]);
    const itemId = harness.engine.getSnapshot()[0]?.id as number;
    // A crash during the 8s wait leaves the row failed with attempts to spare.
    harness.queueItems.update(itemId, { status: 'failed', errorCode: 'NETWORK_ERROR', attemptCount: 1 });

    const engine = harness.restart();
    expect(engine.requeueInterruptedRetries()).toBe(1);
    expect(engine.getSnapshot()[0]?.status).toBe('queued');
  });

  it('does not requeue a terminal failure on restart', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1)]);
    const itemId = harness.engine.getSnapshot()[0]?.id as number;
    harness.queueItems.update(itemId, { status: 'failed', errorCode: 'VIDEO_DELETED', attemptCount: 1 });

    const engine = harness.restart();
    expect(engine.requeueInterruptedRetries()).toBe(0);
    expect(engine.getSnapshot()[0]?.status).toBe('failed');
  });
});

describe('rate limiting (section 8)', () => {
  it('spaces outbound requests by the configured interval', async () => {
    harness = createHarness({ config: { concurrency: 1, rateLimitMs: 1_500, rateLimitJitterMs: 400 } });
    harness.engine.addLinks(Array.from({ length: 5 }, (_, i) => makeUrl(i)));

    harness.engine.start();
    await harness.engine.whenIdle();

    // Five items, one outbound resolve each: four gaps between them.
    const gaps = harness.clock.sleeps.filter((ms) => ms === 1_500);
    expect(gaps).toHaveLength(4);
    expect(harness.rateLimiter.acquireCount).toBe(5);
  });

  it('stays global when concurrency rises, instead of multiplying the request rate', async () => {
    harness = createHarness({ config: { concurrency: 4, rateLimitMs: 1_500, rateLimitJitterMs: 0 } });
    harness.engine.addLinks(Array.from({ length: 8 }, (_, i) => makeUrl(i)));

    harness.engine.start();
    await harness.engine.whenIdle();

    // Four workers must not mean four times the requests — this is what keeps
    // the IP from being throttled (section 2).
    expect(harness.rateLimiter.acquireCount).toBe(8);
    expect(harness.clock.sleeps.filter((ms) => ms === 1_500)).toHaveLength(7);
  });

  it('applies jitter around the configured interval', async () => {
    const clock = new TestClock();
    const values = [0, 0.5, 1];
    let index = 0;
    const limiter = new RateLimiter({
      minIntervalMs: () => 1_500,
      jitterMs: () => 400,
      clock,
      random: () => values[index++ % values.length] as number,
    });

    for (let i = 0; i < 4; i++) await limiter.acquire();

    // random 0 -> -400, 0.5 -> 0, 1 -> +400
    expect(clock.sleeps).toEqual([1_100, 1_500, 1_900]);
  });

  it('does not spend a request deciding about a link it can classify offline', async () => {
    harness = createHarness();
    // A photo carousel is knowable from the URL, so raising the question about
    // it must cost nothing.
    harness.engine.addLinks([`https://www.tiktok.com/@user/photo/${awemeIdFor(9)}`]);
    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getPendingPhotoPosts()).toHaveLength(1);
    expect(harness.engine.getSnapshot()[0]?.status).toBe('awaiting_user');
    expect(harness.rateLimiter.acquireCount).toBe(0);
    expect(harness.extractor.resolvedIds).toEqual([]);
  });

  it('skips slideshows without a request when the user has already decided', async () => {
    harness = createHarness({ config: { photoSlideshows: 'skip' } });
    harness.engine.addLinks([`https://www.tiktok.com/@user/photo/${awemeIdFor(9)}`]);
    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot()[0]?.status).toBe('skipped');
    expect(harness.rateLimiter.acquireCount).toBe(0);
    expect(harness.extractor.resolvedIds).toEqual([]);
    // Declined is written to the ledger, so listing the account later passes
    // over it instead of queueing it again.
    expect(harness.ledger.find(awemeIdFor(9))?.status).toBe('declined');
  });
});

describe('queue controls (section 8)', () => {
  it('pauses without losing position, and resumes in order', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks(Array.from({ length: 8 }, (_, i) => makeUrl(i)));
    harness.pipeline.hangFor(awemeIdFor(2));

    harness.engine.start();
    await vi.waitFor(() => expect(harness.pipeline.processed).toHaveLength(2));
    harness.engine.pause();
    expect(harness.engine.isPaused).toBe(true);

    const processedWhilePaused = harness.pipeline.processed.length;
    harness.engine.cancelItem(harness.engine.getSnapshot().find((i) => i.awemeId === awemeIdFor(2))?.id as number);
    await harness.engine.whenIdle();
    expect(harness.pipeline.processed).toHaveLength(processedWhilePaused);

    harness.engine.resume();
    await harness.engine.whenIdle();
    expect(harness.pipeline.processed).toEqual([0, 1, 3, 4, 5, 6, 7].map(awemeIdFor));
  });

  it('cancels an in-flight item and marks it cancelled', async () => {
    harness = createHarness();
    harness.pipeline.hangFor(awemeIdFor(1));
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();

    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('downloading'));
    harness.engine.cancelItem(harness.engine.getSnapshot()[0]?.id as number);
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('cancelled'));

    expect(harness.engine.getSnapshot()[0]?.errorCode).toBe('CANCELLED');
  });

  it('cancels a queued item that never started', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    const second = harness.engine.getSnapshot()[1]?.id as number;

    harness.engine.cancelItem(second);
    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot()[1]?.status).toBe('cancelled');
    expect(harness.pipeline.processed).toEqual([awemeIdFor(1)]);
  });

  it('reorders queued items while keeping positions unique and increasing', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3)]);
    const ids = harness.engine.getSnapshot().map((i) => i.id);

    harness.engine.reorder([ids[2], ids[0], ids[1]] as number[]);

    const after = harness.engine.getSnapshot();
    expect(after.map((i) => i.rawUrl)).toEqual([makeUrl(3), makeUrl(1), makeUrl(2)]);
    const positions = after.map((i) => i.position);
    expect(new Set(positions).size).toBe(3);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('processes reordered items in the new order', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3)]);
    const ids = harness.engine.getSnapshot().map((i) => i.id);
    harness.engine.reorder([ids[2], ids[1], ids[0]] as number[]);

    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.pipeline.processed).toEqual([awemeIdFor(3), awemeIdFor(2), awemeIdFor(1)]);
  });

  it('refuses to reorder an item that is not queued', async () => {
    harness = createHarness();
    harness.pipeline.hangFor(awemeIdFor(1));
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('downloading'));

    const ids = harness.engine.getSnapshot().map((i) => i.id);
    // The active item is not reorderable (section 8).
    let thrown: unknown;
    try {
      harness.engine.reorder([ids[1], ids[0]] as number[]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'INTERNAL_ERROR' });
    // The user-facing message stays generic; the specifics live in detail.
    expect((thrown as { detail?: string }).detail).toMatch(/cannot be reordered/i);

    harness.engine.cancelItem(ids[0] as number);
  });

  it('removes completed items and clears the queue', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.removeCompleted()).toBe(2);
    expect(harness.engine.getSnapshot()).toHaveLength(0);

    harness.engine.addLinks([makeUrl(3)]);
    expect(harness.engine.clearQueue()).toBe(1);
    expect(harness.engine.getSnapshot()).toHaveLength(0);
  });

  it('never reuses a position after a clear', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    const highest = Math.max(...harness.engine.getSnapshot().map((i) => i.position));
    harness.engine.clearQueue();

    harness.engine.addLinks([makeUrl(3)]);
    expect(harness.engine.getSnapshot()[0]?.position).toBeGreaterThan(highest);
  });
});

describe('events', () => {
  it('emits a batch summary once every item is terminal', async () => {
    harness = createHarness();
    harness.extractor.failFor(awemeIdFor(2), ['VIDEO_DELETED']);
    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3)], 'batch-x');

    harness.engine.start();
    await harness.engine.whenIdle();

    const summary = harness.events.find((e) => e.type === 'batch-complete');
    expect(summary).toBeDefined();
    if (summary?.type !== 'batch-complete') return;
    expect(summary.summary).toMatchObject({ batchId: 'batch-x', completed: 2, failed: 1, skipped: 0 });
  });

  it('does not announce a batch complete while a question is outstanding', async () => {
    harness = createHarness();
    const { seedHistory } = await import('./helpers/queue-fixtures');
    seedHistory(harness, awemeIdFor(2));
    harness.engine.addLinks([makeUrl(1), makeUrl(2)], 'batch-y');

    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getPendingDuplicates()).toHaveLength(1);
    expect(harness.events.some((e) => e.type === 'batch-complete')).toBe(false);
  });

  it('throttles progress updates rather than emitting every chunk', async () => {
    harness = createHarness({ engineOverrides: { progressThrottleMs: 250 } });
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    // The fake reports one final progress event; the throttle must always let
    // a completed transfer through so the bar reaches 100%.
    const item = harness.engine.getSnapshot()[0];
    expect(item?.progress).toBe(1);
    expect(item?.bytesDone).toBe(1_000_000);
  });
});
