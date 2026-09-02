import { existsSync, rmSync } from 'node:fs';
import { AppError } from '@shared/errors';
import { parseProfile } from '@shared/url-parse';
import type { CreatorDto } from '@shared/ipc/contract';
import type { CreatorRow } from '../db/repositories/creators';
import { buildRunPlan } from '../creators/run-plan';
import type { LibraryEntryDto } from '@shared/ipc/contract';
import type { LibraryRow } from '../db/repositories/downloads';
import type { AppServices } from '../services';
import type { EventBus, IpcRegistry } from './registry';

/**
 * Queue and library handlers.
 *
 * Every one is a thin adapter over the engine — no business logic lives at the
 * IPC layer, so the same operations stay callable from the CLI harness without
 * an Electron window.
 */
export function registerQueueHandlers(registry: IpcRegistry, services: AppServices): void {
  const { queue } = services;

  registry.handle('queue:getSnapshot', () => ({
    items: queue.getSnapshot(),
    state: { running: queue.isRunning, paused: queue.isPaused, active: queue.activeCount },
  }));

  registry.handle('queue:addLinks', ({ urls, subfolder }) => {
    const result = queue.addLinks(urls, undefined, subfolder ?? null);
    // Pasting links is the user saying "download these"; making them press
    // start as well is a step with no decision in it.
    if (result.added > 0 && !queue.isRunning) queue.start();
    // The engine's result is readonly; the contract's is not, so copy rather
    // than cast — a cast here would hide a real shape mismatch later.
    return { ...result, invalid: result.invalid.map((entry) => ({ ...entry })) };
  });

  /**
   * Lists an account and hands the links back — it queues nothing.
   *
   * The user sees what the account contains and decides; a paste that silently
   * became two hundred downloads would be a worse product than one that asks.
   */
  registry.handle('queue:expandProfile', async ({ input, limit }) => {
    const expansion = await services.resolution.profiles.expand(input, {
      ...(limit === undefined ? {} : { limit }),
    });
    return {
      handle: expansion.handle,
      profileUrl: expansion.profileUrl,
      urls: [...expansion.urls],
      truncated: expansion.truncated,
    };
  });

  const toCreatorDto = (row: CreatorRow): CreatorDto => ({
    id: row.id,
    handle: row.handle,
    profileUrl: row.profile_url,
    videoLimit: row.video_limit,
    captionMode: row.caption_mode,
    enabled: row.enabled === 1,
    addedAt: row.added_at,
    lastQueuedAt: row.last_queued_at,
    videosQueued: row.videos_queued,
  });

  registry.handle('creators:list', () => ({
    creators: services.repos.creators.list().map(toCreatorDto),
  }));

  /**
   * Adds many accounts from one paste.
   *
   * Every line is parsed here rather than trusted: a line that is not a profile
   * link is reported back as invalid instead of being saved as an account that
   * will fail on every run.
   */
  registry.handle('creators:add', ({ input, videoLimit }) => {
    const lines = input
      .split(/[\n,]/)
      .map((line) => line.trim())
      .filter((line) => line !== '');

    const parsed = lines.map((line) => ({ line, profile: parseProfile(line) }));
    const invalid = parsed.filter((entry) => entry.profile === null).map((entry) => entry.line);

    const result = services.repos.creators.addMany(
      parsed
        .filter((entry) => entry.profile !== null)
        .map((entry) => ({
          handle: entry.profile!.handle,
          profileUrl: entry.profile!.profileUrl,
          ...(videoLimit === undefined ? {} : { videoLimit }),
        })),
    );

    return {
      creators: services.repos.creators.list().map(toCreatorDto),
      added: result.added.length,
      alreadySaved: result.skipped,
      invalid,
    };
  });

  registry.handle('creators:update', ({ id, videoLimit, captionMode, enabled }) => {
    const row = services.repos.creators.update(id, {
      ...(videoLimit === undefined ? {} : { videoLimit }),
      ...(captionMode === undefined ? {} : { captionMode }),
      ...(enabled === undefined ? {} : { enabled }),
    });
    return { creator: row ? toCreatorDto(row) : null };
  });

  registry.handle('creators:remove', ({ id }) => {
    services.repos.creators.remove(id);
    return { ok: true as const };
  });

  /**
   * Cheap enough to call on every queue event, which is what makes the count
   * come down: one grouped query over the ledger, no network, no listing.
   */
  registry.handle('creators:plan', () => {
    const taken = services.repos.linkLedger.downloadedByHandle();
    const plan = buildRunPlan(services.repos.creators.list(), (handle) => taken.get(handle) ?? 0);
    /**
     * Whether a run is under way, answered by the engine rather than by the
     * screen that started it.
     *
     * The Run button used to key off a React flag set when it was clicked,
     * which is lost the moment the window reloads or the app restarts — so a
     * run interrupted by a power cut came back with the button enabled and
     * inviting a second one on top of the first. The runner and the queue
     * both know the truth; this reports it.
     */
    const running = services.creatorRunner.isRunning || services.queue.hasPendingWork();
    return { ...plan, running, creators: plan.creators.map((entry) => ({ ...entry })) };
  });

  /**
   * Starts the run and does not wait for it.
   *
   * A run is minutes to hours of work; holding the IPC call open for it would
   * time out and tell the renderer nothing in the meantime. Progress arrives
   * on `creators:progress` instead.
   */
  registry.handle('creators:run', (request) => {
    const topUp = request?.topUp === true;
    const list = services.repos.creators.list().filter((row) => row.enabled === 1);

    /**
     * What this run will do, answered before it starts.
     *
     * A top-up takes another full count from every account; an ordinary run
     * only visits the ones that still owe something. Returning both counts
     * lets the UI say "listing 2 accounts, 3 already finished" straight away
     * rather than leaving the user watching a progress line to work it out.
     */
    const taken = services.repos.linkLedger.downloadedByHandle();
    const plan = buildRunPlan(list, (handle) => taken.get(handle) ?? 0);
    const visited = topUp ? list.length : plan.accountsToVisit;

    /**
     * Started, not awaited — and its failure is logged rather than swallowed.
     *
     * `.catch(() => undefined)` was hiding the one case that matters: if the
     * whole run threw, nothing appeared anywhere. Per-account failures already
     * report themselves through progress events; this is the outer one.
     */
    void services.creatorRunner.run({ topUp }).catch((err: unknown) => {
      services.log.error({ err: err instanceof Error ? err.message : String(err) }, 'the creator run failed');
    });

    // `queued` is zero because nothing has been queued yet: the run is minutes
    // to hours of work and reports its real counts over `creators:progress`.
    return { queued: 0, creators: list.length, caughtUp: list.length - visited, visited };
  });

  registry.handle('creators:cancelRun', () => {
    services.creatorRunner.cancel();
    return { ok: true as const };
  });

  registry.handle('queue:start', () => {
    queue.start();
    return { ok: true as const };
  });

  registry.handle('queue:pause', () => {
    queue.pause();
    return { ok: true as const };
  });

  registry.handle('queue:resume', () => {
    queue.resume();
    return { ok: true as const };
  });

  registry.handle('queue:cancelItem', ({ itemId }) => {
    queue.cancelItem(itemId);
    return { ok: true as const };
  });

  registry.handle('queue:retryItem', ({ itemId }) => {
    queue.retryItem(itemId);
    return { ok: true as const };
  });

  registry.handle('queue:retryAllFailed', () => ({ retried: queue.retryAllFailed() }));

  registry.handle('queue:removeItem', ({ itemId }) => {
    queue.removeItem(itemId);
    return { ok: true as const };
  });

  registry.handle('queue:removeCompleted', () => ({ removed: queue.removeCompleted() }));
  registry.handle('queue:clear', () => ({ removed: queue.clearQueue() }));

  registry.handle('queue:reorder', ({ orderedIds }) => {
    queue.reorder(orderedIds);
    return { ok: true as const };
  });

  registry.handle('queue:getPendingDuplicates', () => ({ pending: queue.getPendingDuplicates() }));

  registry.handle('queue:resolveDuplicate', ({ itemId, action, applyToBatch }) => {
    queue.resolveDuplicate(itemId, action, applyToBatch);
    return { ok: true as const };
  });

  registry.handle('queue:getPendingPhotoPosts', () => ({ pending: queue.getPendingPhotoPosts() }));

  registry.handle('queue:resolvePhotoPost', ({ itemId, action, applyToBatch }) => {
    queue.resolvePhotoPost(itemId, action, applyToBatch);
    return { ok: true as const };
  });
}

