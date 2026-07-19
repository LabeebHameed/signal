-- Pay/compensation as extracted from the posting, verbatim (e.g. "$150K - $200K").
-- Shown in the Telegram notification when the page states it; null otherwise.
alter table public.postings add column compensation text;
