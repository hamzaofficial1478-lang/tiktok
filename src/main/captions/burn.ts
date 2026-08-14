import type { CaptionMode } from '@shared/caption-schema';

/**
 * Getting captions into the file.
 *
 * Two routes, and the difference matters enough to be a setting rather than a
 * default:
 *
 *   soft  a subtitle track alongside the video. No re-encode, no quality lost,
 *         toggleable in a player — and ignored by anything that does not read
 *         subtitle tracks, which includes most social re-uploads.
 *   burn  painted into the pixels. Survives anywhere, cannot be switched off,
 *         and costs a full re-encode of the video.
 *
 * ## The filename problem, and why it is not solved with escaping
 *
 * The `subtitles` filter takes its file inside a filter graph, where `:`
 * separates a filter's options, `,` chains filters, `;` separates chains and
 * `\` escapes. A real Windows path — `C:\Users\ammar laptops\Videos\cap.ass` —
 * contains three of those four. The published escapes for it contradict each
 * other, and the failure mode is ffmpeg reporting a missing file for a file
 * that is plainly there.
 *
 * So the path is never put in the graph. ffmpeg runs from the directory the
 * subtitle file is in and is handed a bare filename this app chose, which is
 * ASCII, has no spaces, and needs no escaping under any rule. The video's own
 * paths stay absolute in argv, where the shell is not involved and nothing
 * needs quoting.
 */

/** ASCII, no spaces, no punctuation a filter graph cares about. */
export const SUBTITLE_FILENAME = 'captions.ass';

export interface BurnPlan {
  /** Passed to `-vf`; empty when captions are not being burned in. */
  readonly videoFilter: string | null;
  /** Extra arguments placed before the output file. */
  readonly args: readonly string[];
  /** The directory ffmpeg must run from, when a filter references a file. */
  readonly cwd: string | null;
  /** True when the video has to be re-encoded for this. */
  readonly reencodes: boolean;
}

export interface BurnOptions {
  readonly mode: CaptionMode;
  /** Directory holding SUBTITLE_FILENAME. */
  readonly subtitleDir: string;
  /** Absolute path to the subtitle file, for the soft-mux input. */
  readonly subtitlePath: string;
  /** Container of the output; soft subtitles are not universally supported. */
  readonly outputExtension: string;
}

/**
 * Containers that can carry a soft subtitle track.
 *
 * MP4 takes `mov_text` and nothing else — an ASS track muxed into MP4 either
 * fails or produces a track no player will show, so the styling is flattened
 * on the way in and the user is told what was lost rather than left to find out.
 */
const SOFT_SUBTITLE_CODEC: Record<string, string> = {
  '.mp4': 'mov_text',
  '.m4v': 'mov_text',
  '.mkv': 'ass',
  '.webm': 'webvtt',
};

export function planBurn(options: BurnOptions): BurnPlan {
  if (options.mode === 'off') {
    return { videoFilter: null, args: [], cwd: null, reencodes: false };
  }

  if (options.mode === 'soft') {
    const codec = SOFT_SUBTITLE_CODEC[options.outputExtension.toLowerCase()] ?? 'mov_text';
    return {
      videoFilter: null,
      args: [
        '-i',
        options.subtitlePath,
        // Explicit maps: without them ffmpeg picks one stream per type and the
        // subtitle input would replace the video rather than join it.
        '-map',
        '0:v?',
        '-map',
        '0:a?',
        '-map',
        '1:0',
        '-c:s',
        codec,
        // Marked so a player knows the track is available without being told.
        '-disposition:s:0',
        'default',
      ],
      cwd: null,
      reencodes: false,
    };
  }

  return {
    // A bare filename, resolved against cwd. See the note above.
    videoFilter: `subtitles=${SUBTITLE_FILENAME}`,
    args: [],
    cwd: options.subtitleDir,
    reencodes: true,
  };
}

/** True when the chosen container cannot carry the styling as authored. */
export function softSubtitlesLoseStyling(outputExtension: string): boolean {
  return (SOFT_SUBTITLE_CODEC[outputExtension.toLowerCase()] ?? 'mov_text') !== 'ass';
}
