import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError, describeError, toAppError, type ErrorCode } from '@shared/errors';
import type { AppConfig } from '@shared/config-schema';
import type { DuplicateAction, PhotoAction } from '@shared/types';
import type { QueueItemRow, QueueItemsRepository } from '../db/repositories/queue-items';
import type { VideosRepository } from '../db/repositories/videos';
import type { DownloadsRepository } from '../db/repositories/downloads';
import type { LinkLedgerRepository } from '../db/repositories/link-ledger';
import type { UrlNormalizer } from '../resolve/url-normalizer';
import type { Extractor, NormalizedUrl, ResolvedVideo } from '../resolve/types';
import { buildCanonicalUrl } from '@shared/url-parse';
import type { Clock } from '../clock';
import { RateLimiter } from './rate-limiter';
import { decideRetry, MAX_RETRIES } from './retry-policy';
import { checkDuplicate, checkRepost, dedupePaste } from './dedup';
import type { PipelineStage, StageState } from '@shared/stages';
import {
  readLookupCache,
  readResumeState,
  toSnapshot,
  type LookupCache,
  type ResumeState,
  type AddLinksResult,
  type BatchSummary,
  type MediaPipeline,
  type PendingDuplicate,
  type PendingPhotoPost,
  type PipelineProgress,
  type QueueEvent,
  type QueueItemSnapshot,
} from './types';

export interface QueueEngineOptions {
  readonly queueItems: QueueItemsRepository;
  readonly videos: VideosRepository;
  readonly downloads: DownloadsRepository;
  /**
   * The record of what has been settled, by TikTok's id.
   *
   * Optional so the existing fixtures and the CLI harness keep working, but the
   * real app always supplies it: without it, "have I taken this?" falls back to
   * asking the filesystem, which is the question that got renaming a file
   * wrong.
   */
  readonly ledger?: LinkLedgerRepository;
  readonly normalizer: UrlNormalizer;
  readonly extractor: Extractor;
  readonly pipeline: MediaPipeline;
  readonly rateLimiter: RateLimiter;
  readonly clock: Clock;
  /** Read live, so concurrency and rate limits change without a restart. */
  readonly config: () => AppConfig;
  readonly log: Logger;
  readonly fileExists?: (path: string) => boolean;
  readonly random?: () => number;
  readonly progressThrottleMs?: number;
  /**
   * How often progress is *written to SQLite*, as opposed to pushed to the
   * screen. Far larger than the emit throttle on purpose — see `onProgress`.
   */
  readonly progressPersistMs?: number;
  /**
   * Persists whether the queue is meant to be running, so an unexpected exit
   * does not turn into a queue that quietly sits idle on next launch.
   */
  readonly onRunStateChanged?: (running: boolean) => void;
  /**
   * How long one item may hold a worker before it is failed and requeued.
   *
   * Injectable so tests can assert the behaviour in milliseconds rather than
   * sitting through it. Defaults to `ITEM_DEADLINE_MS`.
   */
  readonly itemDeadlineMs?: number;
  /** Move on if a transfer stops advancing, even while yt-dlp prints retries. */
  readonly downloadStallMs?: number;
  /**
   * The total across every attempt. Injectable for the same reason.
   * Defaults to `ITEM_TOTAL_BUDGET_MS`.
   */
  readonly itemTotalBudgetMs?: number;
  /** The ceiling on local ffmpeg work. Defaults to `PROCESSING_DEADLINE_MS`. */
  readonly processingDeadlineMs?: number;
  /**
   * Several links in a row failed in a way that points at the extractor rather
   * than at the links.
   *
   * yt-dlp is a moving target against a site that changes without notice, and
   * a build that worked last week can fail on everything this week. The
   * start-up check only looks when the installed build is over a week old,
   * which is exactly the case this misses: a build four days old that TikTok
   * has already broken. Failing links are the best available evidence that the
   * extractor needs replacing *now*, so the queue reports them and lets
   * whoever owns updating decide.
   */
  readonly onExtractorSuspect?: (info: { failures: number; lastCode: ErrorCode }) => void;
}

/**
 * The ceiling on a single item, chosen from what the steps under it can
 * legitimately need.
 *
 * Resolution is seconds. A TikTok video is rarely over 100 MB, so even a slow
 * connection has it inside a couple of minutes. Post-processing is the long
 * pole — removing a watermark re-encodes the video, and burning in captions
 * transcribes it first — which is why this is generous rather than tight.
 *
 * What it is not is a performance setting. It is the promise that one bad
 * link cannot take the afternoon: past this point the item has stopped being
 * a download and started being a blockage.
 */
export const ITEM_DEADLINE_MS = 8 * 60_000;

/**
 * The total one video may cost the queue, across every attempt it gets.
 *
 * This is the number that answers "and then what happens when the queue
 * reaches the failures?". Attempts are capped individually by
 * `ITEM_DEADLINE_MS`, but four automatic attempts plus the end-of-run sweep is
 * five of them, and five capped attempts still add up to most of an hour on a
 * single link. This makes the guarantee whole: a video that has spent this
 * long is set aside, and the queue moves on to the next one for good.
 *
 * Set aside, not thrown away. The row stays, with what happened on it, and
 * pressing Retry gives it a fresh budget — because a person asking again is
 * usually a person who has changed something.
 */
export const ITEM_TOTAL_BUDGET_MS = 15 * 60_000;

/**
 * The ceiling on the local half — everything after the bytes have landed.
 *
 * Separate from the download's because the work is nothing like it. Removing a
 * watermark re-encodes the video and burning in captions transcribes it first;
 * on a slow or memory-starved machine either can genuinely take minutes, and
 * holding them to a network timeout would fail downloads that were working.
 *
 * What it must not be is absent, which is what it was. Each subprocess has its
 * own timeout, and that reasoning is precisely what left the gap: fifteen
 * minutes for a re-encode plus fifteen for captions plus thirty for a
 * transcription is an hour of ceilings that never sum to one, and any step
 * added later starts with none at all. This is the number that covers the lot.
 */
export const PROCESSING_DEADLINE_MS = 20 * 60_000;

/**
 * Failures in a row that mean "the extractor is broken", not "those links were
 * bad".
 *
 * Three, because one is a link and two is a coincidence. These codes are the
 * ones TikTok changing its site produces — a page that no longer parses, an
 * endpoint that no longer answers — as opposed to a deleted or private video,
 * which is about that video and says nothing about the extractor.
 */
export const EXTRACTOR_SUSPECT_THRESHOLD = 3;

/**
 * The shortest window an attempt that is started is ever given.
 *
 * An attempt with no time left used to be armed with a one-millisecond
 * watchdog, which fired before it had done anything and killed the first
 * process it spawned. What reached the user was "yt-dlp.exe was stopped before
 * it finished" on every row — a message that reads as a broken program or as
 * something they did, and is neither.
 *
 * If an item is out of budget the honest response is to say so and stop
 * retrying it, which `handleFailure` does. Starting an attempt and shooting it
 * a millisecond later is not a limit, it is a misleading way to fail.
 */
export const MIN_ATTEMPT_MS = 60_000;

/**
 * How long a lookup TikTok already answered stays usable as a fallback.
 *
 * The metadata in it — duration, handle, caption — would stay true for as long
 * as the video exists. The stream URLs would not: TikTok signs them and they
 * expire, so an old answer trades a lookup failure for a download failure,
 * which is no better and reads worse. Half an hour is comfortably inside their
 * life and comfortably longer than a retry ladder.
 *
 * This bound does not apply to a *resuming* item. That one has its bytes
 * already and no transfer left to do, so nothing in the answer can go stale in
 * a way that matters.
 */
export const LOOKUP_CACHE_TTL_MS = 30 * 60_000;

/**
 * Lookup failures a recent cached answer may stand in for.
 *
 * All four are about the request rather than the video: TikTok refusing a
 * request it decided was automated, a connection that dropped, an extractor
 * that could not parse the page it was served, a rate limit. None of them is a
 * statement that the video changed.
 *
 * Deliberately not here: VIDEO_DELETED, VIDEO_PRIVATE, REGION_BLOCKED,
 * AGE_RESTRICTED, UNSUPPORTED_MEDIA and CANCELLED. Those are verdicts, and
 * answering a verdict with an answer from before it was handed down would have
 * the app cheerfully download a video that has since been taken down.
 */
export const LOOKUP_FALLBACK_CODES: readonly ErrorCode[] = [
  'RESOLVE_FAILED',
  'NETWORK_ERROR',
  'EXTRACTOR_FAILED',
  'RATE_LIMITED',
];
const EXTRACTOR_SUSPECT_CODES: readonly ErrorCode[] = ['EXTRACTOR_FAILED', 'RESOLVE_FAILED', 'CDN_FORBIDDEN'];

/**
 * The queue engine — spec section 8.
 *
 * Three properties define it, and each is load-bearing:
 *
 *  1. Ordering is a hard guarantee. Items are claimed by lowest `position` in
 *     a single atomic UPDATE…RETURNING, so at concurrency 1 processing order
 *     is exactly insertion order, and at higher concurrency items still
 *     *start* in order.
 *
 *  2. A duplicate question never stalls the queue. Layer 3 parks its item in
 *     `awaiting_user` and returns the worker immediately; the engine moves on
 *     to the next item and several questions can be outstanding at once. The
 *     brief calls the alternative a product defect, and it would be: a modal
 *     that halts a 200-item batch while the user is away from their desk.
 *
 *  3. Nothing is lost to a crash. Every transition is persisted, and a retry
 *     backoff is a scheduled requeue rather than a worker sleeping on a slot.
 */
export class QueueEngine {
  private running = false;
  private paused = false;
  private suspending = false;
  /**
   * True while in-flight work is being aborted for a reason that is not the
   * user abandoning it — a system suspend, or the app being quit mid-batch.
   *
   * The distinction matters because both look identical from a worker's catch
   * block: an aborted download throws CANCELLED either way. Without this, a
   * download interrupted by closing the app was recorded as "cancelled", which
   * is a finished state — so the next launch resumed the queue and skipped
   * straight past the item that had been running, and its half-finished `.part`
   * sat there forever. Parking puts it back to `queued` instead, keeping its
   * position and its `.part`, so the next launch carries on from where it was.
   */
  private parking = false;
  private activeWorkers = 0;

