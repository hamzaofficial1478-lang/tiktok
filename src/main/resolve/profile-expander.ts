import { AppError } from '@shared/errors';
import type { Logger } from 'pino';
import { parse } from '@shared/url-parse';
import { parseProfile, type ProfileRef } from '@shared/url-parse';
import type { ProcessRunner } from './process-runner';
import { BROWSER_USER_AGENT, sessionArgs, type YtDlpSessionOptions } from './yt-dlp-extractor';
import { classifyYtDlpFailure } from './yt-dlp-errors';

/**
 * Turning a profile link into the list of that account's video links.
 *
 * The alternative the user was left with was opening the profile, copying
 * links one at a time, and pasting them in — for an account with two hundred
 * posts that is not a workflow, it is a punishment.
 *
 * ## Why this does not pin a device ID
 *
 * Extraction of a single video benefits from a stable device identity (see
 * device-id.ts). Listing a profile is the opposite case, and yt-dlp's own
 * source says why:
 *
 *     # Avoid infinite loop caused by bad device_id
 *     if current_batch and current_batch == sorted(seen_ids):
 *         message = 'TikTok API keeps sending the same page'
 *         if self._KNOWN_DEVICE_ID:
 *             raise ExtractorError(f'{message}. Try again with a different device_id')
 *         # The user didn't pass a device_id so we can reset it and retry
 *         del self._DEVICE_ID
 *
 * The feed endpoint paginates against the device, and a device it has decided
 * to stop paginating for is stuck for good. yt-dlp can mint a new one and carry
 * on — but only while nobody has pinned one. Passing ours would trade a
 * recoverable hiccup for a hard failure, so the listing runs on yt-dlp's own
 * rotating identity and the pinned routes are kept as a fallback.
 */

/** Enough for any real account, and a bound on the JSON we parse. */
export const DEFAULT_PROFILE_LIMIT = 500;

export interface ProfileExpansion extends ProfileRef {
  /** Canonical video URLs, newest first, deduplicated, in TikTok's own order. */
  readonly urls: readonly string[];
  /** True when the account has more posts than the limit allowed. */
  readonly truncated: boolean;
}

export interface ProfileExpanderOptions {
  readonly binaryPath: string | null;
  readonly runner: ProcessRunner;
  readonly session?: () => YtDlpSessionOptions;
  readonly proxyUrl?: () => string | undefined;
  /** Fallback routes, tried only if yt-dlp's own identity gets nowhere. */
  readonly fallbackArgs?: () => readonly (readonly string[])[];
  readonly timeoutMs?: number;
  readonly log?: Logger;
}

interface FlatPlaylist {
  readonly title?: string;
  readonly entries?: readonly {
    readonly url?: string;
    readonly webpage_url?: string;
    readonly id?: string;
  }[];
}

export class ProfileExpander {
  constructor(private readonly options: ProfileExpanderOptions) {}

  /** Pure and instant, so the paste box can label a profile link as it is typed. */
  static identify(input: string): ProfileRef | null {
    return parseProfile(input);
  }

  async expand(
    input: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<ProfileExpansion> {
    const profile = parseProfile(input);
    if (!profile) throw new AppError('NOT_A_TIKTOK_URL', `${truncate(input)} is not a TikTok profile link`);

    const binary = this.options.binaryPath;
    if (!binary) throw new AppError('EXTRACTOR_FAILED', 'yt-dlp is not installed');

    const limit = options?.limit ?? DEFAULT_PROFILE_LIMIT;
    // One past the limit, so "there are more" is observed rather than assumed.
    const routes: readonly (readonly string[])[] = [[], ...(this.options.fallbackArgs?.() ?? [])];

    let lastError: unknown;
    for (const [index, route] of routes.entries()) {
      try {
        return await this.attempt(binary, profile, limit, route, options?.signal);
      } catch (err) {
        lastError = err;
        const code = (err as { code?: string }).code;
        // A private account or a missing one answers the same way on every
        // route; only an extraction failure is worth another.
        if (code !== 'EXTRACTOR_FAILED' && code !== 'NETWORK_ERROR') throw err;
        if (index < routes.length - 1) {
          this.options.log?.warn({ handle: profile.handle, code }, 'profile listing failed; trying another route');
        }
      }
    }
    throw lastError;
  }

  private async attempt(
    binary: string,
    profile: ProfileRef,
    limit: number,
    route: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<ProfileExpansion> {
    const args = [
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      '--no-progress',
      '--skip-download',
      // The feed is paginated and TikTok drops pages; yt-dlp's own default of
      // 3 gives up on accounts that list perfectly well on a fourth try.
      '--extractor-retries',
      '5',
      '--playlist-items',
      `1:${limit + 1}`,
      '--socket-timeout',
      '20',
      '--user-agent',
      BROWSER_USER_AGENT,
      ...route,
      ...sessionArgs({ ...this.options.session?.(), proxyUrl: this.options.proxyUrl?.() }),
      profile.profileUrl,
    ];

    const result = await this.options.runner.run(binary, args, {
      // Listing a large account is many sequential page requests, so this is
      // deliberately far longer than a single video's extraction budget.
      timeoutMs: this.options.timeoutMs ?? 5 * 60_000,
      ...(signal ? { signal } : {}),
    });

    if (result.exitCode !== 0 || result.stdout.trim() === '') {
      const classified = classifyYtDlpFailure(result);
      this.options.log?.warn(
        { handle: profile.handle, exitCode: result.exitCode, stderr: result.stderr.slice(0, 600) },
        'could not list the profile',
      );
      throw new AppError(classified.code, firstError(result.stderr) || `yt-dlp exited ${result.exitCode}`);
    }

    let payload: FlatPlaylist;
    try {
      payload = JSON.parse(result.stdout) as FlatPlaylist;
    } catch (err) {
      throw new AppError('EXTRACTOR_FAILED', 'yt-dlp returned unreadable output for this profile', { cause: err });
    }

    const urls = collectVideoUrls(payload);
    if (urls.length === 0) {
      throw new AppError('EXTRACTOR_FAILED', `no public videos were found on @${profile.handle}`);
    }

    const truncated = urls.length > limit;
    this.options.log?.info(
      { handle: profile.handle, found: urls.length, truncated },
      'listed a profile',
    );

    return { ...profile, urls: urls.slice(0, limit), truncated };
  }
}

/**
 * Takes the video links out of a flat playlist, in order, without duplicates.
 *
 * Every entry is put back through the ordinary parser rather than trusted:
 * these strings arrive from a remote response, and the canonical form is what
 * the rest of the app deduplicates and names by. An entry that does not reduce
 * to a video ID is skipped rather than queued as a link that will fail later.
 */
export function collectVideoUrls(payload: FlatPlaylist): readonly string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const entry of payload.entries ?? []) {
    // `webpage_url` is the real page; `url` can be either that or a bare ID
    // depending on which listing path yt-dlp took.
    const candidate = entry.webpage_url ?? entry.url ?? (entry.id ? `https://www.tiktok.com/@_/video/${entry.id}` : '');
    if (candidate === '') continue;

    const parsed = parse(candidate);
    if (parsed.status !== 'resolved') continue;
    if (seen.has(parsed.awemeId)) continue;
    seen.add(parsed.awemeId);
    urls.push(parsed.canonicalUrl);
  }

  return urls;
}

function firstError(stderr: string): string {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^ERROR[:\s]/i.test(l));
  return truncate((line ?? '').replace(/^ERROR:\s*/i, ''), 300);
}

function truncate(value: string, max = 120): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}
