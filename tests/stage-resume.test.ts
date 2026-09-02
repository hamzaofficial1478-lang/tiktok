import { afterEach, describe, expect, it, vi } from 'vitest';
import { awemeIdFor, createHarness, makeUrl, type Harness } from './helpers/queue-fixtures';
import { readResumeState } from '@main/queue/types';

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

/**
 * Where a download is, and where it stopped.
 *
 * A download is seven steps presented for a long time as one. The row said
 * "downloading" for the transfer and "processing" for everything after it, so a
 * video four minutes into a re-encode and a video that was genuinely wedged
 * showed the same word — and a failure named the error but never the step that
 * produced it.
 *
 * The two halves of the fix are tested together here because they are the same
 * mechanism: once the steps are named and written down, the row can say which
 * one is running, which one failed, and — because the note survives the failure
 * — a retry can start at that one instead of at the link.
 */
describe('the steps of a download', () => {
  it('names the step that failed', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 99);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();

    // The fake throws from the finishing pass. Before this, the row could say
    // "ffmpeg failed" and nothing whatsoever about where.
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.failedStage).toBe('finish'));
  });

  it('names the step that failed when the failure is before any bytes land', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    // Terminal, so the row settles and stays put to be inspected.
    harness.pipeline.failFor(awemeIdFor(1), ['VIDEO_DELETED']);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('failed'));

    expect(harness.engine.getSnapshot()[0]?.failedStage).toBe('download');
    // Nothing was banked, so the retry is a fresh start — which is correct:
    // there is no file to resume from.
    expect(harness.engine.getSnapshot()[0]?.stagesDone).toEqual([]);
  });

  it('shows the steps already banked while the item waits to try again', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 99);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.stagesDone.length).toBeGreaterThan(0));

    /**
     * The promise the row is making.
     *
     * "Trying again in 8s" on a video that has already downloaded reads as a
     * threat to download it a second time — which is exactly what used to
     * happen. This is what lets the row say the bytes are kept.
     */
    expect(harness.engine.getSnapshot()[0]?.stagesDone).toEqual(['download', 'verify']);
  });

  it('clears the note once the item is finished with', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const row = harness.queueItems.listOrdered()[0];
    expect(row?.status).toBe('completed');
    // A finished row carries no leftover state: nothing to resume, no step
    // running, and no stale "failed here" on a row that succeeded.
    expect(row?.resume_state).toBeNull();
    expect(row?.stage).toBeNull();
    expect(harness.engine.getSnapshot()[0]?.stagesDone).toEqual([]);
  });

  /**
   * The case the whole feature exists for.
   *
   * Quitting mid-processing is not exotic — it is what happens every time
   * someone closes the app while a batch is re-encoding — and every one of
   * those used to cost a second copy of whatever was in flight.
   *
   * Set up by writing the note a dead process would have left, rather than by
   * killing one: the note *is* the whole interface between the two runs, and a
   * test that builds it directly is testing the thing that has to work while
   * being immune to how fast the first run happened to get through its retries.
   */
  it('resumes a note left by a process that is gone, without downloading again', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1)]);

    const id = harness.queueItems.listOrdered()[0]?.id ?? 0;
    harness.existingFiles.add('/out/left-behind.mp4');
    harness.queueItems.update(id, {
      resumeState: JSON.stringify({ filePath: '/out/left-behind.mp4', done: ['download', 'verify'] }),
    });

    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
    // The bytes were never asked for a second time, and the steps that had not
    // run did run.
    expect(harness.pipeline.transfers).toEqual([]);
    expect(harness.pipeline.processed).toEqual([awemeIdFor(1)]);
    expect(harness.pipeline.stageLog).toContain(`${awemeIdFor(1)}:download:skipped`);
  });

  /**
   * A note pointing at a file that is not there any more.
   *
   * Someone deleted the half-finished video, or moved the output folder, or
   * cleaned up by hand. The note is then worthless and must be discarded
   * whole — half-believing it would skip the steps a fresh download genuinely
   * needs to do.
   */
  it('starts over when the file the note names has gone', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1)]);

    const id = harness.queueItems.listOrdered()[0]?.id ?? 0;
    harness.queueItems.update(id, {
      // Never added to the virtual filesystem: the note is a lie.
      resumeState: JSON.stringify({ filePath: '/out/deleted.mp4', done: ['download', 'verify'] }),
    });

    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
    // Fetched, because this time there was genuinely nothing to keep — and
    // fetched once, under its own name rather than beside a phantom.
    expect(harness.pipeline.transfers).toEqual([awemeIdFor(1)]);
  });

  /**
   * The note survives the process that wrote it.
   *
   * Held in a column rather than in the engine's memory, so a crash mid-encode
   * leaves the next launch something to act on. Losing it is what made every
   * quit during processing cost a second copy of the video.
   */
  it('writes the note where a restart can find it', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 99);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.stagesDone.length).toBeGreaterThan(0));
    await harness.engine.stop();

    const parked = readResumeState(harness.queueItems.listOrdered()[0]?.resume_state ?? null);
    expect(parked?.done).toEqual(['download', 'verify']);
    expect(parked?.filePath).toBe(`/out/${awemeIdFor(1)}.mp4`);
    // However many attempts the ladder spent, the video was fetched once.
    expect(harness.pipeline.transfers).toEqual([awemeIdFor(1)]);
  });

  /**
   * A resuming item must not meet the duplicate layers.
   *
   * Every one of them would find this item's own file, or its own ledger entry,
   * and conclude somebody had already taken the video — parking it on a
   * question about itself or skipping it outright, and leaving the outstanding
   * steps outstanding for ever. It is the failure mode that a narrower version
   * of this fix actually shipped with.
   */
  it('is not mistaken for a duplicate of itself', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 1);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'));

    const snapshot = harness.engine.getSnapshot()[0];
    expect(snapshot?.status).toBe('completed');
    expect(snapshot?.status).not.toBe('awaiting_user');
    expect(harness.pipeline.processed).toEqual([awemeIdFor(1)]);
  });

  it('keeps the note when an item is cancelled, so Retry finishes it', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.slowPostProcessFor(awemeIdFor(1), 60_000);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('processing'));

    harness.engine.cancelItem(harness.engine.getSnapshot()[0]?.id ?? 0);
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('cancelled'));

    /**
     * A cancel during processing leaves a complete file on disk. Tearing up the
     * note there would make Retry mean "download it all over again", which is
     * the opposite of what someone pressing it wants.
     */
    expect(harness.queueItems.listOrdered()[0]?.resume_state).not.toBeNull();
  });
});
