import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceFile, sweepSuperseded, type FileOps } from '@main/media/replace-file';

/**
 * The failure this exists for, verbatim from a user's log:
 *
 *   IPC handler failed {"channel":"app:updateExtractor","code":"INTERNAL_ERROR",
 *     "detail":"Error: EPERM: operation not permitted, rename
 *      '…\\bin\\win32-x64\\yt-dlp.exe.new' -> '…\\bin\\win32-x64\\yt-dlp.exe'"}
 *
 * Not a permissions problem, despite the code. The updater proves a downloaded
 * binary by running it with `--version` immediately before renaming it, and
 * Windows keeps an executable's image mapped for a moment after it exits —
 * while Defender opens any newly written `.exe` to scan it. Either holds the
 * file long enough for `rename` to fail outright.
 *
 * The locking itself cannot be reproduced on the platform this suite runs on.
 * What can be, and what decides whether a real update survives, is what the
 * code does when a rename comes back with the codes Windows uses — which is
 * why the two filesystem calls are handed in.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'replace-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function lockedError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: operation not permitted, rename`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

const realOps: FileOps = {
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
};

/** Records every rename, and lets a test refuse whichever ones it likes. */
function ops(refuse: (from: string, to: string, nth: number) => NodeJS.ErrnoException | null): {
  fs: FileOps;
  renames: [string, string][];
} {
  const renames: [string, string][] = [];
  return {
    renames,
    fs: {
      rename: (from, to) => {
        renames.push([from, to]);
        const err = refuse(from, to, renames.length);
        if (err) throw err;
        realOps.rename(from, to);
      },
      remove: realOps.remove,
    },
  };
}

const staged = (name = 'yt-dlp.exe'): { staging: string; target: string } => {
  const target = join(dir, name);
  const staging = `${target}.new`;
  writeFileSync(target, 'old binary');
  writeFileSync(staging, 'new binary');
  return { staging, target };
};

const fast = [1, 1, 1, 1] as const;

describe('replacing a file that is momentarily in use', () => {
  it('puts the new file in place when nothing is holding it', async () => {
    const { staging, target } = staged();

    const result = await replaceFile(staging, target);

    expect(result.how).toBe('direct');
    expect(readFileSync(target, 'utf8')).toBe('new binary');
  });

  it('waits out a scanner rather than giving up on the first EPERM', async () => {
    const { staging, target } = staged();
    const io = ops((_from, _to, nth) => (nth <= 2 ? lockedError('EPERM') : null));

    const result = await replaceFile(staging, target, { delays: fast, fs: io.fs });

    // The whole failure was one rename, one error, one dead update.
    expect(result.how).toBe('retried');
    expect(readFileSync(target, 'utf8')).toBe('new binary');
  });

  it.each(['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY'])('treats %s as "in use", not as a refusal', async (code) => {
    const { staging, target } = staged();
    const io = ops((_from, _to, nth) => (nth === 1 ? lockedError(code) : null));

    await replaceFile(staging, target, { delays: fast, fs: io.fs });
    expect(readFileSync(target, 'utf8')).toBe('new binary');
  });

  it('moves the old file aside when waiting is not enough', async () => {
    const { staging, target } = staged();
    /**
     * A held *destination*: writing over the target is refused, and renaming
     * the target away is allowed. That asymmetry is real — the Windows loader
     * opens an executable in a way that permits exactly this — and it is the
     * trick every self-updating program on Windows relies on. Once the old
     * file is out of the way, the path is free and the new one goes in.
     */
    let occupied = true;
    const io = ops((from, to) => {
      if (from === staging && to === target && occupied) return lockedError('EPERM');
      if (from === target) occupied = false;
      return null;
    });

    const result = await replaceFile(staging, target, { delays: [1, 1], fs: io.fs });

    expect(result.how).toBe('sidelined');
    expect(readFileSync(target, 'utf8')).toBe('new binary');
    expect(io.renames.at(-1)).toEqual([staging, target]);
  });

  it('cleans up the file it moved aside', async () => {
    const { staging, target } = staged();
    let firstSideline = true;
    const io = ops((from, to) => {
      // Refuse the direct route until the old file has been moved away, then
      // allow it — exactly what a released handle looks like.
      if (from === staging && to === target && firstSideline) return lockedError('EPERM');
      if (from === target) firstSideline = false;
      return null;
    });

    const result = await replaceFile(staging, target, { delays: [1], fs: io.fs });

    expect(result.leftBehind).toBeNull();
    expect(readdirSync(dir).filter((f) => f.includes('superseded'))).toHaveLength(0);
  });

  it('says so rather than deleting, when the old file cannot be removed either', async () => {
    const { staging, target } = staged();
    let firstSideline = true;
    const io: FileOps = {
      rename: (from, to) => {
        if (from === staging && to === target && firstSideline) throw lockedError('EPERM');
        if (from === target) firstSideline = false;
        realOps.rename(from, to);
      },
      remove: () => {
        throw lockedError('EPERM');
      },
    };

    const result = await replaceFile(staging, target, { delays: [1], fs: io });

    // Harmless where it sits, and swept up on a later run once the handle is
    // gone. Failing the update over it would be absurd — the update worked.
    expect(result.how).toBe('sidelined');
    expect(result.leftBehind).toContain('superseded');
    expect(readFileSync(target, 'utf8')).toBe('new binary');
  });

  it('puts the old file back if the replacement cannot be completed', async () => {
    const { staging, target } = staged();
    const io = ops((from) => (from === staging ? lockedError('EPERM') : null));

    await expect(replaceFile(staging, target, { delays: [1], fs: io.fs })).rejects.toThrow();

    // An update that fails is recoverable. An update that leaves nothing where
    // the extractor should be breaks every download until someone notices.
    expect(readFileSync(target, 'utf8')).toBe('old binary');
    expect(readdirSync(dir).filter((f) => f.includes('superseded'))).toHaveLength(0);
  });

  it('does not retry an error that will never clear', async () => {
    const { staging, target } = staged();
    const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
    err.code = 'ENOSPC';
    const io = ops(() => err);

    await expect(replaceFile(staging, target, { delays: [1, 1, 1], fs: io.fs })).rejects.toThrow(/ENOSPC/);
    // A full disk is not a lock, and waiting four seconds to say so helps
    // nobody.
    expect(io.renames).toHaveLength(1);
  });
});

describe('sweeping up what a previous update had to leave behind', () => {
  it('deletes the leftovers of a sidelined replacement', () => {
    const target = join(dir, 'yt-dlp.exe');
    writeFileSync(target, 'current');
    writeFileSync(`${target}.superseded-1000`, 'old');
    writeFileSync(`${target}.superseded-2000`, 'older');

    expect(sweepSuperseded(target)).toBe(2);
    expect(readdirSync(dir)).toEqual(['yt-dlp.exe']);
  });

  it('never touches the file in use, or anything else in the folder', () => {
    const target = join(dir, 'yt-dlp.exe');
    writeFileSync(target, 'current');
    writeFileSync(join(dir, 'ffmpeg.exe'), 'unrelated');
    writeFileSync(`${target}.superseded-1000`, 'old');

    sweepSuperseded(target);
    expect(readdirSync(dir).sort()).toEqual(['ffmpeg.exe', 'yt-dlp.exe']);
  });

  it('is a no-op before the folder exists, which is every first run', () => {
    expect(sweepSuperseded(join(dir, 'not-yet', 'yt-dlp.exe'))).toBe(0);
  });
});
