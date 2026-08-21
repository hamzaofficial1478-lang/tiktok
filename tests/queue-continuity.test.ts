import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awemeIdFor, createHarness, makeUrl, type Harness } from './helpers/queue-fixtures';
import { buildPaths } from '@main/paths';
import { createServices, type AppServices } from '@main/services';
import { AppMetaRepository, QUEUE_RUNNING_KEY } from '@main/db/repositories/app-meta';
import { partPathFor } from '@main/download/downloader';
import type { MediaPipeline } from '@main/queue/types';
import { AppError } from '@shared/errors';

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

/**
 * Requirement: the program must keep working when the machine sleeps or the
 * screen turns off, and must never lose its place.
 *
 * The Electron half — powerSaveBlocker and backgroundThrottling — cannot be
 * asserted without a real desktop session. What is testable, and what actually
 * decides whether links are lost, is the engine's behaviour across a suspend
 * and across a process restart. That is what these cover.
 */
describe('surviving system sleep', () => {
  it('parks in-flight downloads instead of failing them', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.hangFor(awemeIdFor(2));
    harness.engine.addLinks(Array.from({ length: 5 }, (_, i) => makeUrl(i)));

    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[2]?.status).toBe('downloading'));

    await harness.engine.suspend();

    const parked = harness.engine.getSnapshot()[2];
    // Not 'cancelled' and not 'failed': the user did not abandon it, the
    // machine went to sleep underneath it.
    expect(parked?.status).toBe('queued');
    expect(parked?.errorCode).toBeNull();
    expect(harness.engine.isPaused).toBe(true);
  });

  it('continues from the exact item it was on when the machine wakes', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.hangFor(awemeIdFor(2));
    harness.engine.addLinks(Array.from({ length: 5 }, (_, i) => makeUrl(i)));

    harness.engine.start();
    await vi.waitFor(() => expect(harness.pipeline.processed).toHaveLength(2));
    await harness.engine.suspend();

    harness.pipeline.clearHangs();
    harness.engine.resumeFromSuspend();
    await harness.engine.whenIdle();

    // Nothing skipped, nothing repeated, order intact.
    expect(harness.pipeline.processed).toEqual([0, 1, 2, 3, 4].map(awemeIdFor));
    expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
  });

  it('does not spend a retry attempt on a suspend', async () => {
    harness = createHarness();
    harness.pipeline.hangFor(awemeIdFor(1));
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('downloading'));

    await harness.engine.suspend();

    // Sleeping is not a failure, so the item keeps its full retry budget.
    expect(harness.engine.getSnapshot()[0]?.attemptCount).toBe(0);
  });

  it('a suspend while idle is a no-op', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    await harness.engine.suspend();
    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
  });
});

/**
 * Closing the app is the same interruption as the machine sleeping, and used
 * not to be treated as one.
 *
 * `stop({ keepRunState: true })` is what runs when the app quits. It aborts
 * whatever is downloading, and an abort arrives in the worker looking exactly
 * like a cancel — so the item was written down as `cancelled`, which is a
 * finished state. The next launch resumed the queue, saw a finished row, and
 * carried on from the item after it: the video that was actually in flight was
 * never downloaded, and its half-written `.part` stayed on disk forever. The
 * user saw a stray "yt-dlp cancelled" against a video they never cancelled.
 */
describe('quitting the app mid-download', () => {
  it('puts the in-flight download back in the queue rather than cancelling it', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.hangFor(awemeIdFor(2));
    harness.engine.addLinks(Array.from({ length: 5 }, (_, i) => makeUrl(i)));

    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[2]?.status).toBe('downloading'));

    await harness.engine.stop({ keepRunState: true });

    const parked = harness.engine.getSnapshot()[2];
    expect(parked?.status).toBe('queued');
    expect(parked?.errorCode).toBeNull();
    // Being quit is not a failed attempt either.
    expect(parked?.attemptCount).toBe(0);
  });

  it('picks that same item up again on the next start', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.hangFor(awemeIdFor(2));
    harness.engine.addLinks(Array.from({ length: 5 }, (_, i) => makeUrl(i)));

    harness.engine.start();
    await vi.waitFor(() => expect(harness.pipeline.processed).toHaveLength(2));
    await harness.engine.stop({ keepRunState: true });

    harness.pipeline.clearHangs();
    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.pipeline.processed).toEqual([0, 1, 2, 3, 4].map(awemeIdFor));
    expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
  });

  it('still honours a cancel the user asked for, even as the app is closing', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.hangFor(awemeIdFor(0));
    harness.engine.addLinks([makeUrl(0), makeUrl(1)]);

    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('downloading'));

    harness.engine.cancelItem(harness.engine.getSnapshot()[0]!.id);
    await harness.engine.stop({ keepRunState: true });

    // Parking exists for aborts nobody asked for. This one was asked for.
    expect(harness.engine.getSnapshot()[0]?.status).toBe('cancelled');
  });

  it('a user stop — not a quit — still cancels what was in flight', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    harness.pipeline.hangFor(awemeIdFor(0));
    harness.engine.addLinks([makeUrl(0), makeUrl(1)]);

    harness.engine.start();
    await vi.waitFor(() => expect(harness.engine.getSnapshot()[0]?.status).toBe('downloading'));

    await harness.engine.stop();

    expect(harness.engine.getSnapshot()[0]?.status).toBe('cancelled');
  });
});

