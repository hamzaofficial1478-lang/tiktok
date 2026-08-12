import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@main/db/migrator';
import { MIGRATIONS } from '@main/db/migrations';
import { VideosRepository } from '@main/db/repositories/videos';
import { DownloadsRepository } from '@main/db/repositories/downloads';

let db: Database.Database;
let videos: VideosRepository;
let downloads: DownloadsRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  videos = new VideosRepository(db);
  downloads = new DownloadsRepository(db);
});

function seed(awemeId: string, options: { caption?: string; handle?: string; phash?: string; at?: number } = {}): number {
  const video = videos.upsert({
    awemeId,
    canonicalUrl: `https://www.tiktok.com/@${options.handle ?? 'creator'}/video/${awemeId}`,
    caption: options.caption ?? `caption ${awemeId}`,
    authorHandle: options.handle ?? 'creator',
  });
  return downloads.insert({
    videoId: video.id,
    filePath: `/out/${awemeId}.mp4`,
    watermarkRemoved: true,
    sourceStrategy: 'clean_source',
    ...(options.phash === undefined ? {} : { phash: options.phash }),
    completedAt: options.at ?? Date.now(),
  });
}

describe('library query (section 10)', () => {
  it('returns newest downloads first', () => {
    seed('7000000000000000001', { at: 1_000 });
    seed('7000000000000000002', { at: 3_000 });
    seed('7000000000000000003', { at: 2_000 });

    const { entries, total } = downloads.listLibrary();
    expect(total).toBe(3);
    expect(entries.map((e) => e.aweme_id)).toEqual([
      '7000000000000000002',
      '7000000000000000003',
      '7000000000000000001',
    ]);
  });

  it('searches captions and author handles, case-insensitively', () => {
    seed('7000000000000000001', { caption: 'A Cooking Video', handle: 'chef' });
    seed('7000000000000000002', { caption: 'skateboarding', handle: 'rider' });

    expect(downloads.listLibrary({ search: 'cooking' }).entries).toHaveLength(1);
    expect(downloads.listLibrary({ search: 'COOKING' }).entries).toHaveLength(1);
    expect(downloads.listLibrary({ search: 'rider' }).entries[0]?.aweme_id).toBe('7000000000000000002');
    expect(downloads.listLibrary({ search: 'nothing here' }).entries).toHaveLength(0);
  });

  it('reports the unfiltered total alongside a filtered page', () => {
    for (let i = 1; i <= 5; i++) seed(`700000000000000000${i}`);
    const page = downloads.listLibrary({ limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it('pages without repeating or skipping rows', () => {
    for (let i = 1; i <= 5; i++) seed(`700000000000000000${i}`, { at: i * 1_000 });
    const first = downloads.listLibrary({ limit: 2, offset: 0 }).entries.map((e) => e.aweme_id);
    const second = downloads.listLibrary({ limit: 2, offset: 2 }).entries.map((e) => e.aweme_id);
    expect(new Set([...first, ...second]).size).toBe(4);
  });

  /**
   * Computed in SQL rather than per row: at a few thousand downloads, an N+1
   * lookup for repost badges would make the grid visibly slow to open.
   */
  it('flags a repost without flagging the original against itself', () => {
    seed('7000000000000000001', { phash: 'aaaa' });
    seed('7000000000000000002', { phash: 'aaaa' });
    seed('7000000000000000003', { phash: 'bbbb' });

    const byId = Object.fromEntries(downloads.listLibrary().entries.map((e) => [e.aweme_id, e]));
    expect(byId['7000000000000000001']?.possible_repost).toBe(1);
    expect(byId['7000000000000000002']?.possible_repost).toBe(1);
    // A unique hash is not a repost of anything.
    expect(byId['7000000000000000003']?.possible_repost).toBe(0);
  });

  it('does not treat two downloads of the same video as reposts of each other', () => {
    const video = videos.upsert({ awemeId: '7000000000000000009', canonicalUrl: 'https://t/9' });
    downloads.insert({ videoId: video.id, filePath: '/out/a.mp4', watermarkRemoved: true, phash: 'same' });
    downloads.insert({ videoId: video.id, filePath: '/out/a (2).mp4', watermarkRemoved: true, phash: 'same' });

    // "Download again" produces two rows for one video; that is not a repost.
    for (const entry of downloads.listLibrary().entries) expect(entry.possible_repost).toBe(0);
  });

  it('ignores null hashes rather than matching them to each other', () => {
    seed('7000000000000000001');
    seed('7000000000000000002');
    for (const entry of downloads.listLibrary().entries) expect(entry.possible_repost).toBe(0);
  });

  it('deletes a record without touching the video row', () => {
    const downloadId = seed('7000000000000000001');
    downloads.deleteRecord(downloadId);

    expect(downloads.listLibrary().total).toBe(0);
    // The video is kept: it is still the dedup key for anything re-added.
    expect(videos.findByAwemeId('7000000000000000001')).toBeDefined();
  });

  it('survives a search containing SQL wildcards', () => {
    seed('7000000000000000001', { caption: '100% real' });
    expect(() => downloads.listLibrary({ search: "100%' OR 1=1 --" })).not.toThrow();
    expect(downloads.listLibrary({ search: "100%' OR 1=1 --" }).entries).toHaveLength(0);
  });
});

describe('daily history', () => {
  it('groups downloads by calendar day, newest first', () => {
    const day = 24 * 60 * 60 * 1_000;
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);

    const a = videos.upsert({ awemeId: '7000000000000000001', canonicalUrl: 'https://t/1' });
    const b = videos.upsert({ awemeId: '7000000000000000002', canonicalUrl: 'https://t/2' });
    const c = videos.upsert({ awemeId: '7000000000000000003', canonicalUrl: 'https://t/3' });

    downloads.insert({
      videoId: a.id, filePath: '/o/a.mp4', fileSize: 1_000, watermarkRemoved: true,
      sourceStrategy: 'clean_source', completedAt: now,
    });
    downloads.insert({
      videoId: b.id, filePath: '/o/b.mp4', fileSize: 2_000, watermarkRemoved: true,
      sourceStrategy: 'removelogo', completedAt: now,
    });
    downloads.insert({
      videoId: c.id, filePath: '/o/c.mp4', fileSize: 4_000, watermarkRemoved: false,
      sourceStrategy: 'raw', completedAt: now - 2 * day,
    });

    const stats = downloads.dailyStats(30, now + 1_000);
    expect(stats).toHaveLength(2);

    const [newest, older] = stats;
    expect(newest?.downloads).toBe(2);
    expect(newest?.watermarkFree).toBe(2);
    // Only the filtered one counts as re-encoded; a clean source never was.
    expect(newest?.reEncoded).toBe(1);
    expect(newest?.bytes).toBe(3_000);

    expect(older?.downloads).toBe(1);
    expect(older?.watermarkFree).toBe(0);
    expect(newest?.day && older?.day && newest.day > older.day).toBe(true);
  });

  it('excludes anything older than the requested window', () => {
    const day = 24 * 60 * 60 * 1_000;
    const now = Date.UTC(2026, 5, 15);
    const video = videos.upsert({ awemeId: '7000000000000000009', canonicalUrl: 'https://t/9' });

    downloads.insert({
      videoId: video.id, filePath: '/o/old.mp4', watermarkRemoved: true, completedAt: now - 40 * day,
    });

    expect(downloads.dailyStats(7, now)).toEqual([]);
    expect(downloads.dailyStats(90, now)).toHaveLength(1);
  });

  it('returns nothing rather than throwing on an empty library', () => {
    expect(downloads.dailyStats(30)).toEqual([]);
  });
});
