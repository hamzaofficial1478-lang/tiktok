import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyYtDlpFailure } from '@main/resolve/yt-dlp-errors';
import { describeError } from '@shared/errors';
import { awemeIdFor, createHarness, makeUrl, type Harness } from './helpers/queue-fixtures';

/**
 * The failure a real batch actually hit.
 *
 *     ERROR: [TikTok] 7674605024353324320: Unable to extract universal data
 *     for rehydration; please report this issue on …
 *
 * Three of twelve links failed with it, the app said "Extractor out of date —
 * update the extractor, then retry", and updating reported the extractor was
 * already current. Every part of that was wrong:
 *
 *  - Nine of the twelve downloaded fine, so the extractor plainly parses
 *    TikTok. yt-dlp reads the video out of a data blob that TikTok only puts
 *    in the page for requests it accepts as a browser; when it decides a
 *    request looks automated, it serves the page without it.
 *  - The item failed on attempt 1 and stopped, because EXTRACTOR_FAILED is
 *    not auto-retryable — the one code where a retry was most likely to work.
 *  - The end-of-run sweep skipped it too, for the same reason.
 */

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

const REAL_STDERR =
  'ERROR: [TikTok] 7674605024353324320: Unable to extract universal data for rehydration; ' +
  'please report this issue on https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the ' +
  'appropriate issue template. Confirm you are on the latest version using yt-dlp -U';

describe('classifying a page served without its video data', () => {
  it('is not reported as a stale extractor', () => {
    const result = classifyYtDlpFailure({ stderr: REAL_STDERR, exitCode: 1 });

    expect(result.code).toBe('RESOLVE_FAILED');
    // The old answer sent the user to press Update and be told there was
    // nothing to update, with no next step from there.
    expect(result.code).not.toBe('EXTRACTOR_FAILED');
  });

  it('is retried automatically, which is the whole point of the reclassification', () => {
    const descriptor = describeError(classifyYtDlpFailure({ stderr: REAL_STDERR }).code);
    expect(descriptor.autoRetry).toBe(true);
    expect(descriptor.userRetryable).toBe(true);
  });

  it('still reports a genuinely unparseable response as a stale extractor', () => {
    // The generic rule has to keep working, or the reclassification has just
    // hidden the failure it was meant to distinguish itself from.
    expect(classifyYtDlpFailure({ stderr: 'ERROR: Unsupported URL: https://example.com' }).code).toBe(
      'EXTRACTOR_FAILED',
    );
    expect(classifyYtDlpFailure({ stderr: 'ERROR: [TikTok] failed to parse JSON' }).code).toBe('EXTRACTOR_FAILED');
  });

  it('does not swallow the failures that must stay terminal', () => {
    // Ordering in the rules table decides these, and getting it wrong would
    // spend the retry budget on videos that will never download.
    expect(classifyYtDlpFailure({ stderr: 'ERROR: Video not found' }).code).toBe('VIDEO_DELETED');
    expect(classifyYtDlpFailure({ stderr: 'ERROR: This video is private' }).code).toBe('VIDEO_PRIVATE');
  });
});

describe('what the queue does with it', () => {
  it('retries instead of failing on the first attempt', async () => {
    harness = createHarness();
    // Fails once, then works — which is how it behaved in the field.
    harness.extractor.failFor(awemeIdFor(1), ['RESOLVE_FAILED']);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'));

    // One recorded failure, and a completed row: it failed, waited, and got
    // there on its own. Before the reclassification it stopped at the failure.
    expect(harness.engine.getSnapshot()[0]?.attemptCount).toBe(1);
    // The backoff actually ran rather than the item being requeued instantly.
    expect(harness.clock.sleeps).toContain(2_000);
  });

  it('sweeps it at the end of the run when the retries are spent', async () => {
    harness = createHarness();
    // Four failures exhausts the ladder; the fifth attempt is the sweep.
    harness.extractor.failFor(awemeIdFor(1), Array.from({ length: 4 }, () => 'RESOLVE_FAILED' as const));

    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'));

    // The link that failed did not hold up the one behind it, and it still
    // ended up downloaded rather than sitting failed with a Retry button.
    expect(harness.pipeline.processed).toContain(awemeIdFor(1));
    expect(harness.pipeline.processed).toContain(awemeIdFor(2));
  });

  it('sweeps a stale-extractor failure too, rather than leaving it for the user', async () => {
    harness = createHarness();
    // EXTRACTOR_FAILED is not auto-retryable and never will be, but it is
    // user-retryable — so the end-of-run sweep is exactly the manual retry
    // the user would otherwise have to press themselves.
    harness.extractor.failFor(awemeIdFor(1), ['EXTRACTOR_FAILED']);

    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'));
  });

  it('leaves a deleted video alone', async () => {
    harness = createHarness();
    harness.extractor.failFor(awemeIdFor(1), ['VIDEO_DELETED', 'VIDEO_DELETED']);

    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const row = harness.engine.getSnapshot()[0];
    expect(row?.status).toBe('failed');
    // One attempt, no ladder and no sweep: retrying cannot change the answer.
    expect(row?.attemptCount).toBe(1);
  });
});
