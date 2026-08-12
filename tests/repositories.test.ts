import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@main/db/migrator';
import { MIGRATIONS } from '@main/db/migrations';
import { QueueItemsRepository } from '@main/db/repositories/queue-items';
import { VideosRepository } from '@main/db/repositories/videos';
import { DownloadsRepository } from '@main/db/repositories/downloads';

let db: Database.Database;
let queue: QueueItemsRepository;
let videos: VideosRepository;
let downloads: DownloadsRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  queue = new QueueItemsRepository(db);
  videos = new VideosRepository(db);
  downloads = new DownloadsRepository(db);
});

const urls = (count: number, batch = 'b1'): { batchId: string; rawUrl: string; awemeId: string }[] =>
  Array.from({ length: count }, (_, i) => ({
    batchId: batch,
    rawUrl: `https://www.tiktok.com/@a/video/${7_000_000_000_000_000_000n + BigInt(i)}`,
    awemeId: String(7_000_000_000_000_000_000n + BigInt(i)),
  }));

describe('queue ordering (section 8: ordering is a hard guarantee)', () => {
  it('preserves paste order across a 200-link batch', () => {
    const inputs = urls(200);
    const inserted = queue.enqueue(inputs);

    expect(inserted).toHaveLength(200);

    const listed = queue.listOrdered();
    expect(listed).toHaveLength(200);
    expect(listed.map((r) => r.raw_url)).toEqual(inputs.map((i) => i.rawUrl));
    // Positions must be strictly increasing, with no duplicates.
    const positions = listed.map((r) => r.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(200);
  });

  it('never reuses a position after the highest item is removed', () => {
    const first = queue.enqueue(urls(3));
    const highest = first[first.length - 1];
    expect(highest).toBeDefined();
    const retiredPosition = highest?.position as number;

    queue.remove(highest?.id as number);

    const [next] = queue.enqueue([{ batchId: 'b2', rawUrl: 'https://www.tiktok.com/@a/video/9', awemeId: '9' }]);
    // MAX(position) + 1 would hand back the retired position here.
    expect(next?.position).toBeGreaterThan(retiredPosition);
  });

  it('keeps positions monotonic across batches', () => {
    queue.enqueue(urls(5, 'b1'));
    const second = queue.enqueue(urls(5, 'b2'));
    const all = queue.listOrdered();

    expect(all.slice(0, 5).every((r) => r.batch_id === 'b1')).toBe(true);
    expect(second.every((r) => r.batch_id === 'b2')).toBe(true);
    expect(second[0]?.position).toBeGreaterThan(all[4]?.position as number);
  });

  it('processes in insertion order — nextQueued returns the lowest position', () => {
    const items = queue.enqueue(urls(4));
    // Finish them out of order; the next queued item must still be by position.
    queue.update(items[0]?.id as number, { status: 'completed' });
    queue.update(items[2]?.id as number, { status: 'completed' });

    expect(queue.nextQueued()?.id).toBe(items[1]?.id);
  });

  it('inserts a batch atomically — a failure leaves no partial rows', () => {
    queue.enqueue(urls(2));
    const before = queue.listOrdered().length;

    // status has no CHECK constraint, so force a failure with a NOT NULL violation.
    expect(() =>
      queue.enqueue([
        { batchId: 'b9', rawUrl: 'https://ok', awemeId: '1' },
        { batchId: null as unknown as string, rawUrl: 'https://bad', awemeId: '2' },
      ]),
    ).toThrow();

    expect(queue.listOrdered()).toHaveLength(before);
  });
});

describe('crash recovery (section 8)', () => {
  it('returns in-flight items to queued and leaves terminal ones alone', () => {
    const items = queue.enqueue(urls(5));
    queue.update(items[0]?.id as number, { status: 'downloading', progress: 0.4, startedAt: 1 });
    queue.update(items[1]?.id as number, { status: 'processing', progress: 0.9 });
    queue.update(items[2]?.id as number, { status: 'resolving' });
    queue.update(items[3]?.id as number, { status: 'completed' });
    queue.update(items[4]?.id as number, { status: 'failed', errorCode: 'VIDEO_DELETED' });

    expect(queue.resetInFlight()).toBe(3);

    const after = queue.listOrdered();
    expect(after[0]?.status).toBe('queued');
    expect(after[0]?.progress).toBe(0);
    expect(after[0]?.started_at).toBeNull();
    expect(after[1]?.status).toBe('queued');
    expect(after[2]?.status).toBe('queued');
    expect(after[3]?.status).toBe('completed');
    expect(after[4]?.status).toBe('failed');
    // Order survives recovery.
    expect(after.map((r) => r.position)).toEqual([...after.map((r) => r.position)].sort((a, b) => a - b));
  });
});

describe('dedup lookups (section 7)', () => {
  it('layer 2 finds an aweme_id already pending or in flight, ignoring finished ones', () => {
    const items = queue.enqueue([
      { batchId: 'b', rawUrl: 'https://x/1', awemeId: '111' },
      { batchId: 'b', rawUrl: 'https://x/2', awemeId: '222' },
    ]);

    expect(queue.findActiveByAwemeId('111')?.id).toBe(items[0]?.id);

    queue.update(items[0]?.id as number, { status: 'completed' });
    expect(queue.findActiveByAwemeId('111')).toBeUndefined();

    queue.update(items[1]?.id as number, { status: 'awaiting_user' });
    expect(queue.findActiveByAwemeId('222')?.id).toBe(items[1]?.id);
  });

  it('layer 3 finds a prior download only while its file still exists', () => {
    const video = videos.upsert({ awemeId: '333', canonicalUrl: 'https://t/333', caption: 'hello' });
    const id = downloads.insert({
      videoId: video.id,
      filePath: '/out/hello.mp4',
      watermarkRemoved: true,
      sourceStrategy: 'clean_source',
    });

    const found = downloads.findExistingByAwemeId('333');
    expect(found?.file_path).toBe('/out/hello.mp4');
    expect(found?.caption).toBe('hello');

    // A file the user deleted must re-download silently, not prompt.
    downloads.markFileMissing(id);
    expect(downloads.findExistingByAwemeId('333')).toBeUndefined();
  });

  it('"download again" adds a second downloads row against one video row', () => {
    const video = videos.upsert({ awemeId: '444', canonicalUrl: 'https://t/444' });
    downloads.insert({ videoId: video.id, filePath: '/out/a.mp4', watermarkRemoved: true });
    downloads.insert({ videoId: video.id, filePath: '/out/a (2).mp4', watermarkRemoved: true });

    expect(downloads.findByVideoId(video.id)).toHaveLength(2);
    expect(
      db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM videos').get()?.n,
    ).toBe(1);
  });

  it('layer 4 surfaces same-content reposts under a different aweme_id', () => {
    const a = videos.upsert({ awemeId: '555', canonicalUrl: 'https://t/555' });
    const b = videos.upsert({ awemeId: '666', canonicalUrl: 'https://t/666' });
    downloads.insert({ videoId: a.id, filePath: '/out/a.mp4', watermarkRemoved: true, phash: 'ff00ff00' });
    downloads.insert({ videoId: b.id, filePath: '/out/b.mp4', watermarkRemoved: true, phash: 'ff00ff00' });

    const candidates = downloads.findRepostCandidates('ff00ff00', b.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.aweme_id).toBe('555');
  });
});

describe('videos repository', () => {
  it('upserts by aweme_id without duplicating rows or losing first_seen_at', () => {
    const first = videos.upsert({ awemeId: '777', canonicalUrl: 'https://t/777', caption: 'original' }, 1_000);
    const second = videos.upsert({ awemeId: '777', canonicalUrl: 'https://t/777', authorHandle: '@me' }, 2_000);

    expect(second.id).toBe(first.id);
    expect(second.first_seen_at).toBe(1_000);
    // A later partial resolve must not blank out metadata captured earlier.
    expect(second.caption).toBe('original');
    expect(second.author_handle).toBe('@me');
  });

  it('enforces the aweme_id uniqueness the dedup key depends on', () => {
    videos.upsert({ awemeId: '888', canonicalUrl: 'https://t/888' });
    expect(() =>
      db
        .prepare('INSERT INTO videos (aweme_id, canonical_url, first_seen_at) VALUES (?, ?, ?)')
        .run('888', 'https://t/888', Date.now()),
    ).toThrow(/UNIQUE/i);
  });

  it('enforces the downloads -> videos foreign key', () => {
    expect(() => downloads.insert({ videoId: 9_999, filePath: '/out/x.mp4', watermarkRemoved: false })).toThrow(
      /FOREIGN KEY/i,
    );
  });
});

describe('watermark verdict on a queue row (section 9)', () => {
  it('starts unknown and survives a round trip', () => {
    const [row] = queue.enqueue(urls(1));
    expect(row?.source_strategy).toBeNull();
    expect(row?.watermark_removed).toBeNull();

    const updated = queue.update(row?.id as number, { sourceStrategy: 'removelogo', watermarkRemoved: 1 });
    expect(updated?.source_strategy).toBe('removelogo');
    expect(updated?.watermark_removed).toBe(1);
  });

  it('clears a stale verdict when the row is claimed again', () => {
    const [row] = queue.enqueue(urls(1));
    const id = row?.id as number;
    queue.update(id, { status: 'queued', sourceStrategy: 'clean_source', watermarkRemoved: 1 });

    // A new attempt has not decided anything yet, so the row must not carry
    // the last attempt's answer into it.
    const claimed = queue.claimNext();
    expect(claimed?.id).toBe(id);
    expect(claimed?.source_strategy).toBeNull();
    expect(claimed?.watermark_removed).toBeNull();
  });
});
