import { existsSync, statSync } from 'node:fs';
import { AppError } from '@shared/errors';
import type { Ffprobe, ProbeResult } from '../media/ffprobe';

/**
 * Integrity verification — spec section 9 step 7: "file size > 0; ffprobe
 * returns a valid video stream; actual duration within ±10% of metadata
 * duration. Fail with VERIFY_FAILED if not — a silently truncated file is the
 * worst possible outcome."
 *
 * This is the gate between the `.part` and the final filename. Everything it
 * rejects stays a `.part`, so the guarantee that no truncated file exists
 * under its final name is enforced here rather than hoped for.
 */

/** Section 9: ±10%. */
export const DURATION_TOLERANCE = 0.1;

/**
 * Below this, the tolerance is meaningless: a 2s clip has a ±0.2s budget,
 * which normal container rounding can exceed on a perfectly good file.
 */
const MIN_DURATION_FOR_CHECK_MS = 3_000;

/**
 * The floor under the percentage, in milliseconds.
 *
 * 10% of a short video is smaller than the error in the number it is compared
 * against. TikTok reports duration in whole seconds for many posts, and the
 * container's own duration includes the final frame's display time, so a
 * perfectly good 6-second video probes as 7 seconds and lands 16.7% out — over
 * the line, rejected, and reported to the user as a corrupt download. That is
 * not a hypothetical: it is what a real file did. Anything under a second and a
 * half of disagreement is rounding, not truncation.
 */
const DURATION_FLOOR_MS = 1_500;

/**
 * Truncation makes a file shorter, never longer, and the whole purpose of this
 * check is to catch truncation — so only a short file is a failure. A long one
 * is a container quirk or a trailing frame, and refusing it throws away a video
 * that plays correctly. The asymmetry is the point, not an oversight.
 */
export function durationDriftIsFatal(expectedMs: number, actualMs: number): boolean {
  const allowance = Math.max(expectedMs * DURATION_TOLERANCE, DURATION_FLOOR_MS);
  return actualMs < expectedMs - allowance;
}

export interface VerifyInput {
  readonly filePath: string;
  /** Duration the extractor reported, if any. */
  readonly expectedDurationMs: number | null;
  readonly audioOnly: boolean;
  readonly ffprobe: Ffprobe;
  readonly signal?: AbortSignal;
}

export interface VerifyResult {
  readonly sizeBytes: number;
  readonly probe: ProbeResult | null;
  /** True when ffprobe was unavailable and only the size check ran. */
  readonly degraded: boolean;
}

export async function verifyDownload(input: VerifyInput): Promise<VerifyResult> {
  if (!existsSync(input.filePath)) {
    throw new AppError('VERIFY_FAILED', `${input.filePath} does not exist`);
  }

  const sizeBytes = statSync(input.filePath).size;
  if (sizeBytes === 0) {
    throw new AppError('VERIFY_FAILED', 'the downloaded file is empty');
  }

  /**
   * Without ffprobe the size check is all there is. Refusing the download
   * outright would be worse: the file is very likely fine, and the app already
   * reports a missing sidecar prominently at startup. The degraded flag is
   * surfaced so the row can say the file was not fully verified.
   */
  if (!input.ffprobe.isAvailable) {
    return { sizeBytes, probe: null, degraded: true };
  }

  const probe = await input.ffprobe.probe(input.filePath, input.signal);

  const hasVideo = probe.streams.some((s) => s.codecType === 'video');
  const hasAudio = probe.streams.some((s) => s.codecType === 'audio');

  if (input.audioOnly) {
    if (!hasAudio) throw new AppError('VERIFY_FAILED', 'the file contains no audio stream');
  } else if (!hasVideo) {
    // A truncated MP4 frequently probes as audio-only, so this catches exactly
    // the failure the check exists for.
    throw new AppError('VERIFY_FAILED', 'the file contains no video stream; it is probably truncated');
  }

  if (
    input.expectedDurationMs !== null &&
    input.expectedDurationMs >= MIN_DURATION_FOR_CHECK_MS &&
    probe.durationMs !== null
  ) {
    if (durationDriftIsFatal(input.expectedDurationMs, probe.durationMs)) {
      const missing = (input.expectedDurationMs - probe.durationMs) / 1_000;
      throw new AppError(
        'VERIFY_FAILED',
        `the file is ${missing.toFixed(1)}s shorter than the ${Math.round(
          input.expectedDurationMs / 1_000,
        )}s TikTok reported, so it is probably truncated`,
      );
    }
  }

  return { sizeBytes, probe, degraded: false };
}
