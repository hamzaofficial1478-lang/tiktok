/**
 * The resolution layer's vocabulary.
 *
 * Kept separate from the extractor implementations so that adding a second
 * extractor (section 2 requires the chain to be pluggable) means implementing
 * an interface, not reaching into yt-dlp-shaped types.
 */

/** TikTok serves both videos and image slideshows under the same ID space. */
export type MediaKind = 'video' | 'photo';

export interface NormalizedUrl {
  /** The 15-21 digit canonical TikTok ID. The dedup key — never the URL string. */
  readonly awemeId: string;
  /** `https://www.tiktok.com/@{handle}/video/{awemeId}`, query params dropped. */
  readonly canonicalUrl: string;
  /** Null when the source form carried no handle (short links, m.tiktok.com/v/…). */
  readonly authorHandle: string | null;
  readonly kind: MediaKind;
  /** True when a network redirect lookup was required to get here. */
  readonly viaShortLink: boolean;
  /** Exactly what the user pasted, for the queue row and diagnostics. */
  readonly rawUrl: string;
}

/**
 * One downloadable stream. `watermarked` is the field the whole product hangs
 * on: section 2's primary strategy is picking a clean source so no re-encode
 * is ever needed.
 */
export interface StreamCandidate {
  /** yt-dlp's format_id, or an equivalent from another extractor. */
  readonly id: string;
  readonly url: string;
  readonly watermarked: boolean;
  readonly kind: 'video' | 'audio';
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly bitrate: number | null;
  readonly filesize: number | null;
  readonly ext: string | null;
  readonly codec: string | null;
  readonly hasAudio: boolean;
  /** Extractor-supplied ordering hint; higher is better. */
  readonly preference: number;
  /**
   * Headers the extractor says this URL needs.
   *
   * TikTok's CDN does not serve a stream URL to just anyone who has it: it
   * checks Referer, User-Agent and the session cookie issued during
   * extraction. yt-dlp reports them per format precisely because the download
   * has to repeat them, and a request without them comes back 403 even though
   * the URL is valid and the video is public.
   */
  readonly headers: Readonly<Record<string, string>>;
}

export interface VideoMetadata {
  readonly awemeId: string;
  readonly authorHandle: string | null;
  readonly authorName: string | null;
  readonly caption: string | null;
  readonly durationMs: number | null;
  readonly coverUrl: string | null;
  readonly musicTitle: string | null;
  /** Epoch milliseconds. */
  readonly uploadedAt: number | null;
  readonly hashtags: readonly string[];
  readonly isPhotoPost: boolean;
  readonly stats: {
    readonly views: number | null;
    readonly likes: number | null;
    readonly comments: number | null;
    readonly shares: number | null;
  };
}

/** Exactly the shape section 2 specifies: `resolve(canonicalUrl) -> { streams[], metadata }`. */
export interface ResolvedVideo {
  /**
   * Extra arguments that made this resolution succeed.
   *
   * The download has to reach the same endpoint the metadata came from: a
   * stream URL obtained through the mobile API is not served to a request that
   * re-resolves through the failing web route.
   */
  readonly extractorArgs?: readonly string[];
  readonly streams: readonly StreamCandidate[];
  readonly metadata: VideoMetadata;
  /** Which extractor produced this, for the row detail and the Logs screen. */
  readonly extractor: string;
}

export interface Extractor {
  /** Stable identifier recorded against each resolve, e.g. 'yt-dlp'. */
  readonly name: string;
  /** Cheap precondition check — a missing sidecar must not count as a failed attempt. */
  isAvailable(): Promise<boolean>;
  resolve(canonicalUrl: string, options?: { signal?: AbortSignal }): Promise<ResolvedVideo>;
}
