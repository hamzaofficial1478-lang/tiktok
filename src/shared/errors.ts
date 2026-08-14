/**
 * Error taxonomy — spec section 11.
 *
 * Every failure in the app maps to exactly one of these codes. The registry
 * below is the single source of truth for what the user is told and what the
 * engine is allowed to do about it. Two separate retry concepts, because they
 * are genuinely different:
 *
 *   autoRetry     — the queue engine's 3-attempt exponential backoff applies.
 *                   Reserved for transient faults (section 8: network timeout,
 *                   connection reset, 5xx, rate limit). Burning retries on a
 *                   deleted video wastes the user's rate budget.
 *   userRetryable — the UI shows a Retry button. Broader than autoRetry: a
 *                   full disk or a bad output folder is not worth an automatic
 *                   retry, but is absolutely worth a manual one once fixed.
 *
 * A code with neither is terminal, and its row must render without a Retry
 * button at all rather than offering an action that cannot succeed.
 */

/**
 * The 17 codes section 11 enumerates. These are *item* failures — each one can
 * appear on a queue row and has a message written for the person who pasted
 * the link.
 */
export const SPEC_ERROR_CODES = [
  'INVALID_URL',
  'NOT_A_TIKTOK_URL',
  'RESOLVE_FAILED',
  'VIDEO_PRIVATE',
  'VIDEO_DELETED',
  'REGION_BLOCKED',
  'AGE_RESTRICTED',
  'UNSUPPORTED_MEDIA',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'EXTRACTOR_FAILED',
  'DOWNLOAD_INCOMPLETE',
  'VERIFY_FAILED',
  'FFMPEG_FAILED',
  'DISK_FULL',
  'PERMISSION_DENIED',
  'CANCELLED',
] as const;

/**
 * One addition to the brief's list: `INTERNAL_ERROR`.
 *
 * A malformed IPC payload or a failed invariant is a bug in our own code, not
 * a download failure, and it has no honest home among the 17. Reusing
 * INVALID_URL for it would tell a user "This doesn't look like a web address"
 * when the real cause is a schema violation between our own two processes —
 * precisely the misleading message section 11 exists to prevent. It never
 * appears on a queue row; it only ever surfaces at the IPC boundary.
 */
export const ERROR_CODES = [...SPEC_ERROR_CODES, 'INTERNAL_ERROR', 'CDN_FORBIDDEN'] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export type SpecErrorCode = (typeof SPEC_ERROR_CODES)[number];

/**
 * Remedial action the UI should offer inline alongside the message. Keeps the
 * "what can I do about it" out of prose and in something the UI can render as
 * a button. `update-extractor` exists because section 2 requires a stale
 * extractor to never present as a generic network error.
 */
export type ErrorAction =
  | 'retry'
  | 'update-extractor'
  | 'choose-folder'
  | 'free-space'
  | 'open-logs'
  | 'none';

export interface ErrorDescriptor {
  readonly code: ErrorCode;
  /** Short label for the status chip. */
  readonly title: string;
  /** Full sentence: what happened, then what the user can do. Never a stack trace. */
  readonly message: string;
  readonly autoRetry: boolean;
  readonly userRetryable: boolean;
  readonly action: ErrorAction;
}

