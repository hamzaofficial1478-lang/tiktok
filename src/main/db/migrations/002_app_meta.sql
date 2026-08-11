-- 002_app_meta — a durable key/value table for engine bookkeeping.
--
-- Added because section 8 requires queue `position` to be "a monotonically
-- increasing integer, never reused". Deriving the next position from
-- MAX(position) + 1 silently breaks that promise: removing the last item (a
-- first-class action — "remove completed items") lowers the maximum, and the
-- next insert reuses a retired position. A persisted high-water mark is the
-- only way to keep the guarantee across deletions and restarts.
--
-- Seeded from existing rows so upgrading a populated library cannot collide
-- with positions already handed out.

CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO app_meta (key, value)
SELECT 'queue_position_seq', CAST(COALESCE(MAX(position), 0) AS TEXT) FROM queue_items;
