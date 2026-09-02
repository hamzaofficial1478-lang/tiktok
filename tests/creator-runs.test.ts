import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import { runMigrations } from '@main/db/migrator';
import { MIGRATIONS } from '@main/db/migrations';
import { CreatorsRepository } from '@main/db/repositories/creators';
import { LinkLedgerRepository } from '@main/db/repositories/link-ledger';
import { CreatorRunner, type CreatorRunProgress } from '@main/creators/creator-runner';
import type { ProfileExpander } from '@main/resolve/profile-expander';
import type { QueueEngine } from '@main/queue/queue-engine';
import { reconcileLedger } from '@main/library/reconcile';

/**
 * How many videos a run is allowed to take.
 *
 * The bug: `selectNewVideos` takes up to `video_limit` *new* videos every time
 * it is called, and nothing capped a run against what an account had already
 * given. So an account set to "3 videos" gave three on the first run and three
 * more on the second — six files on disk from a setting that says three, with
 * nothing said about it either time.
 */

const silent = pino({ level: 'silent' });

let db: Database.Database;
let creators: CreatorsRepository;
let ledger: LinkLedgerRepository;
let queued: string[][];

/** Every video @alpha has ever posted, newest first. */
const catalogue = Array.from({ length: 12 }, (_, i) => `https://www.tiktok.com/@alpha/video/71111111111111111${String(i).padStart(2, '0')}`);
const awemeOf = (url: string): string => /\/video\/(\d+)/.exec(url)?.[1] ?? '';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  creators = new CreatorsRepository(db);
  ledger = new LinkLedgerRepository(db);
  queued = [];
});

/**
 * A runner over fakes, wired the way services.ts wires the real one.
 *
 * The queue is stubbed to record what it was handed and to mark those videos
 * downloaded, which is what a finished download really does — that feedback
 * loop is the thing under test.
 */
function makeRunner(
  onProgress?: (progress: CreatorRunProgress) => void,
  reconcile?: () => void,
): {
  runner: CreatorRunner;
  listings: number;
} {
  const state = { listings: 0 };

  const profiles = {
    expand: async () => {
      state.listings++;
      return { handle: 'alpha', profileUrl: 'https://www.tiktok.com/@alpha', urls: catalogue, truncated: false };
    },
  } as unknown as ProfileExpander;

  const queue = {
    addLinks: (urls: readonly string[]) => {
      queued.push([...urls]);
      for (const url of urls) {
        ledger.record({ awemeId: awemeOf(url), handle: 'alpha', status: 'downloaded' });
      }
      return { batchId: 'b', added: urls.length, duplicatesRemoved: 0, alreadyInQueue: 0, invalid: [], totalFound: urls.length };
    },
    start: () => undefined,
    whenIdle: async () => undefined,
  } as unknown as QueueEngine;

  const runner = new CreatorRunner({
    creators,
    ledger,
    profiles,
    queue,
    log: silent,
    ...(onProgress ? { onProgress } : {}),
    ...(reconcile ? { reconcile } : {}),
  });

  return {
    runner,
    get listings(): number {
      return state.listings;
    },
  };
}