export const ERROR_REGISTRY: Readonly<Record<ErrorCode, ErrorDescriptor>> = {
  INVALID_URL: {
    code: 'INVALID_URL',
    title: 'Invalid link',
    message: "This doesn't look like a web address. Check for typos or missing characters and add it again.",
    autoRetry: false,
    userRetryable: false,
    action: 'none',
  },
  NOT_A_TIKTOK_URL: {
    code: 'NOT_A_TIKTOK_URL',
    title: 'Not a TikTok link',
    message: 'This link points somewhere other than TikTok. Only TikTok video links can be downloaded.',
    autoRetry: false,
    userRetryable: false,
    action: 'none',
  },
  RESOLVE_FAILED: {
    code: 'RESOLVE_FAILED',
    title: 'Could not read video',
    message: "TikTok didn't return usable video details. This is often temporary — retry in a moment.",
    autoRetry: true,
    userRetryable: true,
    action: 'retry',
  },
  VIDEO_PRIVATE: {
    code: 'VIDEO_PRIVATE',
    title: 'Private video',
    message: 'This video is private, or its author\'s account is. Only its owner can access it.',
    autoRetry: false,
    userRetryable: false,
    action: 'none',
  },
  VIDEO_DELETED: {
    code: 'VIDEO_DELETED',
    title: 'Video deleted',
    message: 'This video no longer exists on TikTok. It was removed by its author or by TikTok.',
    autoRetry: false,
    userRetryable: false,
    action: 'none',
  },
  CDN_FORBIDDEN: {
    code: 'CDN_FORBIDDEN',
    title: 'TikTok refused the file',
    message:
      'TikTok served the video details but refused the file itself. This usually clears on a retry with a fresh ' +
      'link. If it persists, try Settings \u2192 Use cookies from, and pick the browser you watch TikTok in.',
    action: 'retry',
    autoRetry: true,
    userRetryable: true,
  },
  REGION_BLOCKED: {
    code: 'REGION_BLOCKED',
    title: 'Blocked in your region',
    message: 'TikTok will not serve this video from your location. A proxy can be set in Settings.',
    autoRetry: false,
    userRetryable: false,
    action: 'none',
  },
  AGE_RESTRICTED: {
    code: 'AGE_RESTRICTED',
    title: 'Age restricted',
    message: 'This video is age restricted and cannot be downloaded without a signed-in session.',
    autoRetry: false,
    userRetryable: false,
    action: 'none',
  },
  UNSUPPORTED_MEDIA: {
    code: 'UNSUPPORTED_MEDIA',
    title: 'Not a video',
    message: 'This link is a photo slideshow, not a video. Slideshow downloading is not supported yet.',
    autoRetry: false,
    userRetryable: false,
    action: 'none',
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    title: 'Rate limited',
    message: 'TikTok is temporarily refusing requests from this connection. Slowing down and retrying automatically.',
    autoRetry: true,
    userRetryable: true,
    action: 'retry',
  },
  NETWORK_ERROR: {
    code: 'NETWORK_ERROR',
    title: 'Network problem',
    message: 'The connection dropped or timed out. Check your internet connection, then retry.',
    autoRetry: true,
    userRetryable: true,
    action: 'retry',
  },
  EXTRACTOR_FAILED: {
    code: 'EXTRACTOR_FAILED',
    title: 'Extractor out of date',
    message:
      'TikTok changed how videos are served and the downloader engine needs updating. Update the extractor, then retry.',
    autoRetry: false,
    userRetryable: true,
    action: 'update-extractor',
  },
  DOWNLOAD_INCOMPLETE: {
    code: 'DOWNLOAD_INCOMPLETE',
    title: 'Download interrupted',
    message: 'The download stopped before finishing. The partial file was kept and can be resumed.',
    autoRetry: true,
    userRetryable: true,
    action: 'retry',
  },
  VERIFY_FAILED: {
    code: 'VERIFY_FAILED',
    title: 'Damaged file',
    message: 'The downloaded file failed its integrity check and was discarded rather than saved broken. Retry to download it again.',
    autoRetry: true,
    userRetryable: true,
    action: 'retry',
  },
  FFMPEG_FAILED: {
    code: 'FFMPEG_FAILED',
    title: 'Processing failed',
    message: 'The video downloaded but could not be processed. The unprocessed file was kept. See Logs for details.',
    autoRetry: false,
    userRetryable: true,
    action: 'open-logs',
  },
  DISK_FULL: {
    code: 'DISK_FULL',
    title: 'Not enough space',
    message: 'There is not enough free space on the output drive. Free some space or pick another folder, then retry.',
    autoRetry: false,
    userRetryable: true,
    action: 'free-space',
  },
  PERMISSION_DENIED: {
    code: 'PERMISSION_DENIED',
    title: 'Folder not writable',
    message: 'The output folder cannot be written to. Choose a different folder or adjust its permissions.',
    autoRetry: false,
    userRetryable: true,
    action: 'choose-folder',
  },
  CANCELLED: {
    code: 'CANCELLED',
    title: 'Cancelled',
    message: 'You cancelled this download. Nothing was saved.',
    autoRetry: false,
    userRetryable: true,
    action: 'retry',
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    title: 'Unexpected problem',
    message: 'The app hit an internal problem and stopped this action safely. The details are in Logs.',
    autoRetry: false,
    userRetryable: false,
    action: 'open-logs',
  },
};

export function describeError(code: ErrorCode): ErrorDescriptor {
  return ERROR_REGISTRY[code];
}

export function isAutoRetryable(code: ErrorCode): boolean {
  return ERROR_REGISTRY[code].autoRetry;
}

/**
 * The only error type allowed to cross the IPC boundary or land in
 * `queue_items.error_code`. `detail` is diagnostic text for the Logs screen and
 * the "Copy diagnostic" button — it is never the string shown as the primary
 * message.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(ERROR_REGISTRY[code].message, options);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }

  get descriptor(): ErrorDescriptor {
    return ERROR_REGISTRY[this.code];
  }

  toJSON(): { code: ErrorCode; message: string; detail?: string } {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail };
  }
}

/**
 * Coerce anything thrown into an AppError. Used at every boundary so a raw
 * stack trace can never reach the renderer (section 11). Unknown throwables
 * become the supplied fallback with the original text preserved as detail.
 */
export function toAppError(err: unknown, fallback: ErrorCode = 'RESOLVE_FAILED'): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) return new AppError(fallback, `${err.name}: ${err.message}`, { cause: err });
  return new AppError(fallback, typeof err === 'string' ? err : JSON.stringify(err));
}
