import { AppError } from '@shared/errors';
import type { SourceStrategy } from '@shared/types';
import type { AppConfig } from '@shared/config-schema';
import type { StreamCandidate } from '../resolve/types';

/**
 * Stream selection — spec section 9 step 4.
 *
 * The order is the whole product argument: "Prefer, in order: clean/no-watermark
 * source at the highest available resolution → clean source at lower resolution
 * → watermarked source."
 *
 * A clean source is lossless and instant. A watermarked one costs a full
 * re-encode of 20-60s and visible quality loss. So a 480p clean stream beats a
 * 1080p watermarked one — resolution only breaks ties *within* a watermark
 * class, never across it.
 */

export interface SelectionResult {
  readonly stream: StreamCandidate;
  /**
   * What this choice implies for post-processing. 'clean_source' means the
   * file needs no watermark work at all; 'raw' means a watermarked stream was
   * the only option and phase 5's filtering tiers will have to run.
   */
  readonly strategy: SourceStrategy;
  /** Why this stream won, for the row detail and the Logs screen. */
  readonly reason: string;
}

const QUALITY_CEILING: Record<AppConfig['qualityPreference'], number | null> = {
  best: null,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
};

export interface SelectOptions {
  readonly qualityPreference: AppConfig['qualityPreference'];
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
    const audio = streams.filter((s) => s.kind === 'audio');
    const best = audio.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
    if (!best) {
      throw new AppError('UNSUPPORTED_MEDIA', 'audio-only was requested but no audio stream is available');
    }
    return { stream: best, strategy: 'raw', reason: 'audio-only requested' };
  }

  const video = streams.filter((s) => s.kind === 'video');
  if (video.length === 0) {
    throw new AppError('EXTRACTOR_FAILED', 'no video streams were offered for this video');
  }

  const ceiling = QUALITY_CEILING[options.qualityPreference];
  const withinCeiling = (s: StreamCandidate): boolean => ceiling === null || shortSide(s) <= ceiling;

  const clean = video.filter((s) => !s.watermarked);
  const watermarked = video.filter((s) => s.watermarked);

  // "Keep watermark" makes the watermarked variant a first-class choice; it is
  // usually the higher-quality encode TikTok offers for download.
  const preferred = options.watermarkMode === 'keep' && watermarked.length > 0 ? watermarked : clean;
  const fallback = preferred === clean ? watermarked : clean;

  const pick = (pool: readonly StreamCandidate[]): StreamCandidate | undefined => {
    if (pool.length === 0) return undefined;
    // Honour the ceiling when anything satisfies it; otherwise take the
    // smallest available rather than failing, since a user asking for 720p
    // wants a file, not an error.
    const eligible = pool.filter(withinCeiling);
    const sorted = [...(eligible.length > 0 ? eligible : pool)].sort(byQualityDesc);
    return eligible.length > 0 ? sorted[0] : sorted[sorted.length - 1];
  };

  const best = pick(preferred);
  if (best) {
    const isClean = !best.watermarked;
    return {
      stream: best,
      strategy: isClean ? 'clean_source' : 'raw',
      reason: isClean
        ? `clean source at ${describe(best)}`
        : `watermarked source at ${describe(best)} (watermark kept by preference)`,
    };
  }

  const alternative = pick(fallback);
  if (!alternative) throw new AppError('EXTRACTOR_FAILED', 'no usable video stream was offered');

  return {
    stream: alternative,
    strategy: alternative.watermarked ? 'raw' : 'clean_source',
    reason: alternative.watermarked
      ? `only a watermarked source was available at ${describe(alternative)}; it will need re-encoding`
      : `clean source at ${describe(alternative)}`,
  };
}

/**
 * The dimension a resolution label refers to.
 *
 * TikTok is portrait-first: a "720p" clip is 720x1280, so measuring height
 * against the ceiling would exclude it — and would exclude every 1080x1920
 * video from a "1080p" preference, quietly handing the user something worse
 * than they asked for. The short side is the right measure in any orientation.
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
