-- Postings improvements:
-- 1. pending_notify: notification queue flag. New (non-baseline) postings are
--    inserted with pending_notify = true; a successful Telegram send flips it
--    to false and stamps notified_at. Failed sends stay pending and retry on
--    the next poll run instead of being silently lost.
-- 2. posted_at / posted_text: when the source page shows a "posted" date for
--    a job ("2 days ago", "Posted Mar 3"), the extractor records it — the ISO
--    date in posted_at (best effort) and the verbatim text in posted_text.

alter table public.postings
  add column pending_notify boolean not null default false,
  add column posted_at date,
  add column posted_text text;

create index postings_pending_notify_idx on public.postings (page_id) where pending_notify;
