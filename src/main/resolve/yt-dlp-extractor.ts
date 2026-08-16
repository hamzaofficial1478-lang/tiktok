import type { Logger } from 'pino';
import { AppError } from '@shared/errors';
import type { Extractor, ResolvedVideo, StreamCandidate, VideoMetadata } from './types';
import type { ProcessRunner } from './process-runner';
import { classifyYtDlpFailure } from './yt-dlp-errors';

/**
 * The yt-dlp-backed extractor — the first implementation in section 2's
 * priority chain.
 *
 * The single most important thing it does is decide, per format, whether a
 * stream carries a watermark. That decision is what lets section 9's primary
 * strategy work: fetching a clean source is lossless and instant, while
 * filtering a watermarked file costs a full re-encode and visible quality.
 *
 * The classification below was read off yt-dlp's TikTok extractor rather than
 * guessed:
 *
 *     'format_id': 'play_addr'                              -> clean
 *     'format_id': 'download_addr'
 *     'format_note': 'Download video, watermarked'          -> watermarked
 *     'preference': -2 if has_watermark else -1
 *     'format_id': 'audio'                                  -> audio only
 */

/** Format IDs known to serve the watermarked "download" variant. */
const WATERMARKED_FORMAT_IDS = new Set(['download_addr', 'download']);

interface YtDlpFormat {
  format_id?: string;
  format_note?: string;
  url?: string;
  ext?: string;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  tbr?: number | null;
  vbr?: number | null;
  abr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
  preference?: number | null;
  /** Headers TikTok's CDN requires for this URL: Referer, User-Agent, Cookie. */
  http_headers?: Record<string, unknown> | null;
}

interface YtDlpPayload {
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  creator?: string;
  channel?: string;
  duration?: number | null;
  thumbnail?: string | null;
  track?: string | null;
  artist?: string | null;
  timestamp?: number | null;
  upload_date?: string | null;
  view_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  repost_count?: number | null;
  formats?: YtDlpFormat[];
  url?: string;
  ext?: string;
  _type?: string;
  entries?: unknown[];
}

/**
 * One way of asking TikTok for a video.
 *
 * yt-dlp's default route scrapes the web page, and that is the route that
 * breaks first: TikTok changes the page, or serves an interstitial instead of
 * it, and the result is "Unexpected response from webpage request" for every
 * link regardless of how current the extractor is. Its mobile API route is a
 * different endpoint with a different response shape, and it commonly keeps
 * working when the web one does not.
 *
 * Registering these as separate extractors in the chain is what turns "the app
 * cannot download anything" into "the first route failed, the second worked",
 * which is how a downloader survives TikTok changing something. Asking every
 * user to find a proxy is not a substitute for having a second route.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Network and session arguments that must be identical on both the extraction
 * call and the download call.
 *
 * Drift here is silent and expensive: extracting with a browser session and
 * then downloading without it produces exactly the failure this was added to
 * fix, and the log would show a successful resolve followed by a 403.
 */
export interface YtDlpSessionOptions {
  readonly browserCookies?: string | undefined;
  readonly forceIpv4?: boolean | undefined;
  readonly proxyUrl?: string | undefined;
}

export function sessionArgs(options: YtDlpSessionOptions): string[] {
  const args: string[] = [];
  // 'none' is the config's way of saying "do not touch a browser profile".
  if (options.browserCookies && options.browserCookies !== 'none') {
    args.push('--cookies-from-browser', options.browserCookies);
  }
  if (options.forceIpv4) args.push('--force-ipv4');
  if (options.proxyUrl) args.push('--proxy', options.proxyUrl);
  return args;
}

export interface YtDlpStrategy {
  /** Appears in the log and in the extractor's name. */
  readonly label: string;
  /** Extra arguments placed before the URL. */
  readonly args: readonly string[];
}

