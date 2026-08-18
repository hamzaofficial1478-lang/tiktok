import type { ErrorCode } from '@shared/errors';

/**
 * Translates yt-dlp's free-text failures into the section 11 taxonomy.
 *
 * This is the most fragile file in the resolution layer and it is fragile by
 * nature: yt-dlp reports almost everything as prose on stderr. Only a couple of
 * signals are structured — the numeric status codes below come from the
 * extractor source itself:
 *
 *     # 10216: private post; 10222: private account
 *     raise ExtractorError('Your IP address is blocked from accessing this post')
 *
 * Everything else is matched on message text, which upstream can reword at any
 * time. Two consequences shape the design:
 *
 *  - Order matters. Specific rules run before generic ones, so "Unable to
 *    download webpage: HTTP Error 404" is VIDEO_DELETED rather than
 *    NETWORK_ERROR — the difference decides whether the queue spends three
 *    retries and the user's rate budget on a video that no longer exists.
 *  - The default is EXTRACTOR_FAILED, not RESOLVE_FAILED. An unrecognised
 *    failure most often means TikTok changed something and the bundled yt-dlp
 *    is behind, which section 2 says must surface as its own actionable state
 *    with an update button — never as a generic network error.
 */

interface Rule {
  readonly pattern: RegExp;
  readonly code: ErrorCode;
  readonly why: string;
}

