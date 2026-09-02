import type { Database } from 'better-sqlite3';
import {
  ACTIVE_FOR_DEDUP_STATUSES,
  IN_FLIGHT_STATUSES,
  type DuplicateAction,
  type QueueStatus,
  type SourceStrategy,
} from '@shared/types';
import type { ErrorCode } from '@shared/errors';

export interface QueueItemRow {
  id: number;
  position: number;
  batch_id: string;
  raw_url: string;
  canonical_url: string | null;
  aweme_id: string | null;
  status: QueueStatus;
  progress: number;
  bytes_done: number | null;
  bytes_total: number | null;
  attempt_count: number;
  error_code: ErrorCode | null;
  error_detail: string | null;
  duplicate_action: DuplicateAction | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  source_strategy: SourceStrategy | null;
  watermark_removed: number | null;
  /** 1-based ordinal within this batch — the number the user counted. */
  batch_index: number | null;
  /** Folder under the output directory; null means the output directory itself. */
  output_subdir: string | null;
  /** Per-batch caption override; null means follow the app setting. */
  caption_mode: string | null;
  /**
   * Milliseconds this video has already spent talking to TikTok, added up over
   * every attempt. The budget the engine spends; see `addBusyMs`.
   */
  busy_ms: number;
  /** The step currently running, from `PIPELINE_STAGES`; null when idle. */
  stage: string | null;
  /** The step an attempt failed at, kept after the failure so the row can say so. */
  failed_stage: string | null;
  /**
   * JSON: where the bytes are and which steps are already finished.
   *
   * Present only between a committed download and the item finishing. It is
   * what lets a retry resume rather than re-download; see the 010 migration.
   */
  resume_state: string | null;
  /**
   * JSON: the details TikTok returned, and when.
   *
   * Lets a resuming attempt skip the lookup entirely, and lets a refused
   * lookup fall back on a recent answer instead of failing the item. See the
   * 011 migration.
   */
  lookup: string | null;
}

export interface EnqueueInput {
  batchId: string;
  rawUrl: string;
  canonicalUrl?: string | null;
  awemeId?: string | null;
  status?: QueueStatus;
  /** Set for links that came from one account, so they are filed together. */
  outputSubdir?: string | null;
  captionMode?: string | null;
}

export interface QueueItemPatch {
  status?: QueueStatus;
  progress?: number;
  bytesDone?: number | null;
  bytesTotal?: number | null;
  canonicalUrl?: string | null;
  awemeId?: string | null;
  attemptCount?: number;
  errorCode?: ErrorCode | null;
  errorDetail?: string | null;
  duplicateAction?: DuplicateAction | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  sourceStrategy?: SourceStrategy | null;
  watermarkRemoved?: number | null;
  busyMs?: number;
  stage?: string | null;
  failedStage?: string | null;
  resumeState?: string | null;
  lookup?: string | null;
}

const POSITION_SEQ_KEY = 'queue_position_seq';

/**
 * Data access for the queue. Deliberately free of business logic — the state
 * machine, retry policy and dedup decisions live in queue/QueueEngine
 * (phase 3). This class only guarantees two things the engine depends on:
 * positions are unique and never reused, and ordering is always by position.
 */
export class QueueItemsRepository {
  constructor(private readonly db: Database) {}

  /**
   * Allocates the next position from a persisted counter rather than
   * MAX(position) + 1, so removing the last item never causes a later insert
   * to reuse its position (section 8).
   */
  private nextPosition(): number {
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM app_meta WHERE key = ?')
      .get(POSITION_SEQ_KEY);
    const next = (row ? Number(row.value) : 0) + 1;
    this.db
      .prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(POSITION_SEQ_KEY, String(next));
    return next;
  }

  /** Highest batch ordinal already used by this batch, or 0 when it is new. */
  private highestBatchIndex(batchId: string): number {
    const row = this.db
      .prepare<[string], { n: number | null }>('SELECT MAX(batch_index) AS n FROM queue_items WHERE batch_id = ?')
      .get(batchId);
    return row?.n ?? 0;
  }

