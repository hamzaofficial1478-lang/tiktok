-- 007_item_caption_mode — a caption choice that belongs to the batch.
--
-- The creators table has carried `caption_mode` since it was added, and until
-- now nothing read it: a per-account setting that saved, displayed, and did
-- nothing. The gap was between the two — a creator's choice had no way to
-- travel with the videos it queued, because the queue only knew the app-wide
-- setting.
--
-- NULL means "use whatever the app setting is when this item runs", which is
-- the right default for a link pasted by hand and the only honest answer for
-- rows created before this column existed.

ALTER TABLE queue_items ADD COLUMN caption_mode TEXT;
