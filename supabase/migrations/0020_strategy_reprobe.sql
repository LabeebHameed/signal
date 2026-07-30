-- Bound the cost of the link-aware strategy probe added alongside this
-- migration (see selectAttempt in _shared/fetcher.ts).
--
-- Background: fetch_strategy remembers whichever strategy last produced
-- usable content and retries it first forever. That made a single unlucky
-- pick permanent — nodesk.co landed on the pure.md reader proxy, which
-- returns the page's job titles and salaries but none of its job links, and
-- stayed pinned there while 199 postings were stored with no URL at all. The
-- fetcher now treats a link-free result as a degraded render and keeps
-- walking the chain, which un-pins that page on its next poll.
--
-- The tradeoff is that a page which genuinely has no links would re-run the
-- whole four-strategy chain on every single poll. This column caps that: when
-- a full probe finishes and still found nothing better than a link-free
-- result, the page is excused from probing until this timestamp, and the
-- fetcher goes back to accepting its preferred strategy on the first try.
-- Cleared the moment any strategy does return links.
--
-- Null means "probe normally", which is the right default for every existing
-- row: they should all get one full probe on their next poll.

alter table public.watched_pages
  add column strategy_probe_after timestamptz;

comment on column public.watched_pages.strategy_probe_after is
  'Skip the full fetch-strategy re-probe until this time; set only after a probe found no link-bearing strategy. Null = probe normally.';
