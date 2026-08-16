import type { Database } from 'better-sqlite3';

/**
 * The record of every link this app has settled.
 *
 * ## Why it keys on TikTok's ID and not on a file
 *
 * The question "have I already taken this video?" was previously answered by
 * joining downloads to videos and requiring `file_exists = 1` — which tied the
 * answer to a file still being exactly where the app had left it. Rename the
 * file, move it, or point the app at a different output folder, and the same
 * video downloads again. None of those actions mean the video was not taken.
 *
 * The aweme ID is TikTok's own, it is in the URL, and it never changes. Keyed
 * on that, the ledger survives all three. It records a `file_path` for
 * reference and nothing reads it back for this decision, deliberately: the
 * moment a path can change the answer, moving a folder starts re-downloading an
 * archive.
 *
 * ## Why an in-memory set rather than a query per link
 *
 * Not because SQLite is slow — an indexed primary-key lookup is measured in
 * microseconds, which is why the suggestion of a spreadsheet with a cache in
 * front of it would have been strictly slower and more fragile. It is because
 * listing an account produces hundreds of links at once and every one of them
 * is checked; one read at start-up and a set membership test per link keeps
 * that a single database round trip instead of hundreds.
 */

export type LedgerStatus =
  /** The file was produced. */
  | 'downloaded'
  /** A photo slideshow the user was asked about and declined. */
  | 'declined'
  /** No video track at all; nothing to offer, ever. */
  | 'unsupported';

export interface LedgerRow {
  readonly aweme_id: string;
  readonly handle: string | null;
  readonly status: LedgerStatus;
  readonly file_path: string | null;
  readonly settled_at: number;
}

export class LinkLedgerRepository {
  /** Loaded once; kept in step by every write that goes through this class. */
  private settled: Set<string> | null = null;

  constructor(private readonly db: Database) {}

  private index(): Set<string> {
    if (this.settled) return this.settled;
    const rows = this.db.prepare<[], { aweme_id: string }>('SELECT aweme_id FROM link_ledger').all();
    this.settled = new Set(rows.map((row) => row.aweme_id));
    return this.settled;
  }

  /**
   * True when this video has been settled, whatever the outcome was.
   *
   * All three statuses mean "do not offer this again" — a declined slideshow
   * and an unsupported post are as finished as a downloaded video, and asking
   * about them on every run is exactly what the user asked not to happen.
   */
  isSettled(awemeId: string): boolean {
    return this.index().has(awemeId);
  }

  /** The subset of these ids that has been settled, for filtering a listing. */
  settledAmong(awemeIds: readonly string[]): Set<string> {
    const index = this.index();
    return new Set(awemeIds.filter((id) => index.has(id)));
  }

  find(awemeId: string): LedgerRow | undefined {
    return this.db.prepare<[string], LedgerRow>('SELECT * FROM link_ledger WHERE aweme_id = ?').get(awemeId);
  }

  /**
   * Records an outcome. Later calls win, so a declined slideshow that is later
   * accepted becomes `downloaded` rather than staying declined forever.
   */
  record(input: {
    readonly awemeId: string;
    readonly handle?: string | null;
    readonly status: LedgerStatus;
    readonly filePath?: string | null;
    readonly now?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO link_ledger (aweme_id, handle, status, file_path, settled_at)
         VALUES (@awemeId, @handle, @status, @filePath, @settledAt)
         ON CONFLICT(aweme_id) DO UPDATE SET
           handle = COALESCE(excluded.handle, handle),
           status = excluded.status,
           file_path = COALESCE(excluded.file_path, file_path),
           settled_at = excluded.settled_at`,
      )
      .run({
        awemeId: input.awemeId,
        handle: input.handle ?? null,
        status: input.status,
        filePath: input.filePath ?? null,
        settledAt: input.now ?? Date.now(),
      });

    this.index().add(input.awemeId);
  }

  /** How many of an account's videos have been settled, for the run plan. */
  countForHandle(handle: string): number {
    return (
      this.db
        .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM link_ledger WHERE handle = ?')
        .get(handle)?.n ?? 0
    );
  }

  /** Forgetting one video, so it can be taken again on purpose. */
  forget(awemeId: string): void {
    this.db.prepare('DELETE FROM link_ledger WHERE aweme_id = ?').run(awemeId);
    this.index().delete(awemeId);
  }

  clear(): number {
    const changes = this.db.prepare('DELETE FROM link_ledger').run().changes;
    this.settled = new Set();
    return changes;
  }
}
