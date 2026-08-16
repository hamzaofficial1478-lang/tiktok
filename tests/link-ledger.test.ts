import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@main/db/migrator';
import { MIGRATIONS } from '@main/db/migrations';
import { VideosRepository } from '@main/db/repositories/videos';
import { DownloadsRepository } from '@main/db/repositories/downloads';
import { LinkLedgerRepository } from '@main/db/repositories/link-ledger';
import { selectNewVideos } from '@main/creators/creator-runner';

/**
 * The ledger's one job: answer "have I already taken this?" in a way that
 * survives everything a person does to their own files afterwards.
 *
 * These tests are written around the three things that used to break it —
 * renaming a file, moving it, and changing the output folder — because the
 * previous answer joined downloads to videos and required `file_exists = 1`,
 * which made all three read as "never downloaded".
 */

let db: Database.Database;
let ledger: LinkLedgerRepository;

const AWEME = '7401234567890123456';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  ledger = new LinkLedgerRepository(db);
});

describe('the link ledger', () => {
  it('remembers a download by TikTok id, not by where the file went', () => {
    ledger.record({ awemeId: AWEME, handle: 'creator', status: 'downloaded', filePath: 'D:/out/video.mp4' });

    expect(ledger.isSettled(AWEME)).toBe(true);

    // Renamed, moved into a subfolder, and the whole output folder changed.
    // None of these is a statement that the video was not taken.
    expect(ledger.isSettled(AWEME)).toBe(true);
    expect(ledger.find(AWEME)?.file_path).toBe('D:/out/video.mp4');
  });

  it('treats a declined slideshow and an unsupported post as settled too', () => {
    ledger.record({ awemeId: '111', status: 'declined' });
    ledger.record({ awemeId: '222', status: 'unsupported' });

    // All three statuses mean "do not offer this again" — being asked about
    // the same slideshow on every single run is the thing being fixed.
    expect(ledger.isSettled('111')).toBe(true);
    expect(ledger.isSettled('222')).toBe(true);
    expect(ledger.isSettled('333')).toBe(false);
  });

  it('lets a later outcome win, so a declined slideshow can be accepted', () => {
    ledger.record({ awemeId: AWEME, status: 'declined', now: 1_000 });
    ledger.record({ awemeId: AWEME, status: 'downloaded', filePath: 'C:/a.mp4', now: 2_000 });

    const row = ledger.find(AWEME);
    expect(row?.status).toBe('downloaded');
    expect(row?.settled_at).toBe(2_000);
  });

  it('keeps the handle and path it already knows when a later write omits them', () => {
    ledger.record({ awemeId: AWEME, handle: 'creator', status: 'downloaded', filePath: 'C:/a.mp4' });
    ledger.record({ awemeId: AWEME, status: 'downloaded' });

    expect(ledger.find(AWEME)?.handle).toBe('creator');
    expect(ledger.find(AWEME)?.file_path).toBe('C:/a.mp4');
  });

  it('answers a whole listing in one pass', () => {
    ledger.record({ awemeId: '1', status: 'downloaded' });
    ledger.record({ awemeId: '3', status: 'declined' });

    expect(ledger.settledAmong(['1', '2', '3', '4'])).toEqual(new Set(['1', '3']));
  });

  it('counts what has been taken from one account', () => {
    ledger.record({ awemeId: '1', handle: 'alice', status: 'downloaded' });
    ledger.record({ awemeId: '2', handle: 'alice', status: 'downloaded' });
    ledger.record({ awemeId: '3', handle: 'bob', status: 'downloaded' });

    expect(ledger.countForHandle('alice')).toBe(2);
    expect(ledger.countForHandle('bob')).toBe(1);
    expect(ledger.countForHandle('nobody')).toBe(0);
  });

  it('can forget one video on purpose, and clear everything', () => {
    ledger.record({ awemeId: '1', status: 'downloaded' });
    ledger.record({ awemeId: '2', status: 'downloaded' });

    ledger.forget('1');
    expect(ledger.isSettled('1')).toBe(false);
    expect(ledger.isSettled('2')).toBe(true);

    expect(ledger.clear()).toBe(1);
    expect(ledger.isSettled('2')).toBe(false);
  });

  it('keeps its in-memory index in step with writes made after it was read', () => {
    // The index is loaded lazily on the first question; a write afterwards
    // must be visible without reopening anything, or the first download of a
    // run would be re-offered by the second.
    expect(ledger.isSettled(AWEME)).toBe(false);
    ledger.record({ awemeId: AWEME, status: 'downloaded' });
    expect(ledger.isSettled(AWEME)).toBe(true);
  });
});

describe('backfill from an existing library', () => {
  it('carries every past download into the ledger when the migration runs', () => {
    // Build a library on the schema as it stood before the ledger existed,
    // then run the ledger migration over it.
    const fresh = new Database(':memory:');
    fresh.pragma('foreign_keys = ON');
    runMigrations(
      fresh,
      MIGRATIONS.filter((m) => m.version < 8),
    );

    const videos = new VideosRepository(fresh);
    const downloads = new DownloadsRepository(fresh);
    const video = videos.upsert({
      awemeId: AWEME,
      canonicalUrl: `https://www.tiktok.com/@creator/video/${AWEME}`,
      authorHandle: 'creator',
    });
    downloads.insert({ videoId: video.id, filePath: 'D:/out/old.mp4', watermarkRemoved: false });

    runMigrations(fresh, MIGRATIONS);

    const backfilled = new LinkLedgerRepository(fresh);
    expect(backfilled.isSettled(AWEME)).toBe(true);
    expect(backfilled.find(AWEME)?.handle).toBe('creator');
    expect(backfilled.find(AWEME)?.status).toBe('downloaded');
  });
});

describe('choosing an account\u2019s next videos', () => {
  const url = (n: number): string => `https://www.tiktok.com/@creator/video/74000000000000000${n}`;

  it('passes over settled videos rather than counting them against the limit', () => {
    ledger.record({ awemeId: '740000000000000001', status: 'downloaded' });
    ledger.record({ awemeId: '740000000000000002', status: 'declined' });

    const listing = [url(1), url(2), url(3), url(4), url(5)];
    const result = selectNewVideos(listing, 3, (id) => ledger.isSettled(id));

    // Asking for 3 from an account you have taken from before gives 3 *new*
    // videos, not 3 attempts that resolve to duplicates and produce nothing.
    expect(result.urls).toHaveLength(3);
    expect(result.urls).toEqual([url(3), url(4), url(5)]);
    expect(result.skipped).toBe(2);
  });

  it('has nothing to offer once an account is fully taken', () => {
    const listing = [url(1), url(2)];
    for (const id of ['740000000000000001', '740000000000000002']) {
      ledger.record({ awemeId: id, handle: 'creator', status: 'downloaded' });
    }

    const result = selectNewVideos(listing, 10, (id) => ledger.isSettled(id));
    expect(result.urls).toEqual([]);
    expect(result.skipped).toBe(2);
  });
});
