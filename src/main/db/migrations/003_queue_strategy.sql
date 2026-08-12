-- 003_queue_strategy — surface the watermark outcome on the queue row.
--
-- The strategy already lived in `downloads`, but the Queue screen shows rows
-- that have not finished yet and rows whose download row was later removed.
-- Reading it here means the badge is available the instant an item completes,
-- with no join, and it survives a restart.
--
-- Denormalised on purpose: `downloads` remains the record of what is on disk,
-- this is the record of what happened to the queue item.

ALTER TABLE queue_items ADD COLUMN source_strategy TEXT;
ALTER TABLE queue_items ADD COLUMN watermark_removed INTEGER;