  /**
   * Inserts a batch in the given array order, in one transaction.
   *
   * Atomicity is the point: pasting 200 links must produce 200 rows with 200
   * consecutive positions or none at all. A partial insert would leave gaps
   * that look like lost links.
   */
  enqueue(inputs: readonly EnqueueInput[], now: number = Date.now()): QueueItemRow[] {
    const insert = this.db.prepare(
      `INSERT INTO queue_items (
         position, batch_index, batch_id, raw_url, canonical_url, aweme_id, status, progress, attempt_count,
         created_at, output_subdir, caption_mode
       ) VALUES (@position, @batchIndex, @batchId, @rawUrl, @canonicalUrl, @awemeId, @status, 0, 0, @createdAt,
         @outputSubdir, @captionMode)`,
    );

    const run = this.db.transaction((items: readonly EnqueueInput[]): number[] => {
      const ids: number[] = [];
      // Counted per batch id rather than per call, so two pastes that happen to
      // share a batch continue the sequence instead of restarting it.
      const nextIndex = new Map<string, number>();

      for (const item of items) {
        const index = (nextIndex.get(item.batchId) ?? this.highestBatchIndex(item.batchId)) + 1;
        nextIndex.set(item.batchId, index);

        const result = insert.run({
          position: this.nextPosition(),
          batchIndex: index,
          batchId: item.batchId,
          rawUrl: item.rawUrl,
          canonicalUrl: item.canonicalUrl ?? null,
          awemeId: item.awemeId ?? null,
          outputSubdir: item.outputSubdir ?? null,
          captionMode: item.captionMode ?? null,
          status: item.status ?? 'queued',
          createdAt: now,
        });
        ids.push(Number(result.lastInsertRowid));
      }
      return ids;
    });

    const ids = run(inputs);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare<number[], QueueItemRow>(`SELECT * FROM queue_items WHERE id IN (${placeholders}) ORDER BY position ASC`)
      .all(...ids);
  }

  findById(id: number): QueueItemRow | undefined {
    return this.db.prepare<[number], QueueItemRow>('SELECT * FROM queue_items WHERE id = ?').get(id);
  }

  /** Always ORDER BY position — never by id, timestamp, or insertion into a Map (section 8). */
  listOrdered(): QueueItemRow[] {
    return this.db.prepare<[], QueueItemRow>('SELECT * FROM queue_items ORDER BY position ASC').all();
  }

  listByBatch(batchId: string): QueueItemRow[] {
    return this.db
      .prepare<[string], QueueItemRow>('SELECT * FROM queue_items WHERE batch_id = ? ORDER BY position ASC')
      .all(batchId);
  }

  /**
   * The order work is taken in: untried links first, then retries.
   *
   * `attempt_count` before `position`, and that ordering is a bug fix rather
   * than a preference. A failed item is requeued for its next attempt keeping
   * the position it already had, so with plain position ordering the engine
   * claimed it again immediately — ahead of every link behind it, at the front
   * of the queue, for every one of its attempts. At the default concurrency of
   * one, a link that took minutes to fail therefore held up the entire batch
   * for all four of its tries, and the user watched an hour pass with nothing
   * downloaded and eleven perfectly good links waiting behind the broken one.
   *
   * Sorting tried links behind untried ones costs nothing when everything
   * works — every item is on attempt zero, so this is plain position order —
   * and when something does fail, the rest of the batch runs to completion
   * first and the failure gets its remaining attempts at the end.
   *
   * Position is deliberately *not* rewritten to achieve this: `{index}` in the
   * filename template is the row's position, so moving rows around would
   * renumber files and leave gaps in a folder meant to read in order.
   */
  private static readonly WORK_ORDER = 'ORDER BY attempt_count ASC, position ASC';

  /** The next item to work on. */
  nextQueued(): QueueItemRow | undefined {
    return this.db
      .prepare<[], QueueItemRow>(
        `SELECT * FROM queue_items WHERE status = 'queued' ${QueueItemsRepository.WORK_ORDER} LIMIT 1`,
      )
      .get();
  }

  /**
   * Atomically takes the next queued item and marks it in flight.
   *
   * The SELECT and UPDATE are one statement on purpose: with concurrency up to
   * 4, a read-then-write would let two workers claim the same row and download
   * it twice. RETURNING gives back the row as claimed, so the caller never has
   * to re-read and wonder whether it changed underneath.
   *
   * The watermark columns are cleared on claim so a retry never displays the
   * previous attempt's badge while the new attempt is still running, and
   * `failed_stage` with them — the step that failed last time is history the
   * moment a new attempt starts, and leaving it would have the row claim to be
   * failing at a step it has not reached yet.
   *
   * `resume_state` is emphatically *not* cleared. It is the record of work
   * already done on a file that is already on disk, and clearing it here is
   * exactly the mistake that had retries download the same video twice.
   */
  claimNext(now: number = Date.now()): QueueItemRow | undefined {
    return this.db
      .prepare<[number], QueueItemRow>(
        `UPDATE queue_items
            SET status = 'resolving', started_at = ?, source_strategy = NULL, watermark_removed = NULL,
                failed_stage = NULL
          WHERE id = (
            SELECT id FROM queue_items WHERE status = 'queued' ${QueueItemsRepository.WORK_ORDER} LIMIT 1
          )
      RETURNING *`,
      )
      .get(now);
  }

