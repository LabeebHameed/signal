drop index if exists watched_pages_next_check_idx;
alter table public.watched_pages
  drop column if exists check_interval_minutes,
  drop column if exists next_check_at;
