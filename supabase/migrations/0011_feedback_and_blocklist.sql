-- Filtering-quality improvements:
-- 1. postings.user_status: what the seeker did with a posting after seeing
--    it. Feeds straight back into the judge's calibration context on every
--    future screening call (see loadCalibration in poll-pages).
-- 2. settings.blocked_companies: absolute negative-signal override — a
--    posting from a blocked company is filtered deterministically, before
--    it ever reaches the LLM judge.
-- 3. settings.min_score: notify only when the judge's score clears this
--    bar, layered on top of the existing off/balanced/strict verdict mode.

alter table public.postings
  add column user_status text not null default 'none'
    check (user_status in ('none', 'interested', 'not_interested', 'applied', 'interviewing', 'offer', 'rejected')),
  add column user_status_at timestamptz;

create index postings_user_status_idx on public.postings (user_status) where user_status <> 'none';

alter table public.settings
  add column blocked_companies text not null default '',
  add column min_score integer not null default 0 check (min_score between 0 and 100);
