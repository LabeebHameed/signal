-- Simplify the job profile to a title-screening-only shape (roles,
-- role_synonyms, title_keywords, locations, compensation) and remove the
-- filter-mode/min-score/feedback-loop machinery that grew around it. The
-- company background layer and the deterministic title-keyword gate
-- (keyword_filtered) are untouched.

drop index if exists public.postings_user_status_idx;
alter table public.postings
  drop column if exists user_status,
  drop column if exists user_status_at,
  drop column if exists filter_score;

alter table public.settings
  drop column if exists filter_mode,
  drop column if exists blocked_companies,
  drop column if exists min_score;

-- Strip fields no longer part of the profile shape from existing rows (the
-- PUT /settings sanitizer also self-heals this on every future save).
update public.settings
  set filter_profile = filter_profile
    - 'seniority' - 'skills' - 'company_prefs' - 'must_haves'
    - 'nice_to_haves' - 'dealbreakers' - 'context';
