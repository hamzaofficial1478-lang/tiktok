import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { LinkLedgerRepository } from '../db/repositories/link-ledger';

/**
 * Rebuilding "what have I already taken?" from the videos themselves.
 *
 * ## The failure this exists for
 *
 * Ten accounts, five videos each. Press Run: fifty videos arrive. Close the
 * app, or clear the Library list, then press Run again — and the same fifty
 * download a second time before it moves on to anything new. Press it once
 * more and it behaves correctly again.
 *
 * That shape is the signature of a record that went missing rather than logic
 * that is wrong. The run asks the ledger which of an account's newest videos it
 * already has; with the ledger empty it correctly concludes it has none, takes
 * the newest five again, and — because taking them writes the ledger back —
 * gets the right answer on the attempt after. Everything downstream behaves
 * exactly as designed. The input was gone.
 *
 * Clearing the Library was one way to lose it, and that is fixed at the source.
 * But a record with only one copy will be lost again, by some other route: a
 * crash between the file landing and the row being written, a database restored
 * from a backup, a profile copied to a new machine, a folder brought over from
 * an older version of the app. Every one of those produces the same afternoon
 * of re-downloading, and none of them can be fixed by being more careful with
 * the row.
 *
 * ## Why the files are the better source
 *
 * The videos are on disk with TikTok's own id in their names — the default
 * filename template is `{index:3} - {author} - {id}` — inside a folder named
 * after the account. That is the same fact the ledger holds, written down in a
 * second place, by the same program, and it survives everything the database
 * does not: it *is* the thing the user actually cares about keeping.
 *
 * So the ledger is treated as a cache of the folder rather than as the only
 * copy. On startup and before every run, the folder is read and anything in it
 * the ledger has not heard of is recorded. The app converges on the truth
 * instead of drifting away from it, and pointing a fresh install at an existing
 * archive now means it knows what is in it.
 *
 * ## What it will not do
 *
 * Only ever adds. A ledger entry whose file is not found is left completely
 * alone, because a missing file means moved or renamed at least as often as it
 * means deleted, and the ledger exists precisely so that moving a video does
 * not cause it to be downloaded again. Deleting a video through the Library is
 * the one deletion the app can be sure of, and that path removes the entry
 * itself — the file is gone by then, so nothing here can put it back.
 */

/**
 * A TikTok id inside a filename.
 *
 * 15-21 digits, matching what the URL parser accepts, and bounded by non-digits
 * so a longer number cannot be sliced into something that looks like an id. The
 * template is user-editable and need not contain `{id}` at all, so this reads
 * the name rather than assuming a layout — a filename with no id in it is
 * simply skipped, and the account it belongs to falls back to the ledger.
 */
const AWEME_ID_IN_NAME = /(?<!\d)(\d{15,21})(?!\d)/;

/** TikTok's own rule for a handle, which is what the folders are named after. */
const FOLDER_HANDLE = /^[a-z0-9._]{1,24}$/i;

/**
 * What a finished download looks like.
 *
 * `.part` and `.download` are deliberately absent: a half-transferred file is
 * not a video anybody has, and recording one would be the very mistake this is
 * meant to prevent, in the opposite direction. Sidecars share the video's stem
 * and would name an id that is already recorded, so excluding them costs
 * nothing and keeps the scan honest about what it found.
 */
const MEDIA_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.mov',
  '.m4v',
  '.m4a',
  '.mp3',
  '.opus',
  '.aac',
  '.flac',
  '.wav',
]);

/** The output folder, an account folder inside it, and a slideshow inside that. */
const MAX_DEPTH = 3;

/**
 * Enough for any real library, and a stop for a folder that is not one.
 *
 * Someone will eventually point the output folder at their whole drive. That
 * should be slow once and then finish, not hang the app on every run.
 */
const MAX_ENTRIES = 50_000;

export interface ReconcileResult {
  /** Finished downloads found on disk that carried an id. */
  readonly found: number;
  /** Of those, how many the ledger had never heard of. */
  readonly recovered: number;
  /** True when the scan hit its ceiling and stopped early. */
  readonly truncated: boolean;
}