/**
 * The routes, ordered cheapest-and-most-likely first.
 *
 * ## What was wrong with the previous list
 *
 * It had three entries and one route. The two "mobile api" entries set
 * `api_hostname` and nothing else, and `api_hostname` on its own does not
 * select the mobile API — it renames an endpoint that is never contacted.
 * yt-dlp gates its app path on having a device identity:
 *
 *     @functools.cached_property
 *     def _KNOWN_APP_INFO(self):
 *         default = [''] if self._KNOWN_DEVICE_ID else []
 *         return self._configuration_arg('app_info', default, ie_key=TikTokIE)
 *
 *     def _real_extract(self, url):
 *         if self._KNOWN_APP_INFO:                     # empty without device_id
 *             try:
 *                 return self._extract_aweme_app(video_id)
 *             ...
 *         video_data, status = self._extract_web_data_and_status(url, video_id)
 *
 * — yt_dlp/extractor/tiktok.py. With neither `device_id` nor `app_info` given,
 * `_KNOWN_APP_INFO` is empty, the app branch is skipped, and all three routes
 * scraped the same web page. So a link that failed with "Unable to extract
 * universal data for rehydration" — the web page not carrying the JSON blob —
 * failed identically on every route and every retry, which is exactly what four
 * attempts of the same error in the queue looked like.
 *
 * Passing `device_id` switches the branch on. `_build_api_query` sends it as
 * the device and drops the absent install ID (`filter_dict` strips None), so no
 * fabricated install ID is needed. The app route also falls back to the web
 * page internally if it fails, so these routes are strictly additive.
 *
 * Web stays first because it is the fast path and it works for most links; the
 * app routes are what the ones it cannot serve now fall through to.
 */
export function ytDlpStrategies(deviceId: string): readonly YtDlpStrategy[] {
  const app = (hostname: string): readonly string[] => [
    '--extractor-args',
    `tiktok:device_id=${deviceId};api_hostname=${hostname}`,
  ];

  return [
    { label: 'web', args: [] },
    // TikTok's own regional endpoints; availability differs by region, which is
    // the situation a user would otherwise be told to solve with a proxy.
    { label: 'mobile app api', args: app('api16-normal-c-useast1a.tiktokv.com') },
    { label: 'mobile app api (alt region)', args: app('api22-normal-c-useast2a.tiktokv.com') },
  ];
}

export interface YtDlpExtractorOptions {
  /** Absolute path to the sidecar, or null when it is not installed. */
  readonly binaryPath: string | null;
  readonly runner: ProcessRunner;
  /**
   * A getter is accepted so the extractor picks up a proxy change made in
   * Settings mid-batch, instead of holding the value it was constructed with.
   */
  readonly proxyUrl?: string | (() => string | undefined);
  readonly timeoutMs?: number;
  readonly log?: Logger;
  /** Which route this instance uses. Defaults to the plain web one. */
  readonly strategy?: YtDlpStrategy;
  /** Read fresh per call so a Settings change applies mid-batch. */
  readonly session?: () => YtDlpSessionOptions;
}

export class YtDlpExtractor implements Extractor {
  readonly name: string;

  constructor(private readonly options: YtDlpExtractorOptions) {
    this.name = options.strategy ? `yt-dlp (${options.strategy.label})` : 'yt-dlp';
  }

  async isAvailable(): Promise<boolean> {
    return this.options.binaryPath !== null;
  }

  async resolve(canonicalUrl: string, options?: { signal?: AbortSignal }): Promise<ResolvedVideo> {
    const binary = this.options.binaryPath;
    if (!binary) {
      throw new AppError('EXTRACTOR_FAILED', 'yt-dlp is not installed');
    }

    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-progress',
      '--no-playlist',
      // Never write anything: this call only reads metadata.
      '--skip-download',
      '--socket-timeout',
      '15',
      // TikTok rejects requests that do not look like a browser, and yt-dlp's
      // default agent is one of the first things a site starts filtering on.
      '--user-agent',
      BROWSER_USER_AGENT,
    ];

    if (this.options.strategy) args.push(...this.options.strategy.args);

    const proxy = typeof this.options.proxyUrl === 'function' ? this.options.proxyUrl() : this.options.proxyUrl;
    args.push(...sessionArgs({ ...this.options.session?.(), proxyUrl: proxy }));
    args.push(canonicalUrl);

