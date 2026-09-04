import { afterEach, describe, expect, it, vi } from 'vitest';
import { awemeIdFor, createHarness, makeUrl, type Harness } from './helpers/queue-fixtures';
import { EXTRACTOR_SUSPECT_THRESHOLD } from '@main/queue/queue-engine';
import { MAX_RETRIES } from '@main/queue/retry-policy';
import type { ErrorCode } from '@shared/errors';

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

/**
 * A batch must never be held up by one bad link.
 *
 * This is the shape of the complaint: twelve links pasted, one of them broken,
 * and an hour later nothing at all had downloaded. Two separate faults added up
 * to it.
 *
 * The first is ordering. A failed item is requeued for its next attempt keeping
 * the position it already had, and the engine claims by position — so it was
 * picked up again immediately, ahead of every link behind it, for all four of
 * its attempts. At the default concurrency of one, the batch went nowhere.
 *
 * The second is time. Each attempt was allowed to run for a very long time
 * before anything gave up on it, so those four attempts were not quick.
 */
describe('a failing link does not hold up the ones behind it', () => {
  it('runs the untried links first and comes back to the failure', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    // Fails its first attempt, succeeds on the retry.
    harness.pipeline.failFor(awemeIdFor(0), ['NETWORK_ERROR']);

    harness.engine.addLinks([0, 1, 2, 3].map(makeUrl));
    harness.engine.start();
    await vi.waitFor(() => {
      expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
    });

    // Every call, in order. The retry comes last; it used to come second,
    // straight back to the front of the queue while three untouched links
    // waited behind it.
    expect(harness.pipeline.attempts).toEqual([0, 1, 2, 3, 0].map(awemeIdFor));
  });

  it('keeps every attempt behind the links that have not been tried yet', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failFor(awemeIdFor(0), ['NETWORK_ERROR', 'NETWORK_ERROR', 'NETWORK_ERROR']);

    harness.engine.addLinks([0, 1, 2].map(makeUrl));
    harness.engine.start();
    await vi.waitFor(() => {
      expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
    });

    const order = harness.pipeline.attempts;
    // Both healthy links are tried before the failure's second attempt.
    expect(order.slice(0, 3)).toEqual([0, 1, 2].map(awemeIdFor));
    expect(order.filter((id) => id === awemeIdFor(0))).toHaveLength(4);
  });

  /**
   * The guarantee stated as the user stated it: every link that can download
   * does, and only then are the failures tried again.
   *
   * Several links failing is the case that decides it. One failure behaving
   * itself proves little — the question is whether a run with three bad links
   * among nine good ones works through all nine first, or ends up alternating
   * between the broken ones while good links wait.
   */
  it('finishes every healthy link before retrying any failure', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    for (const bad of [1, 4, 7]) harness.pipeline.failFor(awemeIdFor(bad), ['NETWORK_ERROR']);

    const links = Array.from({ length: 9 }, (_, i) => i);
    harness.engine.addLinks(links.map(makeUrl));
    harness.engine.start();
    await vi.waitFor(() => {
      expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
    });

    const healthy = links.filter((i) => ![1, 4, 7].includes(i)).map(awemeIdFor);
    const firstPass = harness.pipeline.attempts.slice(0, 9);
    // The first nine attempts are the nine links, each once. No link is tried
    // a second time while another has not been tried at all.
    expect([...firstPass].sort()).toEqual([...links.map(awemeIdFor)].sort());
    // And every healthy one is finished before the first retry happens.
    const firstRetryAt = harness.pipeline.attempts.findIndex(
      (id, i) => harness.pipeline.attempts.indexOf(id) !== i,
    );
    const beforeAnyRetry = new Set(harness.pipeline.attempts.slice(0, firstRetryAt));
    for (const id of healthy) expect(beforeAnyRetry.has(id)).toBe(true);
  });

  it('does not disturb the running order when nothing fails', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([0, 1, 2, 3, 4].map(makeUrl));
    harness.engine.start();
    await harness.engine.whenIdle();

    // Every item is on attempt zero, so this is plain insertion order — the
    // ordering change must cost nothing in the ordinary case.
    expect(harness.pipeline.processed).toEqual([0, 1, 2, 3, 4].map(awemeIdFor));
  });

  it('leaves the queue numbering alone, so filenames keep counting in order', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failFor(awemeIdFor(1), ['NETWORK_ERROR']);

    harness.engine.addLinks([0, 1, 2].map(makeUrl));
    const before = harness.engine.getSnapshot().map((i) => i.position);

    harness.engine.start();
    await vi.waitFor(() => {
      expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
    });

    // `{index}` in the filename template is the row's position. Reordering by
    // rewriting positions would have renumbered the file and left a gap in a
    // folder meant to read in order, so the fix must not touch them.
    expect(harness.engine.getSnapshot().map((i) => i.position)).toEqual(before);
  });
});

