-- Remove live per-posting link verification.
--
-- Migration 0019 added these columns to record whether a posting's link had
-- been proven correct by fetching it and confirming the title was on the
-- page. In production that check could not succeed on the sites that needed
-- it: every single indeterminate row recorded the same note, "site returned
-- HTTP 403". Two permanent causes —
--
--   * dailyremote.com blocks Supabase's egress IP. The crawler already works
--     around this by going through a reader proxy, but the verifier made one
--     plain direct request, so it was walled on exactly the sources the
--     crawler had to proxy around in the first place.
--   * himalayas.app answers with a real Cloudflare challenge. Nothing keyless
--     gets past it — and those links come straight from the Himalayas API, so
--     they were correct by construction and labelled "unconfirmed" anyway.
--
-- The result was an "unconfirmed" badge on most of the Inbox carrying no
-- actionable information, on links that were mostly fine.
--
-- The replacement needs no verification: _shared/cards.ts reads a posting's
-- link from the DOM card that displays that posting's own title, at scrape
-- time. A link taken from the card containing the title does not need to be
-- re-proven afterwards, and per-posting network cost drops to zero.
--
-- Dropping rather than keeping: this data is per-attempt history for a
-- mechanism that no longer exists. link_source, link_note and link_score
-- survive because they still describe how the stored URL was obtained.

alter table public.postings
  drop column if exists link_verification,
  drop column if exists link_final_url,
  drop column if exists link_checked_at,
  drop column if exists link_check_attempts,
  drop column if exists link_retry_after,
  drop column if exists link_attempts;

-- The verification queue's index; nothing scans that queue any more.
drop index if exists postings_link_queue_idx;

-- 'card' is the new primary provenance: the link belonged to the DOM card
-- displaying this posting's title. Kept alongside 'cited'/'matched', which
-- still carry reader-proxy pages, where markdown gives us no DOM to read.
alter table public.postings
  drop constraint if exists postings_link_source_check;
alter table public.postings
  add constraint postings_link_source_check
  check (link_source in ('unknown', 'platform', 'card', 'cited', 'matched', 'none'));

comment on column public.postings.link_source is
  'How postings.url was obtained: platform (ATS/RSS feed) | card (the page DOM card showing this title) | cited (model citation, reader-proxy pages) | matched (title/anchor-text fallback) | none | unknown (pre-provenance rows).';

-- postings_page_title_idx is deliberately kept: re-crawl link repair and the
-- rename-merge path both look a page's existing rows up by exact title.
