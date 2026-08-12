
/**
 * Pure URL parsing and canonical ID extraction — spec section 6.
 *
 * This lives in shared/ rather than main/ for one concrete reason: the Add
 * Links screen validates every pasted line live as the user types (section
 * 10). Routing that through IPC would mean a round trip per keystroke for up
 * to 300 lines; importing it directly makes validation instant and free.
 *
 * Nothing here touches the filesystem, a process or the network — it is string
 * manipulation only, so the section 4 rule about renderer privileges is
 * untouched. The half that *does* reach the network (short-link redirect
 * resolution) stays in main as UrlNormalizer.
 *
 * The aweme ID — never the URL string — is the dedup key, so every accepted
 * form below must reduce to the same ID for the same video.
 */

/** TikTok serves both videos and image slideshows under the same ID space. */
export type MediaKind = 'video' | 'photo';

/**
 * Deviation from section 6 worth knowing: the spec says "19-digit". Real IDs
 * have grown over time and older ones are shorter, so a hard 19 would reject
 * legitimate older videos. 15-21 is wide enough to accept every real ID and
 * still narrow enough to reject noise like a timestamp in a caption.
 */
const AWEME_ID = String.raw`\d{15,21}`;

/** Paths that carry an ID directly. Matched case-insensitively. */
const ID_PATTERNS: readonly { readonly pattern: RegExp; readonly kind: MediaKind }[] = [
  { pattern: new RegExp(String.raw`/video/(${AWEME_ID})`, 'i'), kind: 'video' },
  { pattern: new RegExp(String.raw`/photo/(${AWEME_ID})`, 'i'), kind: 'photo' },
  // Legacy mobile form. yt-dlp has no matcher for it at all, which is exactly
  // why normalizing to the canonical form matters rather than passing through.
  { pattern: new RegExp(String.raw`/v/(${AWEME_ID})(?:\.html)?`, 'i'), kind: 'video' },
  { pattern: new RegExp(String.raw`/embed/(?:v2/)?(${AWEME_ID})`, 'i'), kind: 'video' },
];

const HANDLE_PATTERN = /\/@([\w.-]+)/;

/** Hosts whose links must be followed before an ID can be extracted. */
const SHORT_LINK_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);

/**
 * Finds a TikTok URL embedded in arbitrary pasted text (share sheets, chat
 * messages).
 *
 * Both guards are load-bearing, and the suite has fixtures for each:
 *
 *   (?<![\w.\-/])  the match must begin at a host boundary. Without it the
 *                  pattern happily finds "tiktok.com/@a/video/1" inside
 *                  "eviltiktok.com/@a/video/1" and inside
 *                  "evil.example.com/www.tiktok.com/@a/video/1", accepting a
 *                  lookalike link as genuine.
 *   (?![\w.-])     the host must end at "tiktok.com". Without it,
 *                  "tiktok.com.evil.net" reads as the real host with a path.
 */
const TIKTOK_URL_IN_TEXT = /(?<![\w.\-/])(?:https?:\/\/)?(?:[a-z0-9-]+\.)*tiktok\.com(?![\w.-])(?:\/[^\s<>"'`\\]*)?/i;

export type ParseResult =
  | {
      readonly status: 'resolved';
      readonly awemeId: string;
      readonly authorHandle: string | null;
      readonly kind: MediaKind;
      readonly canonicalUrl: string;
    }
  /** A TikTok short link: valid, but its ID is only knowable over the network. */
  | { readonly status: 'needs-redirect'; readonly shortUrl: string }
  | { readonly status: 'invalid'; readonly code: 'INVALID_URL' | 'NOT_A_TIKTOK_URL' };

/**
 * Strips wrapping quotes and brackets, then trailing sentence punctuation.
 *
 * Pasted links routinely arrive as `"https://…"`, `<https://…>` or at the end
 * of a sentence. A closing bracket is only removed when the URL contains no
 * matching opener, so a legitimate parenthesis inside a path survives.
 */
function stripWrappers(input: string): string {
  let value = input.trim();

  const pairs: readonly [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['<', '>'],
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs) {
      if (value.length > 1 && value.startsWith(open) && value.endsWith(close)) {
        value = value.slice(1, -1).trim();
        changed = true;
      }
    }
  }
  return value;
}

function stripTrailingPunctuation(url: string): string {
  let value = url;
  const closers: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

  while (value.length > 0) {
    const last = value[value.length - 1] as string;
    if ('.,;:!?"\'`'.includes(last)) {
      value = value.slice(0, -1);
      continue;
    }
    const opener = closers[last];
    if (opener !== undefined && !value.slice(0, -1).includes(opener)) {
      value = value.slice(0, -1);
      continue;
    }
    break;
  }
  return value;
}

/** `tiktok.com` and its subdomains only — never `eviltiktok.com`. */
function isTikTokHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'tiktok.com' || host.endsWith('.tiktok.com');
}