    const result = await this.options.runner.run(binary, args, {
      timeoutMs: this.options.timeoutMs ?? 60_000,
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (result.exitCode !== 0 || result.stdout.trim() === '') {
      const classified = classifyYtDlpFailure(result);
      const reason = firstMeaningfulLine(result.stderr);

      /**
       * The stderr text is the log line, not a field beside it.
       *
       * This classifier matches on prose that upstream rewords freely, so its
       * fallback — "unrecognised extractor failure" — is precisely the case
       * where someone needs to read what yt-dlp actually said, either to fix
       * their setup or to add a rule. Recording only the code we guessed threw
       * away the one piece of information that had any diagnostic value, and
       * left the UI asserting "Extractor out of date" about a failure nobody
       * had identified.
       */
      this.options.log?.warn(
        {
          canonicalUrl,
          exitCode: result.exitCode,
          code: classified.code,
          why: classified.why,
          timedOut: result.timedOut,
          stderr: truncate(result.stderr, 1_000),
        },
        `yt-dlp failed: ${reason || `exited ${result.exitCode} with no output`}`,
      );
      throw new AppError(classified.code, truncate(result.stderr) || `yt-dlp exited ${result.exitCode}`);
    }

    let payload: YtDlpPayload;
    try {
      payload = JSON.parse(result.stdout) as YtDlpPayload;
    } catch (err) {
      // Valid exit but unparseable output means the contract with yt-dlp
      // changed — that is an extractor problem, not a network one.
      throw new AppError('EXTRACTOR_FAILED', `yt-dlp returned unparseable JSON: ${truncate(result.stdout, 300)}`, {
        cause: err,
      });
    }

    return this.mapPayload(payload, canonicalUrl);
  }

  private mapPayload(payload: YtDlpPayload, canonicalUrl: string): ResolvedVideo {
    const formats = payload.formats ?? [];
    const streams = formats
      .filter((format) => typeof format.url === 'string' && format.url !== '')
      .map((format) => toStream(format));

    // A single-format response arrives with a top-level url and no `formats`.
    if (streams.length === 0 && typeof payload.url === 'string' && payload.url !== '') {
      streams.push(
        toStream({
          format_id: 'default',
          url: payload.url,
          ...(payload.ext === undefined ? {} : { ext: payload.ext }),
        }),
      );
    }

    const metadata = toMetadata(payload, canonicalUrl);

    // Section 2: photo carousels must be handled explicitly rather than
    // crashing the pipeline. Detected here as well as in the URL, because a
    // /video/ URL can still point at a slideshow.
    if (metadata.isPhotoPost) {
      throw new AppError('UNSUPPORTED_MEDIA', `${metadata.awemeId} is a photo slideshow, not a video`);
    }

    if (streams.length === 0) {
      throw new AppError('EXTRACTOR_FAILED', `yt-dlp returned no downloadable formats for ${canonicalUrl}`);
    }

    return {
      streams,
      metadata,
      extractor: this.name,
      // The download must reach the same endpoint this metadata came from.
      extractorArgs: [
        ...(this.options.strategy?.args ?? []),
        ...sessionArgs({ ...this.options.session?.(), proxyUrl: undefined }),
      ],
    };
  }
}

/**
 * Keeps only the headers that are safe and useful to replay on the download.
 *
 * Everything yt-dlp reports here is needed by TikTok's CDN, but a blanket
 * copy would also carry hop-by-hop headers that break a second request made by
 * a different HTTP client — Accept-Encoding in particular, since our fetch
 * negotiates its own compression and would then be handed a body it did not
 * ask for. Range is excluded because the downloader sets its own when resuming.
 */
const REPLAYABLE_HEADERS = new Set(['user-agent', 'referer', 'cookie', 'origin', 'accept', 'accept-language']);

function sanitiseHeaders(raw: Record<string, unknown> | null | undefined): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || value === '') continue;
    if (!REPLAYABLE_HEADERS.has(key.toLowerCase())) continue;
    headers[key.toLowerCase()] = value;
  }
  return headers;
}

function toStream(format: YtDlpFormat): StreamCandidate {
  const formatId = format.format_id ?? 'unknown';
  const note = format.format_note ?? '';

  const watermarked = WATERMARKED_FORMAT_IDS.has(formatId) || /watermark/i.test(note);
  const hasVideo = format.vcodec !== 'none';
  const hasAudio = format.acodec !== 'none' && format.acodec !== undefined ? format.acodec !== 'none' : true;
  const kind: 'video' | 'audio' = hasVideo && formatId !== 'audio' ? 'video' : 'audio';

  return {
    id: formatId,
    url: format.url as string,
    watermarked,
    kind,
    width: format.width ?? null,
    height: format.height ?? null,
    fps: format.fps ?? null,
    bitrate: format.tbr ?? format.vbr ?? format.abr ?? null,
    filesize: format.filesize ?? format.filesize_approx ?? null,
    ext: format.ext ?? null,
    codec: format.vcodec && format.vcodec !== 'none' ? format.vcodec : (format.acodec ?? null),
    hasAudio: kind === 'audio' ? true : hasAudio,
    // A clean stream always outranks a watermarked one, whatever yt-dlp's own
    // preference says; resolution breaks ties within each group.
    preference: (watermarked ? 0 : 1_000_000) + (format.height ?? 0) * 10 + (format.preference ?? 0),
    headers: sanitiseHeaders(format.http_headers),
  };
}

