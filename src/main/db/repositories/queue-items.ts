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
}

export interface EnqueueInput {
  batchId: string;
  rawUrl: string;
  canonicalUrl?: string | null;
  awemeId?: string | null;
  status?: QueueStatus;
  /** Set for links that came from one account, so they are filed together. */
  outputSubdir?: string | null;
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
         created_at, output_subdir
       ) VALUES (@position, @batchIndex, @batchId, @rawUrl, @canonicalUrl, @awemeId, @status, 0, 0, @createdAt,
         @outputSubdir)`,
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

  /** The next item to work on: lowest position still queued. */
  nextQueued(): QueueItemRow | undefined {
    return this.db
      .prepare<[], QueueItemRow>("SELECT * FROM queue_items WHERE status = 'queued' ORDER BY position ASC LIMIT 1")
      .get();
  }

  /**
   * Atomically takes the lowest-position queued item and marks it in flight.
   *
   * The SELECT and UPDATE are one statement on purpose: with concurrency up to
   * 4, a read-then-write would let two workers claim the same row and download
   * it twice. RETURNING gives back the row as claimed, so the caller never has
   * to re-read and wonder whether it changed underneath.
   *
   * The watermark columns are cleared on claim so a retry never displays the
   * previous attempt's badge while the new attempt is still running.
   */
  claimNext(now: number = Date.now()): QueueItemRow | undefined {
    return this.db
      .prepare<[number], QueueItemRow>(
        `UPDATE queue_items
            SET status = 'resolving', started_at = ?, source_strategy = NULL, watermark_removed = NULL
          WHERE id = (SELECT id FROM queue_items WHERE status = 'queued' ORDER BY position ASC LIMIT 1)
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
