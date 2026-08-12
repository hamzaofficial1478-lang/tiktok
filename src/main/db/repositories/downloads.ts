import type { Database } from 'better-sqlite3';
import type { SourceStrategy } from '@shared/types';

export interface DownloadRow {
  id: number;
  video_id: number;
  file_path: string;
  file_size: number | null;
  sha256: string | null;
  phash: string | null;
  source_strategy: SourceStrategy | null;
  watermark_removed: number;
  outro_trimmed_ms: number | null;
  completed_at: number;
  file_exists: number;
}

/** A download joined with the video it came from — what dedup layer 3's modal shows. */
export interface DownloadWithVideo extends DownloadRow {
  aweme_id: string;
  author_handle: string | null;
  caption: string | null;
}

/** One row of the Library grid. */
export interface LibraryRow {
  download_id: number;
  file_path: string;
  file_size: number | null;
  source_strategy: SourceStrategy | null;
  watermark_removed: number;
  outro_trimmed_ms: number | null;
  completed_at: number;
  file_exists: number;
  aweme_id: string;
  canonical_url: string;
  author_handle: string | null;
  author_name: string | null;
  caption: string | null;
  duration_ms: number | null;
  cover_url: string | null;
  possible_repost: number;
}

export interface DownloadInput {
  videoId: number;
  filePath: string;
  fileSize?: number | null;
  sha256?: string | null;
  phash?: string | null;
  sourceStrategy?: SourceStrategy | null;
  watermarkRemoved: boolean;
  outroTrimmedMs?: number | null;
  completedAt?: number;
}

export class DownloadsRepository {
  constructor(private readonly db: Database) {}

  insert(input: DownloadInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO downloads (
           video_id, file_path, file_size, sha256, phash, source_strategy,
           watermark_removed, outro_trimmed_ms, completed_at, file_exists
         ) VALUES (
           @videoId, @filePath, @fileSize, @sha256, @phash, @sourceStrategy,
           @watermarkRemoved, @outroTrimmedMs, @completedAt, 1
         )`,
      )
      .run({
        videoId: input.videoId,
        filePath: input.filePath,
        fileSize: input.fileSize ?? null,
        sha256: input.sha256 ?? null,
        phash: input.phash ?? null,
        sourceStrategy: input.sourceStrategy ?? null,
        watermarkRemoved: input.watermarkRemoved ? 1 : 0,
        outroTrimmedMs: input.outroTrimmedMs ?? null,
        completedAt: input.completedAt ?? Date.now(),
      });
    return Number(result.lastInsertRowid);
  }

  findByVideoId(videoId: number): DownloadRow[] {
    return this.db
      .prepare<[number], DownloadRow>('SELECT * FROM downloads WHERE video_id = ? ORDER BY completed_at DESC')
      .all(videoId);
  }

  /**
   * Dedup layer 3's question: has this video been downloaded before, and is
   * the file still on disk?
   *
   * `file_exists = 1` is part of the query rather than a caller-side check
   * because section 7 is explicit — a history row whose file the user deleted
   * must re-download silently, not prompt.
   */
  findExistingByAwemeId(awemeId: string): DownloadWithVideo | undefined {
    return this.db
      .prepare<[string], DownloadWithVideo>(
        `SELECT d.*, v.aweme_id, v.author_handle, v.caption
           FROM downloads d
           JOIN videos v ON v.id = d.video_id
          WHERE v.aweme_id = ? AND d.file_exists = 1
          ORDER BY d.completed_at DESC
          LIMIT 1`,
      )
      .get(awemeId);
  }

  /** Called when a file is found missing, so the next add re-downloads without prompting. */
  markFileMissing(id: number): void {
    this.db.prepare('UPDATE downloads SET file_exists = 0 WHERE id = ?').run(id);
  }

  /**
   * The Library screen's query (section 10).
   *
   * `possible_repost` is computed in SQL rather than per row in JS: at a few
   * thousand downloads, N+1 lookups for repost badges would make the grid
   * visibly slow to open.
   */
  listLibrary(options: { search?: string; limit?: number; offset?: number } = {}): {
    entries: LibraryRow[];
    total: number;
  } {
    const search = options.search?.trim() ?? '';
    const like = `%${search.toLowerCase()}%`;
    /**
     * Single quotes, not double: SQLite reads a double-quoted token as an
     * identifier, so COALESCE(v.caption, "") looks for a column named "" and
     * the whole search fails.
     *
     * The needle itself is bound as @like, never interpolated — a caption
     * containing a quote or a % is data, not syntax.
     */
    const where =
      search === ''
        ? ''
        : `WHERE lower(COALESCE(v.caption, '')) LIKE @like OR lower(COALESCE(v.author_handle, '')) LIKE @like`;

    const total = this.db
      .prepare<{ like: string }, { n: number }>(
        `SELECT COUNT(*) AS n FROM downloads d JOIN videos v ON v.id = d.video_id ${where}`,
      )
      .get({ like })?.n ?? 0;

    const entries = this.db
      .prepare<{ like: string; limit: number; offset: number }, LibraryRow>(
        `SELECT
           d.id AS download_id, d.file_path, d.file_size, d.source_strategy,
           d.watermark_removed, d.outro_trimmed_ms, d.completed_at, d.file_exists,
           v.aweme_id, v.canonical_url, v.author_handle, v.author_name, v.caption,
           v.duration_ms, v.cover_url,
           EXISTS (
             SELECT 1 FROM downloads other
             WHERE other.phash IS NOT NULL AND other.phash = d.phash AND other.video_id != d.video_id
           ) AS possible_repost
         FROM downloads d
         JOIN videos v ON v.id = d.video_id
         ${where}
         ORDER BY d.completed_at DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ like, limit: options.limit ?? 200, offset: options.offset ?? 0 });

    return { entries, total };
  }

  deleteRecord(downloadId: number): void {
    this.db.prepare('DELETE FROM downloads WHERE id = ?').run(downloadId);
  }

  findById(id: number): DownloadRow | undefined {
    return this.db.prepare<[number], DownloadRow>('SELECT * FROM downloads WHERE id = ?').get(id);
  }

  /**
   * Dedup layer 4: same content under a different aweme_id, i.e. a repost.
   * Returns candidates only — perceptual hashing has false positives, so
   * section 7 requires this to badge rather than block.
   */
  findRepostCandidates(phash: string, excludeVideoId: number): DownloadWithVideo[] {
    return this.db
      .prepare<[string, number], DownloadWithVideo>(
        `SELECT d.*, v.aweme_id, v.author_handle, v.caption
           FROM downloads d
           JOIN videos v ON v.id = d.video_id
          WHERE d.phash = ? AND d.video_id != ?`,
      )
      .all(phash, excludeVideoId);
  }
}