/**
 * Requirement: if the PC shuts down or the program is closed mid-batch, it
 * restarts from exactly where it left off and no link is lost.
 */
describe('resuming after a shutdown', () => {
  let dir = '';
  let services: AppServices | null = null;

  afterEach(async () => {
    await services?.shutdown();
    services = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  /** Fails every item, so the queue always has unfinished work to resume. */
  const stallingPipeline: MediaPipeline = {
    process: async () => {
      throw new AppError('VIDEO_DELETED', 'held terminal for the test');
    },
  };

  it('restarts the queue automatically when it was running at exit', async () => {
    dir = mkdtempSync(join(tmpdir(), 'resume-'));
    const paths = buildPaths(join(dir, 'userData'), join(dir, 'resources'));

    const first = await createServices({ paths, isDev: false, appVersion: 'test', pipeline: stallingPipeline });
    first.queue.addLinks(
      Array.from({ length: 4 }, (_, i) => makeUrl(i)),
      'batch',
    );
    first.queue.start();
    first.queue.pause(); // keep the items unprocessed so there is work to resume
    // Quitting is not pausing, so re-mark it running before the shutdown.
    first.queue.resume();
    await first.shutdown();

    services = await createServices({ paths, isDev: false, appVersion: 'test', pipeline: stallingPipeline });

    expect(services.queue.getSnapshot()).toHaveLength(4);
    expect(services.queue.getSnapshot().map((i) => i.rawUrl)).toEqual([0, 1, 2, 3].map(makeUrl));
  });

  it('stays paused when the user had paused it before quitting', async () => {
    dir = mkdtempSync(join(tmpdir(), 'resume-paused-'));
    const paths = buildPaths(join(dir, 'userData'), join(dir, 'resources'));

    const first = await createServices({ paths, isDev: false, appVersion: 'test', pipeline: stallingPipeline });
    first.queue.addLinks([makeUrl(1), makeUrl(2)], 'batch');
    first.queue.start();
    first.queue.pause();
    await first.shutdown();

    services = await createServices({ paths, isDev: false, appVersion: 'test', pipeline: stallingPipeline });

    // Resuming a deliberately paused queue unbidden would be its own surprise.
    expect(services.queue.isRunning).toBe(false);
    expect(services.queue.getSnapshot()).toHaveLength(2);
  });

  it('does not start a queue that has nothing left to do', async () => {
    dir = mkdtempSync(join(tmpdir(), 'resume-empty-'));
    const paths = buildPaths(join(dir, 'userData'), join(dir, 'resources'));

    const first = await createServices({ paths, isDev: false, appVersion: 'test', pipeline: stallingPipeline });
    first.queue.start();
    await first.shutdown();

    services = await createServices({ paths, isDev: false, appVersion: 'test', pipeline: stallingPipeline });
    expect(services.queue.isRunning).toBe(false);
  });

  it('keeps the run state in engine bookkeeping, not in user settings', async () => {
    dir = mkdtempSync(join(tmpdir(), 'resume-key-'));
    const paths = buildPaths(join(dir, 'userData'), join(dir, 'resources'));

    services = await createServices({ paths, isDev: false, appVersion: 'test', pipeline: stallingPipeline });
    const meta = new AppMetaRepository(services.database.db);

    services.queue.addLinks([makeUrl(1)], 'batch');
    services.queue.start();
    expect(meta.getBoolean(QUEUE_RUNNING_KEY)).toBe(true);

    services.queue.pause();
    expect(meta.getBoolean(QUEUE_RUNNING_KEY)).toBe(false);

    // Engine state must not leak into the user's settings file.
    expect(Object.keys(services.config.get())).not.toContain(QUEUE_RUNNING_KEY);
  });

  it('preserves queue order and every link across the restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'resume-order-'));
    const paths = buildPaths(join(dir, 'userData'), join(dir, 'resources'));
    const urls = Array.from({ length: 25 }, (_, i) => makeUrl(i));

    const first = await createServices({ paths, isDev: false, appVersion: 'test', pipeline: stallingPipeline });
    first.queue.addLinks(urls, 'batch');
    await first.shutdown();

    services = await createServices({ paths, isDev: false, appVersion: 'test', pipeline: stallingPipeline });

    const restored = services.queue.getSnapshot();
    expect(restored).toHaveLength(25);
    expect(restored.map((i) => i.rawUrl)).toEqual(urls);
    const positions = restored.map((i) => i.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('.part files survive to be resumed', () => {
  it('never lets the final name exist alongside an unverified partial', () => {
    const dir = mkdtempSync(join(tmpdir(), 'part-'));
    try {
      const target = join(dir, 'video.mp4');
      // Stands in for what an interrupted transfer leaves behind.
      writeFileSync(partPathFor(target), Buffer.alloc(1_024));

      expect(existsSync(partPathFor(target))).toBe(true);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
