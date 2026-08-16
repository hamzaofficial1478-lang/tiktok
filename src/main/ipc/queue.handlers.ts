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
    return { ...plan, creators: plan.creators.map((entry) => ({ ...entry })) };
  });

  /**
   * Starts the run and does not wait for it.
   *
   * A run is minutes to hours of work; holding the IPC call open for it would
   * time out and tell the renderer nothing in the meantime. Progress arrives
   * on `creators:progress` instead.
   */
  registry.handle('creators:run', () => {
    const list = services.repos.creators.list().filter((row) => row.enabled === 1);

    /**
     * Started, not awaited — and its failure is logged rather than swallowed.
     *
     * `.catch(() => undefined)` was hiding the one case that matters: if the
     * whole run threw, nothing appeared anywhere. Per-account failures already
     * report themselves through progress events; this is the outer one.
     */
    void services.creatorRunner.run().catch((err: unknown) => {
      services.log.error({ err: err instanceof Error ? err.message : String(err) }, 'the creator run failed');
    });

    // `queued` is zero because nothing has been queued yet: the run is minutes
    // to hours of work and reports its real counts over `creators:progress`.
    return { queued: 0, creators: list.length };
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
   * Forgetting one download, and meaning it.
   *
   * The ledger is what stops a video being taken twice, so removing the
   * history row without removing the ledger entry would leave the link
   * permanently unclaimable — the record gone from the Library, and every
   * future attempt still skipped as already taken. Deleting a record is a
   * deliberate act, so it clears both.
   */
  registry.handle('library:deleteRecord', ({ downloadId }) => {
    const row = services.repos.downloads.findWithVideoById(downloadId);
    services.repos.downloads.deleteRecord(downloadId);
    if (row) services.repos.linkLedger.forget(row.aweme_id);
    return { ok: true as const };
  });

  registry.handle('library:clearRecords', () => {
    const removed = services.repos.downloads.deleteAllRecords();
    // Same reasoning at scale: "clear the history" that left the ledger intact
    // would produce an app that remembers nothing and downloads nothing.
    services.repos.linkLedger.clear();
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
