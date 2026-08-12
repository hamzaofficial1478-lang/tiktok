import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError, toAppError, type ErrorCode } from '@shared/errors';
import type { AppConfig } from '@shared/config-schema';
import type { DuplicateAction } from '@shared/types';
import type { QueueItemRow, QueueItemsRepository } from '../db/repositories/queue-items';
import type { VideosRepository } from '../db/repositories/videos';
import type { DownloadsRepository } from '../db/repositories/downloads';
import type { UrlNormalizer } from '../resolve/url-normalizer';
import type { Extractor, NormalizedUrl } from '../resolve/types';
import type { Clock } from '../clock';
import { RateLimiter } from './rate-limiter';
import { decideRetry, MAX_RETRIES } from './retry-policy';
import { checkDuplicate, checkRepost, dedupePaste } from './dedup';
import {
  toSnapshot,
  type AddLinksResult,
  type BatchSummary,
  type MediaPipeline,
  type PendingDuplicate,
  type PipelineProgress,
  type QueueEvent,
  type QueueItemSnapshot,
} from './types';

export interface QueueEngineOptions {
  readonly queueItems: QueueItemsRepository;
  readonly videos: VideosRepository;
  readonly downloads: DownloadsRepository;
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
   * Persists whether the queue is meant to be running, so an unexpected exit
   * does not turn into a queue that quietly sits idle on next launch.
   */
  readonly onRunStateChanged?: (running: boolean) => void;
}

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
  private activeWorkers = 0;

  private readonly controllers = new Map<number, AbortController>();
  private readonly retryTimers = new Map<number, AbortController>();
  private readonly pendingDuplicates = new Map<number, PendingDuplicate>();
  /**
   * "Apply to all remaining duplicates in this batch" — batch-scoped and
   * in-memory only. Section 7: never permanent, never across batches.
   */
  private readonly batchChoices = new Map<string, DuplicateAction>();
  private readonly listeners = new Set<(event: QueueEvent) => void>();
  private readonly lastProgressEmit = new Map<number, number>();
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
    if (row) this.emit({ type: 'item-updated', item: toSnapshot(row) });
  }

  /* ---------------------------------------------------------------- *
   * Adding links — dedup layer 1, and layer 2 where the ID is known
   * ---------------------------------------------------------------- */

  addLinks(rawUrls: readonly string[], batchId: string = randomUUID()): AddLinksResult {
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
      toEnqueue.map((item) => ({ ...item, batchId })),
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
   * the next launch would sit idle instead of carrying on.
   */
  async stop(options: { keepRunState?: boolean } = {}): Promise<void> {
    if (!options.keepRunState) this.options.onRunStateChanged?.(false);
    this.running = false;
    for (const controller of this.controllers.values()) controller.abort();
    for (const controller of this.retryTimers.values()) controller.abort();
    this.retryTimers.clear();
    await this.whenIdle();
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

    try {
      await this.processItem(row, controller.signal);
    } catch (err) {
      this.handleFailure(row, err);
    } finally {
      this.controllers.delete(row.id);
      this.lastProgressEmit.delete(row.id);
      this.checkBatchComplete(row.batch_id);
    }
  }

  /* ---------------------------------------------------------------- *
   * The per-item pipeline
   * ---------------------------------------------------------------- */

  private async processItem(row: QueueItemRow, signal: AbortSignal): Promise<void> {
    const normalized = await this.normalize(row, signal);

    // A carousel is knowable from the URL alone, so it fails without ever
    // spending an outbound request (section 2).
    if (normalized.kind === 'photo') {
      throw new AppError('UNSUPPORTED_MEDIA', `${normalized.awemeId} is a photo slideshow`);
    }

    this.update(row.id, { canonicalUrl: normalized.canonicalUrl, awemeId: normalized.awemeId });

    const decided = row.duplicate_action ?? this.batchChoices.get(row.batch_id) ?? null;
    const verdict = decided
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
      // The user deleted the file; correct the record and download again
      // without asking. Section 7: prompting here is just annoying.
      this.options.downloads.markFileMissing(verdict.downloadId);
      this.log.info({ itemId: row.id, awemeId: normalized.awemeId }, 'history row pointed at a missing file');
    }

    if (verdict.kind === 'needs-decision') {
      this.park(row, normalized, verdict.existing);
      return;
    }

    if (decided === 'skip') {
      this.finish(row.id, 'skipped', { errorCode: null, errorDetail: 'Skipped (already downloaded).' });
      return;
    }

    await this.options.rateLimiter.acquire(signal);
    throwIfAborted(signal);
    const resolved = await this.options.extractor.resolve(normalized.canonicalUrl, { signal });

    this.update(row.id, { status: 'downloading', progress: 0 });
    this.emitItem(this.options.queueItems.findById(row.id));

    const current = this.options.queueItems.findById(row.id) ?? row;
    const result = await this.options.pipeline.process({
      item: current,
      normalized,
      resolved,
      duplicateAction: decided,
      signal,
      onProgress: (progress) => this.onProgress(row.id, progress),
    });

    throwIfAborted(signal);
    this.recordCompletion(row, normalized, resolved, result);
  }

  private async normalize(row: QueueItemRow, signal: AbortSignal): Promise<NormalizedUrl> {
    const parsed = this.options.normalizer.parse(row.raw_url);
    // Only a short link costs a request, so only a short link pays the rate
    // limit — otherwise a 300-item paste of full URLs would crawl for no reason.
    if (parsed.status === 'needs-redirect') {
      await this.options.rateLimiter.acquire(signal);
      throwIfAborted(signal);
    }
    return this.options.normalizer.normalize(row.raw_url, { signal });
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

    // Layer 4 is advisory: it records a flag and never blocks or fails.
    const repost = checkRepost(this.options.downloads, result.phash, video.id);
    if (repost.isPossibleRepost) {
      this.log.info(
        { itemId: row.id, awemeId: normalized.awemeId, matches: repost.matches.map((m) => m.aweme_id) },
        'possible repost of an existing download',
      );
    }

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
    const appError = toAppError(err, 'RESOLVE_FAILED');
    const attemptCount = row.attempt_count + 1;

    if (appError.code === 'CANCELLED') {
      // A suspend aborts in-flight work the same way a cancel does, but it is
      // not the user abandoning the item: put it back in the queue, keeping
      // its position and its .part, so waking up continues rather than loses it.
      if (this.suspending) {
        this.update(row.id, { status: 'queued', progress: row.progress, startedAt: null });
        this.emitItem(this.options.queueItems.findById(row.id));
        return;
      }
      this.finish(row.id, 'cancelled', { errorCode: 'CANCELLED', errorDetail: appError.detail ?? null });
      return;
    }

    const decision = decideRetry(appError.code, attemptCount, this.random);

    this.options.queueItems.update(row.id, {
      status: 'failed',
      attemptCount,
      errorCode: appError.code,
      errorDetail: appError.detail ?? null,
      finishedAt: decision.retry ? null : this.options.clock.now(),
    });
    this.emitItem(this.options.queueItems.findById(row.id));

    this.log.warn(
      { itemId: row.id, code: appError.code, attemptCount, willRetry: decision.retry, reason: decision.reason },
      'queue item failed',
    );

    if (decision.retry) this.scheduleRetry(row.id, decision.delayMs);
  }

  /**
   * Backoff without holding a worker slot.
   *
   * Sleeping inside the worker would idle one of at most four slots for up to
   * 30 seconds while other items wait. The item is instead left `failed` with
   * its error recorded — which is also what makes the wait crash-safe, since a
   * restart finds a retryable failure under the attempt limit and requeues it.
   */
  private scheduleRetry(itemId: number, delayMs: number): void {
    const controller = new AbortController();
    this.retryTimers.set(itemId, controller);

    void this.options.clock
      .sleep(delayMs, controller.signal)
      .then(() => {
        this.retryTimers.delete(itemId);
        const row = this.options.queueItems.findById(itemId);
        // Only requeue if nothing else touched it while it waited.
        if (row?.status !== 'failed') return;
        this.update(itemId, { status: 'queued', progress: 0, startedAt: null, finishedAt: null });
        this.emitItem(this.options.queueItems.findById(itemId));
        this.pump();
      })
      .catch(() => {
        this.retryTimers.delete(itemId);
        this.settleIdle();
      });
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
      controller.abort();
      return;
    }

    this.pendingDuplicates.delete(itemId);
    const row = this.options.queueItems.findById(itemId);
    if (!row || row.status === 'completed') return;
    this.finish(itemId, 'cancelled', { errorCode: 'CANCELLED', errorDetail: 'Cancelled.' });
    this.settleIdle();
  }

  retryItem(itemId: number): void {
    const row = this.options.queueItems.findById(itemId);
    if (!row) return;
    if (row.status !== 'failed' && row.status !== 'cancelled' && row.status !== 'skipped') return;
    // A manual retry starts the attempt budget over; the user has decided the
    // condition changed.
    this.update(itemId, {
      status: 'queued',
      attemptCount: 0,
      errorCode: null,
      errorDetail: null,
      progress: 0,
      finishedAt: null,
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
    this.options.queueItems.remove(itemId);
    this.emit({ type: 'item-removed', itemId });
  }

  removeCompleted(): number {
    return this.options.queueItems.removeByStatus(['completed']);
  }

  clearQueue(): number {
    for (const controller of this.controllers.values()) controller.abort();
    for (const controller of this.retryTimers.values()) controller.abort();
    this.retryTimers.clear();
    this.pendingDuplicates.clear();
    this.batchChoices.clear();
    return this.options.queueItems.removeAll();
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
    return this.options.queueItems.listOrdered().map(toSnapshot);
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private update(itemId: number, patch: Parameters<QueueItemsRepository['update']>[1]): void {
    this.options.queueItems.update(itemId, patch);
  }

  private finish(
    itemId: number,
    status: 'completed' | 'skipped' | 'cancelled',
    patch: Parameters<QueueItemsRepository['update']>[1] = {},
  ): void {
    this.options.queueItems.update(itemId, { status, finishedAt: this.options.clock.now(), ...patch });
    this.emitItem(this.options.queueItems.findById(itemId));
  }

  /**
   * Progress, throttled to roughly 4 updates a second per item (section 9), so
   * a 300-row list is not asked to re-render on every socket chunk.
   */
  private onProgress(itemId: number, progress: PipelineProgress): void {
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

    this.options.queueItems.update(itemId, {
      progress: ratio,
      bytesDone: progress.bytesDone,
      bytesTotal: progress.bytesTotal,
      ...(progress.processing ? { status: 'processing' as const } : {}),
    });
    this.emitItem(this.options.queueItems.findById(itemId));
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

    const summary: BatchSummary = {
      batchId,
      completed: rows.filter((r) => r.status === 'completed').length,
      skipped: rows.filter((r) => r.status === 'skipped').length,
      failed: rows.filter((r) => r.status === 'failed').length,
      cancelled: rows.filter((r) => r.status === 'cancelled').length,
    };

    this.knownBatches.delete(batchId);
    // The batch choice must not outlive its batch (section 7).
    this.batchChoices.delete(batchId);
    this.emit({ type: 'batch-complete', summary });
    this.log.info(summary, 'batch complete');
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('CANCELLED', 'cancelled by user');
}

export type { ErrorCode };
