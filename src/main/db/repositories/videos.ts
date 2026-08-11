import type { Database } from 'better-sqlite3';

export interface VideoRow {
  id: number;
  aweme_id: string;
  canonical_url: string;
  author_handle: string | null;
  author_name: string | null;
  caption: string | null;
  duration_ms: number | null;
  cover_url: string | null;
  music_title: string | null;
  uploaded_at: number | null;
  first_seen_at: number;
}

export interface VideoInput {
  awemeId: string;
  canonicalUrl: string;
  authorHandle?: string | null;
  authorName?: string | null;
  caption?: string | null;
  durationMs?: number | null;
  coverUrl?: string | null;
  musicTitle?: string | null;
  uploadedAt?: number | null;
}

/**
 * `videos` is keyed by `aweme_id` — the dedup key of section 7. One row per
 * TikTok video ever seen, regardless of how many times it was downloaded;
 * repeat downloads add `downloads` rows, not `videos` rows.
 */
export class VideosRepository {
  constructor(private readonly db: Database) {}

  findByAwemeId(awemeId: string): VideoRow | undefined {
    return this.db.prepare<[string], VideoRow>('SELECT * FROM videos WHERE aweme_id = ?').get(awemeId);
  }

  findById(id: number): VideoRow | undefined {
    return this.db.prepare<[number], VideoRow>('SELECT * FROM videos WHERE id = ?').get(id);
  }

  /**
   * Insert, or refresh metadata for a video already known.
   *
   * COALESCE(excluded.x, videos.x) means a later resolve that returns partial
   * metadata cannot blank out fields captured earlier. `first_seen_at` is
   * never overwritten — it records when the library first saw the video, which
   * is not the same as when it was last downloaded.
   */
  upsert(input: VideoInput, now: number = Date.now()): VideoRow {
    this.db
      .prepare(
        `INSERT INTO videos (
           aweme_id, canonical_url, author_handle, author_name, caption,
           duration_ms, cover_url, music_title, uploaded_at, first_seen_at
         ) VALUES (
           @awemeId, @canonicalUrl, @authorHandle, @authorName, @caption,
           @durationMs, @coverUrl, @musicTitle, @uploadedAt, @firstSeenAt
         )
         ON CONFLICT(aweme_id) DO UPDATE SET
           canonical_url = excluded.canonical_url,
           author_handle = COALESCE(excluded.author_handle, videos.author_handle),
           author_name   = COALESCE(excluded.author_name,   videos.author_name),
           caption       = COALESCE(excluded.caption,       videos.caption),
           duration_ms   = COALESCE(excluded.duration_ms,   videos.duration_ms),
           cover_url     = COALESCE(excluded.cover_url,     videos.cover_url),
           music_title   = COALESCE(excluded.music_title,   videos.music_title),
           uploaded_at   = COALESCE(excluded.uploaded_at,   videos.uploaded_at)`,
      )
      .run({
        awemeId: input.awemeId,
        canonicalUrl: input.canonicalUrl,
        authorHandle: input.authorHandle ?? null,
        authorName: input.authorName ?? null,
        caption: input.caption ?? null,
        durationMs: input.durationMs ?? null,
        coverUrl: input.coverUrl ?? null,
        musicTitle: input.musicTitle ?? null,
        uploadedAt: input.uploadedAt ?? null,
        firstSeenAt: now,
      });

    const row = this.findByAwemeId(input.awemeId);
    if (!row) throw new Error(`upsert failed to produce a row for aweme_id ${input.awemeId}`);
    return row;
  }
}
