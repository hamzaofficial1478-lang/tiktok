-- 008_link_ledger — every link this app has ever settled, by TikTok's own ID.
--
-- The record that decides "have I already taken this?", and it deliberately
-- knows nothing about files. The previous answer to that question joined
-- downloads to videos and required `file_exists = 1`, which tied the decision
-- to a file still being where the app left it: rename it, move it, or point the
-- app at a different output folder, and the same video downloads again. None of
-- those actions mean the video was not taken.
--
-- The aweme ID is TikTok's, it is in the URL, and it never changes. Keying on
-- it makes the ledger survive every one of those.
--
-- `status` is what lets a decision be remembered rather than re-asked:
--   downloaded  the file was produced
--   declined    the user was asked about a photo slideshow and said no
--   unsupported the post has no video track and cannot be downloaded at all
-- All three mean "do not offer this again"; only the first means a file exists.

CREATE TABLE IF NOT EXISTS link_ledger (
  aweme_id     TEXT PRIMARY KEY,
  handle       TEXT,
  status       TEXT NOT NULL,
  -- Where it went, when it went anywhere. Informational: nothing keys off it,
  -- precisely so that moving the file cannot change the ledger's answer.
  file_path    TEXT,
  settled_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_handle ON link_ledger(handle);

-- Backfill from what is already known, so an existing library is not re-taken.
INSERT OR IGNORE INTO link_ledger (aweme_id, handle, status, file_path, settled_at)
SELECT v.aweme_id, v.author_handle, 'downloaded', d.file_path, d.completed_at
  FROM downloads d
  JOIN videos v ON v.id = d.video_id;
