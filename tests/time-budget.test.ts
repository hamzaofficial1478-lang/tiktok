import { afterEach, describe, expect, it, vi } from 'vitest';
import { awemeIdFor, createHarness, makeUrl, type Harness } from './helpers/queue-fixtures';

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

/**
 * The counter that quietly broke everything after two or three days.
 *
 * `busy_ms` is a per-video budget on how long one link may spend *talking to
 * TikTok*, and the migration that introduced it says exactly that: "Only the
 * part that talks to TikTok is counted. Re-encoding to strip a watermark and
 * transcribing for burned-in captions are legitimately slow and are work the
 * user asked for, not a video misbehaving."
 *
 * The code charged both phases. Every millisecond of ffmpeg went onto the same
 * counter as every millisecond of network.
 *
 * That was survivable while post-processing was a rare watermark re-encode. It
 * stopped being survivable the moment colour correction, sharpening and the
 * H.264 conversion began running on every video: minutes of local encoding per
 * attempt, charged against a fifteen-minute budget meant for a link that hangs.
 * Two or three attempts and a perfectly healthy video is over its limit — after
 * which the watchdog was armed for **one millisecond**, killed the first
 * process the next attempt spawned, and the row read
 *
 *     yt-dlp.exe was stopped before it finished
 *
 * which reads as a broken program or as something the user did, and is neither.
 * Then the budget check set the item aside for good, and the account it came
 * from offered the same video again on the next run because nothing had ever
 * been recorded as downloaded.
 *
 * Nothing was breaking. A counter was filling up.
 */
describe('the per-video time budget', () => {
  it('does not charge local processing to a network budget', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { itemDeadlineMs: 5_000, processingDeadlineMs: 5_000, itemTotalBudgetMs: 60_000 },
    });
    // Downloads instantly, then spends a long time in ffmpeg — a video with
    // colour correction, sharpening and a codec conversion to do.
    harness.pipeline.slowPostProcessFor(awemeIdFor(0), 120);

    harness.engine.addLinks([makeUrl(0)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const row = harness.queueItems.listOrdered()[0];
    expect(row?.status).toBe('completed');
    /**
     * The heart of it. That 120ms was work the user asked for, on a video that
     * downloaded without complaint, and charging it here is what eventually
     * left every row saying the download had been stopped.
     */
    expect(row?.busy_ms ?? 0).toBeLessThan(120);
  });

  it('still charges time spent waiting on TikTok', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { itemDeadlineMs: 60, itemTotalBudgetMs: 60_000 },
    });
    harness.pipeline.hangFor(awemeIdFor(0));

    harness.engine.addLinks([makeUrl(0)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.attemptCount).toBeGreaterThan(1), {
      timeout: 5_000,
    });

    // The budget still does its job: a link that hangs is exactly what it is
    // for, and it must not be relaxed into uselessness by the fix above.
    expect(harness.queueItems.listOrdered()[0]?.busy_ms ?? 0).toBeGreaterThan(0);
  });

  /**
   * A video that has downloaded is not the link the budget exists to stop.
   *
   * Everything it has left is local work. Carrying its network spend forward
   * meant a healthy video that hit a problem in post-processing came back to a
   * shorter window each time, until the watchdog was killing it before it could
   * start — and the queue then set it aside with a message about giving up on a
   * download that had in fact succeeded.
   */
  it('starts the budget over once the bytes are on disk', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { itemDeadlineMs: 5_000, itemTotalBudgetMs: 60_000 },
    });
    // A slow transfer that succeeds, followed by a step that does not.
    harness.pipeline.slowDownloadFor(awemeIdFor(0), 120);
    harness.pipeline.failAfterCommitFor(awemeIdFor(0), 99);

    harness.engine.addLinks([makeUrl(0)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.stagesDone.length).toBeGreaterThan(0));

    // Without the reset this would be at least the 120ms the transfer took, and
    // every retry would come back to a shorter window than the last.
    expect(harness.queueItems.listOrdered()[0]?.busy_ms ?? 0).toBeLessThan(120);
  });

  /**
   * The one-millisecond watchdog, which is what actually reached the user.
   *
   * An attempt with no budget left was armed with a timer that had already
   * expired, so it fired before the attempt had done anything and killed the
   * first process it spawned. Whatever is decided about a video that has run out
   * of time, starting an attempt and shooting it a millisecond later is not a
   * limit — it is a misleading way to fail.
   */
  it('gives an attempt it starts a real window, even with the budget spent', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      // The item is over budget from its very first attempt.
      engineOverrides: { itemDeadlineMs: 2_000, itemTotalBudgetMs: 1 },
    });
    // Long enough that a watchdog armed for a millisecond certainly kills it,
    // and short enough that a real window certainly does not.
    harness.pipeline.slowDownloadFor(awemeIdFor(0), 80);

    harness.engine.addLinks([makeUrl(0)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const item = harness.engine.getSnapshot()[0];
    // It downloaded. Before, it was aborted on the spot and reported as
    // "yt-dlp.exe was stopped before it finished".
    expect(item?.status).toBe('completed');
    expect(harness.pipeline.processed).toEqual([awemeIdFor(0)]);
  });

  it('says how long it actually waited, not how long it might have', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { itemDeadlineMs: 60, itemTotalBudgetMs: 60 },
    });
    harness.pipeline.hangFor(awemeIdFor(0));

    harness.engine.addLinks([makeUrl(0)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.finishedAt).not.toBeNull(), { timeout: 5_000 });

    const detail = harness.engine.getSnapshot()[0]?.errorDetail ?? '';
    // Never "0 seconds", which reads as the app not having tried at all.
    expect(detail).not.toMatch(/\b0 seconds\b/);
    expect(detail).toMatch(/gave up after .+ without finishing|set aside/i);
  });
});

/**
 * The same video, twice, a couple of rows apart.
 *
 * Visible in a queue screenshot as two entries with identical nineteen-digit
 * ids under the same handle. TikTok's profile listing repeats a post from time
 * to time — a pinned video that also appears in date order, or the same post
 * arriving in two pages while the account is being scrolled — and both copies
 * were queued and downloaded into the same folder.
 *
 * Neither existing layer catches it: the paste-level dedup only sees one call
 * at a time, and the in-queue check looks for rows that are still *active* and
 * finds nothing once the first copy has finished or failed.
 */
describe('a listing that offers the same video twice', () => {
  it('takes it once', async () => {
    const { selectNewVideos } = await import('@main/creators/creator-runner');
    const url = (n: number): string => `https://www.tiktok.com/@alpha/video/711111111111111111${n}`;

    const picked = selectNewVideos([url(1), url(2), url(1), url(3)], 10, () => false);

    expect(picked.urls).toHaveLength(3);
    expect(new Set(picked.urls).size).toBe(3);
  });

  it('does not let the repeat eat one of the slots the account was given', async () => {
    const { selectNewVideos } = await import('@main/creators/creator-runner');
    const url = (n: number): string => `https://www.tiktok.com/@alpha/video/711111111111111111${n}`;

    // Asking for three from a listing whose first entry appears twice must
    // still deliver three different videos.
    const picked = selectNewVideos([url(1), url(1), url(2), url(3)], 3, () => false);
    expect(new Set(picked.urls).size).toBe(3);
  });
});
