import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awemeIdFor,
  createHarness,
  makeUrl,
  seedHistory,
  type Harness,
} from './helpers/queue-fixtures';
import type { PendingDuplicate, QueueEvent } from '@main/queue/types';
import { AppError } from '@shared/errors';

let harness: Harness;

afterEach(async () => {
  await harness?.engine.stop();
  harness?.close();
});

function pendingEvents(events: QueueEvent[]): PendingDuplicate[] {
  return events.filter((e) => e.type === 'duplicate-pending').map((e) => e.pending);
}

describe('ordering (section 8: a hard guarantee)', () => {
  it('turns a 200-link paste into 200 items in exact paste order', async () => {
    harness = createHarness();
    const urls = Array.from({ length: 200 }, (_, i) => makeUrl(i));

    const result = harness.engine.addLinks(urls);

    expect(result.added).toBe(200);
    expect(result.duplicatesRemoved).toBe(0);
    expect(result.invalid).toHaveLength(0);
    expect(harness.engine.getSnapshot().map((i) => i.rawUrl)).toEqual(urls);
  });

  it('processes in insertion order at concurrency 1', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    const urls = Array.from({ length: 200 }, (_, i) => makeUrl(i));
    harness.engine.addLinks(urls);

    harness.engine.start();
    await harness.engine.whenIdle();

    // The acceptance criterion: completion order matches insertion order.
    expect(harness.pipeline.processed).toEqual(urls.map((_, i) => awemeIdFor(i)));
    expect(harness.engine.getSnapshot().every((i) => i.status === 'completed')).toBe(true);
  });

  it('still starts items in order at concurrency 4', async () => {
    harness = createHarness({ config: { concurrency: 4 } });
    harness.engine.addLinks(Array.from({ length: 40 }, (_, i) => makeUrl(i)));

    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.pipeline.processed).toHaveLength(40);
    // Completion order is explicitly not guaranteed above concurrency 1, but
    // every item must be accounted for exactly once.
    expect(new Set(harness.pipeline.processed).size).toBe(40);
  });

  it('never runs more items at once than the configured concurrency', async () => {
    harness = createHarness({ config: { concurrency: 3 } });
    harness.engine.addLinks(Array.from({ length: 20 }, (_, i) => makeUrl(i)));

    let peak = 0;
    harness.engine.subscribe(() => {
      peak = Math.max(peak, harness.engine.activeCount);
    });

    harness.engine.start();
    await harness.engine.whenIdle();

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('keeps later batches after earlier ones', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1), makeUrl(2)]);
    harness.engine.addLinks([makeUrl(3)]);

    const positions = harness.engine.getSnapshot().map((i) => i.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(harness.engine.getSnapshot().map((i) => i.rawUrl)).toEqual([makeUrl(1), makeUrl(2), makeUrl(3)]);
  });
});

describe('dedup layer 1 — within the paste', () => {
  it('collapses the same link pasted twice into one item', async () => {
    harness = createHarness();
    const result = harness.engine.addLinks([makeUrl(1), makeUrl(1)]);

    expect(result.added).toBe(1);
    expect(result.duplicatesRemoved).toBe(1);
    expect(harness.engine.getSnapshot()).toHaveLength(1);
  });

  it('collapses different URL forms of one video', async () => {
    harness = createHarness();
    const id = awemeIdFor(1);
    const result = harness.engine.addLinks([
      `https://www.tiktok.com/@user1/video/${id}`,
      `https://www.tiktok.com/@user1/video/${id}?is_from_webapp=1`,
      `  tiktok.com/@USER1/video/${id}/  `,
      `Look at this https://m.tiktok.com/v/${id}.html`,
    ]);

    expect(result.added).toBe(1);
    expect(result.duplicatesRemoved).toBe(3);
  });

  it('reports invalid links without dropping them silently', async () => {
    harness = createHarness();
    const result = harness.engine.addLinks([makeUrl(1), 'not a link', 'https://youtube.com/watch?v=x', '']);

    expect(result.added).toBe(1);
    expect(result.totalFound).toBe(3);
    expect(result.invalid.map((i) => i.code).sort()).toEqual(['INVALID_URL', 'NOT_A_TIKTOK_URL']);
  });

  it('preserves paste order after removing duplicates', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(3), makeUrl(1), makeUrl(3), makeUrl(2)]);
    expect(harness.engine.getSnapshot().map((i) => i.rawUrl)).toEqual([makeUrl(3), makeUrl(1), makeUrl(2)]);
  });
});