/**
 * The backstop: no single item may hold a worker indefinitely.
 *
 * Every step has its own timeout, but "every step has a timeout" is not the
 * same promise as "the queue keeps moving" — a step added later, or one whose
 * timeout is generous, puts the whole batch back on hold. This is the guarantee
 * that does not depend on getting each of those right.
 */
describe('an item that never finishes', () => {
  it('is failed as a timeout and does not stop the queue', async () => {
    harness = createHarness({ config: { concurrency: 1 }, engineOverrides: { itemDeadlineMs: 40 } });
    harness.pipeline.hangFor(awemeIdFor(0));

    harness.engine.addLinks([0, 1, 2].map(makeUrl));
    harness.engine.start();

    await vi.waitFor(
      () => {
        expect(harness.engine.getSnapshot().slice(1).every((i) => i.status === 'completed')).toBe(true);
      },
      { timeout: 5_000 },
    );

    const stuck = harness.engine.getSnapshot()[0];
    // Not 'cancelled'. An abort the app made to protect itself must not be
    // written down as the user abandoning the video — cancelled is terminal,
    // so the item the watchdog rescued the queue from would have been the one
    // thing the run silently lost.
    expect(stuck?.status).not.toBe('cancelled');
    expect(stuck?.errorCode).toBe('NETWORK_ERROR');
    // The window it was actually given, whatever that happened to be. The
    // message used to quote the per-attempt ceiling even when the item had been
    // handed a fraction of it — telling someone their download had eight
    // minutes when it had ninety seconds sends them to look at their
    // connection instead of at the row that says it is nearly out of time.
    expect(stuck?.errorDetail ?? '').toMatch(/gave up after .+ without finishing/i);
  });

  it('gets its retries like any other transient failure', async () => {
    harness = createHarness({ config: { concurrency: 1 }, engineOverrides: { itemDeadlineMs: 40 } });
    harness.pipeline.hangFor(awemeIdFor(0));

    harness.engine.addLinks([makeUrl(0)]);
    harness.engine.start();

    await vi.waitFor(
      () => expect(harness.engine.getSnapshot()[0]?.attemptCount).toBeGreaterThan(1),
      { timeout: 5_000 },
    );
  });

  it('leaves a slow re-encode alone once the bytes are in', async () => {
    harness = createHarness({ config: { concurrency: 1 }, engineOverrides: { itemDeadlineMs: 40 } });
    // Downloads promptly, then spends far longer than the limit processing.
    harness.pipeline.slowPostProcessFor(awemeIdFor(0), 250);

    harness.engine.addLinks([makeUrl(0)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'), { timeout: 5_000 });

    // Removing a watermark re-encodes the video and burning in captions
    // transcribes it first. Cutting either short would fail a download that
    // worked perfectly — and fail it again on every retry.
    expect(harness.engine.getSnapshot()[0]?.errorCode).toBeNull();
  });

  /**
   * The hole the download limit left behind it.
   *
   * The limit used to be switched *off* once the bytes were in, because
   * re-encoding to strip a watermark and transcribing for burned-in captions
   * are legitimately slow and a network timeout is the wrong thing to hold
   * them to. But "the wrong limit" was replaced with no limit at all, and past
   * that line an item could sit forever — which is exactly what a queue stuck
   * on one download that never moves and never fails looks like.
   *
   * The subprocesses each have their own timeouts, and that reasoning is what
   * produced the hole: fifteen minutes for a re-encode plus fifteen for
   * captions plus thirty for a transcription is an hour of ceilings that never
   * sum to one.
   */
  it('is still bounded once the download is done and processing starts', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { itemDeadlineMs: 30_000, processingDeadlineMs: 40 },
    });
    // Reports that processing has begun, then never finishes it.
    harness.pipeline.slowPostProcessFor(awemeIdFor(0), 60_000);

    harness.engine.addLinks([makeUrl(0), makeUrl(1)]);
    harness.engine.start();

    await vi.waitFor(
      () => expect(harness.engine.getSnapshot()[1]?.status).toBe('completed'),
      { timeout: 5_000 },
    );

    // It was cut short rather than left running: the attempt was counted, and
    // the healthy link behind it got the worker. Without a ceiling here the
    // first item would still be processing and the second would never start.
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.attemptCount).toBeGreaterThan(0), {
      timeout: 5_000,
    });
  });

  it('gives processing its own, longer allowance rather than the download\'s', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      // A download limit far too short for the processing that follows it: if
      // the two shared a clock, this would be cut off at 40ms.
      engineOverrides: { itemDeadlineMs: 40, processingDeadlineMs: 30_000 },
    });
    harness.pipeline.slowPostProcessFor(awemeIdFor(0), 200);

    harness.engine.addLinks([makeUrl(0)]);
    harness.engine.start();

    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'), { timeout: 5_000 });
    expect(harness.engine.getSnapshot()[0]?.errorCode).toBeNull();
  });

  it('never fires for an item that finishes in time', async () => {
    harness = createHarness({ config: { concurrency: 1 }, engineOverrides: { itemDeadlineMs: 30_000 } });
    harness.engine.addLinks([0, 1].map(makeUrl));
    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
  });
});

