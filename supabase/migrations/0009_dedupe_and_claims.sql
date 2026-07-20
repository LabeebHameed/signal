-- Fixes duplicate/repeat notifications reported in production:
--
-- 1. poll_claimed_at: an atomic per-page lock so an overlapping cron tick, a
--    manual "Check now", and chained batches can never process the same page
--    at once and both send the same notification.
-- 2. content_key + duplicate_of: cross-source dedup -- the same job posted to
--    several watched pages is only ever notified once.
-- 3. last_seen_at: refreshed on every crawl a posting still appears in,
--    laying the groundwork for stale/reposted detection.

alter table public.watched_pages
  add column poll_claimed_at timestamptz;

alter table public.postings
  add column content_key text,
  add column last_seen_at timestamptz not null default now(),
  add column duplicate_of uuid references public.postings(id) on delete set null;

create index postings_content_key_idx on public.postings (content_key) where content_key is not null;
create index postings_duplicate_of_idx on public.postings (duplicate_of) where duplicate_of is not null;
