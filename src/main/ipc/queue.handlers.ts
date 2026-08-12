import { existsSync, rmSync } from 'node:fs';
import { AppError } from '@shared/errors';
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

  registry.handle('queue:addLinks', ({ urls }) => {
    const result = queue.addLinks(urls);
    // Pasting links is the user saying "download these"; making them press
    // start as well is a step with no decision in it.
    if (result.added > 0 && !queue.isRunning) queue.start();
    // The engine's result is readonly; the contract's is not, so copy rather
    // than cast — a cast here would hide a real shape mismatch later.
    return { ...result, invalid: result.invalid.map((entry) => ({ ...entry })) };
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

  registry.handle('library:deleteRecord', ({ downloadId }) => {
    services.repos.downloads.deleteRecord(downloadId);
    return { ok: true as const };
  });

  registry.handle('library:deleteFile', ({ downloadId }) => {
    const row = services.repos.downloads.findById(downloadId);
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
      case 'batch-complete':
        bus.emit('queue:batchComplete', event.summary);
        break;
      case 'queue-state':
        bus.emit('queue:state', { running: event.running, paused: event.paused, active: event.active });
        break;
    }
  });
}
