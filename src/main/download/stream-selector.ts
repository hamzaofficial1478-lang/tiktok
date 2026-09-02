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
  /**
   * The winner is H.265 and H.264 was asked for, so convert it after the
   * download — at this resolution, rather than having taken a smaller stream.
   */
  /**
   * Advisory only, now that the finishing pass reads the finished file.
   *
   * This is the selector's *expectation* of what will land, taken from the
   * codec name in TikTok's stream listing. The finishing pass no longer acts on
   * it, because by the time that runs the watermark and caption passes may have
   * rewritten the video and a pre-download guess is the wrong thing to convert
   * from. It stays because it is honest about the choice being made, and it is
   * what the log line and its tests describe.
   */
  readonly needsH264Transcode?: boolean;
}

export interface SelectOptions {
  readonly audioOnly: boolean;
  /**
   * 'keep' means the user wants the watermark left alone, which makes the
   * watermarked download variant an equally valid choice rather than a
   * last resort.
   */
  readonly watermarkMode: AppConfig['watermarkMode'];
  /**
   * Whether a merge is actually possible, i.e. ffmpeg is installed.
   *
   * Merging a video-only stream with its audio track is ffmpeg's job. Choosing
   * a video-only stream on a machine without ffmpeg does not produce a silent
   * file — it produces a failed download, because yt-dlp cannot join the two
   * halves it was asked for. Since ffmpeg is optional in this app, the selector
   * has to know, and fall back to a muxed stream rather than pick something it
   * cannot assemble.
   *
   * Defaults to true so existing callers and tests are unaffected.
   */
  readonly canMerge?: boolean;
  /**
   * Refuse H.265 outright, rather than only breaking ties against it.
   *
   * The tie-break handles the common case, where TikTok offers both codecs at
   * the same resolution and the H.264 one costs nothing to prefer. It cannot
   * help when H.265 is the only encode at the top resolution — and that is
   * precisely when a black picture appears on a Windows machine without the
   * HEVC extensions. This is the escape hatch for that, and it is the user's
   * to choose because it can cost a resolution step.
   */
  readonly forceH264?: boolean;
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

  /**
   * Resolution is never traded for codec. Not here, not for anything.
   *
   * This used to filter every H.265 stream out when `forceH264` was set, which
   * is a reasonable-sounding rule that quietly did the worst thing in the
   * program: TikTok routinely offers its top resolution *only* as H.265, so
   * dropping those left the best available H.264 — often 480p against a 1080p
   * source. The download then succeeded, said nothing, and produced a video
   * good for nothing. Asking for compatibility got a quarter of the picture.
   *
   * Wanting H.264 is still a real want; it is just not a reason to download
   * less. The best stream is chosen on quality alone, and if the winner turns
   * out to be H.265, it is converted afterwards at its own resolution — see
   * `needsH264Transcode`. A conversion costs time and one near-transparent
   * encode. The filter cost half the pixels, permanently.
   */
  const clean = rank(video.filter((s) => !s.watermarked));
  const watermarked = rank(video.filter((s) => s.watermarked));

  // "Keep watermark" makes the watermarked variant a first-class choice; it is
  // usually the higher-quality encode TikTok offers for download.
  const preferred = options.watermarkMode === 'keep' ? (watermarked[0] ?? clean[0]) : (clean[0] ?? watermarked[0]);
  if (!preferred) throw new AppError('EXTRACTOR_FAILED', 'no usable video stream was offered');

  const isClean = !preferred.watermarked;
  const audioStream = preferred.hasAudio ? undefined : audioTracks[0];

