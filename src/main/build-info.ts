/**
 * Which commit this build came from.
 *
 * Stamped in by electron.vite.config.ts at build time. The reason it exists:
 * `package.json` says 0.1.0 and always will, so "what version am I running?"
 * had no answer — and three separate features were reported missing that had
 * already shipped, each time because the launcher's `git pull` had silently
 * failed and the app was building weeks-old source. Nothing on screen could
 * have revealed that. Now it can.
 */

declare const __BUILD_COMMIT__: string;
declare const __BUILD_COMMITTED_AT__: string;
declare const __BUILD_AT__: string;

export interface BuildInfo {
  /** Short commit hash, or 'unknown' when built outside a git checkout. */
  readonly commit: string;
  /** When that commit was made, ISO 8601, or 'unknown'. */
  readonly committedAt: string;
  /** When this build ran, ISO 8601. */
  readonly builtAt: string;
}

/**
 * Falls back rather than throwing when the constants were not injected — the
 * test runner and the CLI harness both import this module without going
 * through the Vite build that defines them.
 */
export function buildInfo(): BuildInfo {
  return {
    commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown',
    committedAt: typeof __BUILD_COMMITTED_AT__ === 'string' ? __BUILD_COMMITTED_AT__ : 'unknown',
    builtAt: typeof __BUILD_AT__ === 'string' ? __BUILD_AT__ : 'unknown',
  };
}

/**
 * How out of date this build is, in days, or null when it cannot be known.
 *
 * Used to say "built from code 34 days old" rather than printing a hash and
 * leaving the reader to work out whether that is a problem.
 */
export function buildAgeDays(info: BuildInfo = buildInfo(), now: number = Date.now()): number | null {
  if (info.committedAt === 'unknown') return null;
  const at = Date.parse(info.committedAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / 86_400_000));
}
