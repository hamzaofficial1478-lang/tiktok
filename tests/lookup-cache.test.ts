import { afterEach, describe, expect, it, vi } from 'vitest';
import { awemeIdFor, createHarness, makeUrl, type Harness } from './helpers/queue-fixtures';
import type { NormalizedUrl, ResolvedVideo } from '@main/resolve/types';
import type { ErrorCode } from '@shared/errors';

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

/**
 * Fetches one real answer out of the fake extractor and forgets that it asked.
 *
 * The cache holds whatever the extractor returned, so a test that builds one by
 * hand should build it out of the same shape rather than a hand-written stub
 * that could drift from the real thing.
 */
async function answerFor(index: number): Promise<{ normalized: NormalizedUrl; resolved: ResolvedVideo }> {
  const scratch = createHarness({});
  const resolved = await scratch.extractor.resolve(makeUrl(index));
  scratch.close();

  return {
    normalized: {
      awemeId: awemeIdFor(index),
      canonicalUrl: makeUrl(index),
      authorHandle: `user${index}`,
      kind: 'video',
      viaShortLink: false,
      rawUrl: makeUrl(index),
    },
    resolved,
  };
}

/** Puts a cached answer of a given age onto the item's row. */
async function cacheLookup(index: number, ageMs: number): Promise<void> {
  const answer = await answerFor(index);
  const id = harness.queueItems.listOrdered()[0]?.id ?? 0;
  harness.queueItems.update(id, {
    lookup: JSON.stringify({ at: harness.clock.now() - ageMs, ...answer }),
  });
}

/**
 * The lookup, and the two ways it used to lose a video.
 *
 * Every attempt starts by asking TikTok for the video's details, and that
 * request is the one TikTok is most likely to refuse — in bursts, to some links
 * and not others, minutes apart from the same machine, with a message telling
 * you to update yt-dlp that has nothing to do with anything.
 */
describe('the lookup', () => {
  /**
   * The sharp one. An attempt that got the bytes and fell over at a later step
   * is retried, and the retry began by asking for details it does not need —
   * the video is downloaded, and everything left is local ffmpeg work. A
   * refusal there killed the item and left the video in the output folder
   * unprocessed for good.
   */
  it('is not made at all by an item that already has the video', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1)]);

    const answer = await answerFor(1);
    const id = harness.queueItems.listOrdered()[0]?.id ?? 0;
    harness.existingFiles.add('/out/already-here.mp4');
    harness.queueItems.update(id, {
      resumeState: JSON.stringify({ filePath: '/out/already-here.mp4', done: ['download', 'verify'] }),
      lookup: JSON.stringify({ at: harness.clock.now(), ...answer }),
    });

    // TikTok refusing every request it is sent. The item must not care.
    harness.extractor.failFor(awemeIdFor(1), Array<ErrorCode>(9).fill('RESOLVE_FAILED'));

    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
    // Not "asked and was turned down" — never asked. The fallback below would
    // also have rescued this item, so the assertion has to be on the request
    // rather than on the answer.
    expect(harness.extractor.resolveCalls).toEqual([]);
    // Nor did it fetch the video again on the way past.
    expect(harness.pipeline.transfers).toEqual([]);
  });

  it('says on the row that the step was skipped rather than run', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1)]);

    const answer = await answerFor(1);
    const id = harness.queueItems.listOrdered()[0]?.id ?? 0;
    harness.existingFiles.add('/out/already-here.mp4');
    harness.queueItems.update(id, {
      resumeState: JSON.stringify({ filePath: '/out/already-here.mp4', done: ['download', 'verify'] }),
      lookup: JSON.stringify({ at: harness.clock.now(), ...answer }),
    });
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 99);

    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.failedStage).toBe('finish'));

    // It failed at the finishing pass, which is the truth. Before the cache it
    // would have failed at the lookup, which was a lie about a video sitting
    // complete on the disk.
    expect(harness.extractor.resolveCalls).toEqual([]);
  });

  /**
   * The ordinary one. A lookup that succeeded four minutes ago describes the
   * same video as a lookup now, so failing the link because the second request
   * was refused throws away an answer that is still true.
   */
  it('falls back on a recent answer when TikTok refuses a fresh one', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1)]);
    await cacheLookup(1, 4 * 60_000);

    harness.extractor.failFor(awemeIdFor(1), Array<ErrorCode>(9).fill('RESOLVE_FAILED'));

    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
    expect(harness.pipeline.transfers).toEqual([awemeIdFor(1)]);
  });

  it('will not fall back on an answer old enough for its stream URLs to have expired', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1)]);
    await cacheLookup(1, 3 * 60 * 60_000);

    harness.extractor.failFor(awemeIdFor(1), Array<ErrorCode>(9).fill('RESOLVE_FAILED'));

    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('failed'));

    // Trading a lookup failure for a download failure against expired URLs
    // would be no better and would read worse.
    expect(harness.engine.getSnapshot()[0]?.errorCode).toBe('RESOLVE_FAILED');
    expect(harness.pipeline.transfers).toEqual([]);
  });

  /**
   * The line that keeps this honest.
   *
   * Deleted, private, region-blocked and age-gated are verdicts about the
   * video, not refusals of the request. Answering a verdict with an answer from
   * before it was handed down would have the app try to download a video that
   * has since been taken down, and insist a private account is still public.
   */
  it.each<[ErrorCode]>([['VIDEO_DELETED'], ['VIDEO_PRIVATE'], ['REGION_BLOCKED'], ['AGE_RESTRICTED']])(
    'does not paper over %s with a cached answer',
    async (code) => {
      harness = createHarness({ config: { concurrency: 1 } });
      harness.engine.addLinks([makeUrl(1)]);
      await cacheLookup(1, 60_000);

      harness.extractor.failFor(awemeIdFor(1), [code]);

      harness.engine.start();
      await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('failed'));

      expect(harness.engine.getSnapshot()[0]?.errorCode).toBe(code);
      expect(harness.pipeline.transfers).toEqual([]);
    },
  );

  it('keeps the answer as soon as it has one, not when the item succeeds', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 99);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.failedStage).toBe('finish'));

    // The attempt that needs it is the *next* one, so it has to be on the row
    // before the step that is about to go wrong — not after a success that may
    // never come.
    expect(harness.queueItems.listOrdered()[0]?.lookup).not.toBeNull();
  });

  it('throws the answer away once the item is finished with', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const row = harness.queueItems.listOrdered()[0];
    expect(row?.status).toBe('completed');
    expect(row?.lookup).toBeNull();
  });

  it('ignores a cached answer that belongs to a different video', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1)]);

    // Item 1's row, carrying item 2's answer. Substituting it would download
    // the wrong video under the right name.
    const answer = await answerFor(2);
    const id = harness.queueItems.listOrdered()[0]?.id ?? 0;
    harness.queueItems.update(id, { lookup: JSON.stringify({ at: harness.clock.now(), ...answer }) });
    harness.extractor.failFor(awemeIdFor(1), Array<ErrorCode>(9).fill('RESOLVE_FAILED'));

    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('failed'));

    expect(harness.pipeline.transfers).toEqual([]);
  });

  it('ignores a cached answer it cannot read', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1)]);

    const id = harness.queueItems.listOrdered()[0]?.id ?? 0;
    harness.queueItems.update(id, { lookup: '{ not json at all' });

    harness.engine.start();
    await harness.engine.whenIdle();

    // A note written by an older build must cost one network request, never a
    // crash inside the worker loop.
    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
  });
});
