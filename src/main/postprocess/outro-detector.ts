import type { OutroDecision, TrimPlan } from './types';

/**
 * Outro detection — spec section 9.
 *
 * The governing sentence is "a false positive that cuts real content is a far
 * worse bug than a missed outro", and everything here is shaped by it:
 *
 *  - The safety rails are enforced in their own function, after scoring, so no
 *    amount of confidence can talk the detector past them.
 *  - The confidence threshold is deliberately high. Leaving an outro on is a
 *    cosmetic complaint; cutting a creator's last two seconds is data loss.
 *  - Detection only runs on watermarked sources at all (section 9), because a
 *    clean `play_addr` stream usually carries no end card in the first place.
 */

/* ------------------------------------------------------------------ *
 * Safety rails — non-negotiable, per section 9
 * ------------------------------------------------------------------ */

/** Never trim a video shorter than this. */
export const MIN_VIDEO_DURATION_MS = 8_000;
/** Never remove more than this much, however confident the score. */
export const MAX_TRIM_MS = 5_000;
/** Never remove more than this share of the total duration. */
export const MAX_TRIM_RATIO = 0.15;
/** How much of the tail is analysed. */
export const ANALYSIS_WINDOW_MS = 6_000;
/** Below this, nothing is trimmed. Chosen high on purpose. */
export const CONFIDENCE_THRESHOLD = 0.75;

export interface RailCheck {
  readonly allowed: boolean;
  readonly blockedBy: OutroDecision['blockedBy'];
  readonly reason: string;
}

/**
 * The last line of defence.
 *
 * Separate from scoring so it can be read, tested and audited on its own — and
 * so that a future change to the scoring model cannot accidentally widen what
 * is allowed to be cut.
 */
