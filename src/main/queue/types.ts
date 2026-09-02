import type { PhotoAction, DuplicateAction, QueueStatus, SourceStrategy } from '@shared/types';
import { isPipelineStage, type PipelineStage, type StageState } from '@shared/stages';
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
  /**
   * True when the post is a set of images rather than a video and the user has
   * agreed to take it. The pipeline's video path does not apply: there is no
   * stream to select, nothing for ffprobe to verify and no watermark to
   * remove, so it branches to the slideshow downloader instead.
   */
  readonly photoPost?: boolean;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: PipelineProgress) => void;
  /**
   * The bytes are on disk under their final name.
   *
   * Called the instant that is true, and before anything that could still go
   * wrong. Everything after it — watermark removal, captions, colour, the
   * finishing pass — can fail, and when it does the item fails with it and the
   * queue retries. The retry finds the committed file, picks the next free
   * name, and downloads the whole video a second time under it. That is how
   * one video becomes two files, and it is not hypothetical: it is what
   * "downloading on repeat" turned out to be.
   *
   * Recording the video as taken here closes it. A retry then meets the
   * duplicate check like any other repeat link and asks, rather than quietly
   * fetching another copy.
   */
  readonly onCommitted?: (filePath: string) => void;
  /**
   * Which step is running, so the queue row can say more than "processing".
   *
   * Every step reports `started` and then exactly one of `done` or `skipped`.
   * The engine keeps the last `started` it saw, which is what it names when the
   * attempt throws — so a failure says *where* it failed rather than only what
   * the error was.
   */
  readonly onStage?: (stage: PipelineStage, state: StageState) => void;
  /**
   * Work that survives a failure, handed over the moment it is true.
   *
   * Called after every step whose result must not be produced twice, carrying
   * the accumulated state. The engine persists it, and hands it back as
   * `resume` on the next attempt.
   */
  readonly onResumable?: (state: ResumeState) => void;
  /**
   * What a previous attempt already finished, when there was one.
   *
   * Present only when the bytes are on disk. The pipeline then skips the
   * transfer and every step listed in `done`, and starts at the one that
   * failed — instead of fetching a video it already has.
   */
  readonly resume?: ResumeState;
}

/**
 * The note that turns a retry into a resumption.
 *
 * Persisted as JSON on the queue row between a committed download and the item
 * finishing, and deliberately small: a path, the steps already done, and the
 * conclusions those steps reached that the row would otherwise have to
 * recompute by redoing them.
 */
export interface ResumeState {
  /** The committed file. Nothing resumes without this actually existing. */
  readonly filePath: string;
  /** Steps finished, drawn from `ONCE_ONLY_STAGES`. */
  readonly done: readonly PipelineStage[];
  /** What the watermark pass concluded, so a resumed run keeps the right badge. */
  readonly sourceStrategy?: SourceStrategy;
  readonly watermarkRemoved?: boolean;
  readonly outroTrimmedMs?: number | null;
  /** Why captions were not applied, when they were wanted and did not happen. */
  readonly captionNote?: string | null;
  /** Size of the committed file, so progress can be reported without a stat. */
  readonly bytes?: number;
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
  /**
   * When the next automatic attempt is due, for an item waiting out a backoff.
   *
   * Null for everything else, including a failure that will not be retried.
   *
   * It exists because a failed row and a failed row that is about to try again
   * looked identical, and the difference is the whole of what the user needs to
   * know. A link that failed on a dropped connection sits there saying "The
   * connection dropped or timed out" for thirty seconds with nothing moving,
   * and the reasonable conclusion is that the app is stuck on it — so people
   * cancel the item, which is the one thing that guarantees it will not
   * download. Saying "trying again in 8s" turns the same wait into something
   * that is visibly working.
   */
  readonly nextAttemptAt: number | null;
  /**
   * The step running right now — "Removing the watermark", not "processing".
   *
   * The status column has four words for a job with seven steps, so a video
   * that had finished downloading and was being re-encoded looked exactly like
   * one that was stuck. This is the part that says which it is.
   */
  readonly stage: PipelineStage | null;
  /** The step the last attempt failed at, so the row can name it. */
  readonly failedStage: PipelineStage | null;
  /**
   * Steps already finished and banked, from a previous attempt.
   *
   * Non-empty means the video is on disk and a retry will pick up where it
   * left off rather than downloading it again — which is worth showing,
   * because "trying again" and "trying again from scratch" are very different
   * promises to someone watching a queue.
   */
  readonly stagesDone: readonly PipelineStage[];
}