/**
 * And then what happens when the queue reaches the failures?
 *
 * Moving retries behind the untried links answers half the question — the
 * healthy videos all download first. It does not answer the other half. An
 * item gets four automatic attempts plus the end-of-run sweep, so five
 * attempts at the per-attempt limit still add up to most of an hour on one
 * link, and the queue would arrive at its failures and settle down on them
 * exactly as it used to at the start. Several bad links, and that is the
 * afternoon.
 *
 * So the real limit is a total across every attempt. A video that has spent it
 * is set aside and the queue moves on for good. Measured in time rather than
 * attempts on purpose: a link that fails in two seconds costs nothing and
 * keeps every retry it is entitled to — those are the ones a retry fixes — and
 * only the ones that hang run out.
 */
describe('the total time one video may cost', () => {
  it('stops retrying a video that has spent its whole budget', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { itemDeadlineMs: 40, itemTotalBudgetMs: 60 },
    });
    harness.pipeline.hangFor(awemeIdFor(0));

    harness.engine.addLinks([makeUrl(0)]);
    harness.engine.start();

    await vi.waitFor(
      () => {
        const item = harness.engine.getSnapshot()[0];
        expect(item?.status).toBe('failed');
        expect(item?.finishedAt).not.toBeNull();
      },
      { timeout: 5_000 },
    );

    // Two attempts of 40ms exceed a 60ms budget; a fifth is never reached.
    expect(harness.engine.getSnapshot()[0]?.attemptCount).toBeLessThan(4);
    expect(harness.engine.getSnapshot()[0]?.errorDetail ?? '').toMatch(/set aside/i);
  });

  it('does not sweep it back in at the end of the run', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { itemDeadlineMs: 40, itemTotalBudgetMs: 60 },
    });
    harness.pipeline.hangFor(awemeIdFor(0));

    harness.engine.addLinks([makeUrl(0), makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[1]?.status).toBe('completed'), { timeout: 5_000 });
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.finishedAt).not.toBeNull(), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    /**
     * Two attempts, and no third.
     *
     * Each hang costs the 40ms deadline, so the second one takes the total past
     * the 60ms budget and the item is set aside. The sweep runs after that —
     * the batch is finished by then — and its whole job is to give failures one
     * more go. Handing it this item would be the queue undoing its own
     * decision and settling back down on it, which is the behaviour the budget
     * exists to end, so the sweep skips anything that ran out of time.
     */
    const item = harness.engine.getSnapshot()[0];
    expect(item?.status).toBe('failed');
    expect(item?.attemptCount).toBeLessThanOrEqual(2);
  });

  it('leaves the whole retry ladder to a link that fails quickly', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { itemDeadlineMs: 5_000, itemTotalBudgetMs: 10_000 },
    });
    harness.pipeline.failFor(awemeIdFor(0), Array.from({ length: 10 }, () => 'NETWORK_ERROR' as const));

    harness.engine.addLinks([makeUrl(0), makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.finishedAt).not.toBeNull(), { timeout: 5_000 });

    // A failure that costs nothing is exactly the kind a retry fixes, so the
    // budget must not take its attempts away: the full ladder plus the sweep.
    expect(harness.engine.getSnapshot()[0]?.attemptCount).toBe(MAX_RETRIES + 2);
  });

  it('charges the time to the row, so a restart cannot start the hour over', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { itemDeadlineMs: 40, itemTotalBudgetMs: 10_000 },
    });
    harness.pipeline.hangFor(awemeIdFor(0));

    harness.engine.addLinks([makeUrl(0)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.attemptCount).toBeGreaterThan(1), {
      timeout: 5_000,
    });

    const row = harness.queueItems.findById(harness.engine.getSnapshot()[0]!.id);
    expect(row?.busy_ms ?? 0).toBeGreaterThan(0);
  });

  it('gives a fresh budget when a person presses Retry', async () => {
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { itemDeadlineMs: 40, itemTotalBudgetMs: 60 },
    });
    harness.pipeline.hangFor(awemeIdFor(0));

    harness.engine.addLinks([makeUrl(0)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.finishedAt).not.toBeNull(), { timeout: 5_000 });

    const id = harness.engine.getSnapshot()[0]!.id;
    await harness.engine.stop();
    harness.pipeline.clearHangs();
    harness.engine.retryItem(id);

    // Someone pressing Retry has usually changed something. Holding the time
    // spent before the fix against the attempt after it makes the button
    // useless on exactly the items that need it.
    expect(harness.queueItems.findById(id)?.busy_ms).toBe(0);
  });
});