export function registerLibraryHandlers(registry: IpcRegistry, services: AppServices): void {
  registry.handle('library:list', ({ search, limit, offset }) => {
    const result = services.repos.downloads.listLibrary({
      ...(search === undefined ? {} : { search }),
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    });
    return { entries: result.entries.map(toLibraryEntry), total: result.total };
  });

  registry.handle('library:dailyStats', ({ days }) => ({
    days: services.repos.downloads.dailyStats(days),
  }));

  /**
   * Removing a row from the list, and only that.
   *
   * This used to forget the video as well, on the reasoning that a record
   * deleted without its ledger entry leaves a link that can never be taken
   * again. That reasoning had the consequences the wrong way round. The button
   * is on a list, next to a heading that promises "clearing the list forgets the
   * records; it never deletes a video", and what it silently did was erase the
   * app's memory of having downloaded the thing — so the next creator run
   * downloaded it a second time, into the same folder, beside the copy that was
   * already there.
   *
   * Tidying a list is not a request to fetch fifty videos again. The one
   * deletion the app can be certain of is `library:deleteFile`, which removes
   * the video and does forget it — correctly, because it is gone.
   */
  registry.handle('library:deleteRecord', ({ downloadId }) => {
    services.repos.downloads.deleteRecord(downloadId);
    return { ok: true as const };
  });

  registry.handle('library:clearRecords', () => {
    // Same correction at scale, and this is the one that cost an afternoon:
    // clearing the list wiped every "already taken" the app had, so the next
    // run started again from the top of all ten accounts.
    const removed = services.repos.downloads.deleteAllRecords();
    return { removed };
  });

  registry.handle('library:deleteFile', ({ downloadId }) => {
    const row = services.repos.downloads.findWithVideoById(downloadId);
    if (!row) throw new AppError('INTERNAL_ERROR', `download ${downloadId} does not exist`);

    try {
      rmSync(row.file_path, { force: true });
    } catch (err) {
      throw new AppError('PERMISSION_DENIED', `could not delete ${row.file_path}: ${String(err)}`);
    }

    // The record is kept and marked instead of deleted, so re-adding the link
    // re-downloads silently rather than prompting about a file the user removed
    // (section 7).
    services.repos.downloads.markFileMissing(downloadId);
    /**
     * This is the one deletion the app can be certain about.
     *
     * A file that has merely gone missing might have been renamed or moved,
     * which is why that case now asks instead of re-downloading. A file
     * deleted through this button was deleted on purpose, in front of us, so
     * the ledger forgets it and the link becomes takeable again.
     */
    services.repos.linkLedger.forget(row.aweme_id);
    return { ok: true as const };
  });
}