export function toSnapshot(row: QueueItemRow, nextAttemptAt: number | null = null): QueueItemSnapshot {
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
    nextAttemptAt,
    stage: isPipelineStage(row.stage) ? row.stage : null,
    failedStage: isPipelineStage(row.failed_stage) ? row.failed_stage : null,
    stagesDone: readResumeState(row.resume_state)?.done ?? [],
  };
}

/**
 * Parses the resume note, treating anything malformed as absent.
 *
 * It is a text column holding JSON written by an older build, so it is parsed
 * defensively rather than trusted: a note that cannot be read means the item
 * starts over, which is the behaviour before this existed and is never worse
 * than acting on a shape that is not there.
 */
export function readResumeState(json: string | null): ResumeState | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.filePath !== 'string' || record.filePath === '') return null;

    const done = Array.isArray(record.done) ? record.done.filter(isPipelineStage) : [];
    return {
      filePath: record.filePath,
      done,
      ...(typeof record.sourceStrategy === 'string'
        ? { sourceStrategy: record.sourceStrategy as SourceStrategy }
        : {}),
      ...(typeof record.watermarkRemoved === 'boolean' ? { watermarkRemoved: record.watermarkRemoved } : {}),
      ...(typeof record.outroTrimmedMs === 'number' ? { outroTrimmedMs: record.outroTrimmedMs } : {}),
      ...(typeof record.captionNote === 'string' ? { captionNote: record.captionNote } : {}),
      ...(typeof record.bytes === 'number' ? { bytes: record.bytes } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The answer TikTok gave, and when it gave it.
 *
 * Kept on the row between attempts for two jobs. A resuming item — one whose
 * bytes are already on disk — reads it and skips the lookup altogether, because
 * the steps it has left are local ffmpeg work that needs no network at all. And
 * an attempt whose fresh lookup is *refused* reads it as a fallback, so a
 * request TikTok declined does not throw away an answer from four minutes ago
 * that is still perfectly true.
 */
export interface LookupCache {
  /** When the lookup succeeded. The fallback path will not use a stale one. */
  readonly at: number;
  readonly normalized: NormalizedUrl;
  readonly resolved: ResolvedVideo;
}

/**
 * Parses the cached lookup, treating anything malformed as absent.
 *
 * Parsed defensively rather than trusted for the same reason the resume note
 * is: it is a text column that an older build may have written in a different
 * shape. Losing it costs one network request; acting on a shape that is not
 * there would cost a crash inside the worker loop.
 */
export function readLookupCache(json: string | null): LookupCache | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;

    const normalized = record.normalized as NormalizedUrl | undefined;
    const resolved = record.resolved as ResolvedVideo | undefined;
    if (typeof record.at !== 'number') return null;
    if (!normalized || typeof normalized.awemeId !== 'string' || normalized.awemeId === '') return null;
    if (typeof normalized.canonicalUrl !== 'string' || normalized.canonicalUrl === '') return null;
    if (!resolved || typeof resolved.metadata !== 'object' || resolved.metadata === null) return null;
    if (!Array.isArray(resolved.streams)) return null;

    return { at: record.at, normalized, resolved };
  } catch {
    return null;
  }
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

/**
 * A slideshow waiting on an answer.
 *
 * Parked the same way a duplicate question is, and for the same reason: the
 * queue must keep moving while it waits. Section 7 calls a modal that halts a
 * 200-item batch a product defect, and a batch containing three slideshows
 * would otherwise stop three times.
 */
export interface PendingPhotoPost {
  readonly itemId: number;
  readonly batchId: string;
  readonly awemeId: string;
  readonly canonicalUrl: string;
  readonly caption: string | null;
  readonly authorHandle: string | null;
  /** How many images the post contains, when the extractor could say. */
  readonly imageCount: number | null;
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
  | { readonly type: 'photo-pending'; readonly pending: PendingPhotoPost }
  | { readonly type: 'photo-resolved'; readonly itemId: number; readonly action: PhotoAction }
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
