import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@main/db/migrator';
import { MIGRATIONS } from '@main/db/migrations';
import { LinkLedgerRepository } from '@main/db/repositories/link-ledger';
import { awemeIdFromName, reconcileLedger, scanDownloads, type ScanFs } from '@main/library/reconcile';

/**
 * A fake output folder, described as a path -> entries map.
 *
 * Real files would be a fair test of `readdirSync` and nothing else; the part
 * worth testing is which names the walk believes, which folder it takes an
 * account name from, and what it refuses to record.
 */
function fakeFs(tree: Record<string, readonly string[]>): ScanFs {
  return {
    readdir: (dir) => {
      const entries = tree[dir];
      if (!entries) throw new Error(`no such directory: ${dir}`);
      return entries.map((name) => {
        // A trailing slash marks a directory, so a tree stays readable.
        const isDirectory = name.endsWith('/');
        return { name: isDirectory ? name.slice(0, -1) : name, isDirectory, isFile: !isDirectory };
      });
    },
    mtimeMs: () => 1_700_000_000_000,
  };
}

function ledger(): LinkLedgerRepository {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS);
  return new LinkLedgerRepository(db);
}

const ID_A = '7311111111111111111';
const ID_B = '7322222222222222222';
const ID_C = '7333333333333333333';

describe('reading an id out of a filename', () => {
  it('finds the one the default template writes', () => {
    expect(awemeIdFromName(`001 - creator - ${ID_A}.mp4`)).toBe(ID_A);
  });

  it('finds it wherever in the name it happens to be', () => {
    // The template is the user's to change, so the position is not assumable.
    expect(awemeIdFromName(`${ID_A} something.mp4`)).toBe(ID_A);
    expect(awemeIdFromName(`a video [${ID_A}].mkv`)).toBe(ID_A);
  });

  it('does not invent one out of a shorter number', () => {
    expect(awemeIdFromName('holiday 2026.mp4')).toBeNull();
    expect(awemeIdFromName('IMG_20260214.mp4')).toBeNull();
  });

  it('does not slice one out of a longer run of digits', () => {
    // Bounded by non-digits, so a 30-digit number is not four candidate ids.
    expect(awemeIdFromName(`${ID_A}${ID_B}.mp4`)).toBeNull();
  });
});

describe('scanning the output folder', () => {
  it('takes the account name from the folder the video is in', () => {
    const { items } = scanDownloads('/out', {
      fs: fakeFs({
        '/out': ['creatorone/'],
        '/out/creatorone': [`001 - creatorone - ${ID_A}.mp4`],
      }),
    });

    expect(items).toEqual([
      { awemeId: ID_A, filePath: '/out/creatorone/001 - creatorone - ' + ID_A + '.mp4', handle: 'creatorone' },
    ]);
  });

  it('records a slideshow by its folder, and does not look inside it', () => {
    const { items } = scanDownloads('/out', {
      fs: fakeFs({
        '/out': ['creatorone/'],
        '/out/creatorone': [`002 - creatorone - ${ID_B}/`],
        // Never read: the pictures carry no id, and the folder is the record.
      }),
    });

    expect(items).toEqual([{ awemeId: ID_B, filePath: `/out/creatorone/002 - creatorone - ${ID_B}`, handle: 'creatorone' }]);
  });

  it('ignores a transfer that has not finished', () => {
    const { items } = scanDownloads('/out', {
      fs: fakeFs({
        '/out': [`001 - a - ${ID_A}.mp4.part`, `002 - a - ${ID_B}.mp4.download`, `003 - a - ${ID_C}.mp4`],
      }),
    });

    /**
     * The mistake this guards against is the mirror image of the bug: half a
     * video recorded as taken means the real one never arrives.
     */
    expect(items.map((item) => item.awemeId)).toEqual([ID_C]);
  });

  it('leaves files with no account folder unattributed rather than guessing', () => {
    const { items } = scanDownloads('/out', {
      fs: fakeFs({ '/out': [`001 - x - ${ID_A}.mp4`] }),
    });

    // Pasted links land at the top level. They still count as downloaded; they
    // just do not belong to a saved account.
    expect(items[0]?.handle).toBeNull();
  });

  it('survives a folder it cannot read', () => {
    const { items } = scanDownloads('/out', {
      fs: fakeFs({
        '/out': ['locked/', 'creatorone/'],
        // '/out/locked' deliberately absent, so readdir throws for it.
        '/out/creatorone': [`001 - creatorone - ${ID_A}.mp4`],
      }),
    });

    expect(items.map((item) => item.awemeId)).toEqual([ID_A]);
  });

  it('stops rather than walking an entire drive', () => {
    const { truncated } = scanDownloads('/out', {
      fs: fakeFs({ '/out': Array.from({ length: 50 }, (_unused, i) => `${i} - a - 731111111111111111${i % 10}.mp4`) }),
      maxEntries: 10,
    });

    expect(truncated).toBe(true);
  });
});

