-- 012_ledger_handle_case — one spelling of a handle, so the per-account count works.
--
-- The saved creator list stores handles lowercased: `parseProfile` normalises
-- them, so "@Creator" and "@creator" are the same account and cannot be added
-- twice. The ledger did not. It recorded whatever the extractor reported for
-- the video, which is TikTok's own field and comes back in whatever case the
-- account uses.
--
-- The two are compared directly — `countForHandle(creator.handle)` — and a run
-- asks it exactly one question: how many of this account's videos do I already
-- have? An answer of zero for an account with five on disk means the run treats
-- it as untouched and takes five more, which is the same afternoon of repeat
-- downloading arriving by a different route.
--
-- Lowercasing here and on every write makes the two sides agree. It cannot
-- collide: TikTok handles are already case-insensitive, so two rows that differ
-- only in case were always the same account.

UPDATE link_ledger SET handle = LOWER(handle) WHERE handle IS NOT NULL;