describe('a run stops at what the account still owes', () => {
  beforeEach(() => {
    creators.addMany([{ handle: 'alpha', profileUrl: 'https://www.tiktok.com/@alpha', videoLimit: 3 }]);
  });

  it('takes three on the first run and nothing on the second', async () => {
    const { runner } = makeRunner();

    const first = await runner.run();
    expect(first.queued).toBe(3);
    expect(queued[0]).toHaveLength(3);

    // The bug: this used to take three more, leaving six on disk from a
    // setting that says three.
    const second = await runner.run();
    expect(second.queued).toBe(0);
    expect(second.caughtUp).toBe(1);
    expect(second.visited).toBe(0);
    expect(ledger.countForHandle('alpha', 'downloaded')).toBe(3);
  });

  it('does not even list an account that owes nothing', async () => {
    const harness = makeRunner();
    await harness.runner.run();
    expect(harness.listings).toBe(1);

    await harness.runner.run();
    // Listing a large account is a network round trip that can take a minute.
    // Spending one to conclude "nothing to do" is the slowest possible way to
    // say it.
    expect(harness.listings).toBe(1);
  });

  it('says so, rather than reporting the account as merely finished', async () => {
    const seen: CreatorRunProgress[] = [];
    const { runner } = makeRunner((progress) => seen.push(progress));

    await runner.run();
    seen.length = 0;
    await runner.run();

    expect(seen.map((p) => p.phase)).toEqual(['caught-up']);
    expect(seen[0]?.message).toMatch(/already downloaded/i);
  });

  it('takes the next three only when asked for a top-up', async () => {
    const { runner } = makeRunner();
    await runner.run();

    const topUp = await runner.run({ topUp: true });
    expect(topUp.queued).toBe(3);
    expect(ledger.countForHandle('alpha', 'downloaded')).toBe(6);

    // The next three, not the same three: nothing already taken is re-offered.
    expect(queued[1]).toEqual(catalogue.slice(3, 6));
  });

  it('picks up where it stopped when a run is interrupted part-way', async () => {
    creators.update(1, { videoLimit: 5 });
    // Three arrived before the run was cut short.
    for (const url of catalogue.slice(0, 3)) {
      ledger.record({ awemeId: awemeOf(url), handle: 'alpha', status: 'downloaded' });
    }

    const { runner } = makeRunner();
    const result = await runner.run();

    // Two, not five: the count is a total, not a per-press quota.
    expect(result.queued).toBe(2);
    expect(queued[0]).toEqual(catalogue.slice(3, 5));
  });

  it('counts a lowered limit as nothing owed rather than as a negative', async () => {
    const { runner } = makeRunner();
    await runner.run();
    creators.update(1, { videoLimit: 1 });

    const result = await runner.run();
    expect(result.queued).toBe(0);
    expect(result.caughtUp).toBe(1);
  });

  it('takes more when the count is raised, without re-taking anything', async () => {
    const { runner } = makeRunner();
    await runner.run();
    creators.update(1, { videoLimit: 5 });

    const result = await runner.run();
    expect(result.queued).toBe(2);
    expect(queued[1]).toEqual(catalogue.slice(3, 5));
  });
});

describe('several accounts', () => {
  it('reports how many were visited and how many were already finished', async () => {
    creators.addMany([
      { handle: 'alpha', profileUrl: 'https://www.tiktok.com/@alpha', videoLimit: 3 },
      { handle: 'beta', profileUrl: 'https://www.tiktok.com/@beta', videoLimit: 2 },
    ]);
    // @beta is already done; @alpha has not started.
    for (let i = 0; i < 2; i++) ledger.record({ awemeId: `beta-${i}`, handle: 'beta', status: 'downloaded' });

    const { runner } = makeRunner();
    const result = await runner.run();

    expect(result.creators).toBe(2);
    expect(result.visited).toBe(1);
    expect(result.caughtUp).toBe(1);
  });

  it('refuses to start a second run while one is in flight', async () => {
    creators.addMany([{ handle: 'alpha', profileUrl: 'https://www.tiktok.com/@alpha', videoLimit: 3 }]);
    const { runner } = makeRunner();

    const [first, second] = await Promise.all([runner.run(), runner.run()]);
    // Whichever lost the race did nothing; between them exactly three videos.
    expect(first.queued + second.queued).toBe(3);
    await vi.waitFor(() => expect(runner.isRunning).toBe(false));
  });
});

/**
 * Running only part of a saved list.
 *
 * The list used to be all-or-nothing: every account was fetched every time, so
 * wanting one account's videos meant deleting the other four and adding them
 * back afterwards — which threw away their counts and their caption settings
 * too. A switch per account keeps the list standing and runs only part of it.
 */
describe('accounts switched off', () => {
  beforeEach(() => {
    creators.addMany([
      { handle: 'alpha', profileUrl: 'https://www.tiktok.com/@alpha', videoLimit: 3 },
      { handle: 'beta', profileUrl: 'https://www.tiktok.com/@beta', videoLimit: 2 },
    ]);
  });

  it('is not listed, not queued, and not counted as visited', async () => {
    const beta = creators.list().find((c) => c.handle === 'beta')!;
    creators.update(beta.id, { enabled: false });

    const made = makeRunner();
    const result = await made.runner.run();

    // One listing, for @alpha. A switched-off account costs no request at all.
    expect(made.listings).toBe(1);
    expect(result.creators).toBe(1);
    expect(result.visited).toBe(1);
    expect(queued.flat()).toEqual(catalogue.slice(0, 3));
  });

  it('is left completely alone — its count and settings are still there', async () => {
    const beta = creators.list().find((c) => c.handle === 'beta')!;
    creators.update(beta.id, { enabled: false, captionMode: 'burn' });
    await makeRunner().runner.run();

    const after = creators.list().find((c) => c.handle === 'beta')!;
    expect(after.enabled).toBe(0);
    expect(after.video_limit).toBe(2);
    expect(after.caption_mode).toBe('burn');
  });

  it('runs again the moment it is switched back on', async () => {
    const beta = creators.list().find((c) => c.handle === 'beta')!;
    creators.update(beta.id, { enabled: false });
    await makeRunner().runner.run();
    queued = [];

    creators.update(beta.id, { enabled: true });
    const result = await makeRunner().runner.run();

    // @alpha owes nothing now, so only @beta is visited.
    expect(result.visited).toBe(1);
    expect(queued.flat()).toHaveLength(2);
  });

  it('does nothing at all when every account is switched off', async () => {
    for (const row of creators.list()) creators.update(row.id, { enabled: false });

    const made = makeRunner();
    const result = await made.runner.run();

    expect(made.listings).toBe(0);
    expect(result.visited).toBe(0);
    expect(queued).toEqual([]);
  });
});