function isShortLink(url: URL): boolean {
  return SHORT_LINK_HOSTS.has(url.hostname.toLowerCase()) || /^\/t\/[\w-]+/i.test(url.pathname);
}

/**
 * Builds the canonical URL of section 6 step 6.
 *
 * The handle is lowercased so that two pastes differing only in case produce
 * byte-identical canonical URLs — "canonical" should mean it. When no handle is
 * known the `@`-only form is used, which yt-dlp's matcher accepts because its
 * user_id group is optional.
 */
export function buildCanonicalUrl(awemeId: string, authorHandle: string | null): string {
  const handle = authorHandle ? authorHandle.toLowerCase() : '';
  return `https://www.tiktok.com/@${handle}/video/${awemeId}`;
}

/**
 * Steps 1-3 and 5-6 of section 6. Never performs I/O; a short link comes back
 * as `needs-redirect` for normalize() to follow.
 */
export function parse(input: string): ParseResult {
  if (typeof input !== 'string' || input.trim() === '') return { status: 'invalid', code: 'INVALID_URL' };

  const unwrapped = stripWrappers(input);

  // Step 2: pull the first TikTok URL out of any surrounding share text. This
  // runs before host validation so that "Check this out https://vm.tiktok.com/X
  // TikTok" is accepted rather than rejected for having a space in it.
  const found = TIKTOK_URL_IN_TEXT.exec(unwrapped);
  if (!found) {
    // Distinguish "not a URL at all" from "a URL, just not TikTok's", because
    // section 11 gives them different messages.
    const looksLikeUrl = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(unwrapped) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(unwrapped);
    return { status: 'invalid', code: looksLikeUrl ? 'NOT_A_TIKTOK_URL' : 'INVALID_URL' };
  }

  const candidate = stripTrailingPunctuation(found[0]);

  // Step 1: supply a scheme when the paste omitted it (`tiktok.com/@a/video/1`).
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { status: 'invalid', code: 'INVALID_URL' };
  }

  // Step 3.
  if (!isTikTokHost(url.hostname)) return { status: 'invalid', code: 'NOT_A_TIKTOK_URL' };

  // Step 4 is network-bound; hand it back to the caller.
  if (isShortLink(url)) return { status: 'needs-redirect', shortUrl: url.toString() };

  // Step 5.
  for (const { pattern, kind } of ID_PATTERNS) {
    const match = pattern.exec(url.pathname);
    const awemeId = match?.[1];
    if (!awemeId) continue;

    const authorHandle = HANDLE_PATTERN.exec(url.pathname)?.[1] ?? null;
    return {
      status: 'resolved',
      awemeId,
      authorHandle,
      kind,
      canonicalUrl: buildCanonicalUrl(awemeId, authorHandle),
    };
  }

  // A TikTok host with no extractable video ID: a profile, a tag, a music page.
  return { status: 'invalid', code: 'NOT_A_TIKTOK_URL' };
}
