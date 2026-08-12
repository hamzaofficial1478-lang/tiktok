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
}

export class YtDlpExtractor implements Extractor {
  readonly name = 'yt-dlp';

  constructor(private readonly options: YtDlpExtractorOptions) {}

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
    ];
    const proxy = typeof this.options.proxyUrl === 'function' ? this.options.proxyUrl() : this.options.proxyUrl;
    if (proxy) args.push('--proxy', proxy);
    args.push(canonicalUrl);

    const result = await this.options.runner.run(binary, args, {
      timeoutMs: this.options.timeoutMs ?? 60_000,
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (result.exitCode !== 0 || result.stdout.trim() === '') {
      const classified = classifyYtDlpFailure(result);
      this.options.log?.warn(
        { canonicalUrl, exitCode: result.exitCode, code: classified.code, why: classified.why },
        'yt-dlp failed',
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

    return { streams, metadata, extractor: this.name };
  }
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

function truncate(value: string, max = 800): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