export function awemeIdFromName(name: string): string | null {
  const found = AWEME_ID_IN_NAME.exec(name);
  return found ? (found[1] as string) : null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/** Injectable so the scan can be tested without writing files to a real disk. */
export interface ScanFs {
  readonly readdir: (dir: string) => readonly { name: string; isDirectory: boolean; isFile: boolean }[];
  readonly mtimeMs: (path: string) => number;
}

const realFs: ScanFs = {
  readdir: (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
  },
  mtimeMs: (path) => statSync(path).mtimeMs,
};

interface Found {
  readonly awemeId: string;
  readonly filePath: string;
  readonly handle: string | null;
}

/**
 * Walks the output folder and reports every finished download it can name.
 *
 * Separate from the recording below so the traversal can be tested on its own,
 * and so a caller that only wants to know what is there does not have to write
 * anything to find out.
 */
export function scanDownloads(
  outputDir: string,
  options: { fs?: ScanFs; maxEntries?: number } = {},
): { readonly items: readonly Found[]; readonly truncated: boolean } {
  const fs = options.fs ?? realFs;
  const ceiling = options.maxEntries ?? MAX_ENTRIES;
  const items: Found[] = [];
  let seen = 0;
  let truncated = false;

  const walk = (dir: string, depth: number, handle: string | null): void => {
    if (truncated) return;

    let entries: readonly { name: string; isDirectory: boolean; isFile: boolean }[];
    try {
      entries = fs.readdir(dir);
    } catch {
      // An unreadable folder is not a reason to abandon the rest of the scan.
      return;
    }

    for (const entry of entries) {
      if (++seen > ceiling) {
        truncated = true;
        return;
      }

      const path = join(dir, entry.name);

      if (entry.isDirectory) {
        /**
         * A folder named after a video is a photo slideshow.
         *
         * The pictures inside it carry no id of their own, so the folder is the
         * record — and there is nothing below it worth descending into.
         */
        const slideshow = awemeIdFromName(entry.name);
        if (slideshow) {
          items.push({ awemeId: slideshow, filePath: path, handle });
          continue;
        }

        if (depth >= MAX_DEPTH) continue;
        // Only the folders directly inside the output directory name an
        // account; anything deeper keeps the one it inherited.
        const inherited = handle ?? (FOLDER_HANDLE.test(entry.name) ? entry.name.toLowerCase() : null);
        walk(path, depth + 1, inherited);
        continue;
      }

      if (!entry.isFile) continue;
      if (!MEDIA_EXTENSIONS.has(extensionOf(entry.name))) continue;

      const awemeId = awemeIdFromName(entry.name);
      if (awemeId) items.push({ awemeId, filePath: path, handle });
    }
  };

  walk(outputDir, 0, null);
  return { items, truncated };
}

/**
 * Brings the ledger up to date with what is actually in the output folder.
 *
 * Cheap when there is nothing to do, which is the common case: the membership
 * test is against a set already in memory, so a library of ten thousand videos
 * costs one directory walk and ten thousand set lookups, and writes nothing.
 */
export function reconcileLedger(options: {
  readonly outputDir: string;
  readonly ledger: LinkLedgerRepository;
  readonly log?: Logger | undefined;
  readonly fs?: ScanFs | undefined;
  readonly maxEntries?: number | undefined;
}): ReconcileResult {
  if (!options.outputDir) return { found: 0, recovered: 0, truncated: false };

  const { items, truncated } = scanDownloads(options.outputDir, {
    ...(options.fs ? { fs: options.fs } : {}),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
  });

  const fs = options.fs ?? realFs;
  let recovered = 0;

  for (const item of items) {
    if (options.ledger.isSettled(item.awemeId)) continue;

    /**
     * Dated by the file rather than by the clock.
     *
     * `settled_at` is meant to say when the video was taken, and a scan that
     * stamped everything with the moment it ran would report a five-month-old
     * archive as having been downloaded this afternoon.
     */
    let settledAt: number;
    try {
      settledAt = fs.mtimeMs(item.filePath);
    } catch {
      settledAt = Date.now();
    }

    options.ledger.record({
      awemeId: item.awemeId,
      handle: item.handle,
      status: 'downloaded',
      filePath: item.filePath,
      now: settledAt,
    });
    recovered++;
  }

  if (recovered > 0 || truncated) {
    options.log?.info(
      { found: items.length, recovered, truncated, outputDir: options.outputDir },
      'brought the record of downloaded videos back in step with the output folder',
    );
  }

  return { found: items.length, recovered, truncated };
}
