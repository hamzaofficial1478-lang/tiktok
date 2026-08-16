import type { DuplicateAction, QueueStatus, SourceStrategy } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import type { NormalizedUrl, ResolvedVideo } from '../resolve/types';
import type { QueueItemRow } from '../db/repositories/queue-items';

/**
 * Everything after resolution: pick a stream, download it, verify it,
 * post-process it, put it in place.
 *
 * An interface because phase 3 owns the queue and phase 4 owns the download.
 * The engine's ordering, retry and dedup behaviour can therefore be tested
 * against a fake that fails on demand, which is the only practical way to
 * exercise "network drops on item 3 of 200".
 */
export interface MediaPipeline {
  process(input: PipelineInput): Promise<PipelineResult>;
}

export interface PipelineInput {
  readonly item: QueueItemRow;
  readonly normalized: NormalizedUrl;
  readonly resolved: ResolvedVideo;
  /** Set when layer 3 produced a decision; 'replace' overwrites, 'redownload' suffixes. */
  readonly duplicateAction: DuplicateAction | null;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: PipelineProgress) => void;
}

export interface PipelineProgress {
  readonly bytesDone: number;
  readonly bytesTotal: number | null;
  /** Bytes per second, instantaneous. */
  readonly speed: number | null;
  readonly etaMs: number | null;
  /** True once the download is done and post-processing has begun. */
  readonly processing?: boolean;
}

export interface PipelineResult {
  readonly filePath: string;
  readonly fileSize: number | null;
  readonly sha256: string | null;
  readonly phash: string | null;
  readonly sourceStrategy: SourceStrategy;
  readonly watermarkRemoved: boolean;
  readonly outroTrimmedMs: number | null;
  /** Set when captions were wanted and not applied; says which step declined. */
  readonly captionNote?: string;
}

/** A queue row projected for the renderer — the read model of section 3. */
export interface QueueItemSnapshot {
  readonly id: number;
  readonly position: number;
  readonly batchId: string;
  readonly rawUrl: string;
  readonly canonicalUrl: string | null;
  readonly awemeId: string | null;
  readonly status: QueueStatus;
  readonly progress: number;
  readonly bytesDone: number | null;
  readonly bytesTotal: number | null;
  readonly attemptCount: number;
  readonly errorCode: ErrorCode | null;
  readonly errorDetail: string | null;
  readonly duplicateAction: DuplicateAction | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /**
   * How the file was obtained, written once the item completes. Null while the
   * item is still in flight — the queue row is honest about not knowing yet,
   * rather than defaulting to a value that would show a badge prematurely.
   */
  readonly sourceStrategy: SourceStrategy | null;
  readonly watermarkRemoved: boolean | null;
}

export function toSnapshot(row: QueueItemRow): QueueItemSnapshot {
  return {
    id: row.id,
    position: row.position,
    batchId: row.batch_id,
    rawUrl: row.raw_url,
    canonicalUrl: row.canonical_url,
    awemeId: row.aweme_id,
    status: row.status,
    progress: row.progress,
    bytesDone: row.bytes_done,
    bytesTotal: row.bytes_total,
    attemptCount: row.attempt_count,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    duplicateAction: row.duplicate_action,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    sourceStrategy: row.source_strategy,
    watermarkRemoved: row.watermark_removed === null ? null : row.watermark_removed === 1,
  };
}

/** A layer-3 question waiting for the user. Several may be outstanding at once. */
export interface PendingDuplicate {
  readonly itemId: number;
  readonly batchId: string;
  readonly awemeId: string;
  readonly caption: string | null;
  readonly authorHandle: string | null;
  readonly existingFilePath: string;
  readonly downloadedAt: number;
}

export interface BatchSummary {
  readonly batchId: string;
  readonly completed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly cancelled: number;
}

export type QueueEvent =
  | { readonly type: 'items-added'; readonly batchId: string; readonly items: readonly QueueItemSnapshot[] }
  | { readonly type: 'item-updated'; readonly item: QueueItemSnapshot }
  /**
   * Volatile transfer rate, deliberately separate from 'item-updated'.
   *
   * Speed and ETA are meaningless a second later and belong to no persisted
   * row, so they are pushed straight to the renderer instead of being written
   * to SQLite four times a second per active item.
   */
  | {
      readonly type: 'item-progress';
      readonly itemId: number;
      readonly bytesDone: number;
      readonly bytesTotal: number | null;
      readonly speed: number | null;
      readonly etaMs: number | null;
    }
  | { readonly type: 'item-removed'; readonly itemId: number }
  | { readonly type: 'duplicate-pending'; readonly pending: PendingDuplicate }
  | { readonly type: 'duplicate-resolved'; readonly itemId: number; readonly action: DuplicateAction }
  | { readonly type: 'batch-complete'; readonly summary: BatchSummary }
  | { readonly type: 'queue-state'; readonly running: boolean; readonly paused: boolean; readonly active: number };

export interface AddLinksResult {
  readonly batchId: string;
  readonly added: number;
  /** Layer 1: "42 links found · 3 duplicates removed". */
  readonly duplicatesRemoved: number;
  /** Layer 2 at add time, for links whose ID was known without a network call. */
  readonly alreadyInQueue: number;
  readonly invalid: readonly { readonly rawUrl: string; readonly code: ErrorCode }[];
  readonly totalFound: number;
}
