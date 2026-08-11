import type { ErrorCode } from '@shared/errors';
import type { ParseResult } from '../resolve/url-normalizer';
import type { DownloadsRepository, DownloadWithVideo } from '../db/repositories/downloads';
import type { QueueItemsRepository } from '../db/repositories/queue-items';

/**
 * Deduplication — spec section 7's four layers.
 *
 * Each layer answers a different question and, crucially, has a different
 * interruption cost. Layer 1 and 2 are silent or a toast; only layer 3 may ask
 * the user anything, and even then it must never stall the queue; layer 4 is
 * advisory only.
 */

/* ------------------------------------------------------------------ *
 * Layer 1 — within the paste itself
 * ------------------------------------------------------------------ */

export interface PasteEntry {
  readonly rawUrl: string;
  readonly parsed: ParseResult;
  /** What layer 1 deduplicated on. */
  readonly key: string;
}

export interface PasteDedupResult {
  readonly unique: readonly PasteEntry[];
  readonly duplicatesRemoved: number;
  readonly invalid: readonly { readonly rawUrl: string; readonly code: ErrorCode }[];
  readonly totalFound: number;
}

/**
 * Dedupes a pasted block before anything enters the queue.
 *
 * The dedup key is the aweme ID whenever the URL yields one synchronously,
 * and the short-link URL otherwise. Short links cannot be compared by ID
 * without a network round trip each, and resolving 300 of them before the
 * queue even starts would trade a correct count for a minute of dead time —
 * layer 2 catches those a moment later anyway.
 *
 * Order is preserved: the first occurrence of a duplicate wins, so paste order
 * still maps to queue order (section 8).
 */
export function dedupePaste(rawUrls: readonly string[], parse: (input: string) => ParseResult): PasteDedupResult {
  const seen = new Set<string>();
  const unique: PasteEntry[] = [];
  const invalid: { rawUrl: string; code: ErrorCode }[] = [];
  let duplicatesRemoved = 0;
  let totalFound = 0;

  for (const rawUrl of rawUrls) {
    const trimmed = rawUrl.trim();
    if (trimmed === '') continue;
    totalFound++;

    const parsed = parse(trimmed);
    if (parsed.status === 'invalid') {
      invalid.push({ rawUrl: trimmed, code: parsed.code });
      continue;
    }

    const key = parsed.status === 'resolved' ? `id:${parsed.awemeId}` : `url:${parsed.shortUrl.toLowerCase()}`;
    if (seen.has(key)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(key);
    unique.push({ rawUrl: trimmed, parsed, key });
  }

  return { unique, duplicatesRemoved, invalid, totalFound };
}

/* ------------------------------------------------------------------ *
 * Layers 2 and 3 — against the queue, then against history
 * ------------------------------------------------------------------ */

export type DuplicateVerdict =
  /** Nothing matches; proceed. */
  | { readonly kind: 'none' }
  /** Layer 2: already queued or in flight. Inline toast, no dialog. */
  | { readonly kind: 'in-queue'; readonly existingItemId: number }
  /** Layer 3: downloaded before and the file is still there. Ask the user. */
  | { readonly kind: 'needs-decision'; readonly existing: DownloadWithVideo }
  /**
   * Layer 3, the quiet branch: history says downloaded, but the file is gone.
   * Section 7 is explicit that prompting here is annoying — the record is
   * corrected and the download proceeds silently.
   */
  | { readonly kind: 'stale-record'; readonly downloadId: number; readonly existing: DownloadWithVideo };

export interface DedupCheckOptions {
  readonly queueItems: QueueItemsRepository;
  readonly downloads: DownloadsRepository;
  /** Injected so the check is testable without touching a disk. */
  readonly fileExists: (path: string) => boolean;
}

/**
 * Runs layers 2 and 3 for one item.
 *
 * @param excludeItemId the item being checked, so it does not match itself.
 */
export function checkDuplicate(
  awemeId: string,
  excludeItemId: number,
  options: DedupCheckOptions,
): DuplicateVerdict {
  const active = options.queueItems.findActiveByAwemeId(awemeId);
  if (active && active.id !== excludeItemId) {
    return { kind: 'in-queue', existingItemId: active.id };
  }

  const existing = options.downloads.findExistingByAwemeId(awemeId);
  if (!existing) return { kind: 'none' };

  if (!options.fileExists(existing.file_path)) {
    return { kind: 'stale-record', downloadId: existing.id, existing };
  }

  return { kind: 'needs-decision', existing };
}

/* ------------------------------------------------------------------ *
 * Layer 4 — content-level, after the file exists
 * ------------------------------------------------------------------ */

export interface RepostFlag {
  readonly isPossibleRepost: boolean;
  readonly matches: readonly DownloadWithVideo[];
}

/**
 * Looks for the same content under a different aweme ID.
 *
 * Advisory by design: section 7 requires this to badge the item in the Library
 * and never to block, because perceptual hashing has false positives and
 * refusing a legitimate download is worse than keeping a duplicate.
 */
export function checkRepost(
  downloads: DownloadsRepository,
  phash: string | null,
  videoId: number,
): RepostFlag {
  if (!phash) return { isPossibleRepost: false, matches: [] };
  const matches = downloads.findRepostCandidates(phash, videoId);
  return { isPossibleRepost: matches.length > 0, matches };
}