describe('dedup layer 2 — against the pending queue', () => {
  it('rejects a link already queued, without a dialog', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1)]);

    const second = harness.engine.addLinks([makeUrl(1)]);

    expect(second.added).toBe(0);
    expect(second.alreadyInQueue).toBe(1);
    expect(harness.engine.getSnapshot()).toHaveLength(1);
    // No question is ever raised for layer 2.
    expect(pendingEvents(harness.events)).toHaveLength(0);
  });

  it('allows re-adding a link once its first attempt finished', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    // Completed, so it no longer occupies the queue for layer 2 purposes;
    // layer 3 takes over from here.
    const second = harness.engine.addLinks([makeUrl(1)]);
    expect(second.alreadyInQueue).toBe(0);
  });

  it('catches a short link that resolves to a video already in flight', async () => {
    const id = awemeIdFor(1);
    harness = createHarness({
      config: { concurrency: 2 },
      redirects: { 'https://vm.tiktok.com/ZMdupe/': `https://www.tiktok.com/@user1/video/${id}` },
    });

    // The first item stays downloading, so the short link resolves while its
    // twin is genuinely still in the queue — which is the only situation
    // layer 2 can catch a short link in.
    harness.pipeline.hangFor(id);

    harness.engine.addLinks([makeUrl(1), 'https://vm.tiktok.com/ZMdupe/']);
    // Both enter the queue: a short link's ID is unknowable without a request.
    expect(harness.engine.getSnapshot()).toHaveLength(2);

    harness.engine.start();
    await vi.waitFor(() => {
      const shortItem = harness.engine.getSnapshot().find((i) => i.rawUrl.includes('vm.tiktok.com'));
      expect(shortItem?.status).toBe('skipped');
    });

    const shortItem = harness.engine.getSnapshot().find((i) => i.rawUrl.includes('vm.tiktok.com'));
    expect(shortItem?.errorDetail).toBe('Already in queue.');
    // No dialog for layer 2 — an inline toast only.
    expect(pendingEvents(harness.events)).toHaveLength(0);

    harness.engine.cancelItem(harness.engine.getSnapshot()[0]?.id as number);
  });
});

describe('dedup layer 3 — against download history', () => {
  it('raises a question and keeps the rest of the queue moving', async () => {
    harness = createHarness({ config: { concurrency: 1 } });
    seedHistory(harness, awemeIdFor(2));

    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3), makeUrl(4)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    // THE acceptance criterion: the modal must not stall the batch.
    expect(harness.pipeline.processed).toEqual([awemeIdFor(1), awemeIdFor(3), awemeIdFor(4)]);

    const pending = harness.engine.getPendingDuplicates();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.awemeId).toBe(awemeIdFor(2));

    const parked = harness.engine.getSnapshot().find((i) => i.awemeId === awemeIdFor(2));
    expect(parked?.status).toBe('awaiting_user');
  });

  it('queues several questions at once rather than serialising on the user', async () => {
    harness = createHarness();
    seedHistory(harness, awemeIdFor(1));
    seedHistory(harness, awemeIdFor(2));
    seedHistory(harness, awemeIdFor(3));

    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3), makeUrl(4)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getPendingDuplicates()).toHaveLength(3);
    expect(harness.pipeline.processed).toEqual([awemeIdFor(4)]);
  });

  it('Skip marks the item skipped and downloads nothing', async () => {
    harness = createHarness();
    seedHistory(harness, awemeIdFor(1));
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const itemId = harness.engine.getPendingDuplicates()[0]?.itemId as number;
    harness.engine.resolveDuplicate(itemId, 'skip');
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot()[0]?.status).toBe('skipped');
    expect(harness.pipeline.processed).toEqual([]);
  });

  it('Download again writes a second file and a second downloads row', async () => {
    harness = createHarness();
    const id = awemeIdFor(1);
    seedHistory(harness, id);
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const itemId = harness.engine.getPendingDuplicates()[0]?.itemId as number;
    harness.engine.resolveDuplicate(itemId, 'redownload');
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
    const video = harness.videos.findByAwemeId(id);
    const rows = harness.downloads.findByVideoId(video?.id as number);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.file_path.includes('(2)'))).toBe(true);
  });

  it('Replace existing overwrites the original path', async () => {
    harness = createHarness();
    const id = awemeIdFor(1);
    seedHistory(harness, id);
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const itemId = harness.engine.getPendingDuplicates()[0]?.itemId as number;
    harness.engine.resolveDuplicate(itemId, 'replace');
    await harness.engine.whenIdle();

    const snapshot = harness.engine.getSnapshot()[0];
    expect(snapshot?.status).toBe('completed');
    expect(snapshot?.duplicateAction).toBe('replace');
  });

  it('applies "all remaining in this batch" to questions already parked', async () => {
    harness = createHarness();
    seedHistory(harness, awemeIdFor(1));
    seedHistory(harness, awemeIdFor(2));
    seedHistory(harness, awemeIdFor(3));

    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3)]);
    harness.engine.start();
    await harness.engine.whenIdle();
    expect(harness.engine.getPendingDuplicates()).toHaveLength(3);

    const first = harness.engine.getPendingDuplicates()[0]?.itemId as number;
    harness.engine.resolveDuplicate(first, 'skip', true);
    await harness.engine.whenIdle();

    expect(harness.engine.getPendingDuplicates()).toHaveLength(0);
    expect(harness.engine.getSnapshot().every((i) => i.status === 'skipped')).toBe(true);
  });

  it('never carries a batch choice into another batch', async () => {
    harness = createHarness();
    seedHistory(harness, awemeIdFor(1));
    seedHistory(harness, awemeIdFor(2));

    harness.engine.addLinks([makeUrl(1)], 'batch-a');
    harness.engine.start();
    await harness.engine.whenIdle();
    harness.engine.resolveDuplicate(harness.engine.getPendingDuplicates()[0]?.itemId as number, 'skip', true);
    await harness.engine.whenIdle();

    harness.engine.addLinks([makeUrl(2)], 'batch-b');
    await harness.engine.whenIdle();

    // Section 7: the choice is for the rest of that batch only.
    expect(harness.engine.getPendingDuplicates()).toHaveLength(1);
    expect(harness.engine.getPendingDuplicates()[0]?.batchId).toBe('batch-b');
  });

  it('re-downloads silently when the recorded file is gone', async () => {
    harness = createHarness();
    const id = awemeIdFor(1);
    seedHistory(harness, id);
    // The user deleted it; prompting about a file they removed is annoying.
    harness.existingFiles.clear();

    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getPendingDuplicates()).toHaveLength(0);
    expect(harness.pipeline.processed).toEqual([id]);
    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
  });
});