function toLibraryEntry(row: LibraryRow): LibraryEntryDto {
  return {
    downloadId: row.download_id,
    awemeId: row.aweme_id,
    canonicalUrl: row.canonical_url,
    authorHandle: row.author_handle,
    authorName: row.author_name,
    caption: row.caption,
    durationMs: row.duration_ms,
    coverUrl: row.cover_url,
    filePath: row.file_path,
    fileSize: row.file_size,
    sourceStrategy: row.source_strategy,
    watermarkRemoved: row.watermark_removed === 1,
    outroTrimmedMs: row.outro_trimmed_ms,
    completedAt: row.completed_at,
    // Checked live: a file deleted outside the app should not still show as present.
    fileExists: row.file_exists === 1 && existsSync(row.file_path),
    possibleRepost: row.possible_repost === 1,
  };
}

/** Forwards engine events to the renderer (section 4: push, never polling). */
export function registerQueueEvents(bus: EventBus, services: AppServices): () => void {
  return services.queue.subscribe((event) => {
    switch (event.type) {
      case 'item-updated':
        bus.emit('queue:itemUpdated', event.item);
        break;
      case 'item-progress':
        bus.emit('queue:itemProgress', {
          itemId: event.itemId,
          bytesDone: event.bytesDone,
          bytesTotal: event.bytesTotal,
          speed: event.speed,
          etaMs: event.etaMs,
        });
        break;
      case 'items-added':
        bus.emit('queue:itemsAdded', { batchId: event.batchId, items: [...event.items] });
        break;
      case 'item-removed':
        bus.emit('queue:itemRemoved', { itemId: event.itemId });
        break;
      case 'duplicate-pending':
        bus.emit('queue:duplicatePending', event.pending);
        break;
      case 'duplicate-resolved':
        bus.emit('queue:duplicateResolved', { itemId: event.itemId, action: event.action });
        break;
      case 'photo-pending':
        bus.emit('queue:photoPending', event.pending);
        break;
      case 'photo-resolved':
        bus.emit('queue:photoResolved', { itemId: event.itemId, action: event.action });
        break;
      case 'batch-complete':
        bus.emit('queue:batchComplete', event.summary);
        break;
      case 'queue-state':
        bus.emit('queue:state', { running: event.running, paused: event.paused, active: event.active });
        break;
    }
  });
}