  private readonly controllers = new Map<number, AbortController>();
  private readonly retryTimers = new Map<number, AbortController>();
  /**
   * When each waiting item's next attempt is due, so the row can say so.
   *
   * In memory only, and correctly so: a restart requeues retryable failures
   * outright rather than resuming a countdown, so a persisted time would
   * describe an attempt that is never going to happen at it.
   */
  private readonly nextAttempts = new Map<number, number>();
  /**
   * Items the user actually asked to cancel, so parking can tell them apart
   * from the ones it aborted itself. Consumed by the worker's failure path.
   */
  private readonly cancelledByUser = new Set<number>();
  /**
   * Items aborted by the watchdog rather than by a person, so the failure path
   * can record a timeout it should retry instead of a cancel it must not.
   */
  private readonly timedOut = new Set<number>();
  /**
   * How long the running attempt was actually given, by item id.
   *
   * So the failure can say what happened rather than quoting the ceiling: an
   * item near the end of its budget gets a shorter window than the per-attempt
   * limit, and telling it "gave up after 8 minutes" when it gave up after 90
   * seconds is the kind of small lie that sends someone looking in the wrong
   * place.
   */
  private readonly allowances = new Map<number, number>();
  /** Consecutive failures that look like the extractor rather than the link. */
  private extractorFailures = 0;
  /** Cancels the per-item time limit, by item id. See `armWatchdog`. */
  private readonly watchdogs = new Map<number, () => void>();
  /** Items past the download and into local ffmpeg work; see beginProcessingPhase. */
  private readonly processing = new Set<number>();
  private readonly transferActivity = new Map<number, { at: number; bytes: number }>();
  private readonly pendingDuplicates = new Map<number, PendingDuplicate>();
  /** Slideshow questions waiting on an answer, and the answers already given. */
  private readonly pendingPhotos = new Map<number, PendingPhotoPost>();
  private readonly photoChoices = new Map<number, PhotoAction>();
  private readonly photoBatchChoices = new Map<string, PhotoAction>();
  /**
   * "Apply to all remaining duplicates in this batch" — batch-scoped and
   * in-memory only. Section 7: never permanent, never across batches.
   */
  private readonly batchChoices = new Map<string, DuplicateAction>();
  /**
   * Batches whose failures have already had their end-of-run second chance.
   *
   * In-memory and batch-scoped, like `batchChoices`: the sweep is "before I
   * tell you this run is finished, try the failures once more", not a policy
   * that should survive a restart and re-run yesterday's failures.
   */
  private readonly sweptBatches = new Set<string>();
  private readonly listeners = new Set<(event: QueueEvent) => void>();
  private readonly lastProgressEmit = new Map<number, number>();
  /** When each item's progress last reached the database, as opposed to the screen. */
  private readonly lastProgressWrite = new Map<number, number>();
  private idleWaiters: (() => void)[] = [];
  private readonly knownBatches = new Set<string>();

  constructor(private readonly options: QueueEngineOptions) {}

  private get log(): Logger {
    return this.options.log;
  }

  private get fileExists(): (path: string) => boolean {
    return this.options.fileExists ?? existsSync;
  }

  private get random(): () => number {
    return this.options.random ?? Math.random;
  }

  /* ---------------------------------------------------------------- *
   * Subscription
   * ---------------------------------------------------------------- */