/**
 * An abort nobody claims.
 *
 * "yt-dlp was stopped before it finished" against a video the user never
 * stopped is the symptom, and the reason it was so hard to place is that every
 * abort reaches the failure path looking identical — a cancel, a suspend, a
 * quit and a bug all arrive as the same CANCELLED. Cancelled is terminal, so
 * whatever the cause, the video vanished from the run with a half-written
 * `.part` beside it and nothing said.
 *
 * Each known cause now records itself before aborting. What is left over is
 * treated as a fault rather than as an intention, which is the branch that
 * stops the next cause of this — one nobody has written yet — from silently
 * losing a video again.
 */
describe('a download aborted for no recorded reason', () => {
  it('is retried rather than written off as cancelled', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failFor(awemeIdFor(0), ['CANCELLED']);

    harness.engine.addLinks([makeUrl(0), makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => {
      expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
    });

    expect(harness.pipeline.attempts.filter((id) => id === awemeIdFor(0))).toHaveLength(2);
  });

  it('still honours the cancel when the user is the one who asked', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.hangFor(awemeIdFor(0));

    harness.engine.addLinks([makeUrl(0), makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('downloading'));

    harness.engine.cancelItem(harness.engine.getSnapshot()[0]!.id);
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('cancelled'));
  });
});

