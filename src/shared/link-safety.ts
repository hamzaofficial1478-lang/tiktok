import { parse, type ParseResult } from './url-parse';

/**
 * Safety screening for links that arrive in bulk — pasted, or imported from a
 * .txt/.csv file.
 *
 * ## What is actually being defended against
 *
 * A text file cannot "contain dangerous code" in any sense that matters here:
 * nothing in this app ever evaluates a line, spawns it, or renders it as HTML.
 * The real risks in a list of links are narrower and more concrete, and each
 * one below is handled explicitly:
 *
 *   - **Lookalike hosts.** `tiktok.com.evil.net`, `tikt0k.com`, `tik-tok.com`,
 *     and IDN homographs using Cyrillic о or а. These are the genuine attack:
 *     a link that reads as TikTok at a glance and is not. `url-parse` already
 *     refuses them; this module additionally recognises the *deception* so the
 *     user is told a link was disguised rather than merely "not TikTok".
 *   - **Embedded credentials.** `https://user:pass@tiktok.com/…` is the classic
 *     way to make a hostile host look like a trusted one in a UI that truncates.
 *   - **Hidden characters.** Right-to-left overrides and zero-width joiners
 *     rearrange how a URL *displays* without changing what it resolves to.
 *   - **Non-web schemes.** `javascript:`, `data:`, `file:`.
 *   - **Resource exhaustion.** A 200 MB file, a million lines, or a single
 *     10 MB line will freeze the window if fed to a live-validating textarea.
 *   - **Binary content.** A .txt extension proves nothing about the bytes.
 *
 * ## Why there is no third-party reputation API
 *
 * Sending the user's links to an external service to be "scanned" would leak
 * their entire download list to a third party, add a network dependency and a
 * new failure mode to an offline-capable step, and still not detect the threat
 * that actually applies — which is structural (is this host really TikTok?),
 * not reputational. A strict local allowlist answers that question exactly,
 * instantly, and without telling anyone what the user is downloading.
 */

/** Why a line was not accepted. Ordered roughly most to least alarming. */
export type RejectReason =
  | 'lookalike_host'
  | 'embedded_credentials'
  | 'hidden_characters'
  | 'unsafe_scheme'
  | 'oversized_line'
  | 'not_tiktok'
  | 'no_video_id'
  | 'not_a_link'
  | 'duplicate';

export interface RejectedLine {
  readonly lineNumber: number;
  /** Truncated for display; never rendered as markup. */
  readonly raw: string;
  readonly reason: RejectReason;
  readonly detail: string;
}

export interface AcceptedLine {
  readonly lineNumber: number;
  readonly raw: string;
  readonly parsed: Extract<ParseResult, { status: 'resolved' } | { status: 'needs-redirect' }>;
}

export interface ScanReport {
  readonly totalLines: number;
  readonly accepted: readonly AcceptedLine[];
  readonly rejected: readonly RejectedLine[];
  readonly counts: Readonly<Record<RejectReason, number>>;
  /** Set when the file was refused outright; `accepted` is empty when so. */
  readonly fatal: string | null;
  readonly truncated: boolean;
}

export interface ScanLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly maxLineLength: number;
}

/**
 * Generous enough for any real list — 50k links is far beyond a plausible
 * session — and small enough that a hostile or corrupt file cannot wedge the
 * renderer.
 */
export const DEFAULT_LIMITS: ScanLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxLines: 50_000,
  maxLineLength: 2_048,
};

const REJECT_REASONS: readonly RejectReason[] = [
  'lookalike_host',
  'embedded_credentials',
  'hidden_characters',
  'unsafe_scheme',
  'oversized_line',
  'not_tiktok',
  'no_video_id',
  'not_a_link',
  'duplicate',
];

/** Bidi overrides, zero-width characters and the BOM — invisible, and load-bearing for spoofing. */
const HIDDEN_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

