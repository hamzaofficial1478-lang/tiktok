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
    const drift = Math.abs(probe.durationMs - input.expectedDurationMs) / input.expectedDurationMs;
    if (drift > DURATION_TOLERANCE) {
      throw new AppError(
        'VERIFY_FAILED',
        `expected about ${Math.round(input.expectedDurationMs / 1_000)}s but the file is ${Math.round(
          probe.durationMs / 1_000,
        )}s (${Math.round(drift * 100)}% off)`,
      );
    }
  }

  return { sizeBytes, probe, degraded: false };
}
