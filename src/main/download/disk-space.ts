import { statfsSync } from 'node:fs';
import { AppError } from '@shared/errors';

/**
 * Free-space checks — spec section 9 step 5 ("pre-check free disk space
 * against estimated size; fail fast with DISK_FULL if short") and section 12's
 * pre-batch check.
 *
 * Failing before the download beats failing during it: a half-written file
 * plus an out-of-space error mid-batch is far worse than one clear refusal.
 */

/** Kept free on top of the file itself, for the remux and the OS. */
export const DEFAULT_HEADROOM_BYTES = 256 * 1024 * 1024;

export function freeBytes(directory: string): number | null {
  try {
    const stats = statfsSync(directory);
    return Number(stats.bsize) * Number(stats.bavail);
  } catch {
    // An unreadable mount is not itself a reason to refuse the download.
    return null;
  }
}

export interface SpaceCheck {
  readonly ok: boolean;
  readonly freeBytes: number | null;
  readonly requiredBytes: number;
}

export function checkSpace(
  directory: string,
  estimatedBytes: number,
  headroomBytes: number = DEFAULT_HEADROOM_BYTES,
): SpaceCheck {
  const free = freeBytes(directory);
  // Post-processing may write a second copy alongside the original, so the
  // requirement is twice the file plus headroom.
  const required = estimatedBytes * 2 + headroomBytes;
  return { ok: free === null || free >= required, freeBytes: free, requiredBytes: required };
}

export function assertEnoughSpace(
  directory: string,
  estimatedBytes: number,
  headroomBytes: number = DEFAULT_HEADROOM_BYTES,
): void {
  const check = checkSpace(directory, estimatedBytes, headroomBytes);
  if (check.ok) return;
  throw new AppError(
    'DISK_FULL',
    `${directory} has ${formatBytes(check.freeBytes ?? 0)} free but this download needs about ${formatBytes(
      check.requiredBytes,
    )}`,
  );
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}
