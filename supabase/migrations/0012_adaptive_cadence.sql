-- Adaptive check cadence: a page that keeps coming back unchanged is
-- checked less often (up to every 6h); a page whose content just changed
-- goes back to checking every 15 min; a page that's failing backs off
-- exponentially (up to 24h) instead of being hammered every cron tick
-- forever (dailyremote.com/himalayas.app etc. had climbed past 20 straight
-- failures under the old flat 15-min-for-everyone schedule).
--
-- check_interval_minutes: current steady-state interval for this page
-- (doubles on unchanged, resets to 15 on a real content change).
-- next_check_at: when this page is next due; null means "due now" so brand
-- new pages are always picked up on the very next poll. Only a scheduled
-- (cron) run respects this — "Check now" always forces every active page.

alter table public.watched_pages
  add column check_interval_minutes integer not null default 15,
  add column next_check_at timestamptz;

create index watched_pages_next_check_idx on public.watched_pages (next_check_at) where active;
