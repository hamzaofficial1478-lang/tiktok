import { AppError } from '@shared/errors';
import type { MediaCapabilities } from '@shared/ipc/contract';

/**
 * Encoder selection for the re-encode path.
 *
 * Two rules, both from section 3:
 *
 *  1. Hardware first. A watermark re-encode costs 20-60s per video on software;
 *     NVENC or VideoToolbox turns that into a few seconds, which across a
 *     300-item batch is the difference between an afternoon and a coffee break.
 *  2. Never libx264 or libx265. They are why the convenient ffmpeg prebuilds
 *     are GPL, and shipping one would extend GPL obligations to this product.
 *     libopenh264 is the LGPL-safe software fallback.
 */

export interface EncoderChoice {
  readonly name: string;
  readonly hardware: boolean;
  /** Encoder-specific quality/bitrate arguments. */
  readonly args: readonly string[];
  readonly reason: string;
}

interface Candidate {
  readonly name: string;
  readonly hardware: boolean;
  readonly args: readonly string[];
}

/**
 * Ordered by preference. Vendor hardware first, then LGPL software.
 *
 * Quality arguments are per-encoder because the scales are not comparable:
 * NVENC's `cq` and QuickSync's `global_quality` are not the same number as a
 * CRF, and copying one across produces either a bloated file or a soft one.
 *
 * ## Why these targets are aggressive
 *
 * This path only runs when the watermark has to be filtered out of the pixels,
 * which means the video is being decoded and encoded again — a generation loss
 * that cannot be undone later. The source is a TikTok upload that has already
 * been compressed once, so encoding it a second time at a "reasonable" quality
 * compounds two lossy passes and the result visibly softens, most obviously on
 * the fast motion and hard text edges that TikTok videos are full of.
 *
 * The targets below are therefore set near-transparent rather than balanced:
 * roughly CQ/QP 19, where the second encode is not meaningfully distinguishable
 * from its input. The cost is file size, perhaps 40% over the source, and some
 * encode time. That is the right trade for a video that is being kept.
 *
 * None of this touches the common path. When TikTok serves a watermark-free
 * stream the file is copied byte for byte and no encoder is selected at all.
 */
const CANDIDATES: readonly Candidate[] = [
  // p6 is a slower preset than p5 with a real quality gain; on hardware the
  // extra time is still a fraction of a second per video.
  { name: 'h264_nvenc', hardware: true, args: ['-preset', 'p6', '-rc', 'vbr', '-cq', '19', '-b:v', '0'] },
  // VideoToolbox's scale runs the other way: higher is better, out of 100.
  { name: 'h264_videotoolbox', hardware: true, args: ['-q:v', '68'] },
  { name: 'h264_qsv', hardware: true, args: ['-global_quality', '19'] },
  { name: 'h264_amf', hardware: true, args: ['-quality', 'quality', '-rc', 'cqp', '-qp_i', '19', '-qp_p', '19'] },
  { name: 'h264_vaapi', hardware: true, args: ['-qp', '19'] },
  // openh264 has no CRF mode, so quality has to be bought with bitrate. 10M is
  // comfortably above any 1080x1920 TikTok source, which is what keeps the
  // second encode from becoming the visible one.
  { name: 'libopenh264', hardware: false, args: ['-b:v', '10M'] },
  // Last resort: universally available and LGPL, but visibly worse. Better
  // than refusing to process the video at all. Scale is 1-31, lower is better.
  { name: 'mpeg4', hardware: false, args: ['-q:v', '2'] },
];

/** Explicitly refused, whatever the build offers. */
export const FORBIDDEN_ENCODERS = ['libx264', 'libx265', 'libxvid'] as const;

export function selectEncoder(capabilities: MediaCapabilities, preferHardware = true): EncoderChoice {
  const available = (name: string): boolean => capabilities.encoders[name] === true;

  const pool = preferHardware ? CANDIDATES : CANDIDATES.filter((c) => !c.hardware);
  const chosen = pool.find((c) => available(c.name));

  if (!chosen) {
    // Falling back to a GPL encoder is not an option, so this is a hard stop
    // with an actionable message rather than a silent quality compromise.
    throw new AppError(
      'FFMPEG_FAILED',
      'this ffmpeg build offers no usable H.264 encoder. It needs a hardware encoder or libopenh264; ' +
        'libx264 cannot be used because it would make the build GPL.',
    );
  }

  return {
    name: chosen.name,
    hardware: chosen.hardware,
    args: chosen.args,
    reason: chosen.hardware
      ? `hardware encoding via ${chosen.name}`
      : `software encoding via ${chosen.name} (no hardware encoder available)`,
  };
}

/**
 * Rough processing-time estimate for the row detail (section 9: "Show
 * estimated processing time in the row"). Deliberately coarse — it exists to
 * set expectations, not to be accurate.
 */
export function estimateProcessingMs(durationMs: number, encoder: EncoderChoice): number {
  // Hardware runs faster than realtime; software runs slower.
  const factor = encoder.hardware ? 0.25 : 1.6;
  return Math.round(durationMs * factor) + 1_000;
}
