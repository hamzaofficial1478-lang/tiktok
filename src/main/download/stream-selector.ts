import { AppError } from '@shared/errors';
import type { SourceStrategy } from '@shared/types';
import type { AppConfig } from '@shared/config-schema';
import type { StreamCandidate } from '../resolve/types';

/**
 * Stream selection — spec section 9 step 4.
 *
 * There is no resolution setting. TikTok already encoded the video at whatever
 * resolution the creator uploaded, and the app takes the best clean stream on
 * offer. Asking the user to pick a number only invited them to choose
 * something worse than what was available, and downscaling would mean a
 * re-encode — the exact cost the clean-source strategy exists to avoid.
 *
 * The one ordering rule that remains is the important one: a clean source
 * beats a watermarked one *before* resolution is considered. A clean 480p
 * stream is lossless and instant; a watermarked 1080p stream costs a full
 * re-encode and visible quality to clean up. Resolution only breaks ties
 * within a watermark class, never across it.
 */

export interface SelectionResult {
  readonly stream: StreamCandidate;
  /**
   * What this choice implies for post-processing. 'clean_source' means the
   * file needs no watermark work at all; 'raw' means a watermarked stream was
   * the only option.
   */
  readonly strategy: SourceStrategy;
  /** Why this stream won, for the row detail and the Logs screen. */
  readonly reason: string;
}

export interface SelectOptions {
  readonly audioOnly: boolean;
  /**
   * 'keep' means the user wants the watermark left alone, which makes the
   * watermarked download variant an equally valid choice rather than a
   * last resort.
   */
  readonly watermarkMode: AppConfig['watermarkMode'];
}

export function selectStream(streams: readonly StreamCandidate[], options: SelectOptions): SelectionResult {
  if (streams.length === 0) {
    throw new AppError('EXTRACTOR_FAILED', 'no streams were offered for this video');
  }

  if (options.audioOnly) {
    const audio = [...streams].filter((s) => s.kind === 'audio').sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    const best = audio[0];
    if (!best) {
      throw new AppError('UNSUPPORTED_MEDIA', 'audio-only was requested but no audio stream is available');
    }
    return { stream: best, strategy: 'raw', reason: 'audio-only requested' };
  }

  const video = streams.filter((s) => s.kind === 'video');
  if (video.length === 0) {
    throw new AppError('EXTRACTOR_FAILED', 'no video streams were offered for this video');
  }

  const clean = [...video.filter((s) => !s.watermarked)].sort(byQualityDesc);
  const watermarked = [...video.filter((s) => s.watermarked)].sort(byQualityDesc);

  // "Keep watermark" makes the watermarked variant a first-class choice; it is
  // usually the higher-quality encode TikTok offers for download.
  const preferred = options.watermarkMode === 'keep' ? (watermarked[0] ?? clean[0]) : (clean[0] ?? watermarked[0]);
  if (!preferred) throw new AppError('EXTRACTOR_FAILED', 'no usable video stream was offered');

  const isClean = !preferred.watermarked;
  return {
    stream: preferred,
    strategy: isClean ? 'clean_source' : 'raw',
    reason: isClean
      ? `clean source at ${describe(preferred)}, exactly as TikTok serves it`
      : options.watermarkMode === 'keep'
        ? `watermarked source at ${describe(preferred)} (watermark kept by preference)`
        : `only a watermarked source was available at ${describe(preferred)}; it will need re-encoding`,
  };
}

/**
 * Ranks by the short side rather than height.
 *
 * TikTok is portrait-first: a 720p clip is 720x1280, so comparing heights
 * would rank a 1080x1920 stream and a 720x1280 stream by numbers that mean
 * different things in another orientation.
 */
function shortSide(stream: StreamCandidate): number {
  const { width, height } = stream;
  if (width !== null && height !== null) return Math.min(width, height);
  return height ?? width ?? 0;
}

function byQualityDesc(a: StreamCandidate, b: StreamCandidate): number {
  const sizeDiff = shortSide(b) - shortSide(a);
  if (sizeDiff !== 0) return sizeDiff;
  const bitrateDiff = (b.bitrate ?? 0) - (a.bitrate ?? 0);
  if (bitrateDiff !== 0) return bitrateDiff;
  return b.preference - a.preference;
}

function describe(stream: StreamCandidate): string {
  const side = shortSide(stream);
  return side > 0 ? `${side}p` : stream.id;
}
