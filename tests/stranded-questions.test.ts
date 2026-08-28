import { afterEach, describe, expect, it, vi } from 'vitest';
import { awemeIdFor, createHarness, makeUrl, seedHistory, type Harness } from './helpers/queue-fixtures';

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

/**
 * The queue that quietly stops working after a day or two.
 *
 * Layer 3 and the slideshow prompt park an item in `awaiting_user` and hold the
 * question — who posted it, where the existing file is — in a Map on the
 * engine. The status reaches the database; the question does not, because it is
 * a live conversation with a window that is open now.
 *
 * Then the app is quit. The row comes back as `awaiting_user` and the Map is
 * empty. Crash recovery does not touch it, because from the database's point of
 * view nothing was in flight. Nothing rebuilds the question, so no modal can
 * appear and no answer can be given — the row is stranded for good.
 *
 * One stranded row is a download that looks stuck. What makes it get worse over
 * time is that they accumulate, one per quit while a question was open, and
 * that a single one of them holds its whole batch open: `checkBatchComplete`
 * counts `awaiting_user` as outstanding, so the batch never finishes, the
 * end-of-run retry never runs for the genuinely failed links beside it, and the
 * batch's in-memory state is never released.
 */
describe('a question the app can no longer ask', () => {
  /** Queues a link whose video is already in the library, so layer 3 parks it. */
  async function parkOne(): Promise<number> {
    harness.engine.addLinks([makeUrl(1)]);
    seedHistory(harness, awemeIdFor(1));
    harness.existingFiles.add(`/out/${awemeIdFor(1)}.mp4`);

    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('awaiting_user'));
    return harness.engine.getSnapshot()[0]!.id;
  }

  it('is left parked while the process that asked it is still running', async () => {
    harness = createHarness();
    await parkOne();

    harness.engine.recoverUnansweredQuestions();

    // The window can still be shown this one — the renderer re-asks for pending
    // questions when it mounts — so requeueing it would throw away a real
    // question and re-download behind the user's back.
    expect(harness.engine.getSnapshot()[0]?.status).toBe('awaiting_user');
    expect(harness.engine.getPendingDuplicates()).toHaveLength(1);
  });

  it('is put back in the queue when the process that asked it has gone', async () => {
    harness = createHarness();
    await parkOne();
    await harness.engine.stop();

    // A restart: the rows survive, the in-memory questions do not.
    const next = harness.restart();
    expect(next.getPendingDuplicates()).toHaveLength(0);
    expect(next.getSnapshot()[0]?.status).toBe('awaiting_user');

    expect(next.recoverUnansweredQuestions()).toBe(1);
    expect(next.getSnapshot()[0]?.status).toBe('queued');
  });

  it('asks again on the next run, rather than deciding for the user', async () => {
    harness = createHarness();
    await parkOne();
    await harness.engine.stop();

    const next = harness.restart();
    next.recoverUnansweredQuestions();
    next.start();

    // Requeued, not resolved: the decision was never made, so the item simply
    // has not been processed yet. Running it re-checks and parks it again —
    // this time with a live question and a window to show it in.
    await vi.waitFor(() => expect(next.getSnapshot()[0]?.status).toBe('awaiting_user'));
    expect(next.getPendingDuplicates()).toHaveLength(1);
  });

  it('never silently downloads a duplicate it should have asked about', async () => {
    harness = createHarness();
    await parkOne();
    await harness.engine.stop();

    const next = harness.restart();
    next.recoverUnansweredQuestions();
    next.start();
    await vi.waitFor(() => expect(next.getSnapshot()[0]?.status).toBe('awaiting_user'));

    // The recovery must not become a way for a duplicate to slip through.
    expect(harness.pipeline.processed).toEqual([]);
  });

  /**
   * The part that turns one stuck row into a batch that never finishes.
   *
   * `awaiting_user` counts as outstanding, so the batch stays open: no
   * completion event, no end-of-run retry for the genuinely failed links
   * beside it, and none of its in-memory state released.
   */
  it('stops holding its whole batch open once recovered', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    seedHistory(harness, awemeIdFor(1));
    harness.existingFiles.add(`/out/${awemeIdFor(1)}.mp4`);

    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('awaiting_user'));
    await harness.engine.stop();

    const next = harness.restart();
    next.recoverUnansweredQuestions();
    next.adoptUnfinishedBatches();
    // Answer it the moment it is asked again, so the batch can finish.
    next.subscribe((event) => {
      if (event.type === 'duplicate-pending') next.resolveDuplicate(event.pending.itemId, 'skip');
    });
    next.start();

    await vi.waitFor(() => {
      expect(harness.events.some((e) => e.type === 'batch-complete')).toBe(true);
    });
  });

  /**
   * The same shape of fault, one level up.
   *
   * `knownBatches` is what stops a completion being announced for work this
   * engine never saw, and `addLinks` is the only thing that fills it in. After
   * a restart it is empty, so `checkBatchComplete` returns at its first line
   * for every batch that came back from disk — no completion event, no
   * summary, and no end-of-run retry for the links that failed, because that
   * lives behind the same guard. The app is built to start at login and pick
   * the queue back up, so this fired every time it did what it was designed
   * to do.
   */
  it('announces a batch that was picked up from disk, and sweeps its failures', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.failFor(awemeIdFor(2), ['NETWORK_ERROR', 'NETWORK_ERROR', 'NETWORK_ERROR', 'NETWORK_ERROR']);
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    await harness.engine.stop();

    const next = harness.restart();
    next.adoptUnfinishedBatches();
    harness.events.length = 0;
    next.start();
    await next.whenIdle();

    await vi.waitFor(() => {
      expect(harness.events.some((e) => e.type === 'batch-complete')).toBe(true);
    });
    // The sweep is behind the same guard, so it comes back with the event: the
    // ladder's four attempts, and then the one at the end of the run that this
    // link needed. Without the adoption it stayed failed and was never asked
    // again.
    await vi.waitFor(() => expect(next.getSnapshot()[1]?.status).toBe('completed'));
    expect(harness.pipeline.attempts.filter((id) => id === awemeIdFor(2))).toHaveLength(5);
  });

  it('does not announce batches that were already finished before the restart', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await harness.engine.whenIdle();
    await harness.engine.stop();

    const next = harness.restart();
    harness.events.length = 0;

    // Every row is terminal, so there is nothing outstanding to adopt — and
    // firing a completion for last week's work on every launch would be its
    // own kind of noise.
    expect(next.adoptUnfinishedBatches()).toBe(0);
    expect(harness.events.some((e) => e.type === 'batch-complete')).toBe(false);
  });

  it('leaves everything else exactly as it found it', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    // Nothing was ever parked, so there is nothing to recover and nothing to
    // disturb about two finished downloads.
    expect(harness.engine.recoverUnansweredQuestions()).toBe(0);
    expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
  });
});
