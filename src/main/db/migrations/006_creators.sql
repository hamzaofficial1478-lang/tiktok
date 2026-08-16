-- 006_creators — the saved list of accounts to pull from.
--
-- A table rather than a config key, for one reason that decides the rest: this
-- list is the user's work. Ten accounts, each with its own count and its own
-- caption choice, is twenty minutes of setting up, and closing the app must
-- not cost it. Config is for preferences; anything that took effort to enter
-- belongs in the database beside the queue it feeds.
--
-- `last_queued_at` and `videos_queued` exist so the screen can say what has
-- already been taken from each account without recounting the library on every
-- render, and so a second run knows the first one happened.

CREATE TABLE IF NOT EXISTS creators (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Lower-cased, without the @. Unique: the same account added twice is the
  -- same account, and two rows for it would download everything twice.
  handle         TEXT    NOT NULL UNIQUE,
  profile_url    TEXT    NOT NULL,
  -- How many of the newest not-yet-downloaded videos to take per run.
  video_limit    INTEGER NOT NULL DEFAULT 5,
  -- Per-creator overrides. NULL means "use the app's current setting", which
  -- is what keeps a row honest after the global default changes.
  caption_mode   TEXT,
  -- Order the user put them in, and the order runs happen in.
  position       INTEGER NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  added_at       INTEGER NOT NULL,
  last_queued_at INTEGER,
  videos_queued  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_creators_position ON creators(position);
