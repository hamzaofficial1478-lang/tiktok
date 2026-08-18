/**
 * How old the code in this build is, in days.
 *
 * Lives in the renderer because it is a presentation question — "should this
 * say `current` or `built from code 34 days old`" — and because the main
 * process already ships the raw timestamp. Returns null when there is no
 * timestamp to work from, which happens when the app was built from a
 * downloaded ZIP rather than a git checkout; that case gets its own message
 * because such a copy can never update itself at all.
 */
export function buildAgeDays(committedAt: string, now: number = Date.now()): number | null {
  if (!committedAt || committedAt === 'unknown') return null;
  const at = Date.parse(committedAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / 86_400_000));
}