  /**
   * Reassigns positions for a reorder (section 8: drag to reorder queued items).
   *
   * New positions are drawn from the sequence rather than swapped, so the
   * "never reused" guarantee survives a reorder. The visible consequence is
   * that reordered items sort after any already-terminal ones, which is
   * consistent with them genuinely being later in the processing order.
   */
  reposition(orderedIds: readonly number[]): void {
    const update = this.db.prepare('UPDATE queue_items SET position = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const id of orderedIds) update.run(this.nextPosition(), id);
    })();
  }


  /** Dedup layer 2: is this video already pending or in flight? */
  findActiveByAwemeId(awemeId: string): QueueItemRow | undefined {
    const placeholders = ACTIVE_FOR_DEDUP_STATUSES.map(() => '?').join(',');
    return this.db
      .prepare<string[], QueueItemRow>(
        `SELECT * FROM queue_items WHERE aweme_id = ? AND status IN (${placeholders}) ORDER BY position ASC LIMIT 1`,
      )
      .get(awemeId, ...ACTIVE_FOR_DEDUP_STATUSES);
  }

  /**
   * Adds to the time this video has cost the queue, and reports the new total.
   *
   * Added rather than set, in one statement, because two things write it: the
   * worker at the end of an attempt, and a restart that has no idea what the
   * previous process managed to spend. A read-then-write would lose one of
   * them and hand the item a budget it has already used.
   */
  addBusyMs(id: number, ms: number): number {
    if (ms <= 0) return this.findById(id)?.busy_ms ?? 0;
    const row = this.db
      .prepare<[number, number], { busy_ms: number }>(
        'UPDATE queue_items SET busy_ms = busy_ms + ? WHERE id = ? RETURNING busy_ms',
      )
      .get(Math.round(ms), id);
    return row?.busy_ms ?? 0;
  }

  update(id: number, patch: QueueItemPatch): QueueItemRow | undefined {
    const columns: Record<keyof QueueItemPatch, string> = {
      status: 'status',
      progress: 'progress',
      bytesDone: 'bytes_done',
      bytesTotal: 'bytes_total',
      canonicalUrl: 'canonical_url',
      awemeId: 'aweme_id',
      attemptCount: 'attempt_count',
      errorCode: 'error_code',
      errorDetail: 'error_detail',
      duplicateAction: 'duplicate_action',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      sourceStrategy: 'source_strategy',
      watermarkRemoved: 'watermark_removed',
      busyMs: 'busy_ms',
      stage: 'stage',
      failedStage: 'failed_stage',
      resumeState: 'resume_state',
      lookup: 'lookup',
    };

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns) as [keyof QueueItemPatch, string][]) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
    if (sets.length === 0) return this.findById(id);

    this.db.prepare(`UPDATE queue_items SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.findById(id);
  }

  /**
   * Crash recovery (section 8): anything that was mid-flight when the process
   * died goes back to `queued` so the engine picks it up in position order.
   * `.part` files are left untouched on purpose — they are the resume point.
   */
  resetInFlight(): number {
    const placeholders = IN_FLIGHT_STATUSES.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `UPDATE queue_items
            SET status = 'queued', progress = 0, started_at = NULL
          WHERE status IN (${placeholders})`,
      )
      .run(...IN_FLIGHT_STATUSES);
    return result.changes;
  }

  countsByStatus(): Record<string, number> {
    const rows = this.db
      .prepare<[], { status: QueueStatus; n: number }>('SELECT status, COUNT(*) AS n FROM queue_items GROUP BY status')
      .all();
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM queue_items WHERE id = ?').run(id);
  }

  listByStatus(statuses: readonly QueueStatus[]): QueueItemRow[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    return this.db
      .prepare<string[], QueueItemRow>(
        `SELECT * FROM queue_items WHERE status IN (${placeholders}) ORDER BY position ASC`,
      )
      .all(...statuses);
  }

  /**
   * The ids a bulk removal is about to delete.
   *
   * Needed because the renderer learns about removals one id at a time: a
   * delete that reports only "12 rows gone" leaves the UI showing all twelve.
   */
  idsByStatus(statuses: readonly QueueStatus[]): number[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    return this.db
      .prepare<QueueStatus[], { id: number }>(`SELECT id FROM queue_items WHERE status IN (${placeholders})`)
      .all(...[...statuses])
      .map((row) => row.id);
  }

  allIds(): number[] {
    return this.db.prepare<[], { id: number }>('SELECT id FROM queue_items').all().map((row) => row.id);
  }

  removeByStatus(statuses: readonly QueueStatus[]): number {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => '?').join(',');
    return this.db.prepare(`DELETE FROM queue_items WHERE status IN (${placeholders})`).run(...statuses).changes;
  }

  /** Clear queue (section 8) — terminal rows included; the confirmation is the UI's job. */
  removeAll(): number {
    return this.db.prepare('DELETE FROM queue_items').run().changes;
  }
}
