import { lstatSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Logger } from 'pino';

/**
 * Putting a new executable where an old one is, on Windows.
 *
 * `rename` is atomic and instant on every platform, and on Windows it also
 * fails outright if anything anywhere holds the file open:
 *
 *     EPERM: operation not permitted, rename
 *       '…\bin\win32-x64\yt-dlp.exe.new' -> '…\bin\win32-x64\yt-dlp.exe'
 *
 * That is a real report from a real machine, and it is not a permissions
 * problem despite what the code says. Two things hold the handle, and both are
 * temporary:
 *
 *  1. The *source*. The updater proves a downloaded binary before trusting it,
 *     by running it with `--version` — so a fraction of a second before the
 *     rename, that exact file was a running process. Windows keeps the image
 *     section mapped for a moment after a process exits, and a mapped
 *     executable cannot be renamed.
 *  2. The *destination*, or the source again: Defender and every other
 *     real-time scanner opens a newly written `.exe` to inspect it. That scan
 *     takes a moment and blocks the rename while it runs.
 *
 * Both clear on their own, so the first answer is simply to wait and try again.
 *
 * When waiting is not enough, the destination is the one being held, and there
 * is a second answer: a file with an open handle usually *can* be renamed out
 * of the way, because the loader opens executables allowing exactly that. So
 * the old file is moved aside and the new one takes its name. This is the trick
 * every self-updating program on Windows uses, and it is why a browser can
 * replace itself while you are using it.
 */

/** Errors that mean "something is holding the file", not "you may not do this". */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY']);

/** Grows to a few seconds in total — well past a scanner's grip on one file. */
const RETRY_DELAYS_MS = [50, 150, 400, 900, 1_500] as const;

const SIDELINE_SUFFIX = '.superseded-';

function codeOf(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The two filesystem calls this makes, injectable.
 *
 * Not for neatness: the behaviour worth testing is what happens when a rename
 * comes back EPERM, and a lock cannot be produced on the platform this suite
 * runs on. Handing the calls in is the only way to exercise the path that
 * decides whether a real update on Windows survives or reports an internal
 * error to the user.
 */
export interface FileOps {
  rename(from: string, to: string): void;
  remove(path: string): void;
}

const REAL_FS: FileOps = {
  rename: (from, to) => {
    // An unexpected directory is not a locked executable to move aside.
    if (lstatSync(from, { throwIfNoEntry: false })?.isDirectory() ||
        lstatSync(to, { throwIfNoEntry: false })?.isDirectory()) {
      throw Object.assign(new Error('refusing to replace a directory'), { code: 'EISDIR' });
    }
    renameSync(from, to);
  },
  remove: (path) => rmSync(path, { force: true }),
};

export interface ReplaceFileResult {
  /** How it went in, for the log: straight away, after waiting, or by sidelining. */
  readonly how: 'direct' | 'retried' | 'sidelined';
  readonly attempts: number;
  /** The old file, when it could not be deleted and was left for later. */
  readonly leftBehind: string | null;
}

/**
 * Moves `staging` onto `target`, waiting out whatever is holding either.
 *
 * Throws only when the file genuinely cannot be replaced — a read-only volume,
 * a missing directory, a real permissions problem. A lock is not that, and a
 * lock is what this exists to survive.
 */
export async function replaceFile(
  staging: string,
  target: string,
  options: { log?: Logger | undefined; delays?: readonly number[]; fs?: FileOps } = {},
): Promise<ReplaceFileResult> {
  const delays = options.delays ?? RETRY_DELAYS_MS;
  const io = options.fs ?? REAL_FS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      io.rename(staging, target);
      return { how: attempt === 0 ? 'direct' : 'retried', attempts: attempt + 1, leftBehind: null };
    } catch (err) {
      lastError = err;
      if (!TRANSIENT.has(codeOf(err))) throw err;

      const delay = delays[attempt];
      if (delay === undefined) break;
      options.log?.debug({ target, attempt: attempt + 1, code: codeOf(err) }, 'the file is in use; waiting to retry');
      await sleep(delay);
    }
  }

  /**
   * Still held after all that, so the destination is the problem.
   *
   * Renaming it away is allowed where replacing it is not, and it leaves the
   * old binary intact under a new name — so if the second rename somehow fails
   * too, it can be put back rather than leaving nothing at all where the
   * extractor should be.
   */
  const sidelined = `${target}${SIDELINE_SUFFIX}${Date.now()}`;
  try {
    io.rename(target, sidelined);
  } catch {
    throw lastError;
  }

  try {
    io.rename(staging, target);
  } catch (err) {
    // Put it back. An update that fails is recoverable; an update that leaves
    // no extractor at all breaks every download until someone notices.
    try {
      io.rename(sidelined, target);
    } catch {
      /* nothing further to try */
    }
    throw err;
  }

  let leftBehind: string | null = null;
  try {
    io.remove(sidelined);
  } catch {
    // Whatever was holding it still is. Harmless where it sits, and swept up
    // by `sweepSuperseded` on a later run once the handle is gone.
    leftBehind = sidelined;
  }

  options.log?.info({ target, sidelined, leftBehind }, 'replaced a file that was in use by moving the old one aside');
  return { how: 'sidelined', attempts: delays.length + 1, leftBehind };
}

/**
 * Deletes the old files a previous sidelined replacement could not.
 *
 * Cheap, best-effort and safe to call at any time: whatever was holding one has
 * almost certainly let go by the next run, and anything still held is simply
 * skipped and tried again another day.
 */
export function sweepSuperseded(target: string, log?: Logger): number {
  const folder = dirname(target);
  const prefix = `${basename(target)}${SIDELINE_SUFFIX}`;

  let removed = 0;
  try {
    for (const name of readdirSync(folder)) {
      if (!name.startsWith(prefix)) continue;
      try {
        rmSync(join(folder, name), { force: true });
        removed++;
      } catch {
        /* still held; another day */
      }
    }
  } catch {
    // No folder yet, which is the normal case before the first update.
    return 0;
  }

  if (removed > 0) log?.debug({ folder, removed }, 'cleaned up superseded binaries');
  return removed;
}
