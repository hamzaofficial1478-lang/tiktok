/**
 * Domain vocabulary shared by main and renderer.
 *
 * These constants are the same strings persisted in SQLite (spec section 5),
 * so changing one is a migration, not a rename. Keep them in lockstep with
 * db/migrations.
 */

/** Queue state machine — spec section 8. */
export const QUEUE_STATUSES = [
  'queued',
  'resolving',
  'awaiting_user',
  'downloading',
  'processing',
  'completed',
  'failed',
  'skipped',
  'cancelled',
  'paused',
] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/**
 * Statuses that mean work is in flight. On startup these are reset to
 * 'queued' so a crash never strands an item (section 8, crash recovery).
 */
/**
 * How hard to sharpen, for a video that is going to be uploaded again.
 *
 * `unsharp` raises local contrast at edges. It adds no detail — the pixels are
 * the pixels — but it makes what survived TikTok's compression read as
 * crisper, and it means the next compressor has better-defended edges to spend
 * its bits on. Overdone it is unmistakable and cannot be undone, which is why
 * these are three conservative steps rather than a slider.
 */
export const SHARPEN_LEVELS = ['off', 'light', 'medium', 'strong'] as const;
export type SharpenLevel = (typeof SHARPEN_LEVELS)[number];

/**
 * How much of the bit budget to spend when a video is re-encoded at all.
 *
 * `balanced` is the near-transparent target that has always been used. The
 * higher steps are not about this encode looking better — it already looks
 * like its input — but about surviving the *next* one, when a platform
 * re-compresses the upload.
 */
export const ENCODE_QUALITIES = ['balanced', 'high', 'maximum'] as const;
export type EncodeQuality = (typeof ENCODE_QUALITIES)[number];

export const IN_FLIGHT_STATUSES = ['resolving', 'downloading', 'processing'] as const satisfies readonly QueueStatus[];

/** Statuses that occupy a slot for dedup layer 2 (section 7). */
export const ACTIVE_FOR_DEDUP_STATUSES = [
  'queued',
  'resolving',
  'awaiting_user',
  'downloading',
  'processing',
] as const satisfies readonly QueueStatus[];

export const TERMINAL_STATUSES = [
  'completed',
  'failed',
  'skipped',
  'cancelled',
] as const satisfies readonly QueueStatus[];

/** How a file's watermark state was achieved — `downloads.source_strategy`. */
export const SOURCE_STRATEGIES = ['clean_source', 'removelogo', 'blur', 'raw'] as const;
export type SourceStrategy = (typeof SOURCE_STRATEGIES)[number];

/** User's answer to a layer-3 duplicate prompt — `queue_items.duplicate_action`. */
export const DUPLICATE_ACTIONS = ['skip', 'redownload', 'replace'] as const;
export type DuplicateAction = (typeof DUPLICATE_ACTIONS)[number];

export const WATERMARK_MODES = ['auto', 'force_removal', 'keep'] as const;
export type WatermarkMode = (typeof WATERMARK_MODES)[number];

export const OUTRO_MODES = ['ask', 'always', 'never'] as const;
export type OutroMode = (typeof OUTRO_MODES)[number];

/**
 * What to do with a post that is a set of images rather than a video.
 *
 * 'ask' is the default and the interesting one: the question is put once per
 * post and the answer is written to the link ledger, so a slideshow that was
 * turned down is never raised again — including when the account it belongs to
 * is listed on a later run.
 */
export const PHOTO_SLIDESHOW_MODES = ['ask', 'download', 'skip'] as const;
export type PhotoSlideshowMode = (typeof PHOTO_SLIDESHOW_MODES)[number];

/** What the user decided about one slideshow. */
export const PHOTO_ACTIONS = ['download', 'skip'] as const;
export type PhotoAction = (typeof PHOTO_ACTIONS)[number];

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Browsers yt-dlp can lift cookies from.
 *
 * TikTok increasingly serves a normal page to a logged-in browser and refuses
 * the same request from a bare client. Borrowing the user's own session is the
 * one fix that addresses that directly, and it needs no proxy and no account
 * credentials from them.
 */
export const BROWSER_COOKIE_SOURCES = [
  'none',
  'chrome',
  'edge',
  'firefox',
  'brave',
  'chromium',
  'opera',
  'vivaldi',
  'safari',
] as const;
export type BrowserCookieSource = (typeof BROWSER_COOKIE_SOURCES)[number];