export function applySafetyRails(trimmedMs: number, durationMs: number): RailCheck {
  if (durationMs < MIN_VIDEO_DURATION_MS) {
    return {
      allowed: false,
      blockedBy: 'too-short',
      reason: `video is ${Math.round(durationMs / 1_000)}s; nothing under ${MIN_VIDEO_DURATION_MS / 1_000}s is trimmed`,
    };
  }
  if (trimmedMs > MAX_TRIM_MS) {
    return {
      allowed: false,
      blockedBy: 'too-long',
      reason: `proposed cut of ${Math.round(trimmedMs / 1_000)}s exceeds the ${MAX_TRIM_MS / 1_000}s limit`,
    };
  }
  if (trimmedMs > durationMs * MAX_TRIM_RATIO) {
    return {
      allowed: false,
      blockedBy: 'too-large-a-share',
      reason: `proposed cut is ${Math.round((trimmedMs / durationMs) * 100)}% of the video, over the ${
        MAX_TRIM_RATIO * 100
      }% limit`,
    };
  }
  return { allowed: true, blockedBy: null, reason: 'within the safety limits' };
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

/**
 * Per-slice measurements over the analysis window, oldest slice first.
 *
 * Every array is normalised 0-1 and every one is produced by ffmpeg, which is
 * why they arrive as plain numbers: the scoring is then pure and testable
 * without any media at all.
 */
export interface OutroSignals {
  /** Mean absolute difference from the previous frame. Near 0 = a static card. */
  readonly frameDeltas: readonly number[];
  /** Audio RMS. Near 0 = silence. */
  readonly audioRms: readonly number[];
  /** TikTok glyph template match, 0-1. */
  readonly glyphScores: readonly number[];
  /** How dominated the frame is by one colour, 0-1. */
  readonly colorUniformity: readonly number[];
  readonly sliceMs: number;
  /** Where slice 0 begins, in milliseconds from the start of the video. */
  readonly windowStartMs: number;
}

/**
 * Signal weights.
 *
 * The glyph carries the most weight because it is the only signal that is
 * specific to a TikTok outro. The other three describe "a still, quiet,
 * flat-coloured shot", which also describes plenty of legitimate endings — a
 * held final frame, a fade to black — so on their own they must never be
 * enough to justify a cut.
 */
const WEIGHTS = { glyph: 0.45, static: 0.25, silence: 0.18, uniformity: 0.12 } as const;

/** How still a frame must be to read as "static". */
const STATIC_DELTA = 0.02;
/** Below this RMS counts as silence. */
const SILENCE_RMS = 0.02;

function sliceScore(delta: number, rms: number, glyph: number, uniformity: number): number {
  const staticness = delta <= STATIC_DELTA ? 1 : Math.max(0, 1 - delta / (STATIC_DELTA * 8));
  const silence = rms <= SILENCE_RMS ? 1 : Math.max(0, 1 - rms / (SILENCE_RMS * 8));
  return (
    glyph * WEIGHTS.glyph +
    staticness * WEIGHTS.static +
    silence * WEIGHTS.silence +
    Math.max(0, Math.min(1, uniformity)) * WEIGHTS.uniformity
  );
}

export interface OutroScore {
  readonly confidence: number;
  /** Start of the trailing run that scored well, or null when there isn't one. */
  readonly cutAtMs: number | null;
}

/**
 * Finds the longest run of outro-looking slices that reaches the end.
 *
 * Anchoring to the end matters: a still, quiet moment in the middle of a video
 * is not an outro, and scoring the window as a whole would let one confidently
 * detected slice drag an entire six seconds over the threshold.
 */
export function scoreOutro(signals: OutroSignals): OutroScore {
  const count = Math.min(
    signals.frameDeltas.length,
    signals.audioRms.length,
    signals.glyphScores.length,
    signals.colorUniformity.length,
  );
  if (count === 0) return { confidence: 0, cutAtMs: null };

  const scores: number[] = [];
  for (let i = 0; i < count; i++) {
    scores.push(
      sliceScore(
        signals.frameDeltas[i] as number,
        signals.audioRms[i] as number,
        signals.glyphScores[i] as number,
        signals.colorUniformity[i] as number,
      ),
    );
  }

  // Walk backwards from the end while slices keep looking like an outro.
  let runStart = count;
  for (let i = count - 1; i >= 0; i--) {
    if ((scores[i] as number) < CONFIDENCE_THRESHOLD) break;
    runStart = i;
  }

  if (runStart === count) return { confidence: scores[count - 1] ?? 0, cutAtMs: null };

  const runScores = scores.slice(runStart);
  const confidence = runScores.reduce((sum, s) => sum + s, 0) / runScores.length;
  return { confidence, cutAtMs: signals.windowStartMs + runStart * signals.sliceMs };
}

export interface DetectOutroInput {
  readonly signals: OutroSignals;
  readonly durationMs: number;
}

/** Scores, then submits the proposal to the safety rails. */
export function detectOutro(input: DetectOutroInput): OutroDecision {
  const { durationMs } = input;

  // Checked before scoring too, so a short video costs no analysis at all.
  if (durationMs < MIN_VIDEO_DURATION_MS) {
    const rail = applySafetyRails(0, durationMs);
    return { trim: false, cutAtMs: null, trimmedMs: 0, confidence: 0, reason: rail.reason, blockedBy: 'too-short' };
  }

  const score = scoreOutro(input.signals);
  if (score.cutAtMs === null || score.confidence < CONFIDENCE_THRESHOLD) {
    return {
      trim: false,
      cutAtMs: null,
      trimmedMs: 0,
      confidence: score.confidence,
      reason: `confidence ${score.confidence.toFixed(2)} is below the ${CONFIDENCE_THRESHOLD} threshold`,
      blockedBy: 'low-confidence',
    };
  }

  const trimmedMs = Math.max(0, durationMs - score.cutAtMs);
  const rail = applySafetyRails(trimmedMs, durationMs);
  if (!rail.allowed) {
    return {
      trim: false,
      cutAtMs: null,
      trimmedMs: 0,
      confidence: score.confidence,
      reason: rail.reason,
      blockedBy: rail.blockedBy,
    };
  }

  return {
    trim: true,
    cutAtMs: score.cutAtMs,
    trimmedMs,
    confidence: score.confidence,
    reason: `outro detected with confidence ${score.confidence.toFixed(2)}`,
    blockedBy: null,
  };
}

/* ------------------------------------------------------------------ *
 * Trim planning
 * ------------------------------------------------------------------ */

/** Section 9: a keyframe this close to the target makes the cut lossless. */
export const KEYFRAME_TOLERANCE_MS = 250;

/**
 * Decides how to make the cut.
 *
 * Stream copy at a keyframe is instant and lossless. A frame-accurate cut costs
 * a full re-encode, which section 9 only permits when the item is already being
 * re-encoded for watermark removal. Otherwise the nearest preceding keyframe is
 * used and slightly less is trimmed — leaving a fraction of outro is a much
 * better outcome than re-encoding the whole file to remove it.
 */
export function planTrim(
  cutAtMs: number,
  keyframesMs: readonly number[],
  alreadyReEncoding: boolean,
): TrimPlan {
  const preceding = [...keyframesMs].filter((k) => k <= cutAtMs).sort((a, b) => b - a)[0];

  if (preceding !== undefined && cutAtMs - preceding <= KEYFRAME_TOLERANCE_MS) {
    return {
      mode: 'stream-copy',
      cutAtMs: preceding,
      reason: `keyframe ${Math.round(cutAtMs - preceding)}ms before the cut; copying without re-encoding`,
    };
  }

  if (alreadyReEncoding) {
    return {
      mode: 're-encode',
      cutAtMs,
      reason: 'the file is being re-encoded for watermark removal anyway, so the cut can be frame-accurate',
    };
  }

  if (preceding !== undefined) {
    return {
      mode: 'stream-copy',
      cutAtMs: preceding,
      reason: `nearest keyframe is ${Math.round(
        cutAtMs - preceding,
      )}ms early; trimming slightly less rather than re-encoding the file`,
    };
  }

  return {
    mode: 'stream-copy',
    cutAtMs: 0,
    reason: 'no keyframe found before the cut point',
  };
}