const RULES: readonly Rule[] = [
  // --- Structured signals from the extractor -----------------------------
  { pattern: /status code 10216\b/i, code: 'VIDEO_PRIVATE', why: 'private post' },
  { pattern: /status code 10222\b/i, code: 'VIDEO_PRIVATE', why: 'private account' },
  { pattern: /IP address is blocked/i, code: 'REGION_BLOCKED', why: 'IP blocked from this post' },

  // --- Availability ------------------------------------------------------
  { pattern: /\bprivate (?:video|post|account)\b|\bis private\b/i, code: 'VIDEO_PRIVATE', why: 'private' },
  {
    pattern: /HTTP Error 404\b|\b410 Gone\b|has been removed|no longer available|does not exist|video not found/i,
    code: 'VIDEO_DELETED',
    why: 'gone',
  },
  { pattern: /video is unavailable|content isn'?t available/i, code: 'VIDEO_DELETED', why: 'unavailable' },
  {
    pattern: /not available in your (?:country|region)|geo.?restrict|blocked in your country/i,
    code: 'REGION_BLOCKED',
    why: 'geo restricted',
  },
  {
    pattern: /age.?restrict|confirm your age|sign in to confirm|login required|requires authentication/i,
    code: 'AGE_RESTRICTED',
    why: 'age or login gated',
  },
  { pattern: /image post|photo mode|slideshow/i, code: 'UNSUPPORTED_MEDIA', why: 'photo carousel' },

  /**
   * Local failures, which only the download can produce.
   *
   * These matter because the classifier's fallback is EXTRACTOR_FAILED, and
   * the download now treats that as "try another route". Without a rule here a
   * full disk would be retried through every route in turn, each one filling
   * the same disk and failing the same way, before reporting a cause that had
   * nothing to do with TikTok.
   */
  { pattern: /no space left|not enough space|disk full|ENOSPC/i, code: 'DISK_FULL', why: 'out of disk space' },
  {
    pattern: /permission denied|EACCES|EPERM|read-only file system/i,
    code: 'PERMISSION_DENIED',
    why: 'cannot write to the output folder',
  },

  // --- Throttling --------------------------------------------------------
  {
    pattern: /HTTP Error 429\b|too many requests|rate.?limit|slow down/i,
    code: 'RATE_LIMITED',
    why: 'throttled',
  },

  /**
   * TikTok served a page with the video data missing.
   *
   * This must be matched *before* the generic "unable to extract" rule below,
   * and the distinction is the whole point. yt-dlp reads the video out of a
   * `__UNIVERSAL_DATA_FOR_REHYDRATION__` blob in the page, and TikTok only puts
   * that blob there for requests it accepts as a real browser. When it decides
   * a request looks automated — which happens in bursts, to some links and not
   * others, from the same machine, minutes apart — it returns the page without
   * it. yt-dlp's message for that is "Unable to extract universal data for
   * rehydration", which lands on the generic rule and reads as EXTRACTOR_FAILED:
   * "Extractor out of date. Update the extractor, then retry."
   *
   * That message sent a user to press Update, be told they were already on the
   * latest build, and have no next step — while the same links worked on the
   * attempt after. It is also self-evidently not a stale extractor when nine of
   * twelve videos in the same batch download fine.
   *
   * As RESOLVE_FAILED it says what is true — TikTok did not return usable
   * details, this is usually temporary — and, because that code is
   * auto-retryable, the queue's backoff now actually runs instead of failing
   * the item on its first attempt.
   */
  {
    pattern:
      /universal data for rehydration|unable to extract (?:webpage video data|sigi state|initial state)|unable to extract video data/i,
    code: 'RESOLVE_FAILED',
    why: 'TikTok served a page without the video data — usually bot detection, not a stale extractor',
  },

  // --- Extractor breakage ------------------------------------------------
  {
    pattern:
      /unable to extract|unable to solve JS challenge|unexpected response from webpage|unsupported url|no video formats found|failed to parse JSON|signature extraction failed/i,
    code: 'EXTRACTOR_FAILED',
    why: 'extractor could not parse TikTok',
  },

  /**
   * A 403 on the media request, not the page.
   *
   * Deliberately separate from REGION_BLOCKED: the taxonomy code named after a
   * region made every one of these terminal, so a refusal that a fresh link
   * would have fixed was never retried once. TikTok signs these URLs and checks
   * a session, and both go stale.
   */
  { pattern: /HTTP Error 403\b|403: Forbidden|Forbidden/i, code: 'CDN_FORBIDDEN', why: 'CDN refused the media request' },

  // --- Transport ---------------------------------------------------------
  { pattern: /HTTP Error 5\d\d\b/i, code: 'NETWORK_ERROR', why: 'server error' },
  {
    pattern:
      /timed out|timeout|connection reset|connection refused|connection aborted|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|getaddrinfo|temporary failure in name resolution|network is unreachable|SSL|certificate verify failed|proxy/i,
    code: 'NETWORK_ERROR',
    why: 'transport failure',
  },
  { pattern: /unable to download (?:webpage|API page|video data)/i, code: 'NETWORK_ERROR', why: 'fetch failed' },
];

export interface ClassifiedError {
  readonly code: ErrorCode;
  /** Short reason for the log line; not shown to the user. */
  readonly why: string;
}

/**
 * `stderr` is the primary signal; `timedOut` is checked first because a killed
 * process may have written nothing at all.
 */
export function classifyYtDlpFailure(input: {
  stderr: string;
  exitCode?: number | null;
  timedOut?: boolean;
}): ClassifiedError {
  if (input.timedOut) return { code: 'NETWORK_ERROR', why: 'extractor timed out' };

  const text = input.stderr ?? '';
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { code: rule.code, why: rule.why };
  }

  return { code: 'EXTRACTOR_FAILED', why: 'unrecognised extractor failure' };
}

/**
 * Failures where trying another extractor cannot help, so the chain stops
 * instead of spending another outbound request on a foregone conclusion.
 */
export const TERMINAL_FOR_CHAIN: readonly ErrorCode[] = [
  'VIDEO_PRIVATE',
  'VIDEO_DELETED',
  'REGION_BLOCKED',
  'AGE_RESTRICTED',
  'UNSUPPORTED_MEDIA',
  'CANCELLED',
];

export function isTerminalForChain(code: ErrorCode): boolean {
  return TERMINAL_FOR_CHAIN.includes(code);
}
