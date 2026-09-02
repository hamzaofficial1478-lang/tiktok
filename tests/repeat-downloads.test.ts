import { afterEach, describe, expect, it, vi } from 'vitest';
import { awemeIdFor, createHarness, makeUrl, type Harness } from './helpers/queue-fixtures';

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

/**
 * One video, downloaded twice.
 *
 * The pipeline commits the file under its final name and then keeps working on
 * it: watermark removal, captions, colour correction, the finishing pass that
 * converts the codec and applies the filters. Every one of those runs *after*
 * the bytes are safely on disk, and every one of them can throw.
 *
 * When one did, the item failed. The queue retried it, as it should. And the
 * retry started from the link — re-extracting, re-transferring, and, finding
 * the committed file already sitting there, saving the second copy beside it
 * under the next free name. One video, two files, for a fault in a step that
 * had nothing to do with downloading.
 *
 * The more work there is after the commit, the more often this fires, which is
 * why it arrived with the enhancement settings rather than before them.
 *
 * The fix is not to refuse the retry — that would leave the video permanently
 * half-processed — but to make the retry pick up where the last one stopped.
 */
describe('a video that is already on disk', () => {
  it('is not fetched a second time when a later step fails', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    // Commits the file, then throws — post-processing failing on a video that
    // has already finished downloading.
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 1);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'));

    // Two attempts, one transfer. The second attempt ran the steps that had not
    // happened yet and left the bytes alone.
    expect(harness.pipeline.attempts).toEqual([awemeIdFor(1), awemeIdFor(1)]);
    expect(harness.pipeline.transfers).toEqual([awemeIdFor(1)]);
  });

  it('finishes the steps that failed rather than abandoning them', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 1);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'));

    /**
     * The distinction that matters.
     *
     * Simply declining to retry would also stop the second download, and it was
     * the first thing tried. It is wrong: the video would keep whatever state
     * the failed attempt left it in — no watermark pass, no colour correction,
     * no finishing encode — for ever, with the row cheerfully reporting it as
     * settled. A resumption does the outstanding work.
     */
    expect(harness.pipeline.processed).toEqual([awemeIdFor(1)]);
    expect(harness.pipeline.stageLog).toContain(`${awemeIdFor(1)}:download:skipped`);
    expect(harness.pipeline.stageLog).toContain(`${awemeIdFor(1)}:finish:done`);
  });

  it('is recorded as taken the moment the file exists', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 5);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.ledger.isSettled(awemeIdFor(1))).toBe(true));

    // The ledger is what every later "have I taken this?" reads, and it must
    // not wait for the parts of the job that come after the download.
    expect(harness.ledger.isSettled(awemeIdFor(1))).toBe(true);
  });

  it('does not let the failure hold up the rest of the batch', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failAfterCommitFor(awemeIdFor(0), 4);

    harness.engine.addLinks([0, 1, 2].map(makeUrl));
    harness.engine.start();
    await vi.waitFor(() => {
      expect(harness.engine.getSnapshot().slice(1).every((i) => i.status === 'completed')).toBe(true);
    });

    expect(harness.pipeline.processed).toEqual([awemeIdFor(1), awemeIdFor(2)]);
    // However many times the broken one is retried, it is fetched once.
    expect(harness.pipeline.transfers.filter((id) => id === awemeIdFor(0))).toEqual([awemeIdFor(0)]);
  });

  it('still downloads normally when nothing fails after the commit', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    // The guard must not turn a healthy download into a skipped one.
    expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
    expect(harness.pipeline.processed).toEqual([awemeIdFor(1), awemeIdFor(2)]);
    expect(harness.pipeline.transfers).toEqual([awemeIdFor(1), awemeIdFor(2)]);
  });

  it('is never taken twice by a later creator run either', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 9);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.ledger.isSettled(awemeIdFor(1))).toBe(true));

    // What a creator run reads to decide whether an account still owes videos.
    // Without the entry it would offer this one again on every single run.
    expect(harness.ledger.downloadedByHandle().get('user1')).toBe(1);
  });

  /**
   * A second queue row for a video the library already has.
   *
   * Distinct from a resumption: there is no work in flight to pick up, just a
   * link somebody pasted again. The ledger answers that one, and it must keep
   * answering it — the resume path is exempt from the duplicate layers, and an
   * exemption written a little too widely would turn every repeat link into a
   * fresh download.
   */
  it('is skipped when a different link asks for a video already taken', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 99);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.ledger.isSettled(awemeIdFor(1))).toBe(true));
    await harness.engine.stop();

    // A fresh row for the same video, with none of the first row's state.
    harness.queueItems.removeAll();
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.finishedAt).not.toBeNull());

    expect(harness.engine.getSnapshot()[0]?.status).toBe('skipped');
    expect(harness.engine.getSnapshot()[0]?.errorDetail).toMatch(/already downloaded/i);
  });
});
