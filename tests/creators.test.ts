import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@main/db/migrator';
import { MIGRATIONS } from '@main/db/migrations';
import { CreatorsRepository } from '@main/db/repositories/creators';
import { selectNewVideos } from '@main/creators/creator-runner';

function repo(): CreatorsRepository {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS);
  return new CreatorsRepository(db);
}

const url = (id: number): string => `https://www.tiktok.com/@creator/video/71111111111111111${String(id).padStart(2, '0')}`;

describe('the saved creator list', () => {
  it('keeps accounts, their counts and their caption choice', () => {
    const creators = repo();
    creators.addMany([
      { handle: 'alpha', profileUrl: 'https://www.tiktok.com/@alpha', videoLimit: 3 },
      { handle: 'beta', profileUrl: 'https://www.tiktok.com/@beta', videoLimit: 10, captionMode: 'burn' },
    ]);

    const saved = creators.list();
    expect(saved.map((c) => c.handle)).toEqual(['alpha', 'beta']);
    expect(saved[0]?.video_limit).toBe(3);
    expect(saved[1]?.caption_mode).toBe('burn');
  });

  it('adds the same account only once, and says which were already there', () => {
    // Pasting ten links of which three are saved should add seven, not refuse.
    const creators = repo();
    creators.addMany([{ handle: 'alpha', profileUrl: 'https://www.tiktok.com/@alpha' }]);

    const result = creators.addMany([
      { handle: 'alpha', profileUrl: 'https://www.tiktok.com/@alpha' },
      { handle: 'gamma', profileUrl: 'https://www.tiktok.com/@gamma' },
    ]);

    expect(result.added.map((c) => c.handle)).toEqual(['gamma']);
    expect(result.skipped).toEqual(['alpha']);
    expect(creators.list()).toHaveLength(2);
  });

  it('keeps the order they were added in, which is the order runs happen in', () => {
    const creators = repo();
    creators.addMany([
      { handle: 'first', profileUrl: 'u' },
      { handle: 'second', profileUrl: 'u' },
      { handle: 'third', profileUrl: 'u' },
    ]);
    expect(creators.list().map((c) => c.handle)).toEqual(['first', 'second', 'third']);
  });

  it('edits one account without touching the others', () => {
    const creators = repo();
    const { added } = creators.addMany([
      { handle: 'alpha', profileUrl: 'u', videoLimit: 5 },
      { handle: 'beta', profileUrl: 'u', videoLimit: 5 },
    ]);

    creators.update(added[0]!.id, { videoLimit: 25, captionMode: 'soft' });

    const [alpha, beta] = creators.list();
    expect(alpha?.video_limit).toBe(25);
    expect(alpha?.caption_mode).toBe('soft');
    expect(beta?.video_limit).toBe(5);
  });

  it('distinguishes "follow the app setting" from "leave it alone"', () => {
    // null is a real value here; absent means do not change it.
    const creators = repo();
    const { added } = creators.addMany([{ handle: 'alpha', profileUrl: 'u', captionMode: 'burn' }]);

    creators.update(added[0]!.id, { videoLimit: 2 });
    expect(creators.findById(added[0]!.id)?.caption_mode).toBe('burn');

    creators.update(added[0]!.id, { captionMode: null });
    expect(creators.findById(added[0]!.id)?.caption_mode).toBeNull();
  });

  it('records what a run took, so a second run shows the first happened', () => {
    const creators = repo();
    const { added } = creators.addMany([{ handle: 'alpha', profileUrl: 'u' }]);

    creators.recordRun(added[0]!.id, 3, 1_700_000_000_000);
    creators.recordRun(added[0]!.id, 2, 1_700_000_100_000);

    const row = creators.findById(added[0]!.id);
    expect(row?.videos_queued).toBe(5);
    expect(row?.last_queued_at).toBe(1_700_000_100_000);
  });
});

describe('choosing which videos to take from an account', () => {
  const listing = [url(1), url(2), url(3), url(4), url(5)];

  it('takes the newest N, in the order TikTok listed them', () => {
    const result = selectNewVideos(listing, 3, () => false);
    expect(result.urls).toEqual([url(1), url(2), url(3)]);
  });

  /**
   * The point of the count. Asking for 5 from an account you have taken 20
   * from before must give 5 *new* videos — not 5 attempts that all resolve to
   * duplicates and produce nothing.
   */
  it('passes over videos already downloaded rather than counting them', () => {
    const have = new Set(['7111111111111111101', '7111111111111111102']);
    const result = selectNewVideos(listing, 3, (id) => have.has(id));

    expect(result.urls).toEqual([url(3), url(4), url(5)]);
    expect(result.skipped).toBe(2);
  });

  it('returns nothing when the whole account is already downloaded', () => {
    const result = selectNewVideos(listing, 3, () => true);
    expect(result.urls).toEqual([]);
    expect(result.skipped).toBe(5);
  });

  it('takes what there is when the account has fewer than the count', () => {
    expect(selectNewVideos(listing, 50, () => false).urls).toHaveLength(5);
  });

  it('drops an entry that is not a video without spending the count on it', () => {
    const result = selectNewVideos(['https://www.tiktok.com/@creator', url(1), 'nonsense'], 2, () => false);
    expect(result.urls).toEqual([url(1)]);
  });
});
