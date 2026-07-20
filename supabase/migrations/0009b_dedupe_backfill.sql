-- Backfill: collapses the duplicate rows that had already accumulated in
-- the table (mainly ad units whose tracking-parameter click-through URL
-- rotated every poll, so they looked "new" and got reinserted + renotified
-- repeatedly) using the same tracking-param stripping _shared/dedupe.ts now
-- applies to every future crawl.

with normalized as (
  select
    id,
    page_id,
    dedupe_key,
    first_seen_at,
    notified_at,
    regexp_replace(
      regexp_replace(
        regexp_replace(
          split_part(coalesce(url, ''), '#', 1),
          '([?&])(pk|t|source|src|ref|referrer|gh_src|gh_jid|lever-source|lever_source|fbclid|gclid|gclsrc|mc_cid|mc_eid|igshid|trk|click_id|clickid|target|utm_[a-z]+)=[^&]*',
          '\1', 'gi'
        ),
        '\?&+', '?', 'g'
      ),
      '[?&]+$', ''
    ) as norm_url
  from public.postings
),
grouped as (
  select
    n.id,
    n.page_id,
    n.first_seen_at,
    n.notified_at,
    lower(coalesce(nullif(regexp_replace(n.norm_url, '/$', ''), ''), n.dedupe_key)) as group_key
  from normalized n
),
ranked as (
  select
    id,
    page_id,
    group_key,
    row_number() over (
      partition by page_id, group_key
      order by (notified_at is null) asc, first_seen_at asc
    ) as rn
  from grouped
),
losers as (
  select id from ranked where rn > 1
)
delete from public.postings where id in (select id from losers);

-- Point every keeper's dedupe_key at its normalized URL so future crawls
-- match it going forward instead of reinserting under a new key. Skipped
-- when it would collide with another still-existing row's key (rare, but
-- keeps this migration from ever failing on a live table).
with normalized as (
  select
    id,
    page_id,
    lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            split_part(url, '#', 1),
            '([?&])(pk|t|source|src|ref|referrer|gh_src|gh_jid|lever-source|lever_source|fbclid|gclid|gclsrc|mc_cid|mc_eid|igshid|trk|click_id|clickid|target|utm_[a-z]+)=[^&]*',
            '\1', 'gi'
          ),
          '\?&+', '?', 'g'
        ),
        '[?&]+$', ''
      )
    ) as norm_url
  from public.postings
  where url is not null
)
update public.postings p
set dedupe_key = regexp_replace(n.norm_url, '/$', '')
from normalized n
where p.id = n.id
  and n.norm_url <> ''
  and not exists (
    select 1 from public.postings p2
    where p2.page_id = n.page_id
      and p2.dedupe_key = regexp_replace(n.norm_url, '/$', '')
      and p2.id <> p.id
  );

-- Populate content_key (title+company, loosely normalized) for cross-source
-- dedup going forward.
update public.postings
set content_key = trim(regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g'))
  || '|' || trim(regexp_replace(lower(company), '[^a-z0-9]+', ' ', 'g'))
where company is not null and trim(company) <> ''
  and trim(regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g')) <> '';