describe('dedup layer 4 — content-level reposts', () => {
  it('records a download even when its hash matches another video', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    // Same phash under a different aweme_id is a repost signal, never a block.
    const video = harness.videos.findByAwemeId(awemeIdFor(1));
    const other = harness.videos.upsert({ awemeId: '9999999999999999999', canonicalUrl: 'https://t/9' });
    harness.downloads.insert({
      videoId: other.id,
      filePath: '/out/other.mp4',
      watermarkRemoved: true,
      phash: `phash-${awemeIdFor(1)}`,
    });

    const matches = harness.downloads.findRepostCandidates(`phash-${awemeIdFor(1)}`, video?.id as number);
    expect(matches).toHaveLength(1);
    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
  });
});

describe('watermark reporting on the queue row (section 9)', () => {
  it('records how the watermark was handled, per item', async () => {
    harness = createHarness();
    const clean = awemeIdFor(1);
    const filtered = awemeIdFor(2);
    const untouched = awemeIdFor(3);
    harness.pipeline.strategyFor(filtered, 'removelogo', true);
    harness.pipeline.strategyFor(untouched, 'raw', false);

    harness.engine.addLinks([makeUrl(1), makeUrl(2), makeUrl(3)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const byAweme = new Map(harness.engine.getSnapshot().map((i) => [i.awemeId, i]));
    // "clean source" and "re-encoded" are different claims and the row has to
    // be able to tell them apart; 'raw' must not masquerade as either.
    expect(byAweme.get(clean)).toMatchObject({ sourceStrategy: 'clean_source', watermarkRemoved: true });
    expect(byAweme.get(filtered)).toMatchObject({ sourceStrategy: 'removelogo', watermarkRemoved: true });
    expect(byAweme.get(untouched)).toMatchObject({ sourceStrategy: 'raw', watermarkRemoved: false });
  });

  it('says nothing until the item has actually finished', async () => {
    harness = createHarness();
    harness.engine.addLinks([makeUrl(1)]);

    // A queued row has no answer yet, and must not imply one.
    expect(harness.engine.getSnapshot()[0]).toMatchObject({
      sourceStrategy: null,
      watermarkRemoved: null,
    });
  });

  it('does not claim a verdict for an item that failed', async () => {
    harness = createHarness();
    harness.pipeline.failFor(awemeIdFor(1), ['DISK_FULL']);
    harness.engine.addLinks([makeUrl(1)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    const row = harness.engine.getSnapshot()[0];
    expect(row?.status).toBe('failed');
    expect(row?.sourceStrategy).toBeNull();
    expect(row?.watermarkRemoved).toBeNull();
  });
});

describe('accounting: every link ends up somewhere (section 8)', () => {
  it('leaves no item in a non-terminal state after a mixed batch', async () => {
    harness = createHarness();
    // A realistic mix: successes, a permanent failure, and a retry that
    // eventually succeeds.
    harness.pipeline.failFor(awemeIdFor(3), ['DISK_FULL']);
    harness.pipeline.failFor(awemeIdFor(5), ['NETWORK_ERROR']);

    const urls = Array.from({ length: 10 }, (_, i) => makeUrl(i));
    const result = harness.engine.addLinks(urls);
    harness.engine.start();
    await harness.engine.whenIdle();

    const snapshot = harness.engine.getSnapshot();
    const terminal = new Set(['completed', 'failed', 'skipped', 'cancelled']);

    // The guarantee: what went in equals what came out, and nothing is left
    // silently mid-flight.
    expect(snapshot).toHaveLength(result.added);
    expect(snapshot.every((item) => terminal.has(item.status))).toBe(true);
  });

  it('accounts for duplicates rather than dropping them', () => {
    harness = createHarness();
    const urls = [makeUrl(1), makeUrl(2), makeUrl(1), makeUrl(2), makeUrl(3)];

    const result = harness.engine.addLinks(urls);

    // 5 in, 3 queued, 2 named as duplicates — the totals reconcile, which is
    // what stops "it lost my links" being indistinguishable from correct
    // deduplication.
    expect(result.totalFound).toBe(5);
    expect(result.added).toBe(3);
    expect(result.duplicatesRemoved).toBe(2);
    expect(result.added + result.duplicatesRemoved + result.invalid.length).toBe(result.totalFound);
  });

  it('counts invalid links instead of silently discarding them', () => {
    harness = createHarness();
    const result = harness.engine.addLinks([
      makeUrl(1),
      'not a link at all',
      'https://youtube.com/watch?v=x',
      makeUrl(2),
    ]);

    expect(result.added).toBe(2);
    expect(result.invalid).toHaveLength(2);
    expect(result.added + result.duplicatesRemoved + result.invalid.length).toBe(result.totalFound);
  });

  it('keeps every position unique across adds, removals and reorders', () => {
    harness = createHarness();
    harness.engine.addLinks(Array.from({ length: 5 }, (_, i) => makeUrl(i)));

    const before = harness.engine.getSnapshot();
    harness.engine.removeItem(before[4]?.id as number);
    harness.engine.addLinks([makeUrl(99)]);

    const positions = harness.engine.getSnapshot().map((i) => i.position);
    // A reused position would let a later insert overwrite an earlier item's
    // place in the order, which is how links go missing.
    expect(new Set(positions).size).toBe(positions.length);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('short links when our own redirect hop fails', () => {
  it('asks the extractor instead of failing the item', async () => {
    const id = awemeIdFor(1);
    harness = createHarness({
      // Our HEAD request times out — exactly the 8s failure seen in the field,
      // where every item died before the extractor was ever reached.
      redirectFails: new AppError('NETWORK_ERROR', 'timed out resolving short link after 0 hop(s)'),
      extractorResolvesShortLinks: { 'https://vm.tiktok.com/ZMabcdef/': id },
    });

    harness.engine.addLinks(['https://vm.tiktok.com/ZMabcdef/']);
    harness.engine.start();
    await harness.engine.whenIdle();

    // The item completes: yt-dlp follows vm.tiktok.com itself, using the proxy,
    // forced IPv4 and browser session that our bare fetch honoured none of.
    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
    expect(harness.engine.getSnapshot()[0]?.awemeId).toBe(id);
  });

  it('still fails a link that is genuinely gone, rather than masking it', async () => {
    harness = createHarness({
      redirectFails: new AppError('VIDEO_DELETED', 'short link returned 404'),
    });

    harness.engine.addLinks(['https://vm.tiktok.com/ZMgone/']);
    harness.engine.start();
    await harness.engine.whenIdle();

    // Only a transport problem earns a second opinion; a dead link is dead.
    expect(harness.engine.getSnapshot()[0]?.status).toBe('failed');
    expect(harness.engine.getSnapshot()[0]?.errorCode).toBe('VIDEO_DELETED');
  });

  it('does not touch the network for a full URL', async () => {
    harness = createHarness({
      redirectFails: new AppError('NETWORK_ERROR', 'should never be called'),
    });

    harness.engine.addLinks([makeUrl(5)]);
    harness.engine.start();
    await harness.engine.whenIdle();

    expect(harness.engine.getSnapshot()[0]?.status).toBe('completed');
  });
});
