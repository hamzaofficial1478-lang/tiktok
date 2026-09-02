-- 010_item_stage — which step a download is on, and how far it got.
--
-- A download is seven steps, not one: look the video up, transfer it, check it,
-- measure its colour, remove the watermark, add captions, finish and sharpen.
-- The queue row recorded none of that. It said "downloading" for the transfer
-- and "processing" for everything after it, so a video sitting at 100% for four
-- minutes gave no clue whether it was re-encoding, transcribing or stuck — and a
-- failure named the error but never the step that produced it. "It failed" and
-- "it failed at the finishing pass" arrived as the same message.
--
-- `stage` and `failed_stage` are the visible half of that. `resume_state` is the
-- half that fixes a real defect:
--
-- Everything after the bytes land — the watermark pass, captions, the finishing
-- encode, and the library write that follows them — runs on a file that already
-- exists under its final name. When one of those failed, the item failed with
-- it, the queue retried, and the retry started from the link. It re-extracted,
-- re-transferred, and — finding the first copy already sitting in the output
-- folder — saved the second one beside it under the next free name. One video,
-- downloaded twice, for a fault in a step that had nothing to do with
-- downloading. That is what "it keeps downloading the same videos again and
-- again" was.
--
-- `resume_state` is the JSON note that stops it: the path the bytes are at, the
-- steps already finished, and what those steps concluded. A retry reads it,
-- skips straight past the transfer, and does the step that failed. Steps that
-- only measure or read are left out of the note deliberately — they are cheap,
-- their results feed the steps after them, and a resumed attempt needs them
-- fresh.
--
-- All three are nullable and cleared when an item finishes, so a completed row
-- carries no leftover state and an untouched database needs no backfill.

ALTER TABLE queue_items ADD COLUMN stage TEXT;
ALTER TABLE queue_items ADD COLUMN failed_stage TEXT;
ALTER TABLE queue_items ADD COLUMN resume_state TEXT;
