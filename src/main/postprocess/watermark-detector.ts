import type { Box, WatermarkPlan, WatermarkSegment } from './types';
import { CANDIDATE_REGIONS, allPixelBoxes, toPixelBox, type NormalizedRegion } from './regions';

/**
 * Watermark detection and temporal segmentation.
 *
 * The measurement is separated from the decision on purpose. ffmpeg samples
 * frames and produces per-region scores; everything below operates on those
 * numbers alone, so the segmentation, the confidence gate and the tier choice
 * are all testable without a single video file.
 *
 * The tier gate is the important part. When the detector is confident about
 * *where and when* the mark appears, tier 1 or 2 treats only those windows and
 * leaves the rest of the frame untouched. When it is not confident, section 9
 * is explicit: fall back to blurring every candidate region for the whole
 * duration — "crude but never misses" — and flag the item so the user knows.
 */

/** A per-region score for one sampled frame. */
export interface FrameSample {
  readonly timeMs: number;
  /** Region id -> 0-1 likelihood the watermark is present there. */
  readonly regionScores: Readonly<Record<string, number>>;
}

/** A region scoring above this is treated as carrying the mark. */
export const PRESENCE_THRESHOLD = 0.55;
/**
 * Mean confidence below this drops to the static tier. Set where it is because
 * a wrong *box* is worse than a crude one: mis-timed filtering leaves the
 * watermark visible half the time, which is the failure section 2 warns about.
 */
export const TIER_CONFIDENCE_THRESHOLD = 0.6;
/**
 * Fewer samples than this cannot describe an alternating cycle, so the timing
 * is untrustworthy no matter how strongly each individual frame scored.
 */
export const MIN_SAMPLES_FOR_SEGMENTATION = 4;

export interface DetectWatermarkInput {
  readonly samples: readonly FrameSample[];
  readonly durationMs: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  /** Prefer removelogo when the build has it; falls back to blur otherwise. */
  readonly removelogoAvailable: boolean;
}

/**
 * Groups consecutive samples that agree on a region into segments.
 *
 * Segment boundaries are placed midway between the last sample of one run and
 * the first of the next, since the true transition happened somewhere between
 * the two and splitting the difference is the least-wrong guess. Each segment
 * is then padded by half a sample interval at each end, because a mark that is
 * uncovered for even a few frames at a boundary is exactly what a viewer
 * notices.
 */
