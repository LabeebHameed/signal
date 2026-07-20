-- Remembers which fetch strategy (direct / direct-alt / proxy:pure /
-- greenhouse / lever / ashby / rss) last worked for each watched page, so
-- the poller tries the winner first on the next crawl instead of
-- re-discovering it — see _shared/fetcher.ts and _shared/ats.ts.

alter table public.watched_pages
  add column fetch_strategy text;