  /**
   * No ffmpeg, no merge — so take the best stream that already has its sound.
   *
   * Without this the download is simply asked for as `video+audio`, yt-dlp
   * reports it cannot merge, and the item fails. Dropping to the best muxed
   * stream costs at most a resolution step and keeps the video usable, which
   * is the right trade when the alternative is nothing at all.
   */
  if (options.canMerge === false && audioStream) {
    const muxed = [...clean, ...watermarked].find((stream) => stream.hasAudio);
    if (muxed) {
      return {
        stream: muxed,
        formatId: muxed.id,
        strategy: muxed.watermarked ? 'raw' : 'clean_source',
        reason:
          `${describe(muxed)} with its own audio — the higher ${describe(preferred)} stream is video-only and ` +
          'joining it to the sound needs ffmpeg, which is not installed. Install ffmpeg in Settings to get the ' +
          'larger picture as well as the sound.',
      };
    }
  }

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
  let reason = preferred.hasAudio
    ? base
    : audioStream
      ? `${base}; the best picture TikTok offers has no audio in it, so its separate audio track is merged in — no quality is lost`
      : `${base}; TikTok offers no audio for this post, so the file is silent`;

  /**
   * Said out loud when H.265 wins on resolution anyway.
   *
   * Only reachable when the H.265 stream is genuinely higher resolution than
   * any H.264 one, since equal resolutions are already broken the other way and
   * cost nothing to break.
   */
  const hevcWon = isHevc(preferred);
  const transcode = hevcWon && options.forceH264 === true;

  if (hevcWon) {
    reason += transcode
      ? '; H.265 at this resolution, which will be converted to H.264 after the download — the picture is kept, ' +
        'the codec is not'
      : '; this is an H.265 encode — Windows needs the HEVC Video Extensions to play it, ' +
        'and shows a black picture without them';
  }

  return {
    stream: preferred,
    ...(audioStream ? { audioStream } : {}),
    formatId: audioStream ? `${preferred.id}+${audioStream.id}` : preferred.id,
    strategy: isClean ? 'clean_source' : 'raw',
    reason,
    ...(transcode ? { needsH264Transcode: true } : {}),
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

/**
 * H.265 by any of the names TikTok and yt-dlp use for it.
 *
 * TikTok labels its HEVC formats `play_addr_bytevc1`; yt-dlp reports the codec
 * as `h265`, `hevc`, `hev1` or `hvc1` depending on the route the metadata came
 * through, so matching on one of them would catch some videos and miss others.
 */
export function isHevc(stream: StreamCandidate): boolean {
  const codec = (stream.codec ?? '').toLowerCase();
  return /^(h\.?265|hevc|hev1|hvc1)/.test(codec) || /bytevc1/i.test(stream.id);
}

/**
 * Ranks quality first, then playability.
 *
 * The playability tie-break is the fix for downloads that opened to a black
 * screen. TikTok offers the same video as both H.264 and H.265, and H.265 is
 * the smaller file — so a rank on resolution then bitrate happily chose it.
 * Windows cannot decode H.265 out of the box: Films & TV and Media Player both
 * need the HEVC Video Extensions from the Store, which is a paid add-on, and
 * without it they show a black picture rather than an error. The file was
 * perfect; nothing could play it.
 *
 * Applied strictly as a tie-break at equal resolution, never across it, so no
 * picture quality is traded for it: at the same resolution the two encodes look
 * the same, and only the container differs in what will open it. A genuinely
 * higher-resolution H.265 stream still wins, and says so in its reason.
 */
function byQualityDesc(a: StreamCandidate, b: StreamCandidate): number {
  const sizeDiff = shortSide(b) - shortSide(a);
  if (sizeDiff !== 0) return sizeDiff;

  // Same resolution: prefer the encode that plays everywhere.
  const hevcDiff = Number(isHevc(a)) - Number(isHevc(b));
  if (hevcDiff !== 0) return hevcDiff;

  const bitrateDiff = (b.bitrate ?? 0) - (a.bitrate ?? 0);
  if (bitrateDiff !== 0) return bitrateDiff;
  return b.preference - a.preference;
}

function describe(stream: StreamCandidate): string {
  const side = shortSide(stream);
  return side > 0 ? `${side}p` : stream.id;
}