export function buildSegments(
  samples: readonly FrameSample[],
  durationMs: number,
  frameWidth: number,
  frameHeight: number,
): WatermarkSegment[] {
  if (samples.length === 0) return [];

  const ordered = [...samples].sort((a, b) => a.timeMs - b.timeMs);
  const regionById = new Map<string, NormalizedRegion>(CANDIDATE_REGIONS.map((r) => [r.id, r]));

  /** The best-scoring region for a sample, or null when nothing is present. */
  const winnerFor = (sample: FrameSample): string | null => {
    let best: string | null = null;
    let bestScore = PRESENCE_THRESHOLD;
    for (const [id, score] of Object.entries(sample.regionScores)) {
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  };

  const runs: { regionId: string; startIndex: number; endIndex: number }[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const winner = winnerFor(ordered[i] as FrameSample);
    if (winner === null) continue;
    const last = runs[runs.length - 1];
    if (last && last.regionId === winner && last.endIndex === i - 1) {
      last.endIndex = i;
    } else {
      runs.push({ regionId: winner, startIndex: i, endIndex: i });
    }
  }

  /**
   * Padding is half the real sampling interval. With a single sample there is
   * no interval to measure, and falling back to the video duration would let
   * one frame claim half the runtime — so it pads by nothing and the resulting
   * zero-length segment is dropped below. Trusting one sample to describe a
   * two-minute video is exactly the over-confidence the tier gate exists to
   * catch.
   */
  const interval =
    ordered.length > 1
      ? ((ordered[ordered.length - 1] as FrameSample).timeMs - (ordered[0] as FrameSample).timeMs) /
        (ordered.length - 1)
      : 0;
  const pad = interval / 2;

  return runs
    .map((run) => {
      const region = regionById.get(run.regionId);
      if (!region) return null;
      const startMs = Math.max(0, (ordered[run.startIndex] as FrameSample).timeMs - pad);
      const endMs = Math.min(durationMs, (ordered[run.endIndex] as FrameSample).timeMs + pad);
      return { startMs, endMs, box: toPixelBox(region, frameWidth, frameHeight) } satisfies WatermarkSegment;
    })
    .filter((segment): segment is WatermarkSegment => segment !== null)
    .filter((segment) => segment.endMs > segment.startMs);
}

/** Mean of the winning score across samples where anything was found. */
function meanConfidence(samples: readonly FrameSample[]): number {
  const winners = samples
    .map((sample) => Math.max(0, ...Object.values(sample.regionScores)))
    .filter((score) => score >= PRESENCE_THRESHOLD);
  if (winners.length === 0) return 0;
  return winners.reduce((sum, score) => sum + score, 0) / winners.length;
}

/** How much of the video the detected segments actually cover. */
function coverage(segments: readonly WatermarkSegment[], durationMs: number): number {
  if (durationMs <= 0) return 0;
  const covered = segments.reduce((sum, segment) => sum + (segment.endMs - segment.startMs), 0);
  return Math.min(1, covered / durationMs);
}

export function detectWatermark(input: DetectWatermarkInput): WatermarkPlan {
  const { samples, durationMs, frameWidth, frameHeight } = input;
  const staticBoxes = (): Box[] => allPixelBoxes(frameWidth, frameHeight);

  if (samples.length < MIN_SAMPLES_FOR_SEGMENTATION) {
    return {
      tier: 'static-blur',
      segments: staticBoxes().map((box) => ({ startMs: 0, endMs: durationMs, box })),
      confidence: 0,
      reason:
        samples.length === 0
          ? 'no frames could be sampled; blurring every candidate region for the whole video'
          : `only ${samples.length} frame(s) sampled, too few to describe the watermark cycle; using the static fallback`,
    };
  }

  const segments = buildSegments(samples, durationMs, frameWidth, frameHeight);
  const confidence = meanConfidence(samples);
  const covered = coverage(segments, durationMs);

  /**
   * Low confidence, nothing found, or segments covering almost none of the
   * video all mean the same thing: the timing cannot be trusted. A watermark
   * that is present but only filtered for 10% of the runtime is worse than a
   * crude blur, because it looks like the feature works.
   */
  if (segments.length === 0 || confidence < TIER_CONFIDENCE_THRESHOLD || covered < 0.25) {
    return {
      tier: 'static-blur',
      segments: staticBoxes().map((box) => ({ startMs: 0, endMs: durationMs, box })),
      confidence,
      reason:
        segments.length === 0
          ? 'no watermark was located; blurring every candidate region as a precaution'
          : `detection confidence ${confidence.toFixed(2)} over ${Math.round(
              covered * 100,
            )}% of the video is too low to trust the timing; using the static fallback`,
    };
  }

  const tier = input.removelogoAvailable ? 'removelogo' : 'blur';
  return {
    tier,
    segments,
    confidence,
    reason: `${segments.length} segment(s) detected with confidence ${confidence.toFixed(2)}; using ${tier}`,
  };
}

/**
 * Scores one region of one frame.
 *
 * The TikTok mark is a bright, high-contrast glyph composited over whatever is
 * behind it, so it shows up as a region that is both brighter and busier than
 * a normal patch of video. This is a heuristic, not template matching, and it
 * is the part of phase 5 most in need of calibration against real footage —
 * which is why the tier gate above exists to catch it being wrong.
 *
 * @param pixels grayscale bytes for the region, row-major
 */
export function scoreRegionLuminance(pixels: Uint8Array, width: number, height: number): number {
  if (pixels.length === 0 || width <= 1 || height <= 1) return 0;

  let sum = 0;
  for (const value of pixels) sum += value;
  const mean = sum / pixels.length;

  // Horizontal gradient energy: a glyph has hard edges, flat video does not.
  let edges = 0;
  let comparisons = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = pixels[y * width + x] as number;
      const right = pixels[y * width + x + 1] as number;
      edges += Math.abs(left - right);
      comparisons++;
    }
  }
  const edginess = comparisons > 0 ? edges / comparisons : 0;

  // Proportion of near-white pixels: the mark is white-on-anything.
  let bright = 0;
  for (const value of pixels) if (value > 200) bright++;
  const brightRatio = bright / pixels.length;

  const normalisedEdges = Math.min(1, edginess / 40);
  const normalisedBright = Math.min(1, brightRatio / 0.12);
  const normalisedMean = Math.min(1, mean / 200);

  return Math.min(1, normalisedEdges * 0.45 + normalisedBright * 0.4 + normalisedMean * 0.15);
}