/**
 * Noticing that yt-dlp itself is the problem.
 *
 * TikTok changes without warning and a yt-dlp build that worked last week can
 * fail on everything this week. The start-up check only looks for a newer one
 * when the installed build is over a week old — which is exactly wrong for a
 * build four days old that TikTok has already broken. Links failing, one after
 * another, in the way a broken extractor makes them fail, is better evidence
 * than a release date.
 */
describe('spotting a broken extractor from the failures', () => {
  const suspect = (): ErrorCode[] => Array.from({ length: 8 }, () => 'EXTRACTOR_FAILED' as const);

  it('reports it once several links in a row fail the same way', async () => {
    const seen: { failures: number; lastCode: ErrorCode }[] = [];
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { onExtractorSuspect: (info) => seen.push(info) },
    });
    for (let i = 0; i < EXTRACTOR_SUSPECT_THRESHOLD; i++) harness.extractor.failFor(awemeIdFor(i), suspect());

    harness.engine.addLinks(Array.from({ length: EXTRACTOR_SUSPECT_THRESHOLD }, (_, i) => makeUrl(i)));
    harness.engine.start();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));

    expect(seen[0]?.failures).toBe(EXTRACTOR_SUSPECT_THRESHOLD);
    expect(seen[0]?.lastCode).toBe('EXTRACTOR_FAILED');
  });

  it('reports it once, not once per failing link', async () => {
    const seen: unknown[] = [];
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { onExtractorSuspect: () => seen.push(1) },
    });
    for (let i = 0; i < 6; i++) harness.extractor.failFor(awemeIdFor(i), suspect());

    harness.engine.addLinks(Array.from({ length: 6 }, (_, i) => makeUrl(i)));
    harness.engine.start();
    await harness.engine.whenIdle();

    // Six links, four attempts each: without the guard this would fire around
    // twenty times and kick off twenty update checks.
    expect(seen).toHaveLength(1);
  });

  it('stays quiet when the failures are about the videos, not the extractor', async () => {
    const seen: unknown[] = [];
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { onExtractorSuspect: () => seen.push(1) },
    });
    for (let i = 0; i < 4; i++) harness.extractor.failFor(awemeIdFor(i), ['VIDEO_DELETED']);

    harness.engine.addLinks(Array.from({ length: 4 }, (_, i) => makeUrl(i)));
    harness.engine.start();
    await harness.engine.whenIdle();

    // A deleted video says nothing about yt-dlp. Counting these would have the
    // app fetching a new extractor every time someone pasted an old link.
    expect(seen).toEqual([]);
  });

  it('forgets the streak as soon as something downloads', async () => {
    const seen: unknown[] = [];
    harness = createHarness({
      config: { concurrency: 1 },
      engineOverrides: { onExtractorSuspect: () => seen.push(1) },
    });
    // Two bad, one good, two bad — never three in a row.
    harness.extractor.failFor(awemeIdFor(0), ['EXTRACTOR_FAILED']);
    harness.extractor.failFor(awemeIdFor(1), ['EXTRACTOR_FAILED']);
    harness.extractor.failFor(awemeIdFor(3), ['EXTRACTOR_FAILED']);
    harness.extractor.failFor(awemeIdFor(4), ['EXTRACTOR_FAILED']);

    harness.engine.addLinks([0, 1, 2, 3, 4].map(makeUrl));
    harness.engine.start();
    await harness.engine.whenIdle();

    // A download that worked is proof the extractor works.
    expect(seen).toEqual([]);
  });
});
