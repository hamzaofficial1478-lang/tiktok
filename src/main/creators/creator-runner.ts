import type { Logger } from 'pino';
import { parse } from '@shared/url-parse';
import type { CreatorRow, CreatorsRepository } from '../db/repositories/creators';
import type { LinkLedgerRepository } from '../db/repositories/link-ledger';
import type { ProfileExpander } from '../resolve/profile-expander';
import type { QueueEngine } from '../queue/queue-engine';

/**
 * Running the saved creator list.
 *
 * One account at a time, in the order they were added: list it, take the
 * newest videos that have not already been downloaded, queue them into a
 * folder of that account's name, wait for them to finish, then start the next.
 *
 * Sequential on purpose, and not as a simplification. Interleaving ten
 * accounts would mean ten folders filling at once, a progress list nobody can
 * read, and ten times the concurrent load on TikTok from one machine — which
 * is the pattern that gets a client throttled. Finishing one account before
 * starting the next is also the only ordering that makes "downloaded 3 of 5
 * from @creator" a sentence with a clear meaning at any moment.
 */

export interface CreatorRunProgress {
  readonly creatorId: number;
  readonly handle: string;
  readonly phase: 'listing' | 'queued' | 'downloading' | 'done' | 'failed' | 'nothing-new';
  /** How many links were queued for this account this run. */
  readonly queued: number;
  /** Position in the run, 1-based, and how many accounts the run covers. */
  readonly index: number;
  readonly total: number;
  readonly message?: string;
}

export interface CreatorRunnerOptions {
  readonly creators: CreatorsRepository;
  /**
   * What has already been settled, by TikTok's id.
   *
   * This replaced a downloads-table lookup that required the file to still be
   * at the exact path it was written to. That made "have I taken this?" a
   * question about the filesystem rather than about the video: rename it and
   * the account re-downloaded from the top.
   */
  readonly ledger: LinkLedgerRepository;
  readonly profiles: ProfileExpander;
  readonly queue: QueueEngine;
  readonly onProgress?: (progress: CreatorRunProgress) => void;
  readonly log?: Logger;
}

/**
 * Chooses which of an account's videos to take.
 *
 * Newest first — TikTok lists them that way and it is the order people mean by
 * "the latest 5" — and anything already settled is passed over rather than
 * counted. That distinction is the whole point of the count: asking for 5 from
 * an account you have taken 20 from before should give 5 new videos, not 5
 * attempts that all resolve to duplicates and produce nothing.
 *
 * "Settled" covers a slideshow that was declined and a post with no video in
 * it as well as a finished download, because all three are questions that have
 * already been answered and re-asking them on every run is exactly the noise
 * this is meant to remove.
 */
export function selectNewVideos(
  urls: readonly string[],
  limit: number,
  alreadyHave: (awemeId: string) => boolean,
): { readonly urls: readonly string[]; readonly skipped: number } {
  const picked: string[] = [];
  let skipped = 0;

  for (const url of urls) {
    if (picked.length >= limit) break;

    const parsed = parse(url);
    // An unparseable entry is not a video we can claim to have; it is dropped
    // rather than counted against the limit.
    if (parsed.status !== 'resolved') continue;

    if (alreadyHave(parsed.awemeId)) {
      skipped++;
      continue;
    }
    picked.push(parsed.canonicalUrl);
  }

  return { urls: picked, skipped };
}

export class CreatorRunner {
  private running = false;
  private cancelled = false;

  constructor(private readonly options: CreatorRunnerOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Works through every enabled account in order.
   *
   * Guarded against a second concurrent run: two of these interleaving would
   * defeat the sequencing the whole class exists for.
   */
  async run(): Promise<{ queued: number; creators: number }> {
    if (this.running) return { queued: 0, creators: 0 };
    this.running = true;
    this.cancelled = false;

    const list = this.options.creators.list().filter((row) => row.enabled === 1);
    let totalQueued = 0;

    try {
      for (const [index, creator] of list.entries()) {
        if (this.cancelled) break;
        totalQueued += await this.runOne(creator, index + 1, list.length);
      }
      return { queued: totalQueued, creators: list.length };
    } finally {
      this.running = false;
    }
  }

  private async runOne(creator: CreatorRow, index: number, total: number): Promise<number> {
    const report = (progress: Omit<CreatorRunProgress, 'creatorId' | 'handle' | 'index' | 'total'>): void =>
      this.options.onProgress?.({ creatorId: creator.id, handle: creator.handle, index, total, ...progress });

    report({ phase: 'listing', queued: 0 });

    let listed: readonly string[];
    try {
      const expansion = await this.options.profiles.expand(creator.profile_url);
      listed = expansion.urls;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.options.log?.warn({ handle: creator.handle, err: message }, 'could not list a saved creator');
      report({ phase: 'failed', queued: 0, message });
      // One unreachable account does not stop the other nine.
      return 0;
    }

    const { urls, skipped } = selectNewVideos(listed, creator.video_limit, (awemeId) =>
      this.options.ledger.isSettled(awemeId),
    );

    if (urls.length === 0) {
      report({
        phase: 'nothing-new',
        queued: 0,
        message:
          skipped > 0
            ? `every one of the newest ${skipped} is already downloaded`
            : 'this account has no videos to take',
      });
      this.options.creators.recordRun(creator.id, 0);
      return 0;
    }

    /**
     * The handle is the folder name, and the account's caption choice travels
     * with the links.
     *
     * That second argument is the fix for a setting that saved, displayed and
     * did nothing: `caption_mode` has been on the creators table since it was
     * added, and nothing ever read it. Null still means "follow the app
     * setting", so a creator with no override behaves exactly as before.
     */
    const result = this.options.queue.addLinks(urls, undefined, creator.handle, creator.caption_mode);
    this.options.creators.recordRun(creator.id, result.added);
    report({ phase: 'queued', queued: result.added });

    if (result.added > 0) {
      this.options.queue.start();
      report({ phase: 'downloading', queued: result.added });
      /**
       * Waiting here is what makes the run sequential.
       *
       * `whenIdle` resolves when the queue has nothing left in flight, which
       * for a queue fed one account at a time means that account is finished.
       */
      await this.options.queue.whenIdle();
    }

    report({ phase: 'done', queued: result.added });
    return result.added;
  }
}
