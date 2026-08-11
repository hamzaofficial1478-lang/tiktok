-- 001_init — the schema exactly as specified in section 5 of the brief.
--
-- Deliberately verbatim: no speculative columns, no tables for features that
-- do not exist yet. Named output presets and per-item notes/tags (section 12)
-- arrive in their own migration when those features are built, which also
-- proves the migration path works on real user data rather than on day one.
--
-- All timestamps are epoch milliseconds.

CREATE TABLE videos (
  id                INTEGER PRIMARY KEY,
  aweme_id          TEXT UNIQUE NOT NULL,   -- canonical TikTok video ID; the dedup key
  canonical_url     TEXT NOT NULL,
  author_handle     TEXT,
  author_name       TEXT,
  caption           TEXT,
  duration_ms       INTEGER,
  cover_url         TEXT,
  music_title       TEXT,
  uploaded_at       INTEGER,
  first_seen_at     INTEGER NOT NULL
);

CREATE TABLE downloads (
  id                INTEGER PRIMARY KEY,
  video_id          INTEGER NOT NULL REFERENCES videos(id),
  file_path         TEXT NOT NULL,
  file_size         INTEGER,
  sha256            TEXT,
  phash             TEXT,                   -- perceptual hash, for repost detection
  source_strategy   TEXT,                   -- 'clean_source' | 'removelogo' | 'blur' | 'raw'
  watermark_removed INTEGER NOT NULL,
  outro_trimmed_ms  INTEGER,
  completed_at      INTEGER NOT NULL,
  file_exists       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE queue_items (
  id                INTEGER PRIMARY KEY,
  position          INTEGER NOT NULL,       -- insertion order; never reused
  batch_id          TEXT NOT NULL,
  raw_url           TEXT NOT NULL,
  canonical_url     TEXT,
  aweme_id          TEXT,
  status            TEXT NOT NULL,
  progress          REAL NOT NULL DEFAULT 0,
  bytes_done        INTEGER,
  bytes_total       INTEGER,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,
  error_detail      TEXT,
  duplicate_action  TEXT,                   -- null | 'skip' | 'redownload' | 'replace'
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  finished_at       INTEGER
);

CREATE INDEX idx_queue_position ON queue_items(position);
CREATE INDEX idx_queue_status   ON queue_items(status);

-- Supporting indexes for the dedup lookups in section 7. Layer 3 asks
-- "has this aweme_id been downloaded, and does the file still exist" on every
-- single queued item, so it must not be a table scan at 300 items.
CREATE INDEX idx_downloads_video    ON downloads(video_id);
CREATE INDEX idx_downloads_phash    ON downloads(phash);
CREATE INDEX idx_queue_aweme        ON queue_items(aweme_id);
CREATE INDEX idx_queue_batch        ON queue_items(batch_id);