/**
 * The bug in the user's words: ten accounts, five videos each, and after
 * closing the app or clearing the Library the same fifty download again before
 * it moves on to anything new.
 *
 * The run asks one question — which of this account's videos do I already
 * have? — and answers it from the ledger. Everything downstream was right; the
 * input was missing. Reading the folder makes the answer come from the videos.
 */
describe('bringing the record back in step with the folder', () => {
  it('recovers a library the database no longer knows about', () => {
    const repo = ledger();
    const fs = fakeFs({
      '/out': ['creatorone/', 'creatortwo/'],
      '/out/creatorone': [`001 - creatorone - ${ID_A}.mp4`, `002 - creatorone - ${ID_B}.mp4`],
      '/out/creatortwo': [`001 - creatortwo - ${ID_C}.mp4`],
    });

    const result = reconcileLedger({ outputDir: '/out', ledger: repo, fs });

    expect(result).toEqual({ found: 3, recovered: 3, truncated: false });
    expect(repo.isSettled(ID_A)).toBe(true);
    expect(repo.isSettled(ID_C)).toBe(true);
    // And attributed, so the per-account count is right too — which is what
    // decides whether the run visits the account at all.
    expect(repo.countForHandle('creatorone', 'downloaded')).toBe(2);
    expect(repo.countForHandle('creatortwo', 'downloaded')).toBe(1);
  });

  it('writes nothing when the record is already correct', () => {
    const repo = ledger();
    repo.record({ awemeId: ID_A, handle: 'creatorone', status: 'downloaded' });
    const fs = fakeFs({ '/out': ['creatorone/'], '/out/creatorone': [`001 - creatorone - ${ID_A}.mp4`] });

    // The common case, on every run after the first: one directory read and no
    // writes at all.
    expect(reconcileLedger({ outputDir: '/out', ledger: repo, fs })).toEqual({
      found: 1,
      recovered: 0,
      truncated: false,
    });
  });

  it('does not resurrect a video whose file the user deleted', () => {
    const repo = ledger();
    repo.record({ awemeId: ID_A, handle: 'creatorone', status: 'downloaded' });
    repo.forget(ID_A);

    // Deleting through the Library removes the file and the entry together, so
    // the scan finds nothing to put back. That is the one deletion the app can
    // be certain of, and it stays honoured.
    reconcileLedger({ outputDir: '/out', ledger: repo, fs: fakeFs({ '/out': [] }) });
    expect(repo.isSettled(ID_A)).toBe(false);
  });

  it('leaves an entry alone when its file has merely moved', () => {
    const repo = ledger();
    repo.record({ awemeId: ID_A, handle: 'creatorone', status: 'downloaded', filePath: '/out/old/name.mp4' });

    /**
     * Only ever adds. A missing file means renamed or moved at least as often
     * as deleted, and the ledger exists precisely so that tidying a folder does
     * not start the archive downloading itself again.
     */
    reconcileLedger({ outputDir: '/out', ledger: repo, fs: fakeFs({ '/out': [] }) });
    expect(repo.isSettled(ID_A)).toBe(true);
  });

  it('does nothing at all before an output folder has been chosen', () => {
    const repo = ledger();
    expect(reconcileLedger({ outputDir: '', ledger: repo })).toEqual({ found: 0, recovered: 0, truncated: false });
  });
});

/**
 * The other half of the same fault.
 *
 * The saved creator list stores handles lowercased; the ledger recorded
 * whatever TikTok reported for the video. They are compared directly to answer
 * "how many does this account owe me?", so a difference in case answered zero
 * for an account with five on disk — and the run took five more.
 */
describe('handles, however they are spelled', () => {
  it('counts a video recorded under a different case', () => {
    const repo = ledger();
    repo.record({ awemeId: ID_A, handle: 'CreatorOne', status: 'downloaded' });

    expect(repo.countForHandle('creatorone', 'downloaded')).toBe(1);
    expect(repo.downloadedByHandle().get('creatorone')).toBe(1);
  });

  it('answers a query in any case too', () => {
    const repo = ledger();
    repo.record({ awemeId: ID_A, handle: 'creatorone', status: 'downloaded' });
    expect(repo.countForHandle('CREATORONE', 'downloaded')).toBe(1);
  });

  it('treats a blank handle as no handle', () => {
    const repo = ledger();
    repo.record({ awemeId: ID_A, handle: '  ', status: 'downloaded' });
    expect(repo.downloadedByHandle().size).toBe(0);
    expect(repo.countForHandle('', 'downloaded')).toBe(0);
  });
});
