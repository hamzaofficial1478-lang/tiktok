import type { CreatorRow } from '../db/repositories/creators';

/**
 * What pressing Run will actually do.
 *
 * The button used to say "Download 25 videos" because that was the sum of
 * everyone's per-account limit — a number that never moved, whether the run
 * was about to fetch twenty-five videos or nothing at all. After a full run it
 * still said twenty-five, which is how "the download 16 videos is showing
 * while i had downloaded the videos already" happens.
 *
 * The honest number is what is still owed: the limit minus what has already
 * been taken from that account. It falls as videos complete, reaches zero when
 * an account is finished, and needs no network call to compute — the ledger
 * already knows, so the button can be truthful before the first request goes
 * out rather than after a minute of listing.
 *
 * ## Why only downloads count against the limit
 *
 * A slideshow the user declined and a post with no video track are both
 * settled, and neither will be offered again — but neither is a video the user
 * asked for. Counting them would mean that asking for 5 from an account whose
 * newest posts happen to be photos silently delivers 3.
 */

export interface CreatorPlanEntry {
  readonly creatorId: number;
  readonly handle: string;
  readonly enabled: boolean;
  /** How many this account is set to take per run. */
  readonly videoLimit: number;
  /** Videos already downloaded from this account, by TikTok's id. */
  readonly taken: number;
  /** What is still owed: the limit minus what has been taken, never below 0. */
  readonly remaining: number;
}

export interface RunPlan {
  readonly creators: readonly CreatorPlanEntry[];
  /** Accounts that will be visited — enabled and still owing something. */
  readonly accountsToVisit: number;
  /** The headline count: how many videos the run is expected to fetch. */
  readonly remaining: number;
  /** Everything taken so far across the list, for context beside it. */
  readonly taken: number;
}

export function buildRunPlan(
  creators: readonly CreatorRow[],
  takenFor: (handle: string) => number,
): RunPlan {
  const entries = creators.map((row): CreatorPlanEntry => {
    const taken = takenFor(row.handle);
    return {
      creatorId: row.id,
      handle: row.handle,
      enabled: row.enabled === 1,
      videoLimit: row.video_limit,
      taken,
      // A limit lowered below what is already taken is not a negative debt.
      remaining: Math.max(0, row.video_limit - taken),
    };
  });

  const active = entries.filter((entry) => entry.enabled);

  return {
    creators: entries,
    accountsToVisit: active.filter((entry) => entry.remaining > 0).length,
    remaining: active.reduce((sum, entry) => sum + entry.remaining, 0),
    taken: entries.reduce((sum, entry) => sum + entry.taken, 0),
  };
}