  subscribe(listener: (event: QueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: QueueEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.warn({ err: String(err) }, 'queue event listener threw');
      }
    }
  }

  private emitItem(row: QueueItemRow | undefined): void {
    if (row) this.emit({ type: 'item-updated', item: toSnapshot(row, this.nextAttempts.get(row.id) ?? null) });
  }

  /* ---------------------------------------------------------------- *
   * Adding links — dedup layer 1, and layer 2 where the ID is known
   * ---------------------------------------------------------------- */

  /**
   * @param outputSubdir Folder under the output directory these belong in.
   *   Set when a whole account was queued from a profile link, so its videos
   *   are filed together instead of landing loose among everything else.
   */
  addLinks(
    rawUrls: readonly string[],
    batchId: string = randomUUID(),
    outputSubdir: string | null = null,
    captionMode: string | null = null,
  ): AddLinksResult {
    const paste = dedupePaste(rawUrls, (input) => this.options.normalizer.parse(input));

    // Layer 2 at add time for links whose ID is knowable without a network
    // call, so "Already in queue" surfaces immediately rather than after the
    // item works its way to the front.
    const toEnqueue: { rawUrl: string; canonicalUrl: string | null; awemeId: string | null }[] = [];
    let alreadyInQueue = 0;

    for (const entry of paste.unique) {
      if (entry.parsed.status === 'resolved') {
        const active = this.options.queueItems.findActiveByAwemeId(entry.parsed.awemeId);
        if (active) {
          alreadyInQueue++;
          continue;
        }
        toEnqueue.push({
          rawUrl: entry.rawUrl,
          canonicalUrl: entry.parsed.canonicalUrl,
          awemeId: entry.parsed.awemeId,
        });
      } else {
        // A short link: its ID is unknown until the worker resolves it, so
        // layer 2 runs again there.
        toEnqueue.push({ rawUrl: entry.rawUrl, canonicalUrl: null, awemeId: null });
      }
    }

    const rows = this.options.queueItems.enqueue(
      toEnqueue.map((item) => ({ ...item, batchId, outputSubdir, captionMode })),
      this.options.clock.now(),
    );
    if (rows.length > 0) this.knownBatches.add(batchId);

    const result: AddLinksResult = {
      batchId,
      added: rows.length,
      duplicatesRemoved: paste.duplicatesRemoved,
      alreadyInQueue,
      invalid: paste.invalid,
      totalFound: paste.totalFound,
    };

    this.log.info({ ...result, invalid: paste.invalid.length }, 'links added');
    this.emit({ type: 'items-added', batchId, items: rows.map(toSnapshot) });
    this.pump();
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.options.onRunStateChanged?.(true);
    this.emitState();
    this.pump();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.options.onRunStateChanged?.(false);
    this.emitState();
    this.log.info('queue paused');
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    // Do not serve a rate-limit debt accrued while paused.
    this.options.rateLimiter.reset();
    this.options.onRunStateChanged?.(true);
    this.emitState();
    this.pump();
  }

  /**
   * Stops claiming and cancels everything in flight.
   *
   * `keepRunState` is set when the process is going down rather than the user
   * stopping: quitting mid-batch must not be recorded as "the user paused", or
   * the next launch would sit idle instead of carrying on. It also parks
   * whatever was downloading back into the queue rather than cancelling it —
   * closing the app is not a decision to abandon the video that happened to be
   * in flight at the time.
   */
  async stop(options: { keepRunState?: boolean } = {}): Promise<void> {
    if (!options.keepRunState) this.options.onRunStateChanged?.(false);
    if (options.keepRunState) this.parking = true;
    this.running = false;
    for (const [itemId, controller] of this.controllers) {
      // A stop the user asked for really does cancel what is in flight; only
      // the shutdown variant above parks. Saying so explicitly is what lets an
      // abort with no recorded reason be treated as a fault rather than as an
      // intention — see handleFailure.
      if (!options.keepRunState) this.cancelledByUser.add(itemId);
      controller.abort();
    }
    for (const controller of this.retryTimers.values()) controller.abort();
    this.retryTimers.clear();
    try {
      await this.whenIdle();
    } finally {
      this.parking = false;
    }
    this.emitState();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** True when there is work the next launch should pick straight back up. */
  hasPendingWork(): boolean {
    return this.options.queueItems.nextQueued() !== undefined;
  }

  /**
   * The machine is going to sleep.
   *
   * In-flight sockets do not survive a suspend, so anything downloading is
   * aborted and put back to `queued` rather than left to hang on a dead
   * connection until a timeout eventually fires. Its `.part` is untouched, so
   * the resumed download continues from where it stopped rather than
   * restarting — the same mechanism crash recovery uses.
   */
  async suspend(): Promise<void> {
    if (!this.running) return;
    this.log.info({ active: this.activeWorkers }, 'system suspending; parking in-flight downloads');
    this.suspending = true;
    this.parking = true;
    this.paused = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const controller of this.retryTimers.values()) controller.abort();
    this.retryTimers.clear();
    await this.whenIdle();
    this.emitState();
  }

  /** The machine woke up: carry on from exactly where the queue stopped. */
  resumeFromSuspend(): void {
    if (!this.suspending) return;
    this.suspending = false;
    this.parking = false;
    this.paused = false;
    this.options.rateLimiter.reset();
    this.log.info('system resumed; continuing the queue');
    this.emitState();
    this.pump();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get activeCount(): number {
    return this.activeWorkers;
  }

  private emitState(): void {
    this.emit({ type: 'queue-state', running: this.running, paused: this.paused, active: this.activeWorkers });
  }

  /**
   * Resolves once nothing is in flight, queued, or waiting on a retry timer.
   *
   * Items in `awaiting_user` deliberately do not count: a queue with unanswered
   * duplicate questions and no work left really is idle, and treating it
   * otherwise would hang every test of the non-blocking behaviour.
   */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    if (this.activeWorkers > 0) return false;
    if (this.retryTimers.size > 0) return false;
    // A stopped or paused engine is idle by definition: queued items exist but
    // nothing will ever claim them, so waiting on them would hang forever.
    if (!this.running || this.paused) return true;
    return this.options.queueItems.nextQueued() === undefined;
  }

  private settleIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /* ---------------------------------------------------------------- *
   * Worker pump
   * ---------------------------------------------------------------- */

  private pump(): void {
    if (!this.running || this.paused) {
      this.settleIdle();
      return;
    }

    const concurrency = Math.max(1, Math.min(4, this.options.config().concurrency));
    while (this.activeWorkers < concurrency && this.options.queueItems.nextQueued() !== undefined) {
      this.activeWorkers++;
      // claimNext runs synchronously inside runWorker before its first await,
      // so workers spawned in this loop claim distinct rows in position order.
      void this.runWorker().finally(() => {
        this.activeWorkers--;
        if (this.running && !this.paused) this.pump();
        else this.settleIdle();
      });
    }

    this.settleIdle();
  }

  private async runWorker(): Promise<void> {
    const row = this.options.queueItems.claimNext(this.options.clock.now());
    if (!row) return;
    this.emitItem(row);

    const controller = new AbortController();
    this.controllers.set(row.id, controller);
    this.watchdogs.set(row.id, this.armWatchdog(row.id, controller, this.itemDeadlineMs, 'download'));

    const stallMs = this.options.downloadStallMs ?? 90_000;
    const stallTimer = setInterval(() => {
      const activity = this.transferActivity.get(row.id);
      if (!activity || controller.signal.aborted || Date.now() - activity.at < stallMs) return;
      this.allowances.set(row.id, stallMs);
      this.timedOut.add(row.id);
      controller.abort();
    }, Math.min(1_000, stallMs));
    stallTimer.unref?.();
    let onAbort = (): void => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new AppError('CANCELLED', 'Download stopped.'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      // A dependency may ignore AbortSignal. The worker must still be freed;
      // processItem checks the signal before accepting any late result.
      await Promise.race([this.processItem(row, controller.signal), aborted]);
    } catch (err) {
      // Charged before the decision, not after it, so "has this video used its
      // budget?" is asked with this attempt included. Disarming twice is a
      // no-op; the finally below covers the path that succeeded.
      this.disarmWatchdog(row.id);
      this.handleFailure(row, err);
    } finally {
      clearInterval(stallTimer);
      controller.signal.removeEventListener('abort', onAbort);
      this.transferActivity.delete(row.id);
      this.disarmWatchdog(row.id);
      this.controllers.delete(row.id);
      // Whether or not the failure path consumed it — an item that finished
      // just as the cancel arrived never reaches that branch.
      this.cancelledByUser.delete(row.id);
      this.timedOut.delete(row.id);
      this.allowances.delete(row.id);
      this.processing.delete(row.id);
      this.lastProgressEmit.delete(row.id);
      this.lastProgressWrite.delete(row.id);
      this.checkBatchComplete(row.batch_id);
    }
  }

  /**
   * A ceiling on how long an item may spend talking to TikTok — this attempt,
   * and across every attempt it will ever get.
   *
   * Nothing above this enforced one. Resolution tries three routes, the
   * download then tries the same three, and each of those was allowed twenty
   * minutes on its own — so a link that hung rather than failed could occupy
   * the single default worker for over an hour per attempt, and for hours
   * across its four attempts, while the rest of the batch waited behind it
   * with nothing wrong. The user watched the same row sit there all afternoon.
   *
   * ## Why a per-attempt limit is not enough on its own
   *
   * Moving retries behind the untried links bought the batch its healthy
   * downloads first, and then the queue arrived at the failures and sat on them
   * exactly as before. Four automatic attempts plus the end-of-run sweep is
   * five, and five attempts at a per-attempt limit still add up to most of an
   * hour on one link — with several bad links, most of an afternoon. Capping
   * the attempt only decides how the hour is divided.
   *
   * So the real limit is a total: `busy_ms` on the row records what this video
   * has already cost, this attempt gets whatever is left of the budget, and
   * when the budget is gone the item stops being retried automatically. That
   * is a promise about the queue rather than about one download — no single
   * video can take more than `ITEM_TOTAL_BUDGET_MS` of it, however many
   * attempts that turns out to be.
   *
   * Measuring time rather than counting attempts is the point. A link that
   * fails in two seconds costs almost nothing and keeps every retry it is
   * entitled to, which is exactly right — those are the ones a retry fixes. A
   * link that hangs burns its budget in one or two goes and is set aside.
   *
   * ## What is counted
   *
   * Only the part that talks to the network. The watchdog is disarmed once the
   * download is done and post-processing begins, and that boundary matters:
   * removing a watermark re-encodes the video and burning in captions
   * transcribes it first, both legitimately slow on a long video and both work
   * the user asked for. Cutting one short would fail a download that was
   * working perfectly, and fail it again on every retry.
   *
   * Expiry is deliberately not a cancel — while budget remains, the item is
   * failed as a timeout, which is retryable, so it is tried again after the
   * links that are working.
   *
   * Timed with a real timer rather than the injected clock, deliberately. The
   * clock exists so tests can skip a 30-second retry backoff instantly, and a
   * deadline that also elapses instantly would abort every item the moment it
   * started. Tests set a short `itemDeadlineMs` and wait for it instead.
   */
  private armWatchdog(
    itemId: number,
    controller: AbortController,
    limitMs: number,
    phase: 'download' | 'post-processing',
  ): () => void {
    const spent = this.options.queueItems.findById(itemId)?.busy_ms ?? 0;

    /**
     * The window this attempt gets, and the floor under it.
     *
     * `itemTotalBudgetMs - spent` alone could be zero or negative, and the old
     * code turned that into `Math.max(1, …)` — a **one millisecond** watchdog.
     * It fired before the attempt had done anything, killing the first process
     * it spawned, and the file that reached the user said "yt-dlp.exe was
     * stopped before it finished". That reads as a broken program, or as
     * something the user did, and it is neither: it is the app arming a timer
     * it already knew would fire.
     *
     * Every attempt that is started gets a real chance. Whether there is
     * another one after it is decided honestly, once, in `handleFailure` —
     * where the budget is checked and the row is told plainly that it has been
     * set aside.
     */
    const remaining = this.itemTotalBudgetMs - spent;
    // The floor lifts what is left of the budget; the per-attempt limit still
    // caps it, so this can only ever grant a longer window than the old
    // arithmetic, never a longer one than the phase is entitled to.
    const allowed = phase === 'post-processing' ? limitMs :
      Math.max(1, Math.min(limitMs, Math.max(MIN_ATTEMPT_MS, remaining)));
    const startedAt = Date.now();
    this.allowances.set(itemId, allowed);

    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      this.log.warn(
        { itemId, phase, afterMs: allowed, alreadySpentMs: spent },
        'item exceeded its time limit; failing it so the queue can move on',
      );
      this.timedOut.add(itemId);
      controller.abort();
    }, allowed);

    // Never a reason to keep the process alive on its own.
    timer.unref?.();

    return () => {
      clearTimeout(timer);
      /**
       * Only the network phase is charged, which is what the budget is for.
       *
       * This is stated in the migration that introduced the column — "Only the
       * part that talks to TikTok is counted. Re-encoding to strip a watermark
       * and transcribing for burned-in captions are legitimately slow and are
       * work the user asked for, not a video misbehaving" — and the code did
       * the opposite: it charged every millisecond of both phases.
       *
       * That was survivable while post-processing was a rare watermark
       * re-encode. It stopped being survivable the moment colour correction,
       * sharpening and the H.264 conversion started running on *every* video:
       * four minutes of ffmpeg per attempt, charged to a fifteen-minute budget
       * meant for a link that hangs. Two or three attempts and a perfectly
       * healthy video is over its limit — after which the watchdog kills it the
       * instant it starts and the queue writes it off for good.
       *
       * That is the whole of "it works for two or three days and then every
       * download fails": nothing breaks, a counter fills up.
       *
       * Wall-clock rather than the injected clock, because this is a real
       * duration against a real budget and a test clock that never advances
       * would hand every item an unlimited one.
       */
      if (phase === 'download') this.options.queueItems.addBusyMs(itemId, Date.now() - startedAt);
    };
  }

  private disarmWatchdog(itemId: number): void {
    this.watchdogs.get(itemId)?.();
    this.watchdogs.delete(itemId);
  }

  /**
   * The bytes are in; from here on it is local ffmpeg work — under a new
   * ceiling, not under none.
   *
   * The download limit used to be switched *off* at this point, and that was a
   * hole big enough to drive the whole complaint through. Removing a watermark
   * re-encodes the video and burning in captions transcribes it first, both
   * legitimately slow, so the download's own limit is the wrong one to hold
   * them to — but "the wrong limit" was replaced with no limit at all. Past
   * this line an item could sit forever, and forever is what it did: a queue
   * apparently stuck on one download that never moved and never failed, with
   * nothing to cancel it but a person.
   *
   * The subprocesses each have their own timeouts, which is exactly the
   * reasoning that produced the hole — a ceiling made of other people's
   * ceilings holds only while every one of them is right, and they add up:
   * fifteen minutes for a re-encode, fifteen for captions, thirty for a
   * transcription, in sequence, on a machine that may be swapping. This is one
   * number covering all of it.
   *
   * The time is charged to the item's budget like any other, so a video whose
   * processing hangs is set aside after its first go rather than hanging again
   * on every retry.
   */
  private beginProcessingPhase(itemId: number): void {
    // Progress can report `processing` many times; the phase begins once.
    if (this.processing.has(itemId)) return;
    this.processing.add(itemId);
    this.transferActivity.delete(itemId);

    const controller = this.controllers.get(itemId);
    if (!controller) return;

    // Closes out the network phase, charging what it spent, before the new
    // ceiling starts counting.
    this.disarmWatchdog(itemId);
    this.watchdogs.set(itemId, this.armWatchdog(itemId, controller, this.processingDeadlineMs, 'post-processing'));
  }

  private get processingDeadlineMs(): number {
    return this.options.processingDeadlineMs ?? PROCESSING_DEADLINE_MS;
  }

  private get itemTotalBudgetMs(): number {
    return this.options.itemTotalBudgetMs ?? ITEM_TOTAL_BUDGET_MS;
  }

  private get itemDeadlineMs(): number {
    return this.options.itemDeadlineMs ?? ITEM_DEADLINE_MS;
  }

  /**
   * Keeps a running count of failures that look like the extractor's fault.
   *
   * The signal is a *streak*: any download that succeeds proves the extractor
   * works, so the count goes back to zero. A private video or a deleted one
   * neither raises nor clears it — those say nothing either way, and treating
   * them as evidence in either direction would make the count noise.
   *
   * Raised once per streak. Reporting it on every subsequent failure would
   * fire an update check per item for the rest of a broken batch.
   */
  private noteExtractorEvidence(code: ErrorCode): void {
    if (!EXTRACTOR_SUSPECT_CODES.includes(code)) return;

    this.extractorFailures++;
    if (this.extractorFailures !== EXTRACTOR_SUSPECT_THRESHOLD) return;

    this.log.warn(
      { failures: this.extractorFailures, lastCode: code },
      'several links in a row failed the same way; the extractor is the likely cause',
    );
    try {
      this.options.onExtractorSuspect?.({ failures: this.extractorFailures, lastCode: code });
    } catch (err) {
      this.log.warn({ err: String(err) }, 'the extractor-suspect handler threw');
    }
  }

  /** A download that worked is proof the extractor is fine. */
  private clearExtractorEvidence(): void {
    this.extractorFailures = 0;
  }

  /* ---------------------------------------------------------------- *
   * The per-item pipeline
   * ---------------------------------------------------------------- */

  private async processItem(row: QueueItemRow, signal: AbortSignal): Promise<void> {
    this.log.debug({ itemId: row.id }, 'resolving the link');

    /**
     * Work a previous attempt banked, if there was one.
     *
     * Its presence changes what this whole method does. The video is already on
     * disk under its final name, so the duplicate layers below must not run:
     * every one of them would find this item's *own* file and conclude that
     * somebody had already downloaded it — parking the item on a question about
     * itself, or skipping it and leaving the half-finished work half-finished
     * forever.
     */
    const resume = readResumeState(row.resume_state);
    const resuming = resume !== null && this.fileExists(resume.filePath);
    if (resume && !resuming) {
      this.log.warn(
        { itemId: row.id, filePath: resume.filePath },
        'the file the last attempt left is no longer there; this one starts from the link',
      );
      this.update(row.id, { resumeState: null });
    }

    /**
     * The details TikTok gave a previous attempt.
     *
     * Read before the lookup rather than after it, because for a resuming item
     * it replaces the lookup entirely. The video is already downloaded and
     * every step it has left is local ffmpeg work, so asking TikTok again buys
     * nothing — and it is the request TikTok is most likely to refuse. An item
     * that had got its bytes and then fell over used to die on that refusal,
     * leaving the video in the output folder unprocessed for good.
     */
    const cached = readLookupCache(row.lookup);

    this.noteStage(row.id, 'resolve', 'started');

    let normalized: NormalizedUrl;
    let alreadyResolved: ResolvedVideo | undefined;

    if (resuming && cached) {
      normalized = cached.normalized;
      alreadyResolved = cached.resolved;
      this.noteStage(row.id, 'resolve', 'skipped');
      this.log.info(
        { itemId: row.id, awemeId: normalized.awemeId },
        'the video is already downloaded; carrying on with the details from the attempt that fetched it',
      );
    } else {
      const looked = await this.lookUp(row, signal, cached);
      normalized = looked.normalized;
      alreadyResolved = looked.resolved;
      this.noteStage(row.id, 'resolve', 'done');
      this.log.info(
        { itemId: row.id, awemeId: normalized.awemeId, viaShortLink: normalized.viaShortLink },
        'link resolved',
      );
    }

    // Written before anything can throw, so a link that turns out to be
    // undownloadable still leaves its id on the row — which is what the ledger
    // needs in order to remember never to offer it again.
    throwIfAborted(signal);
    this.update(row.id, { canonicalUrl: normalized.canonicalUrl, awemeId: normalized.awemeId });

    const settled = this.options.ledger?.find(normalized.awemeId);
    const existingDownload = this.options.downloads.findExistingByAwemeId(normalized.awemeId);
    // "Skip all duplicates" must not skip new videos later in the same batch.
    const decided = row.duplicate_action ??
      (settled || existingDownload ? this.batchChoices.get(row.batch_id) : null) ?? null;
    // Clearing the library or moving a file does not erase TikTok's ID.
    // Keep the existing duplicate dialog when a library row still exists.
    if (!decided && !resuming && settled &&
        (settled.status !== 'downloaded' || !existingDownload)) {
      this.finish(row.id, 'skipped', {
        errorCode: null,
        errorDetail: settled.status === 'downloaded' ? 'Already downloaded.' : 'Previously skipped or unsupported.',
      });
      return;
    }

    /**
     * A slideshow the URL itself gives away.
     *
     * `/photo/` links are knowable offline, so deciding about them must cost
     * nothing (section 2). Skipping and asking both settle here without an
     * outbound request; only agreeing to download one goes on to resolve, and
     * that request buys something.
     */
    if (normalized.kind === 'photo') {
      const early = this.photoDecision(row);
      if (early === 'ask') {
        this.parkPhoto(row, normalized, null);
        return;
      }
      if (early === 'skip') {
        this.settlePhoto(row.id, normalized.awemeId, normalized.authorHandle, 'skip');
        return;
      }
    }

    // A resuming item is not a duplicate of anything — the file the layers
    // below would find is the one this very item put there.
    const verdict = decided || resuming
      ? ({ kind: 'none' } as const)
      : checkDuplicate(normalized.awemeId, row.id, {
          queueItems: this.options.queueItems,
          downloads: this.options.downloads,
          fileExists: this.fileExists,
        });

    if (verdict.kind === 'in-queue') {
      this.finish(row.id, 'skipped', { errorCode: null, errorDetail: 'Already in queue.' });
      return;
    }

    if (verdict.kind === 'stale-record') {
      // The record points at a path with nothing on it. Correct the record
      // either way — the Library should not keep claiming a file that is not
      // there — but what happens next depends on the ledger.
      this.options.downloads.markFileMissing(verdict.downloadId);
      this.log.info({ itemId: row.id, awemeId: normalized.awemeId }, 'history row pointed at a missing file');

      /**
       * A missing file is not evidence the video was never taken.
       *
       * Renaming it, moving it into a subfolder, or choosing a different
       * output folder all look exactly like a deletion from here, and section
       * 7's "just download it again, quietly" answer turns any of those into a
       * library that silently re-downloads itself. The ledger knows the video
       * was taken regardless of where the file went, so the choice goes back
       * to the person who moved it — who is the only one who knows whether
       * they deleted it or filed it.
       */
      if (this.options.ledger?.isSettled(normalized.awemeId)) {
        this.park(row, normalized, verdict.existing);
        return;
      }
    }

    if (verdict.kind === 'needs-decision') {
      this.park(row, normalized, verdict.existing);
      return;
    }

    if (decided === 'skip') {
      this.finish(row.id, 'skipped', { errorCode: null, errorDetail: 'Skipped (already downloaded).' });
      return;
    }

    let resolved = alreadyResolved;
    if (!resolved) {
      await this.options.rateLimiter.acquire(signal);
      throwIfAborted(signal);
      try {
        resolved = await this.options.extractor.resolve(normalized.canonicalUrl, { signal });
      } catch (err) {
        const recent = this.recentLookup(cached, err, normalized.awemeId, signal);
        if (!recent) throw err;
        resolved = recent.resolved;
      }
    }

    /**
     * Written down as soon as it is known, before anything that can fail.
     *
     * This is what the next attempt reads, and the next attempt is the one that
     * needs it — so it has to be on the row before the step that is going to go
     * wrong, not after the item succeeds.
     */
    throwIfAborted(signal);
    this.rememberLookup(row.id, normalized, resolved);

    /**
     * A post that is a set of images rather than a video.
     *
     * This used to fail with "no video streams were offered", which reads like
     * a broken app rather than a post that simply is not a video. It is also
     * not a question with one right answer, so unless the user has already
     * decided in Settings, it is put to them — parked, so the rest of the
     * batch carries on — and the answer is written to the ledger, which is
     * what stops the same slideshow being raised on every future run.
     */
    const isPhotoPost = normalized.kind === 'photo' || resolved.metadata.isPhotoPost;
    let photoPost = false;

    if (isPhotoPost) {
      const mode = this.photoDecision(row);
      if (mode === 'ask') {
        // Resolved by now, so the question can say whose it is and how many
        // pictures are in it rather than just "this is a slideshow".
        this.parkPhoto(row, normalized, resolved);
        return;
      }
      if (mode === 'skip') {
        this.settlePhoto(row.id, normalized.awemeId, normalized.authorHandle, 'skip');
        return;
      }
      photoPost = true;
    }

    this.update(row.id, { status: 'downloading', progress: 0 });
    if (!photoPost) this.transferActivity.set(row.id, { at: Date.now(), bytes: 0 });
    this.emitItem(this.options.queueItems.findById(row.id));

    const current = this.options.queueItems.findById(row.id) ?? row;
    const result = await this.options.pipeline.process({
      item: current,
      normalized,
      resolved,
      duplicateAction: decided,
      ...(photoPost ? { photoPost: true } : {}),
      signal,
      onProgress: (progress) => { if (!signal.aborted) this.onProgress(row.id, progress); },
      /**
       * The video is on disk; write that down before anything else can fail.
       *
       * Post-processing, captions, colour and the finishing pass all run after
       * the file is committed, and any of them can throw. When one does, the
       * item fails, the queue retries it, and the retry finds the committed
       * file and picks the next free name — downloading the whole video a
       * second time. That is what "downloading on repeat" was.
       *
       * The ledger is what every later "have I taken this?" reads, so an entry
       * here means a retry meets the duplicate check and asks, instead of
       * quietly fetching another copy. `handleSuccess` records it again with
       * the handle and the final path; the entry is keyed on the video's id,
       * so writing it twice is writing it once.
       */
      onCommitted: (filePath) => {
        if (signal.aborted) return;
        /**
         * The bytes are here, so the network budget this item has spent is no
         * longer evidence against it.
         *
         * That budget exists to stop one link that *hangs* from occupying the
         * queue for an afternoon. A video that has just finished downloading is
         * demonstrably not that link, and everything it has left to do is local
         * ffmpeg work that the budget was never meant to cover. Carrying the
         * spend forward meant a healthy video that hit a problem in
         * post-processing came back to a shorter and shorter window each time,
         * until the watchdog was killing it before it could start — and the
         * queue then set it aside for good, with a message about giving up on a
         * download that had in fact succeeded.
         */
        this.update(row.id, { busyMs: 0 });
        this.options.ledger?.record({
          awemeId: normalized.awemeId,
          // The same handle `handleSuccess` would record, so a creator run's
          // per-account tally does not split across two spellings of it.
          handle: resolved.metadata.authorHandle ?? normalized.authorHandle ?? null,
          status: 'downloaded',
          filePath,
          now: this.options.clock.now(),
        });
      },
      onStage: (stage, state) => { if (!signal.aborted) this.noteStage(row.id, stage, state); },
      /**
       * Written down the moment a step that cannot be repeated succeeds.
       *
       * This is the note the next attempt reads, and writing it eagerly rather
       * than at the end is the entire point: the end is exactly what a failing
       * attempt never reaches.
       */
      onResumable: (state) => { if (!signal.aborted) this.rememberResumePoint(row.id, state); },
      ...(resuming && resume ? { resume } : {}),
    });

    throwIfAborted(signal);
    this.noteStage(row.id, 'record', 'started');

    /**
     * A download that finished without the captions someone asked for.
     *
     * Not a failure — the video is there and watchable — but it is the kind of
     * thing that reads as one when nothing says why, so it goes to the log the
     * Activity panel shows rather than being dropped.
     */
    if (result.captionNote) {
      this.log.warn({ itemId: row.id, reason: result.captionNote }, 'captions were not applied');
    }

    /**
     * A download that finished in a form upload sites will refuse.
     *
     * Not a failure either — the video is there and plays — but it is the one
     * thing about a finished download that someone finds out about days later,
     * from Facebook, in a message that names nothing. The row's finishing step
     * is already marked failed; this puts the reason in the log the Activity
     * panel shows.
     */
    if (result.uploadNote) {
      this.log.warn({ itemId: row.id, reason: result.uploadNote }, 'this file may be refused by upload sites');
    }

    this.recordCompletion(row, normalized, resolved, result);
  }

  /**
   * The lookup, with a recent answer to fall back on when TikTok refuses.
   *
   * `normalize` is where the short-link hop and, for those links, the whole
   * resolution happens — so it is one of the two places a refusal can land.
   * See `recentLookup` for which refusals are eligible.
   */
  private async lookUp(
    row: QueueItemRow,
    signal: AbortSignal,
    cached: LookupCache | null,
  ): Promise<{ normalized: NormalizedUrl; resolved?: ResolvedVideo }> {
    try {
      return await this.normalize(row, signal);
    } catch (err) {
      const recent = this.recentLookup(cached, err, row.aweme_id, signal);
      if (!recent) throw err;
      return { normalized: recent.normalized, resolved: recent.resolved };
    }
  }

  /**
   * A cached lookup good enough to stand in for one that was just refused.
   *
   * Four conditions, and every one of them is load-bearing:
   *
   *  - **It is about the same video.** An id that disagrees means the cache
   *    belongs to something else and must not be substituted.
   *  - **It is recent.** The metadata would stay true indefinitely, but the
   *    stream URLs in it are signed and expire, so an old answer would trade a
   *    lookup failure for a download failure — no better, and more confusing.
   *  - **The failure is about the request, not the video.** This is the
   *    important one. Deleted, private, region-blocked, age-gated and
   *    unsupported are *verdicts*, and answering a verdict with an answer from
   *    before it was handed down would have the app download a video that has
   *    since been taken down, or insist a private account is still public.
   *    Those must fail exactly as they do today.
   *  - **Nothing has been cancelled.** An abort is the queue stopping, and a
   *    fallback that ignored it would carry on working after Stop was pressed.
   */
  private recentLookup(
    cached: LookupCache | null,
    err: unknown,
    awemeId: string | null,
    signal: AbortSignal,
  ): LookupCache | null {
    if (!cached || signal.aborted) return null;
    if (awemeId && cached.normalized.awemeId !== awemeId) return null;

    const age = this.options.clock.now() - cached.at;
    if (age < 0 || age > LOOKUP_CACHE_TTL_MS) return null;

    const code = toAppError(err, 'RESOLVE_FAILED').code;
    if (!LOOKUP_FALLBACK_CODES.includes(code)) return null;

    this.log.warn(
      { awemeId: cached.normalized.awemeId, code, ageMs: age },
      'TikTok would not return the video details; using the answer it gave a few minutes ago instead of failing the link',
    );
    return cached;
  }

  /** Keeps the answer for the attempt after this one; see the 011 migration. */
  private rememberLookup(itemId: number, normalized: NormalizedUrl, resolved: ResolvedVideo): void {
    try {
      this.update(itemId, {
        lookup: JSON.stringify({ at: this.options.clock.now(), normalized, resolved } satisfies LookupCache),
      });
    } catch (err) {
      // Never worth failing a download over. The cache is an optimisation and
      // a safety net, and an item that cannot write one simply does without.
      this.log.warn({ itemId, err: String(err) }, 'could not keep the video details for the next attempt');
    }
  }

  /**
   * Resolution, plus anything the resolver already discovered on the way.
   *
   * The short-link fallback resolves the video in full to learn its id. Calling
   * the extractor again afterwards is not merely wasteful — it discards which
   * route succeeded. In the field the fallback recovered on the mobile API,
   * the second call then succeeded on the plain web route, and the download
   * inherited the web route's (empty) arguments and failed re-extracting
   * through the very path that had already been ruled out.
   */
  private async normalize(
    row: QueueItemRow,
    signal: AbortSignal,
  ): Promise<{ normalized: NormalizedUrl; resolved?: ResolvedVideo }> {
    const parsed = this.options.normalizer.parse(row.raw_url);

    // A full URL needs no request, so it pays no rate limit — otherwise a
    // 300-item paste of full URLs would crawl for no reason.
    if (parsed.status !== 'needs-redirect') {
      return { normalized: await this.options.normalizer.normalize(row.raw_url, { signal }) };
    }

    await this.options.rateLimiter.acquire(signal);
    throwIfAborted(signal);

    try {
      return { normalized: await this.options.normalizer.normalize(row.raw_url, { signal }) };
    } catch (err) {
      const appError = toAppError(err, 'RESOLVE_FAILED');
      /**
       * Which failures earn a second opinion.
       *
       * NOT_A_TIKTOK_URL is here because of what it means for a short link
       * specifically: vt.tiktok.com answered our request by redirecting to
       * `https://www.tiktok.com/?_r=1`, its homepage. The link is fine — the
       * request was not recognised as a browser, so TikTok sent us nowhere in
       * particular. Treating that as "this is not a TikTok URL" fails a
       * perfectly good video, terminally, without a retry.
       *
       * A deleted or private video keeps its own code and still fails.
       */
      const worthRetrying =
        appError.code === 'NETWORK_ERROR' ||
        appError.code === 'RESOLVE_FAILED' ||
        appError.code === 'NOT_A_TIKTOK_URL';
      if (!worthRetrying) throw err;

      /**
       * Fall back to the extractor for short links.
       *
       * Following the redirect ourselves is a bare HEAD request on the global
       * fetch, which is the one outbound call in the app that honours none of
       * the user's settings — no proxy, no forced IPv4, no browser session. It
       * is also entirely redundant: yt-dlp resolves vm.tiktok.com itself, using
       * its own network stack and every one of those settings.
       *
       * So when our shortcut fails, the work is handed to the component that
       * was always better placed to do it, rather than failing an item over a
       * hop that did not need to exist.
       */
      this.log.warn(
        { itemId: row.id, code: appError.code, detail: appError.detail },
        'could not follow the short link directly; asking the extractor instead',
      );

      const resolved = await this.options.extractor.resolve(row.raw_url, { signal });
      const awemeId = resolved.metadata.awemeId;
      if (!awemeId) throw err;

      return {
        normalized: {
          awemeId,
          canonicalUrl: buildCanonicalUrl(awemeId, resolved.metadata.authorHandle),
          authorHandle: resolved.metadata.authorHandle,
          kind: resolved.metadata.isPhotoPost ? 'photo' : 'video',
          viaShortLink: true,
          rawUrl: row.raw_url,
        },
        // Carried forward so the winning route reaches the download.
        resolved,
      };
    }
  }

  /** Layer 3: park the question, free the worker, keep the queue moving. */
  private park(row: QueueItemRow, normalized: NormalizedUrl, existing: { file_path: string; completed_at: number; caption: string | null; author_handle: string | null }): void {
    const pending: PendingDuplicate = {
      itemId: row.id,
      batchId: row.batch_id,
      awemeId: normalized.awemeId,
      caption: existing.caption,
      authorHandle: existing.author_handle,
      existingFilePath: existing.file_path,
      downloadedAt: existing.completed_at,
    };
    this.pendingDuplicates.set(row.id, pending);
    this.update(row.id, { status: 'awaiting_user' });
    this.emitItem(this.options.queueItems.findById(row.id));
    this.emit({ type: 'duplicate-pending', pending });
    this.log.info({ itemId: row.id, awemeId: normalized.awemeId }, 'duplicate awaiting a decision; continuing');
  }

  /**
   * What to do about a slideshow: an answer already given, or the setting.
   *
   * Per-item first, then the batch-wide choice, then the app setting — the
   * same precedence the duplicate question uses, so "apply to the rest of this
   * batch" means the same thing in both places.
   */
  private photoDecision(row: QueueItemRow): PhotoAction | 'ask' {
    const decided = this.photoChoices.get(row.id) ?? this.photoBatchChoices.get(row.batch_id) ?? null;
    return decided ?? this.options.config().photoSlideshows;
  }

  /**
   * The slideshow equivalent of `park`: ask, free the worker, keep going.
   *
   * `resolved` is null when the URL alone gave the post away, since resolving
   * it first would spend a request on a question that can be answered without
   * one. The prompt then has the id and the handle but no caption or picture
   * count, which is enough to decide.
   */
  private parkPhoto(row: QueueItemRow, normalized: NormalizedUrl, resolved: ResolvedVideo | null): void {
    const pending: PendingPhotoPost = {
      itemId: row.id,
      batchId: row.batch_id,
      awemeId: normalized.awemeId,
      canonicalUrl: normalized.canonicalUrl,
      caption: resolved?.metadata.caption ?? null,
      authorHandle: resolved?.metadata.authorHandle ?? normalized.authorHandle,
      // Images arrive as separate formats, so counting them is the closest
      // thing to "how many pictures is this?" without a second request.
      imageCount: resolved && resolved.streams.length > 0 ? resolved.streams.length : null,
    };
    this.pendingPhotos.set(row.id, pending);
    this.update(row.id, { status: 'awaiting_user' });
    this.emitItem(this.options.queueItems.findById(row.id));
    this.emit({ type: 'photo-pending', pending });
    this.log.info({ itemId: row.id, awemeId: normalized.awemeId }, 'photo slideshow awaiting a decision; continuing');
  }

  /**
   * Records a slideshow the user turned down.
   *
   * `declined` rather than a plain skip, because the ledger is what makes the
   * answer stick: a declined post is settled, so listing the account again
   * passes over it instead of asking a second time. That is the whole of the
   * request — "make sure not to fetch that link next time".
   */
  private settlePhoto(itemId: number, awemeId: string, handle: string | null, action: PhotoAction): void {
    if (action !== 'skip') return;
    this.options.ledger?.record({
      awemeId,
      handle,
      status: 'declined',
      now: this.options.clock.now(),
    });
    this.finish(itemId, 'skipped', { errorCode: null, errorDetail: 'Photo slideshow — skipped.' });
  }

  /** Answers one slideshow question. Optionally applies to the rest of the batch. */
  resolvePhotoPost(itemId: number, action: PhotoAction, applyToBatch = false): void {
    const pending = this.pendingPhotos.get(itemId);
    if (!pending) throw new AppError('INTERNAL_ERROR', `no pending photo decision for item ${itemId}`);

    this.pendingPhotos.delete(itemId);
    if (applyToBatch) this.photoBatchChoices.set(pending.batchId, action);

    if (action === 'skip') {
      this.settlePhoto(itemId, pending.awemeId, pending.authorHandle, 'skip');
    } else {
      // Recorded so the second pass reads the decision instead of asking again.
      this.photoChoices.set(itemId, action);
      this.update(itemId, { status: 'queued', progress: 0, startedAt: null, finishedAt: null });
      this.emitItem(this.options.queueItems.findById(itemId));
    }

    this.emit({ type: 'photo-resolved', itemId, action });
    this.applyPhotoBatchChoice(pending.batchId);
    this.pump();
  }

  /** Applies a just-set batch-wide slideshow choice to the questions already parked. */
  private applyPhotoBatchChoice(batchId: string): void {
    const action = this.photoBatchChoices.get(batchId);
    if (!action) return;
    for (const pending of [...this.pendingPhotos.values()]) {
      if (pending.batchId !== batchId) continue;
      this.pendingPhotos.delete(pending.itemId);
      if (action === 'skip') {
        this.settlePhoto(pending.itemId, pending.awemeId, pending.authorHandle, 'skip');
      } else {
        this.photoChoices.set(pending.itemId, action);
        this.update(pending.itemId, { status: 'queued', progress: 0, startedAt: null, finishedAt: null });
        this.emitItem(this.options.queueItems.findById(pending.itemId));
      }
      this.emit({ type: 'photo-resolved', itemId: pending.itemId, action });
    }
  }

  getPendingPhotoPosts(): PendingPhotoPost[] {
    return [...this.pendingPhotos.values()];
  }

  private recordCompletion(
    row: QueueItemRow,
    normalized: NormalizedUrl,
    resolved: { metadata: import('../resolve/types').VideoMetadata },
    result: import('./types').PipelineResult,
  ): void {
    const now = this.options.clock.now();
    const meta = resolved.metadata;

    const video = this.options.videos.upsert(
      {
        awemeId: normalized.awemeId,
        // The extractor knows the real handle; upgrade the provisional
        // canonical URL a short link produced.
        canonicalUrl: meta.authorHandle
          ? `https://www.tiktok.com/@${meta.authorHandle.toLowerCase()}/video/${normalized.awemeId}`
          : normalized.canonicalUrl,
        authorHandle: meta.authorHandle,
        authorName: meta.authorName,
        caption: meta.caption,
        durationMs: meta.durationMs,
        coverUrl: meta.coverUrl,
        musicTitle: meta.musicTitle,
        uploadedAt: meta.uploadedAt,
      },
      now,
    );

    this.options.downloads.insert({
      videoId: video.id,
      filePath: result.filePath,
      fileSize: result.fileSize,
      sha256: result.sha256,
      phash: result.phash,
      sourceStrategy: result.sourceStrategy,
      watermarkRemoved: result.watermarkRemoved,
      outroTrimmedMs: result.outroTrimmedMs,
      completedAt: now,
    });

    /**
     * The ledger entry, written the moment the file exists.
     *
     * This, and not the downloads row, is what every later "have I taken
     * this?" reads. The path goes in for reference only — nothing keys off it,
     * so moving the file cannot un-take the video.
     */
    this.options.ledger?.record({
      awemeId: normalized.awemeId,
      handle: meta.authorHandle ?? normalized.authorHandle ?? null,
      status: 'downloaded',
      filePath: result.filePath,
      now,
    });

    // Layer 4 is advisory: it records a flag and never blocks or fails.
    const repost = checkRepost(this.options.downloads, result.phash, video.id);
    if (repost.isPossibleRepost) {
      this.log.info(
        { itemId: row.id, awemeId: normalized.awemeId, matches: repost.matches.map((m) => m.aweme_id) },
        'possible repost of an existing download',
      );
    }

    this.clearExtractorEvidence();

    // Carried onto the queue row as well as the download record, so the Queue
    // screen can say what happened to the watermark without a library lookup.
    this.finish(row.id, 'completed', {
      progress: 1,
      errorCode: null,
      errorDetail: null,
      sourceStrategy: result.sourceStrategy,
      watermarkRemoved: result.watermarkRemoved ? 1 : 0,
    });
  }

  /* ---------------------------------------------------------------- *
   * Failure and retry
   * ---------------------------------------------------------------- */

  private handleFailure(row: QueueItemRow, err: unknown): void {
    let appError = toAppError(err, 'RESOLVE_FAILED');
    const attemptCount = row.attempt_count + 1;

    /**
     * The watchdog's abort is a timeout wearing a cancel's clothes.
     *
     * Everything downstream reports an aborted signal as CANCELLED, and
     * CANCELLED is terminal — so without this the item the watchdog rescued
     * the queue from would be quietly written off, which is worse than the
     * stall it was rescued from. Reclassified here, at the one place that
     * knows why the abort happened, it takes the ordinary retry path.
     */
    if (appError.code === 'CANCELLED' && this.timedOut.delete(row.id)) {
      /**
       * What it was actually given, not the ceiling.
       *
       * An item near the end of its budget gets a shorter window than the
       * per-attempt limit, and quoting the limit told someone their download
       * had eight minutes when it had ninety seconds — which sends them looking
       * at their connection instead of at the row that says it is nearly out of
       * time.
       */
      const window = this.allowances.get(row.id) ?? this.itemDeadlineMs;
      const minutes = window / 60_000;
      // Never "0 seconds": a window shorter than a second is a number nobody
      // can act on, and it reads as the app not having tried at all.
      const said =
        minutes >= 1
          ? `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'}`
          : `${Math.max(1, Math.round(window / 1_000))} second${Math.max(1, Math.round(window / 1_000)) === 1 ? '' : 's'}`;
      appError = new AppError(
        'NETWORK_ERROR',
        `Gave up after ${said} without finishing. Moved to the back of the queue to try again later.`,
      );
    }

    if (appError.code === 'CANCELLED') {
      /**
       * Every abort arrives here looking the same, so the only thing that can
       * separate them is which part of the app asked for one.
       *
       * Cancelling an item, stopping the queue and emptying it all record the
       * intent before they abort. A suspend or a quit sets `parking`. Anything
       * else is an abort nobody claims, and the honest thing to do with it is
       * to treat it as a fault: the item goes back for another attempt rather
       * than being written off as a cancel the user never asked for.
       *
       * That last branch is deliberately a catch-all rather than a list of
       * known causes. The failure it guards against — a video disappearing
       * from a run, marked "cancelled", with a `.part` file left on disk and
       * nothing said — is silent, and the next such cause has not been written
       * yet.
       */
      const byUser = this.cancelledByUser.delete(row.id);
      if (byUser) {
        this.finish(row.id, 'cancelled', { errorCode: 'CANCELLED', errorDetail: appError.detail ?? null });
        return;
      }

      if (this.parking) {
        // Keeps its position and its .part, so the next launch continues it
        // rather than skipping past a half-finished file.
        this.update(row.id, { status: 'queued', progress: row.progress, startedAt: null });
        this.emitItem(this.options.queueItems.findById(row.id));
        return;
      }

      this.log.warn(
        { itemId: row.id, detail: appError.detail },
        'a download was aborted with no recorded reason; treating it as a fault and trying again',
      );
      appError = new AppError('NETWORK_ERROR', 'The download was interrupted. It will be tried again.');
    }

    this.noteExtractorEvidence(appError.code);

    /**
     * Out of budget: retried enough, and stopping is the point.
     *
     * The attempt ladder alone cannot make this promise. Four automatic
     * attempts plus the end-of-run sweep is five, and five of them at the
     * per-attempt limit still add up to most of an hour on one link — so a
     * batch that had correctly downloaded everything healthy would reach its
     * failures and sit on them for the rest of the afternoon, which is the
     * whole complaint reappearing at the end of the queue instead of the
     * start.
     *
     * A time budget stops that without punishing the failures a retry actually
     * fixes: a link that fails in two seconds has spent almost nothing and
     * keeps every attempt it is entitled to. Only the ones that hang run out.
     */
    const spent = this.options.queueItems.findById(row.id)?.busy_ms ?? row.busy_ms ?? 0;
    const outOfTime = spent >= this.itemTotalBudgetMs;

    if (outOfTime) {
      const minutes = Math.max(1, Math.round(spent / 60_000));
      appError = new AppError(
        appError.code,
        `${appError.detail ?? 'It could not be downloaded.'} Set aside after ${minutes} minute${
          minutes === 1 ? '' : 's'
        } of trying, so the rest of the queue could carry on. Press Retry to give it another go.`,
      );
      this.log.warn({ itemId: row.id, spentMs: spent, attemptCount }, 'item used its whole time budget; not retrying it');
    }

    const decision = outOfTime
      ? { retry: false, delayMs: 0, reason: 'used its whole time budget' }
      : decideRetry(appError.code, attemptCount, this.random);

    /**
     * A post with nothing downloadable in it is settled, not failed-for-now.
     *
     * A photo slideshow or a post with no video track will still have no video
     * track tomorrow, so listing the account again should not offer it again.
     * Recording it here is what stops "16 videos to download" from including
     * the same slideshow every single run.
     */
    if (!decision.retry && appError.code === 'UNSUPPORTED_MEDIA') {
      const current = this.options.queueItems.findById(row.id);
      const awemeId = current?.aweme_id ?? row.aweme_id;
      if (awemeId) {
        this.options.ledger?.record({ awemeId, status: 'unsupported', now: this.options.clock.now() });
      }
    }

    /**
     * The step it fell over at, taken from the last one that announced itself.
     *
     * This is the whole reason `stage` is written on `started` rather than only
     * on completion: at the point something throws, the only record of what was
     * running is the one made before it ran.
     */
    const current = this.options.queueItems.findById(row.id);
    const failedStage = current?.stage ?? row.stage ?? null;

    this.options.queueItems.update(row.id, {
      status: 'failed',
      attemptCount,
      errorCode: appError.code,
      errorDetail: appError.detail ?? null,
      finishedAt: decision.retry ? null : this.options.clock.now(),
      stage: null,
      failedStage,
    });
    this.emitItem(this.options.queueItems.findById(row.id));

    this.log.warn(
      {
        itemId: row.id,
        code: appError.code,
        stage: failedStage,
        attemptCount,
        willRetry: decision.retry,
        reason: decision.reason,
        // Says out loud that the retry will not re-fetch the video, which is
        // the thing the log was previously silent about while it happened.
        resuming: current?.resume_state ? true : false,
      },
      'queue item failed',
    );

    if (decision.retry) this.scheduleRetry(row.id, decision.delayMs);
  }

  /**
   * Backoff without holding a worker slot, and without holding the queue.
   *
   * Sleeping inside the worker would idle one of at most four slots for up to
   * 30 seconds while other items wait. The item is instead left `failed` with
   * its error recorded — which is also what makes the wait crash-safe, since a
   * restart finds a retryable failure under the attempt limit and requeues it.
   *
   * Where the retry lands in the running order is decided by `claimNext`,
   * which takes untried links before tried ones. That is the other half of the
   * fix for a batch that stalled on one link — see WORK_ORDER in the queue
   * items repository.
   */
  private scheduleRetry(itemId: number, delayMs: number): void {
    const controller = new AbortController();
    this.retryTimers.set(itemId, controller);

    /**
     * Recorded and announced before the wait, not after it.
     *
     * A failed row and a failed row that is about to try again looked exactly
     * the same, so a link that dropped its connection sat there reading "The
     * connection dropped or timed out" with nothing moving for up to thirty
     * seconds. The reasonable conclusion is that the app is stuck on it, and
     * the reasonable response is to cancel it — which is the one thing that
     * guarantees it will never download.
     */
    this.nextAttempts.set(itemId, this.options.clock.now() + delayMs);
    this.emitItem(this.options.queueItems.findById(itemId));

    void this.options.clock
      .sleep(delayMs, controller.signal)
      .then(() => {
        this.retryTimers.delete(itemId);
        this.nextAttempts.delete(itemId);
        const row = this.options.queueItems.findById(itemId);
        // Only requeue if nothing else touched it while it waited.
        if (row?.status !== 'failed') return;
        this.update(itemId, { status: 'queued', progress: 0, startedAt: null, finishedAt: null });
        this.emitItem(this.options.queueItems.findById(itemId));
        this.pump();
      })
      .catch(() => {
        this.retryTimers.delete(itemId);
        this.nextAttempts.delete(itemId);
        this.settleIdle();
      });
  }

  /**
   * Frees items parked on a question nobody can answer any more.
   *
   * This is the one that makes a queue quietly stop working after a day or
   * two, and it is worth spelling out because nothing about it looks like a
   * fault while it is happening.
   *
   * Layers 3 and the slideshow prompt park an item in `awaiting_user` and hold
   * the question — who posted it, where the existing file is — in a Map on
   * this object. The status goes to the database; the question does not,
   * because it is a live conversation with a window that is open now.
   *
   * Then the app is quit, or the machine restarts. The row comes back as
   * `awaiting_user`; the Map is empty. `resetInFlight` does not touch it,
   * because from the database's point of view nothing was in flight. Nothing
   * rebuilds the question, so no modal can ever appear, `resolveDuplicate`
   * would throw "no pending decision" if anything called it, and
   * `hasPendingWork` does not count the row — so the queue reports itself
   * finished with an item sitting in it that will never move again.
   *
   * One is a row that looks stuck. They accumulate: every quit while a
   * question is open leaves another, which is exactly the shape of "it works
   * for a day or two and then starts sticking". The only escape was to cancel
   * the row by hand, which is what people did.
   *
   * Requeueing is the right recovery rather than re-asking from the database:
   * the decision was never made, so the item simply has not been processed
   * yet. Running it again re-checks for the duplicate and parks it again if it
   * still is one — this time with a live question and a window to show it in.
   */
  recoverUnansweredQuestions(): number {
    let recovered = 0;
    for (const row of this.options.queueItems.listByStatus(['awaiting_user'])) {
      // A question this process is still holding is a live one; leave it be.
      if (this.pendingDuplicates.has(row.id) || this.pendingPhotos.has(row.id)) continue;
      this.update(row.id, { status: 'queued', progress: 0, startedAt: null, finishedAt: null });
      this.emitItem(this.options.queueItems.findById(row.id));
      recovered++;
    }
    if (recovered > 0) {
      this.log.info({ recovered }, 'requeued items parked on a question that no longer has anywhere to be asked');
    }
    return recovered;
  }

  /**
   * Takes responsibility again for batches that were part-way through.
   *
   * `knownBatches` is what stops a batch-complete being announced for work this
   * engine never saw — without it, every launch would fire a completion event
   * for every finished batch still in the table. It is filled in by `addLinks`,
   * and that is the whole of it, which is fine right up until the app restarts
   * with a queue still in it.
   *
   * After a restart the set is empty, so `checkBatchComplete` returns at its
   * first line for every batch that came back from disk. The batch finishes and
   * nothing says so: no completion event, no summary — and, because the
   * end-of-run retry lives behind that same guard, no second chance for the
   * links that failed. Given that the app is built to start at login and pick
   * the queue straight back up, that is not an edge case; it is what happens
   * every time it does the thing it was designed to do.
   *
   * Rebuilt from the rows rather than persisted, because the question it
   * answers — is there outstanding work in this batch — is one the table can
   * already answer. `failed` counts: those are exactly the rows the end-of-run
   * sweep exists for.
   */
  adoptUnfinishedBatches(): number {
    const unfinished = this.options.queueItems.listByStatus([
      'queued',
      'resolving',
      'awaiting_user',
      'downloading',
      'processing',
      'failed',
    ]);

    const before = this.knownBatches.size;
    for (const row of unfinished) this.knownBatches.add(row.batch_id);

    const adopted = this.knownBatches.size - before;
    if (adopted > 0) this.log.info({ batches: adopted }, 'picked up batches that were unfinished at the last exit');
    return adopted;
  }

  /** Requeues retryable failures left behind by a crash mid-backoff. */
  requeueInterruptedRetries(): number {
    let requeued = 0;
    for (const row of this.options.queueItems.listByStatus(['failed'])) {
      if (!row.error_code) continue;
      const decision = decideRetry(row.error_code, row.attempt_count, this.random);
      if (!decision.retry) continue;
      this.update(row.id, { status: 'queued', errorDetail: null, finishedAt: null });
      requeued++;
    }
    if (requeued > 0) this.log.info({ requeued }, 'requeued retryable failures after restart');
    return requeued;
  }

  /* ---------------------------------------------------------------- *
   * User controls
   * ---------------------------------------------------------------- */

  /** Answers one layer-3 question. Optionally applies to the rest of the batch. */
  resolveDuplicate(itemId: number, action: DuplicateAction, applyToBatch = false): void {
    const pending = this.pendingDuplicates.get(itemId);
    if (!pending) throw new AppError('INTERNAL_ERROR', `no pending duplicate decision for item ${itemId}`);

    this.pendingDuplicates.delete(itemId);
    if (applyToBatch) this.batchChoices.set(pending.batchId, action);

    if (action === 'skip') {
      this.finish(itemId, 'skipped', { duplicateAction: action, errorDetail: 'Skipped (already downloaded).' });
    } else {
      // Requeued with the decision recorded, so the second pass skips the
      // layer-3 check rather than asking again.
      this.update(itemId, { status: 'queued', duplicateAction: action });
      this.emitItem(this.options.queueItems.findById(itemId));
    }

    this.emit({ type: 'duplicate-resolved', itemId, action });
    this.applyBatchChoice(pending.batchId);
    this.pump();
  }

  /** Applies a just-set batch-wide choice to the questions already parked. */
  private applyBatchChoice(batchId: string): void {
    const action = this.batchChoices.get(batchId);
    if (!action) return;
    for (const pending of [...this.pendingDuplicates.values()]) {
      if (pending.batchId !== batchId) continue;
      this.pendingDuplicates.delete(pending.itemId);
      if (action === 'skip') {
        this.finish(pending.itemId, 'skipped', {
          duplicateAction: action,
          errorDetail: 'Skipped (already downloaded).',
        });
      } else {
        this.update(pending.itemId, { status: 'queued', duplicateAction: action });
        this.emitItem(this.options.queueItems.findById(pending.itemId));
      }
      this.emit({ type: 'duplicate-resolved', itemId: pending.itemId, action });
    }
  }

  getPendingDuplicates(): PendingDuplicate[] {
    return [...this.pendingDuplicates.values()];
  }

  cancelItem(itemId: number): void {
    const retry = this.retryTimers.get(itemId);
    if (retry) {
      retry.abort();
      this.retryTimers.delete(itemId);
    }

    const controller = this.controllers.get(itemId);
    if (controller) {
      // The worker's catch turns the abort into a `cancelled` transition and
      // is responsible for killing any child process and deleting the .part.
      // Recorded first so that catch knows this abort was asked for, and does
      // not park the item back into the queue the way a suspend or a quit does.
      this.cancelledByUser.add(itemId);
      controller.abort();
      return;
    }

    this.pendingDuplicates.delete(itemId);
    this.pendingPhotos.delete(itemId);
    const row = this.options.queueItems.findById(itemId);
    if (!row || row.status === 'completed') return;
    this.finish(itemId, 'cancelled', { errorCode: 'CANCELLED', errorDetail: 'Cancelled.' });
    this.settleIdle();
  }

  retryItem(itemId: number): void {
    const row = this.options.queueItems.findById(itemId);
    if (!row) return;
    if (row.status !== 'failed' && row.status !== 'cancelled' && row.status !== 'skipped') return;
    // A manual retry starts both budgets over — the attempt count and the time
    // the item is allowed to spend. Someone pressing Retry has usually changed
    // something, and holding a quarter of an hour spent before the fix against
    // the attempt after it would make the button useless on the items that
    // most need it.
    this.update(itemId, {
      status: 'queued',
      attemptCount: 0,
      errorCode: null,
      errorDetail: null,
      progress: 0,
      finishedAt: null,
      busyMs: 0,
    });
    this.emitItem(this.options.queueItems.findById(itemId));
    this.pump();
  }

  retryAllFailed(): number {
    const failed = this.options.queueItems.listByStatus(['failed']);
    for (const row of failed) this.retryItem(row.id);
    return failed.length;
  }

  removeItem(itemId: number): void {
    this.cancelItem(itemId);
    this.pendingDuplicates.delete(itemId);
    this.pendingPhotos.delete(itemId);
    this.photoChoices.delete(itemId);
    this.options.queueItems.remove(itemId);
    this.emit({ type: 'item-removed', itemId });
  }

  /**
   * Removes every item that is finished with.
   *
   * "Finished" is completed, skipped and cancelled — everything the user has
   * no decision left to make about. `failed` is deliberately kept: those are
   * the rows that still want attention, and a tidy-up button that silently
   * discarded them would hide exactly the thing the user needs to see.
   *
   * It used to clear `completed` alone, which is the second half of why this
   * button read as broken. A queue of eleven downloads and three failures had
   * the eleven cleared on the first press and then did nothing at all on the
   * second — with an icon-only button and no count, there was no way to tell
   * "nothing happened" from "nothing left to happen".
   *
   * The ids are collected before the delete and announced one by one
   * afterwards, which was the first half: this used to delete the rows and
   * return a count, emitting nothing, so the renderer never heard about the
   * removals and the rows stayed on screen until the next restart.
   */
  removeFinished(): number {
    const statuses = ['completed', 'skipped', 'cancelled'] as const;
    const ids = this.options.queueItems.idsByStatus(statuses);
    const removed = this.options.queueItems.removeByStatus(statuses);
    for (const itemId of ids) this.emit({ type: 'item-removed', itemId });
    return removed;
  }

  /** @deprecated Kept as the old name; `removeFinished` is what it does. */
  removeCompleted(): number {
    return this.removeFinished();
  }

  clearQueue(): number {
    // Emptying the queue is a cancel of everything in it, so in-flight items
    // are marked as user-asked-for before the abort lands — otherwise a clear
    // during a suspend would park the very rows it is removing.
    for (const [itemId, controller] of this.controllers) {
      this.cancelledByUser.add(itemId);
      controller.abort();
    }
    for (const controller of this.retryTimers.values()) controller.abort();
    this.retryTimers.clear();
    this.pendingDuplicates.clear();
    this.pendingPhotos.clear();
    this.photoChoices.clear();
    this.photoBatchChoices.clear();
    this.batchChoices.clear();
    this.sweptBatches.clear();

    // Same reason as removeCompleted: a silent delete leaves a full screen.
    const ids = this.options.queueItems.allIds();
    const removed = this.options.queueItems.removeAll();
    for (const itemId of ids) this.emit({ type: 'item-removed', itemId });
    return removed;
  }

  /**
   * Reorders queued items. `orderedIds` is the desired order of the items
   * being moved; anything omitted keeps its current place relative to them.
   * The active item is not reorderable (section 8) and is rejected here.
   */
  reorder(orderedIds: readonly number[]): void {
    for (const id of orderedIds) {
      const row = this.options.queueItems.findById(id);
      if (!row) throw new AppError('INTERNAL_ERROR', `queue item ${id} does not exist`);
      if (row.status !== 'queued') {
        throw new AppError('INTERNAL_ERROR', `queue item ${id} is ${row.status} and cannot be reordered`);
      }
    }
    this.options.queueItems.reposition(orderedIds);
    for (const id of orderedIds) this.emitItem(this.options.queueItems.findById(id));
  }

  getSnapshot(): QueueItemSnapshot[] {
    return this.options.queueItems.listOrdered().map((row) => toSnapshot(row, this.nextAttempts.get(row.id) ?? null));
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private update(itemId: number, patch: Parameters<QueueItemsRepository['update']>[1]): void {
    this.options.queueItems.update(itemId, patch);
  }

  /**
   * Records which step an item is on, and which one went wrong.
   *
   * The status column has four words for a job with seven steps, so a video
   * that had finished downloading and was two minutes into a re-encode looked
   * exactly like one that was stuck — and a failure named the error but never
   * the step. This is the column that tells them apart, and it is written on
   * `started` so that a *thrown* failure can be attributed too: `handleFailure`
   * reads whichever step was last announced.
   *
   * `failed` is the caught kind — the watermark, caption and finishing passes
   * never take the item down with them — so it is recorded without disturbing
   * the running stage, and it survives onto a completed row. "Downloaded, but
   * the finishing pass failed" is a true and useful thing for a row to say.
   */
  private noteStage(itemId: number, stage: PipelineStage, state: StageState): void {
    if (state === 'started') this.update(itemId, { stage, ...(stage === 'resolve' ? { failedStage: null } : {}) });
    else if (state === 'failed') this.update(itemId, { failedStage: stage });
    else return;

    this.emitItem(this.options.queueItems.findById(itemId));
  }

  /**
   * Persists what an attempt has banked, so the next one resumes rather than
   * restarts.
   *
   * Not emitted to the renderer on its own: every call is immediately preceded
   * by a `noteStage` that already refreshed the row.
   */
  private rememberResumePoint(itemId: number, state: ResumeState): void {
    this.update(itemId, { resumeState: JSON.stringify(state) });
  }

  private finish(
    itemId: number,
    status: 'completed' | 'skipped' | 'cancelled',
    patch: Parameters<QueueItemsRepository['update']>[1] = {},
  ): void {
    this.options.queueItems.update(itemId, {
      status,
      finishedAt: this.options.clock.now(),
      stage: null,
      /**
       * The notes are torn up when the job is over — but not when it is
       * cancelled.
       *
       * A cancel leaves a real file mid-processing, and the whole point of the
       * resume note is that pressing Retry then finishes the remaining steps
       * instead of fetching the video a second time. The cached lookup goes
       * with it so that retry does not have to ask TikTok again either.
       */
      ...(status === 'cancelled' ? {} : { resumeState: null, lookup: null }),
      ...patch,
    });
    this.emitItem(this.options.queueItems.findById(itemId));
  }

  /**
   * Progress, throttled to roughly 4 updates a second per item (section 9), so
   * a 300-row list is not asked to re-render on every socket chunk.
   */
  private onProgress(itemId: number, progress: PipelineProgress): void {
    const activity = this.transferActivity.get(itemId);
    if (activity && progress.bytesDone !== activity.bytes) {
      activity.at = Date.now();
      activity.bytes = progress.bytesDone;
    }
    /**
     * The bytes are in; from here on it is local ffmpeg work.
     *
     * Checked before the throttle below, because it is a state change rather
     * than a progress tick and dropping it would leave the time limit running
     * over a re-encode it has no business interrupting.
     */
    if (progress.processing === true) this.beginProcessingPhase(itemId);

    const throttleMs = this.options.progressThrottleMs ?? 250;
    const now = this.options.clock.now();
    const last = this.lastProgressEmit.get(itemId) ?? 0;
    const complete = progress.bytesTotal !== null && progress.bytesDone >= progress.bytesTotal;
    if (now - last < throttleMs && !complete) return;
    this.lastProgressEmit.set(itemId, now);

    const ratio =
      progress.bytesTotal && progress.bytesTotal > 0
        ? Math.min(1, progress.bytesDone / progress.bytesTotal)
        : 0;

    /**
     * Written to disk far less often than it is shown on screen.
     *
     * These are two different jobs that were being done by one write. The
     * screen wants a bar that moves — four times a second, which is what the
     * throttle above is for. SQLite wants to know roughly how far a download
     * got, so that a restart can say "62%" instead of "0%" until the first
     * tick arrives; a value two seconds stale is indistinguishable from a
     * fresh one for that purpose.
     *
     * Doing both at 4 Hz meant a 200-item batch wrote tens of thousands of
     * rows nobody would ever read, and that write rate was the stated reason
     * the database ran at a durability setting that can lose committed work in
     * a power cut. Separating them buys back the durability at no visible cost.
     *
     * A status change and the final tick are always persisted, because those
     * are the ones a restart actually reads.
     */
    const persistEveryMs = this.options.progressPersistMs ?? 2_000;
    const lastWrite = this.lastProgressWrite.get(itemId) ?? 0;
    if (complete || progress.processing || now - lastWrite >= persistEveryMs) {
      this.lastProgressWrite.set(itemId, now);
      this.options.queueItems.update(itemId, {
        progress: ratio,
        bytesDone: progress.bytesDone,
        bytesTotal: progress.bytesTotal,
        ...(progress.processing ? { status: 'processing' as const } : {}),
      });
      this.emitItem(this.options.queueItems.findById(itemId));
    } else {
      /**
       * Not persisted, but still shown.
       *
       * The row on screen is the stored row with the live figures laid over
       * it, so the bar keeps moving between writes rather than stepping every
       * two seconds. Nothing here touches the database.
       */
      const row = this.options.queueItems.findById(itemId);
      if (row) {
        this.emit({
          type: 'item-updated',
          item: toSnapshot({ ...row, progress: ratio, bytes_done: progress.bytesDone, bytes_total: progress.bytesTotal }),
        });
      }
    }

    this.emit({
      type: 'item-progress',
      itemId,
      bytesDone: progress.bytesDone,
      bytesTotal: progress.bytesTotal,
      speed: progress.speed,
      etaMs: progress.etaMs,
    });
  }

  private checkBatchComplete(batchId: string): void {
    if (!this.knownBatches.has(batchId)) return;
    const rows = this.options.queueItems.listByBatch(batchId);
    if (rows.length === 0) return;

    const outstanding = rows.some(
      (row) =>
        row.status === 'queued' ||
        row.status === 'resolving' ||
        row.status === 'downloading' ||
        row.status === 'processing' ||
        row.status === 'awaiting_user' ||
        this.retryTimers.has(row.id),
    );
    if (outstanding) return;

    /**
     * One more attempt at the failures before the run is called finished.
     *
     * A link that failed early in a batch failed under whatever conditions
     * existed at that moment — a rate limit, a dropped connection, TikTok
     * having a bad minute. By the end of a run those have usually passed, and
     * the retry costs one request against a link the user has already asked
     * for. It happens here, at the end, rather than by blocking: the failed
     * item never held up the ones behind it, which is the property that
     * matters most in a long batch.
     *
     * Only transient codes qualify. Retrying a deleted or private video at the
     * end of every run would spend requests to be told the same thing again.
     */
    if (!this.sweptBatches.has(batchId)) {
      this.sweptBatches.add(batchId);
      /**
       * Everything the user could retry by hand, not only the transient codes.
       *
       * This used to sweep `isAutoRetryable` only, which excluded the single
       * most common real-world failure: TikTok serving a page without its
       * video data. Those items sat `failed` at the end of a run with a Retry
       * button nobody had asked to press. `userRetryable` is the broader flag
       * and is exactly the right one here — it is defined as "worth a manual
       * retry", and an automatic sweep at the end of the run is that retry.
       *
       * A deleted, private or region-blocked video is `userRetryable: false`
       * and is still left alone, because no amount of retrying changes it.
       */
      const retryable = rows.filter(
        (row) =>
          row.status === 'failed' &&
          row.error_code &&
          describeError(row.error_code).userRetryable &&
          // A video that used its whole time budget has been set aside on
          // purpose. Sweeping it back in is the queue undoing its own decision
          // and settling down on it again for another quarter of an hour,
          // which is the exact behaviour the budget exists to end.
          (row.busy_ms ?? 0) < this.itemTotalBudgetMs,
      );

      if (retryable.length > 0) {
        this.log.info(
          { batchId, count: retryable.length, codes: [...new Set(retryable.map((r) => r.error_code))] },
          'end of run: giving the failures one more attempt',
        );

        /**
         * One attempt, not a second ladder.
         *
         * `attemptCount` is deliberately left where it is rather than reset
         * the way a manual retry resets it. These items have already spent
         * their 2s/8s/30s budget, so carrying the count forward means the next
         * failure is final: `decideRetry` sees the budget is gone and stops.
         * Resetting it would turn every transient failure in a batch into
         * eight attempts and eighty seconds of backoff.
         */
        for (const row of retryable) {
          this.update(row.id, { status: 'queued', progress: 0, startedAt: null, finishedAt: null, errorDetail: null });
          this.emitItem(this.options.queueItems.findById(row.id));
        }
        this.pump();
        // Not finished after all; the next completion re-checks and this time
        // finds the batch already swept.
        return;
      }
    }

    const summary: BatchSummary = {
      batchId,
      completed: rows.filter((r) => r.status === 'completed').length,
      skipped: rows.filter((r) => r.status === 'skipped').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      cancelled: rows.filter((r) => r.status === 'cancelled').length,
    };

    this.knownBatches.delete(batchId);
    // The batch choice must not outlive its batch (section 7); nor must the
    // record of having swept it.
    this.batchChoices.delete(batchId);
    this.photoBatchChoices.delete(batchId);
    this.sweptBatches.delete(batchId);
    /**
     * The per-item slideshow answers too, which nothing else released.
     *
     * Keyed by item rather than by batch, so they were not covered by the
     * three lines above and stayed for the life of the process — one entry per
     * slideshow ever answered. Small, but this is a program that is meant to
     * run for weeks at a time, and "small and forever" is how that ends.
     */
    for (const row of rows) this.photoChoices.delete(row.id);
    this.emit({ type: 'batch-complete', summary });
    this.log.info(summary, 'batch complete');
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('CANCELLED', 'cancelled by user');
}

export type { ErrorCode };
