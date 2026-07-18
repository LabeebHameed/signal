-- Qualification / filtering layer.
--
-- Settings gain a structured job profile (filter_profile jsonb: roles,
-- seniority, locations, skills, company_prefs, compensation, must_haves,
-- nice_to_haves, dealbreakers, context — all optional free text) and a
-- filter_mode:
--   'off'      — every new posting is notified (pre-filter behavior)
--   'balanced' — notify for "match" and "borderline" verdicts (default)
--   'strict'   — notify for "match" verdicts only
-- An empty profile behaves like 'off' regardless of mode.
--
-- Postings gain the screening outcome. New (non-baseline) rows are inserted
-- as filter_status = 'pending'; the poller's screening step judges them via
-- LLM and moves them to 'matched' (queued for Telegram) or 'filtered'
-- (kept, visible in the UI with the full verdict, but silent). Nothing is
-- ever dropped. 'skipped' = never screened: baseline rows, rows that
-- predate the filter, or rows that arrived while filtering was off.
--
-- filter_verdict stores the judge's complete reasoning:
--   { verdict, score, summary, dealbreaker, dimensions: [{name, fit, note}] }

alter table public.settings
  add column filter_profile jsonb not null default '{}'::jsonb,
  add column filter_mode text not null default 'balanced'
    check (filter_mode in ('off', 'balanced', 'strict'));

-- Seed the profile from the old free-text "job focus" field it supersedes.
update public.settings
  set filter_profile = jsonb_build_object('context', job_description)
  where job_description <> '';

alter table public.settings drop column job_description;

alter table public.postings
  add column filter_status text not null default 'skipped'
    check (filter_status in ('pending', 'matched', 'filtered', 'skipped')),
  add column filter_score integer,
  add column filter_verdict jsonb;

create index postings_filter_pending_idx on public.postings (page_id)
  where filter_status = 'pending';