/**
 * The hashtags written into a TikTok caption.
 *
 * They were not extracted at all — the field was hard-coded empty with the
 * note "nothing consumes them", which stopped being true the moment titles and
 * descriptions were written from a video's own words. For a silent video with
 * a short caption they are often the *only* thing distinguishing one post from
 * the next, and their absence is why a whole account's videos came out with
 * identical titles.
 */
export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/#([\p{L}\p{N}_]{2,60})/gu)) {
    const tag = (match[1] as string).toLowerCase();
    if (!seen.has(tag)) seen.add(tag);
  }
  return [...seen];
}

function toMetadata(payload: YtDlpPayload, canonicalUrl: string): VideoMetadata {
  /**
   * The full caption, not the shortened one.
   *
   * yt-dlp fills `title` from the description and truncates it for display,
   * so preferring `title` threw away the end of every caption — including
   * hashtags, which usually sit there.
   */
  const caption =
    (payload.description?.trim() ?? '') !== ''
      ? (payload.description as string)
      : (payload.title ?? null);
  const durationSeconds = typeof payload.duration === 'number' ? payload.duration : null;
  const formats = payload.formats ?? [];
  const hasVideoFormat = formats.some((f) => f.vcodec !== undefined && f.vcodec !== 'none');

  /**
   * Slideshow detection, by the signal that actually decides it.
   *
   * This used to also require a zero or missing duration, on the reasoning
   * that yt-dlp's source calls out "audio-only slideshows have a video
   * duration of 0". That is true of some of them and not all: a photo post
   * carrying a music track reports the music's duration, sailed past this
   * check, and then died three steps later in the stream selector with "no
   * video streams were offered" — which the error taxonomy renders as
   * "Extractor out of date". A perfectly current extractor, a post that is
   * simply not a video, and a message pointing the user at the wrong thing.
   *
   * A post with formats and not one video track among them is a photo post.
   * The duration adds nothing to that and was only ever able to hide it.
   */
  const isPhotoPost = formats.length > 0 && !hasVideoFormat;

  return {
    awemeId: payload.id ?? extractIdFromUrl(canonicalUrl),
    authorHandle: payload.uploader ?? payload.uploader_id ?? null,
    authorName: payload.creator ?? payload.channel ?? null,
    caption,
    durationMs: durationSeconds !== null ? Math.round(durationSeconds * 1_000) : null,
    coverUrl: payload.thumbnail ?? null,
    musicTitle: payload.track ?? payload.artist ?? null,
    uploadedAt: toEpochMs(payload),
    hashtags: extractHashtags(payload.description ?? payload.title ?? null),
    isPhotoPost,
    stats: {
      views: payload.view_count ?? null,
      likes: payload.like_count ?? null,
      comments: payload.comment_count ?? null,
      shares: payload.repost_count ?? null,
    },
  };
}

function toEpochMs(payload: YtDlpPayload): number | null {
  if (typeof payload.timestamp === 'number') return payload.timestamp * 1_000;
  // upload_date is YYYYMMDD; treated as UTC midnight since no time is given.
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(payload.upload_date ?? '');
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function extractIdFromUrl(url: string): string {
  return /\/(\d{15,21})/.exec(url)?.[1] ?? '';
}

/**
 * The line of yt-dlp's stderr that says something.
 *
 * yt-dlp prefixes its real message with "ERROR: " and often pads it with
 * update notices and warnings. The first line carrying the actual complaint is
 * what belongs in a one-line log entry.
 */
function firstMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const error = lines.find((line) => /^ERROR[:\s]/i.test(line));
  const chosen = error ?? lines.find((line) => !/^WARNING[:\s]/i.test(line)) ?? lines[0] ?? '';
  return truncate(chosen.replace(/^ERROR:\s*/i, ''), 300);
}

function truncate(value: string, max = 800): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
