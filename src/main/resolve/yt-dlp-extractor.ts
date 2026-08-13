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
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface YtDlpStrategy {
  /** Appears in the log and in the extractor's name. */
  readonly label: string;
  /** Extra arguments placed before the URL. */
  readonly args: readonly string[];
}

/**
 * Ordered cheapest-and-most-likely first.
 *
 * The API hostnames are TikTok's own regional endpoints. They are worth trying
 * in sequence because availability differs by region — the exact situation
 * where a user is told to go and find a proxy today.
 */
export const YT_DLP_STRATEGIES: readonly YtDlpStrategy[] = [
  { label: 'web', args: [] },
  {
    label: 'mobile api',
    args: ['--extractor-args', 'tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com'],
  },
  {
    label: 'mobile api (alt region)',
    args: ['--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com'],
  },
];

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
    if (proxy) args.push('--proxy', proxy);
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
      extractorArgs: this.options.strategy?.args ?? [],
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

function toMetadata(payload: YtDlpPayload, canonicalUrl: string): VideoMetadata {
  const caption = payload.title ?? payload.description ?? null;
  const durationSeconds = typeof payload.duration === 'number' ? payload.duration : null;
  const formats = payload.formats ?? [];
  const hasVideoFormat = formats.some((f) => f.vcodec !== undefined && f.vcodec !== 'none');

  /**
   * Slideshow detection. yt-dlp's own source notes that "audio-only slideshows
   * have a video duration of 0", and such a post exposes no video format at
   * all. Requiring both signals avoids misreading a genuine short video whose
   * duration simply failed to parse.
   */
  const isPhotoPost = (durationSeconds === 0 || durationSeconds === null) && formats.length > 0 && !hasVideoFormat;

  return {
    awemeId: payload.id ?? extractIdFromUrl(canonicalUrl),
    authorHandle: payload.uploader ?? payload.uploader_id ?? null,
    authorName: payload.creator ?? payload.channel ?? null,
    caption,
    durationMs: durationSeconds !== null ? Math.round(durationSeconds * 1_000) : null,
    coverUrl: payload.thumbnail ?? null,
    musicTitle: payload.track ?? payload.artist ?? null,
    uploadedAt: toEpochMs(payload),
    // Hashtags are not extracted: nothing consumes them.
    hashtags: [],
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