/** C0 and C1 controls, excluding tab which is legitimate in a CSV. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

const SAFE_SCHEME = /^https?:$/i;
const ANY_SCHEME = /^([a-z][a-z0-9+.\-]*):/i;

/**
 * Characters commonly substituted to build a domain that reads as "tiktok".
 * Both leetspeak and the Cyrillic/Greek homoglyphs that render identically in
 * most UI fonts.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  'а': 'a',
  'е': 'e',
  'о': 'o',
  'р': 'p',
  'с': 'c',
  'х': 'x',
  'і': 'i',
  'ο': 'o',
  'ԁ': 'd',
};

/**
 * Folds a hostname to a comparable skeleton: homoglyphs mapped to their Latin
 * lookalike, then everything that is not a letter or digit removed. This makes
 * `tikt0k`, `tik-tok`, `t1kt0k` and `tiktоk` (Cyrillic о) all collapse to
 * `tiktok`, which is exactly the set an attacker is trying to hide in.
 */
export function hostSkeleton(hostname: string): string {
  return [...hostname.toLowerCase()]
    .map((ch) => HOMOGLYPHS[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * True for a host that is trying to look like TikTok without being it.
 *
 * The first rule is the load-bearing one, and it is deliberately blunt:
 * `tiktok.com` is pure ASCII, so a legitimate link never carries a non-ASCII
 * character in its hostname. Rejecting all of them closes the entire homograph
 * class at once — including the substitutions nobody has thought of yet. An
 * enumerated table of confusables can only ever catch the ones it lists, which
 * this function's own test suite demonstrated by finding Cyrillic ka (U+043A)
 * missing from it.
 *
 * The skeleton check then handles the plain-ASCII deceptions a character table
 * does cover well: `tikt0k`, `t1ktok`, `tik-tok`.
 */
export function isLookalikeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return false;

  // Non-ASCII, or its punycode encoding: no real TikTok host has either.
  if (/[^\x20-\x7E]/.test(host)) return true;
  if (host.split('.').some((label) => label.startsWith('xn--'))) return true;

  return hostSkeleton(host).includes('tiktok');
}

/** Extracts a hostname from a raw line without throwing. */
function hostnameOf(raw: string): string | null {
  const withScheme = ANY_SCHEME.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname;
  } catch {
    return null;
  }
}

function reject(lineNumber: number, raw: string, reason: RejectReason, detail: string): RejectedLine {
  return { lineNumber, raw: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw, reason, detail };
}

/**
 * Screens one line. Deliberately ordered: the deceptive cases are decided
 * before the ordinary "this isn't TikTok" one, so a spoofed link is never
 * reported as a harmless typo.
 */
export function screenLine(raw: string, lineNumber: number): RejectedLine | AcceptedLine {
  const trimmed = raw.trim();

  if (trimmed.length > DEFAULT_LIMITS.maxLineLength) {
    return reject(lineNumber, trimmed, 'oversized_line', `${trimmed.length} characters — not a real link`);
  }
  if (HIDDEN_CHARS.test(trimmed) || CONTROL_CHARS.test(trimmed)) {
    return reject(
      lineNumber,
      trimmed,
      'hidden_characters',
      'contains invisible characters that can disguise the real address',
    );
  }

  const schemeMatch = ANY_SCHEME.exec(trimmed);
  if (schemeMatch && !SAFE_SCHEME.test(`${schemeMatch[1]}:`)) {
    return reject(lineNumber, trimmed, 'unsafe_scheme', `"${schemeMatch[1]}:" is not a web address`);
  }

  const hostname = hostnameOf(trimmed);
  if (hostname !== null) {
    if (isLookalikeHost(hostname)) {
      return reject(lineNumber, trimmed, 'lookalike_host', `"${hostname}" is made to look like TikTok but is not`);
    }
    const withScheme = ANY_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const url = new URL(withScheme);
      if (url.username !== '' || url.password !== '') {
        return reject(lineNumber, trimmed, 'embedded_credentials', 'hides a different destination behind a login');
      }
    } catch {
      // Falls through to parse(), which classifies it.
    }
  }

  const parsed = parse(trimmed);
  if (parsed.status === 'invalid') {
    if (parsed.code === 'INVALID_URL') {
      return reject(lineNumber, trimmed, 'not_a_link', 'not a web address');
    }
    // parse() returns NOT_A_TIKTOK_URL both for other sites and for TikTok
    // pages that carry no video, which are worth telling apart.
    const onTikTok = hostname !== null && (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com'));
    return onTikTok
      ? reject(lineNumber, trimmed, 'no_video_id', 'a TikTok page, but not a single video')
      : reject(lineNumber, trimmed, 'not_tiktok', hostname ? `points at ${hostname}` : 'not a TikTok address');
  }

  return { lineNumber, raw: trimmed, parsed };
}

function isAccepted(value: RejectedLine | AcceptedLine): value is AcceptedLine {
  return 'parsed' in value;
}

/** The dedup key for layer 1: the video ID when known, the short URL when not. */
export function dedupKey(line: AcceptedLine): string {
  return line.parsed.status === 'resolved'
    ? `id:${line.parsed.awemeId}`
    : `url:${line.parsed.shortUrl.toLowerCase()}`;
}

/**
 * Screens a whole file or paste.
 *
 * Duplicates are detected here rather than left to the queue so the report can
 * state a number before anything is enqueued — the user finds out what the file
 * contained at the moment they choose it, not after 200 rows appear.
 */
export function scanText(text: string, limits: ScanLimits = DEFAULT_LIMITS): ScanReport {
  const counts: Record<RejectReason, number> = Object.fromEntries(
    REJECT_REASONS.map((reason) => [reason, 0]),
  ) as Record<RejectReason, number>;

  const empty = (fatal: string): ScanReport => ({
    totalLines: 0,
    accepted: [],
    rejected: [],
    counts,
    fatal,
    truncated: false,
  });

  // A null byte means this is not the text file it claims to be. Checked before
  // anything else touches the content.
  if (text.includes('\u0000')) {
    return empty('This is not a text file — it contains binary data.');
  }

  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > limits.maxBytes) {
    const mb = (byteLength / 1024 / 1024).toFixed(1);
    return empty(`The file is ${mb} MB, over the ${limits.maxBytes / 1024 / 1024} MB limit.`);
  }

  const allLines = text
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const truncated = allLines.length > limits.maxLines;
  const lines = truncated ? allLines.slice(0, limits.maxLines) : allLines;

  const accepted: AcceptedLine[] = [];
  const rejected: RejectedLine[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of lines.entries()) {
    const result = screenLine(raw, index + 1);

    if (!isAccepted(result)) {
      counts[result.reason]++;
      rejected.push(result);
      continue;
    }

    const key = dedupKey(result);
    if (seen.has(key)) {
      counts.duplicate++;
      rejected.push(reject(result.lineNumber, result.raw, 'duplicate', 'the same video appears earlier in the file'));
      continue;
    }

    seen.add(key);
    accepted.push(result);
  }

  return { totalLines: lines.length, accepted, rejected, counts, fatal: null, truncated };
}

/** Human-readable label for a rejection reason, for the report UI. */
export const REJECT_LABELS: Readonly<Record<RejectReason, string>> = {
  lookalike_host: 'Disguised as TikTok',
  embedded_credentials: 'Hidden destination',
  hidden_characters: 'Invisible characters',
  unsafe_scheme: 'Not a web address',
  oversized_line: 'Absurdly long',
  not_tiktok: 'A different website',
  no_video_id: 'Not a single video',
  not_a_link: 'Not a link',
  duplicate: 'Duplicate',
};

/** Reasons that indicate deliberate deception rather than user error. */
export const SUSPICIOUS_REASONS: readonly RejectReason[] = [
  'lookalike_host',
  'embedded_credentials',
  'hidden_characters',
  'unsafe_scheme',
];

export function suspiciousCount(report: ScanReport): number {
  return SUSPICIOUS_REASONS.reduce((total, reason) => total + report.counts[reason], 0);
}
