-- Negative keywords: an absolute, deterministic pre-judge override —
-- independent of filter_profile — mirroring the old blocked_companies
-- pattern. If a posting's title contains any declared keyword, it's
-- rejected before the AI judge (and before the positive title_keywords
-- gate) ever runs. negative_keyword_filtered tracks which postings were
-- caught by it, the same way keyword_filtered tracks the positive gate,
-- so Workflow-page stats can tell the two deterministic gates and the AI
-- judge's own rejections apart.
alter table public.settings
  add column negative_keywords text not null default '';

alter table public.postings
  add column negative_keyword_filtered boolean not null default false;
