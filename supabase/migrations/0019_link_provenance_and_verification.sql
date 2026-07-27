-- Link provenance and verification: the posting link is the one thing the
-- user actually acts on, and until now it carried no provenance at all — a
-- real Greenhouse absolute_url and a URL the extraction model invented out of
-- flattened page text were stored in the same nullable `url` column,
-- indistinguishable. These columns record where a link came from, whether it
-- has been proven to actually resolve to this posting, and the attempts made
-- to prove (or repair) it.
--
-- Deliberately NO backfill and NO data migration here. Every row that exists
-- today keeps link_source = 'unknown' / link_verification = 'unverified',
-- which is the honest description of it, makes the UI stop presenting those
-- links as trustworthy, and — because the verification queue's index
-- predicate below excludes 'unknown' — guarantees the first poll after this
-- migration cannot sweep the back catalogue into a burst of verification
-- traffic. Historic rows regain real provenance only when their page is next
-- crawled and the row is seen again (see the re-crawl repair step in
-- poll-pages), and get verified from there like any other row.

alter table public.postings
  -- How postings.url was obtained:
  --   unknown  = predates this migration — never checked, never will be
  --   platform = straight from an ATS/RSS feed (Greenhouse absolute_url, etc.)
  --   cited    = the extraction model cited a numbered anchor read off the page
  --   matched  = recovered by matching the posting title against anchor text
  --   none     = no defensible link was found (url is null)
  add column link_source text not null default 'unknown'
    check (link_source in ('unknown', 'platform', 'cited', 'matched', 'none')),
  -- Outcome of the live HTTP check:
  --   unverified    = not checked yet (or not eligible for checking)
  --   verified      = fetched and the page really is this posting
  --   indeterminate = 401/403/429/5xx/timeout/anti-bot wall — NOT evidence
  --                   the link is wrong, just that we couldn't confirm it
  --   mismatch      = fetched fine, but the page is not this posting
  --   dead          = 404/410
  add column link_verification text not null default 'unverified'
    check (link_verification in ('unverified', 'verified', 'indeterminate', 'mismatch', 'dead')),
  -- The post-redirect URL, when it differs from the stored one — captured on
  -- verification so shortener/tracker links get canonicalized for free.
  add column link_final_url text,
  add column link_checked_at timestamptz,
  add column link_check_attempts integer not null default 0,
  -- When this row is next eligible for a verification/recovery attempt.
  add column link_retry_after timestamptz,
  -- One human-readable sentence: why a link is unconfirmed, or how it was
  -- recovered, or why a candidate href was rejected.
  add column link_note text,
  -- Title <-> anchor-text agreement, 0..1. Used for duplicate-href
  -- tie-breaks and auditing — never as a gate on an otherwise-valid citation.
  add column link_score real,
  -- Audit trail of every check/recovery attempt: [{url, outcome, at}, ...].
  -- Recovery also reads this to exclude hrefs already proven wrong.
  add column link_attempts jsonb not null default '[]'::jsonb;

-- The verification/recovery queue's exact predicate. link_source is part of
-- it on purpose: pre-migration rows are 'unknown' and therefore invisible to
-- this index and to the queue that scans by it — that's what prevents a
-- back-catalogue sweep on first deploy.
create index postings_link_queue_idx
  on public.postings (page_id, link_retry_after)
  where filter_status = 'matched'
    and link_verification <> 'verified'
    and link_source in ('platform', 'cited', 'matched');

-- Re-crawl healing (repairing an existing row's link, and merging a posting
-- whose URL changed) looks up a page's existing rows by exact title.
create index postings_page_title_idx on public.postings (page_id, title);
