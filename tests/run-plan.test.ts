import { describe, expect, it } from 'vitest';
import { buildRunPlan } from '@main/creators/run-plan';
import type { CreatorRow } from '@main/db/repositories/creators';

/**
 * The Run button's count.
 *
 * It used to show the sum of everyone's per-account limit, which never moved:
 * after downloading all sixteen videos it still offered to download sixteen
 * videos. What it has to show is what is still owed.
 */

function creator(overrides: Partial<CreatorRow> & { handle: string }): CreatorRow {
  return {
    id: 1,
    profile_url: `https://www.tiktok.com/@${overrides.handle}`,
    video_limit: 5,
    caption_mode: null,
    enabled: 1,
    added_at: 0,
    last_queued_at: null,
    videos_queued: 0,
    ...overrides,
  } as CreatorRow;
}

describe('the run plan', () => {
  it('counts what is still owed, not what was asked for', () => {
    const plan = buildRunPlan(
      [
        creator({ id: 1, handle: 'alice', video_limit: 5 }),
        creator({ id: 2, handle: 'bob', video_limit: 3 }),
      ],
      (handle) => (handle === 'alice' ? 2 : 0),
    );

    expect(plan.remaining).toBe(6);
    expect(plan.taken).toBe(2);
    expect(plan.accountsToVisit).toBe(2);
    expect(plan.creators[0]).toMatchObject({ handle: 'alice', taken: 2, remaining: 3 });
    expect(plan.creators[1]).toMatchObject({ handle: 'bob', taken: 0, remaining: 3 });
  });

  it('reaches zero once every account has given what it was asked for', () => {
    const plan = buildRunPlan([creator({ handle: 'alice', video_limit: 5 })], () => 5);

    // This is the state the old button could not represent: nothing to do.
    expect(plan.remaining).toBe(0);
    expect(plan.accountsToVisit).toBe(0);
  });

  it('never reports a negative debt when a count is lowered below what was taken', () => {
    const plan = buildRunPlan([creator({ handle: 'alice', video_limit: 2 })], () => 9);

    expect(plan.creators[0]?.remaining).toBe(0);
    expect(plan.remaining).toBe(0);
    // The videos already taken are still reported; only the debt is floored.
    expect(plan.taken).toBe(9);
  });

  it('leaves disabled accounts out of the total but still describes them', () => {
    const plan = buildRunPlan(
      [
        creator({ id: 1, handle: 'alice', video_limit: 5, enabled: 0 }),
        creator({ id: 2, handle: 'bob', video_limit: 4 }),
      ],
      () => 1,
    );

    expect(plan.remaining).toBe(3);
    expect(plan.accountsToVisit).toBe(1);
    // Disabled is not hidden: the row still shows what it would take if it
    // were switched back on.
    expect(plan.creators[0]).toMatchObject({ handle: 'alice', enabled: false, remaining: 4 });
  });

  it('counts an empty list as nothing to do rather than failing', () => {
    expect(buildRunPlan([], () => 0)).toEqual({
      creators: [],
      accountsToVisit: 0,
      remaining: 0,
      taken: 0,
    });
  });
});
