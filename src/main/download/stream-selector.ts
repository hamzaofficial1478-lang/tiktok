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
   * The audio to merge in, set only when the chosen video carries none.
   *
   * TikTok's app API offers video-only formats alongside muxed ones, and they
   * are often the highest resolution on offer. Picking one and downloading it
   * as-is produces a silent video — which is exactly what happened: some
   * downloads from a batch had sound and some did not, with nothing in the UI
   * to say why.
   */
  readonly audioStream?: StreamCandidate;
  /**
   * What to pass to yt-dlp's `-f`. `a+b` asks it to merge, which is the one
   * place the download needs to know a merge is happening.
   */
  readonly formatId: string;
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
    return { stream: best, formatId: best.id, strategy: 'raw', reason: 'audio-only requested' };
  }

  const video = streams.filter((s) => s.kind === 'video');
  if (video.length === 0) {
    /**
     * Audio tracks and no video is what a photo post looks like by the time it
     * reaches here, and it is not an extractor problem.
     *
     * EXTRACTOR_FAILED renders as "Extractor out of date. TikTok changed how
     * videos are served" — so a user with a perfectly current extractor
     * updated it, was told it was already current, and got the same message
     * again. The post was never a video.
     */
    throw new AppError(
      'UNSUPPORTED_MEDIA',
      'this post has no video track — it is a photo slideshow or an audio-only post, not a video',
    );
  }

  /**
   * Best picture, and never at the cost of the sound.
   *
   * The first fix for silent downloads ranked audio-bearing streams above
   * everything, which stopped the silence and quietly cost resolution: TikTok's
   * highest-quality format is frequently video-only, so preferring a muxed
   * stream meant preferring a smaller one. That is a bad trade and it was the
   * wrong instinct — there is no need to choose.
   *
   * Highest quality wins outright. If that stream carries no audio, TikTok's
   * separate audio track is merged into it, which costs a remux and no picture
   * quality at all. Only when a silent winner has no audio track to pair with
   * does audio outrank resolution, and only then is a lower muxed stream taken.
   */
  const audioTracks = [...streams.filter((s) => s.kind === 'audio')].sort(
    (a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0),
  );
  const hasSeparateAudio = audioTracks.length > 0;

  const rank = (candidates: readonly StreamCandidate[]): StreamCandidate[] => {
    const byQuality = [...candidates].sort(byQualityDesc);
    if (hasSeparateAudio) return byQuality;
    // Nothing to merge with, so a muxed stream is the only way to keep sound.
    return [...byQuality.filter((s) => s.hasAudio), ...byQuality.filter((s) => !s.hasAudio)];
  };

  const clean = rank(video.filter((s) => !s.watermarked));
  const watermarked = rank(video.filter((s) => s.watermarked));

  // "Keep watermark" makes the watermarked variant a first-class choice; it is
  // usually the higher-quality encode TikTok offers for download.
  const preferred = options.watermarkMode === 'keep' ? (watermarked[0] ?? clean[0]) : (clean[0] ?? watermarked[0]);
  if (!preferred) throw new AppError('EXTRACTOR_FAILED', 'no usable video stream was offered');

  const isClean = !preferred.watermarked;
  const audioStream = preferred.hasAudio ? undefined : audioTracks[0];

  const base = isClean
    ? `clean source at ${describe(preferred)}, exactly as TikTok serves it`
    : options.watermarkMode === 'keep'
      ? `watermarked source at ${describe(preferred)} (watermark kept by preference)`
      : `only a watermarked source was available at ${describe(preferred)}; it will need re-encoding`;

  /**
   * A silent stream with no audio anywhere is a legitimate TikTok post — plenty
   * are genuinely silent — so it is downloaded rather than failed. It is said
   * out loud, because "the file has no sound" needs an explanation that is not
   * "the downloader lost it".
   */
  const reason = preferred.hasAudio
    ? base
    : audioStream
      ? `${base}; the best picture TikTok offers has no audio in it, so its separate audio track is merged in — no quality is lost`
      : `${base}; TikTok offers no audio for this post, so the file is silent`;

  return {
    stream: preferred,
    ...(audioStream ? { audioStream } : {}),
    formatId: audioStream ? `${preferred.id}+${audioStream.id}` : preferred.id,
    strategy: isClean ? 'clean_source' : 'raw',
    reason,
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
