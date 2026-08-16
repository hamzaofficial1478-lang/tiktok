import type { Database } from 'better-sqlite3';
import type { CaptionMode } from '@shared/caption-schema';

/**
 * The saved list of accounts, and their per-account settings.
 *
 * Kept in the database rather than in config because it is the user's work
 * rather than their preference: ten accounts each with a count and a caption
 * choice is twenty minutes of setting up, and closing the app must not cost it.
 */

export interface CreatorRow {
  readonly id: number;
  readonly handle: string;
  readonly profile_url: string;
  readonly video_limit: number;
  readonly caption_mode: CaptionMode | null;
  readonly position: number;
  readonly enabled: number;
  readonly added_at: number;
  readonly last_queued_at: number | null;
  readonly videos_queued: number;
}

export interface CreatorInput {
  readonly handle: string;
  readonly profileUrl: string;
  readonly videoLimit?: number;
  readonly captionMode?: CaptionMode | null;
}

export interface CreatorPatch {
  readonly videoLimit?: number;
  readonly captionMode?: CaptionMode | null;
  readonly enabled?: boolean;
}

export class CreatorsRepository {
  constructor(private readonly db: Database) {}

  list(): CreatorRow[] {
    return this.db
      .prepare<[], CreatorRow>('SELECT * FROM creators ORDER BY position ASC, id ASC')
      .all();
  }

  findById(id: number): CreatorRow | undefined {
    return this.db.prepare<[number], CreatorRow>('SELECT * FROM creators WHERE id = ?').get(id);
  }

  /**
   * Adds accounts, skipping any already on the list.
   *
   * Silently skipping rather than erroring: pasting ten links of which three
   * are already saved is a completely ordinary thing to do, and it should add
   * seven rather than refuse all ten. The count of each is returned so the
   * screen can say what happened.
   */
  addMany(inputs: readonly CreatorInput[], now: number = Date.now()): { added: CreatorRow[]; skipped: string[] } {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO creators (handle, profile_url, video_limit, caption_mode, position, enabled, added_at)
       VALUES (@handle, @profileUrl, @videoLimit, @captionMode, @position, 1, @addedAt)`,
    );
    const nextPosition = this.db.prepare<[], { n: number | null }>(
      'SELECT MAX(position) AS n FROM creators',
    );

    const run = this.db.transaction((items: readonly CreatorInput[]) => {
      const added: number[] = [];
      const skipped: string[] = [];
      let position = (nextPosition.get()?.n ?? 0) + 1;

      for (const item of items) {
        const result = insert.run({
          handle: item.handle,
          profileUrl: item.profileUrl,
          videoLimit: item.videoLimit ?? 5,
          captionMode: item.captionMode ?? null,
          position,
          addedAt: now,
        });

        if (result.changes === 0) {
          skipped.push(item.handle);
          continue;
        }
        added.push(Number(result.lastInsertRowid));
        position++;
      }
      return { added, skipped };
    });

    const { added, skipped } = run(inputs);
    return {
      added: added.map((id) => this.findById(id)).filter((row): row is CreatorRow => row !== undefined),
      skipped,
    };
  }

  update(id: number, patch: CreatorPatch): CreatorRow | undefined {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if (patch.videoLimit !== undefined) {
      sets.push('video_limit = @videoLimit');
      params.videoLimit = patch.videoLimit;
    }
    // `captionMode: null` is a real value meaning "follow the app setting", so
    // it is distinguished from the key being absent rather than folded into it.
    if (patch.captionMode !== undefined) {
      sets.push('caption_mode = @captionMode');
      params.captionMode = patch.captionMode;
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = @enabled');
      params.enabled = patch.enabled ? 1 : 0;
    }

    if (sets.length > 0) {
      this.db.prepare(`UPDATE creators SET ${sets.join(', ')} WHERE id = @id`).run(params);
    }
    return this.findById(id);
  }

  /** Records what a run took, so the screen can show it without recounting. */
  recordRun(id: number, queued: number, now: number = Date.now()): void {
    this.db
      .prepare('UPDATE creators SET last_queued_at = ?, videos_queued = videos_queued + ? WHERE id = ?')
      .run(now, queued, id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM creators WHERE id = ?').run(id);
  }

  removeAll(): number {
    return this.db.prepare('DELETE FROM creators').run().changes;
  }

  /** Reorders by the given ids; anything omitted keeps its relative place after them. */
  reorder(orderedIds: readonly number[]): void {
    const update = this.db.prepare('UPDATE creators SET position = ? WHERE id = ?');
    this.db.transaction(() => {
      orderedIds.forEach((id, index) => update.run(index + 1, id));
    })();
  }
}
