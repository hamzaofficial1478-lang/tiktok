/**
 * URL fixtures — spec section 6 requires "at least 25 URL variants covering
 * every form above plus malformed input".
 *
 * The point of the table is the invariant in the first group: every one of
 * those inputs describes the same video and must therefore collapse to the
 * same aweme ID. If any row drifts, dedup silently starts letting duplicates
 * through, which is the failure mode hardest to notice in production.
 */

export const CANONICAL_ID = '7123456789012345678';
export const SECOND_ID = '7987654321098765432';
/** A shorter, older-style ID — the reason the matcher is 15-21 digits, not 19. */
export const LEGACY_ID = '6543210987654321';

export interface UrlFixture {
  readonly name: string;
  readonly input: string;
  readonly awemeId: string;
  readonly authorHandle: string | null;
  readonly kind?: 'video' | 'photo';
}

/** Every one of these must resolve to CANONICAL_ID without touching the network. */
export const SAME_VIDEO_FIXTURES: readonly UrlFixture[] = [
  {
    name: 'standard desktop url',
    input: `https://www.tiktok.com/@charlie/video/${CANONICAL_ID}`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'with webapp query params',
    input: `https://www.tiktok.com/@charlie/video/${CANONICAL_ID}?is_from_webapp=1&sender_device=pc&web_id=7300000000000000000`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'with a fragment',
    input: `https://www.tiktok.com/@charlie/video/${CANONICAL_ID}#section`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'trailing slash',
    input: `https://www.tiktok.com/@charlie/video/${CANONICAL_ID}/`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'no scheme',
    input: `www.tiktok.com/@charlie/video/${CANONICAL_ID}`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'bare host without www or scheme',
    input: `tiktok.com/@charlie/video/${CANONICAL_ID}`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'http instead of https',
    input: `http://www.tiktok.com/@charlie/video/${CANONICAL_ID}`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'mobile m. subdomain',
    input: `https://m.tiktok.com/@charlie/video/${CANONICAL_ID}`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'legacy m.tiktok.com/v/{id}.html',
    input: `https://m.tiktok.com/v/${CANONICAL_ID}.html`,
    awemeId: CANONICAL_ID,
    authorHandle: null,
  },
  {
    name: 'legacy /v/ without .html',
    input: `https://m.tiktok.com/v/${CANONICAL_ID}`,
    awemeId: CANONICAL_ID,
    authorHandle: null,
  },
  {
    name: 'embed form',
    input: `https://www.tiktok.com/embed/${CANONICAL_ID}`,
    awemeId: CANONICAL_ID,
    authorHandle: null,
  },
  {
    name: 'embed v2 form',
    input: `https://www.tiktok.com/embed/v2/${CANONICAL_ID}`,
    awemeId: CANONICAL_ID,
    authorHandle: null,
  },
  {
    name: 'leading and trailing whitespace',
    input: `   https://www.tiktok.com/@charlie/video/${CANONICAL_ID}   `,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'wrapped in double quotes',
    input: `"https://www.tiktok.com/@charlie/video/${CANONICAL_ID}"`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'wrapped in single quotes',
    input: `'https://www.tiktok.com/@charlie/video/${CANONICAL_ID}'`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'wrapped in angle brackets',
    input: `<https://www.tiktok.com/@charlie/video/${CANONICAL_ID}>`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'wrapped in parentheses',
    input: `(https://www.tiktok.com/@charlie/video/${CANONICAL_ID})`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'embedded in share text',
    input: `Check this out https://www.tiktok.com/@charlie/video/${CANONICAL_ID} TikTok`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'at the end of a sentence',
    input: `look at this one: https://www.tiktok.com/@charlie/video/${CANONICAL_ID}.`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'markdown link',
    input: `[watch this](https://www.tiktok.com/@charlie/video/${CANONICAL_ID})`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'uppercase scheme and host',
    input: `HTTPS://WWW.TIKTOK.COM/@charlie/video/${CANONICAL_ID}`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'handle case differs from another paste of the same video',
    input: `https://www.tiktok.com/@CHARLIE/video/${CANONICAL_ID}`,
    awemeId: CANONICAL_ID,
    authorHandle: 'CHARLIE',
  },
  {
    name: 'query params in a different order',
    input: `https://www.tiktok.com/@charlie/video/${CANONICAL_ID}?web_id=1&is_from_webapp=1`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'tracking params from a paid share',
    input: `https://www.tiktok.com/@charlie/video/${CANONICAL_ID}?utm_source=x&utm_campaign=y&_r=1&_t=8abc`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
  {
    name: 'handle containing dots and underscores',
    input: `https://www.tiktok.com/@char.lie_99/video/${CANONICAL_ID}`,
    awemeId: CANONICAL_ID,
    authorHandle: 'char.lie_99',
  },
  {
    name: 'newline-padded, as pasted from a text file',
    input: `\n\thttps://www.tiktok.com/@charlie/video/${CANONICAL_ID}\r\n`,
    awemeId: CANONICAL_ID,
    authorHandle: 'charlie',
  },
];

/** Valid, but a different video or a different media kind. */
export const OTHER_VALID_FIXTURES: readonly UrlFixture[] = [
  {
    name: 'a different video entirely',
    input: `https://www.tiktok.com/@dana/video/${SECOND_ID}`,
    awemeId: SECOND_ID,
    authorHandle: 'dana',
  },
  {
    name: 'older, shorter id',
    input: `https://www.tiktok.com/@classic/video/${LEGACY_ID}`,
    awemeId: LEGACY_ID,
    authorHandle: 'classic',
  },
  {
    name: 'photo slideshow post',
    input: `https://www.tiktok.com/@charlie/photo/${SECOND_ID}`,
    awemeId: SECOND_ID,
    authorHandle: 'charlie',
    kind: 'photo',
  },
];

export interface InvalidFixture {
  readonly name: string;
  readonly input: string;
  readonly code: 'INVALID_URL' | 'NOT_A_TIKTOK_URL';
}

export const INVALID_FIXTURES: readonly InvalidFixture[] = [
  { name: 'empty string', input: '', code: 'INVALID_URL' },
  { name: 'whitespace only', input: '    \n\t ', code: 'INVALID_URL' },
  { name: 'plain prose', input: 'download my videos please', code: 'INVALID_URL' },
  { name: 'a bare number', input: '7123456789012345678', code: 'INVALID_URL' },
  { name: 'youtube link', input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', code: 'NOT_A_TIKTOK_URL' },
  { name: 'instagram link', input: 'https://www.instagram.com/reel/Cabcdefg/', code: 'NOT_A_TIKTOK_URL' },
  {
    name: 'lookalike host that merely ends in tiktok.com',
    input: 'https://eviltiktok.com/@charlie/video/7123456789012345678',
    code: 'NOT_A_TIKTOK_URL',
  },
  {
    name: 'tiktok.com in the path of another host',
    input: 'https://evil.example.com/www.tiktok.com/@charlie/video/7123456789012345678',
    code: 'NOT_A_TIKTOK_URL',
  },
  { name: 'tiktok profile page, no video', input: 'https://www.tiktok.com/@charlie', code: 'NOT_A_TIKTOK_URL' },
  { name: 'tiktok tag page', input: 'https://www.tiktok.com/tag/funny', code: 'NOT_A_TIKTOK_URL' },
  { name: 'tiktok music page', input: 'https://www.tiktok.com/music/original-sound-7123456789', code: 'NOT_A_TIKTOK_URL' },
  { name: 'tiktok live page', input: 'https://www.tiktok.com/@charlie/live', code: 'NOT_A_TIKTOK_URL' },
  {
    name: 'video path with too few digits to be an id',
    input: 'https://www.tiktok.com/@charlie/video/12345',
    code: 'NOT_A_TIKTOK_URL',
  },
  { name: 'douyin, the mainland sibling', input: 'https://www.douyin.com/video/7123456789012345678', code: 'NOT_A_TIKTOK_URL' },
];

/** Short links: valid, but the ID is only knowable after a redirect lookup. */
export const SHORT_LINK_FIXTURES: readonly { readonly name: string; readonly input: string }[] = [
  { name: 'vm.tiktok.com', input: 'https://vm.tiktok.com/ZMabcdef1/' },
  { name: 'vt.tiktok.com', input: 'https://vt.tiktok.com/ZSabcdef2/' },
  { name: 'www.tiktok.com/t/', input: 'https://www.tiktok.com/t/ZTabcdef3/' },
  { name: 'tiktok.com/t/ without www', input: 'https://tiktok.com/t/ZTabcdef4/' },
  { name: 'short link without scheme', input: 'vm.tiktok.com/ZMabcdef5/' },
  { name: 'short link with no trailing slash', input: 'https://vm.tiktok.com/ZMabcdef6' },
  {
    name: 'short link embedded in share text',
    input: 'Check this out https://vm.tiktok.com/ZMabcdef7/ TikTok',
  },
  { name: 'short link with query params', input: 'https://vm.tiktok.com/ZMabcdef8/?k=1' },
];
