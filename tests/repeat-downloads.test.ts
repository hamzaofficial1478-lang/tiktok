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
 * retry found the committed file sitting there, picked the next free name
 * beside it, and downloaded the entire video again — because the only record
 * that said "this one is taken" was written at the very end, on success, and
 * that end was never reached.
 *
 * The more work there is after the commit, the more often this fires, which is
 * why it arrived with the enhancement settings rather than before them.
 */
describe('a video that is already on disk', () => {
  it('is not downloaded again when a later step fails', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    // Commits the file, then throws — post-processing failing on a video that
    // has already finished downloading.
    harness.pipeline.failAfterCommitFor(awemeIdFor(1), 1);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.finishedAt).not.toBeNull());

    // Downloaded once, and the retry never even reached the pipeline: the
    // check happens before the transfer is started, so the second copy is not
    // fetched and then discarded, it is never requested.
    expect(harness.pipeline.attempts).toEqual([awemeIdFor(1)]);
    expect(harness.engine.getSnapshot()[0]?.status).toBe('skipped');
    expect(harness.engine.getSnapshot()[0]?.errorDetail).toMatch(/already downloaded/i);
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
  });

  it('still downloads normally when nothing fails after the commit', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    // The guard must not turn a healthy download into a skipped one.
    expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
    expect(harness.pipeline.processed).toEqual([awemeIdFor(1), awemeIdFor(2)]);
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
});
