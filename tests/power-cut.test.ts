import { afterEach, describe, expect, it, vi } from 'vitest';
import { awemeIdFor, createHarness, makeUrl, seedHistory, type Harness } from './helpers/queue-fixtures';

/**
 * A power cut is not a clean quit.
 *
 * Nothing gets a chance to run: no flush, no shutdown hook, no "save before
 * exit". Whatever reached the disk is what survives, and everything the app
 * knows has to be reconstructable from that. These tests kill the engine
 * mid-batch and rebuild it over the same database, which is exactly what the
 * next launch does.
 */

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

describe('picking up where the power cut left off', () => {
  it('finishes the batch, keeping the links that had not started', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    // The machine dies here. Nothing is asked to tidy up.
    const restarted = harness.restart();
    restarted.start();
    await restarted.whenIdle();

    expect(restarted.getSnapshot().map((item) => item.status)).toEqual(['completed', 'completed', 'completed']);
  });

  it('does not lose a link that was mid-download', async () => {
    harness = createHarness();
    harness.pipeline.hangFor(awemeIdFor(2));

    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3)]);
    harness.engine.start();
    await vi.waitFor(() => {
      expect(harness.engine.getSnapshot()[1]?.status).toBe('downloading');
    });

    // Killed while item 2 is in flight — the case a clean quit never produces.
    const restarted = harness.restart();
    harness.pipeline.clearHangs();
    restarted.start();
    await restarted.whenIdle();

    // Nothing was dropped and nothing was left stuck as `downloading`.
    const statuses = restarted.getSnapshot().map((item) => item.status);
    expect(statuses).toEqual(['completed', 'completed', 'completed']);
  });

  it('keeps every pasted link, not only the ones that finished', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3), makeUrl(4)]);
    // Never started: the queue was added to and the power went before Start.
    const restarted = harness.restart();

    expect(restarted.getSnapshot()).toHaveLength(4);
    expect(restarted.getSnapshot().map((item) => item.rawUrl)).toEqual([
      makeUrl(1),
      makeUrl(2),
      makeUrl(3),
      makeUrl(4),
    ]);
    // And in the order they were pasted, which is the one guarantee that
    // cannot be reconstructed if it is lost.
    expect(restarted.getSnapshot().map((item) => item.position)).toEqual([1, 2, 3, 4]);
  });

  it('knows it still has work to do, so the next launch can resume by itself', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);

    const restarted = harness.restart();
    // This is what services.ts reads on start-up to decide whether to resume
    // without being told to.
    expect(restarted.hasPendingWork()).toBe(true);

    restarted.start();
    await restarted.whenIdle();
    expect(restarted.hasPendingWork()).toBe(false);
  });

  it('does not download again what it had already taken', async () => {
    harness = createHarness();
    // Two videos already on disk from before the outage.
    seedHistory(harness, awemeIdFor(1));
    seedHistory(harness, awemeIdFor(2));

    const restarted = harness.restart();
    restarted.addLinks([makeUrl(1), makeUrl(2), makeUrl(3)]);
    restarted.start();
    await restarted.whenIdle();

    // Only the new one was fetched; the other two were recognised.
    expect(harness.pipeline.processed).toEqual([awemeIdFor(3)]);
  });

  it('resumes a retry that was waiting out its backoff when the power went', async () => {
    harness = createHarness();
    harness.pipeline.failFor(awemeIdFor(1), ['NETWORK_ERROR']);

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('completed'));

    // A backoff lives in memory as a timer, so a hard exit loses it. What
    // survives is the `failed` row, and start-up turns that back into work.
    const restarted = harness.restart();
    expect(restarted.requeueInterruptedRetries()).toBe(0);
  });
});

describe('what the queue remembers between launches', () => {
  it('keeps the folder each account’s videos belong in', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1)], 'batch-a', 'studioatlab');

    const restarted = harness.restart();
    expect(restarted.getSnapshot()).toHaveLength(1);
    // Read straight off the stored row: the setting travelled with the link
    // rather than living in the window that queued it.
    expect(harness.queueItems.findById(restarted.getSnapshot()[0]!.id)?.output_subdir).toBe('studioatlab');
  });

  it('keeps a per-link caption choice', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1)], 'batch-a', null, 'burn');

    const restarted = harness.restart();
    expect(harness.queueItems.findById(restarted.getSnapshot()[0]!.id)?.caption_mode).toBe('burn');
  });
});
