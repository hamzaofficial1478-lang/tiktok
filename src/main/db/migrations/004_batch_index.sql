-- 004_batch_index — the 1-based ordinal of an item within its own paste.
--
-- `position` already records order, but it is drawn from a global sequence that
-- never resets or reuses a value, which is what makes ordering and crash
-- recovery reliable. It is therefore useless as a filename prefix: the second
-- batch of the day starts at 301, not 1.
--
-- This column is the number the user actually counted — link 1, link 2 — fixed
-- at enqueue time so it survives restarts, reorders and retries. Nullable
-- because rows created before this migration genuinely have no batch ordinal;
-- the template falls back to `position` for those.

ALTER TABLE queue_items ADD COLUMN batch_index INTEGER;

-- Backfill: rank existing rows within each batch by position, which is the
-- order they were pasted in.
UPDATE queue_items
   SET batch_index = (
     SELECT COUNT(*)
       FROM queue_items AS earlier
      WHERE earlier.batch_id = queue_items.batch_id
        AND earlier.position <= queue_items.position
   );
