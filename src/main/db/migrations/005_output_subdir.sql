-- 005_output_subdir — the folder a batch's videos belong in.
--
-- Added for one case: a whole TikTok account queued from a profile link. Two
-- hundred videos from @creator landing loose in the output folder alongside
-- everything else is not a result anyone wanted, and the folder they belong in
-- has an obvious name — the account's.
--
-- Stored per item rather than per batch because the queue has no batch table:
-- `batch_id` is a column on these rows and nothing else. Per-item also means a
-- row keeps its destination through a restart, a reorder or a retry, which a
-- lookup against something transient would not.
--
-- Nullable, and null means the output folder itself. Individually pasted links
-- have no account in common and must not be filed under one.

ALTER TABLE queue_items ADD COLUMN output_subdir TEXT;