/**
 * The complaint, end to end.
 *
 * Ten accounts with a per-account count. Press Run and the videos arrive. Close
 * the app, or clear the Library, then press Run again — and the same videos
 * download a second time, into the folder that already holds them, before it
 * moves on to anything new. Press it once more and it behaves correctly.
 *
 * That last detail is the diagnosis. The run asks one question, "which of this
 * account's videos do I already have?", answers it from a single database row
 * per video, and behaves impeccably on the answer it is given. Re-downloading
 * writes those rows back, which is why the third press is fine. Nothing
 * downstream was wrong; the input had gone.
 */
describe('a record that went missing between runs', () => {
  beforeEach(() => {
    creators.addMany([{ handle: 'alpha', profileUrl: 'https://www.tiktok.com/@alpha', videoLimit: 3 }]);
  });

  /** The output folder as it stands after a run: three files, named by the app. */
  function folderAfterFirstRun(): () => void {
    const taken = queued.flat().map(awemeOf);
    return () =>
      reconcileLedger({
        outputDir: '/out',
        ledger,
        fs: {
          readdir: (dir) =>
            dir === '/out'
              ? [{ name: 'alpha', isDirectory: true, isFile: false }]
              : taken.map((id, i) => ({
                  name: `00${i + 1} - alpha - ${id}.mp4`,
                  isDirectory: false,
                  isFile: true,
                })),
          mtimeMs: () => 1_700_000_000_000,
        },
      });
  }

  it('is what made the same videos download twice', async () => {
    await makeRunner().runner.run();
    const first = queued.flat();
    expect(first).toHaveLength(3);

    // Exactly what clearing the Library used to do, and what a lost or restored
    // database looks like from here.
    ledger.clear();
    queued = [];

    await makeRunner().runner.run();

    // The bug, reproduced: the same three links, a second time.
    expect(queued.flat()).toEqual(first);
  });

  it('is repaired from the videos themselves before the run decides anything', async () => {
    await makeRunner().runner.run();
    const first = queued.flat();
    const reconcile = folderAfterFirstRun();

    ledger.clear();
    queued = [];

    const result = await makeRunner(undefined, reconcile).runner.run();

    // Nothing queued, and the account correctly reported as finished — read off
    // the three files sitting in the folder rather than off a row that is gone.
    expect(queued.flat()).toEqual([]);
    expect(result.queued).toBe(0);
    expect(result.caughtUp).toBe(1);
    expect(ledger.countForHandle('alpha', 'downloaded')).toBe(3);
    expect(first).toHaveLength(3);
  });

  it('still takes what is genuinely outstanding after repairing itself', async () => {
    // An account set to five that has three on disk owes two, and must not be
    // reported as finished just because the folder is not empty.
    const alpha = creators.list()[0];
    await makeRunner().runner.run();
    const reconcile = folderAfterFirstRun();

    ledger.clear();
    queued = [];
    creators.update(alpha?.id ?? 0, { videoLimit: 5 });

    const result = await makeRunner(undefined, reconcile).runner.run();

    expect(result.queued).toBe(2);
    expect(queued.flat()).toHaveLength(2);
  });

  it('runs anyway when the output folder cannot be read', async () => {
    const result = await makeRunner(undefined, () => {
      throw new Error('EACCES: permission denied');
    }).runner.run();

    // A folder the app cannot read leaves the record exactly as it was, which
    // is where the run would have started from regardless.
    expect(result.queued).toBe(3);
  });
});
