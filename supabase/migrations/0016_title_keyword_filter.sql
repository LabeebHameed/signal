-- Deterministic title-keyword gate, run before the AI judge ever sees a
-- posting (see judge.ts titleMatchesKeywords / poll-pages screenPending): a
-- posting whose title contains none of the profile's declared
-- title_keywords is rejected without spending an LLM call. Stored as a real
-- column, same pattern as the old blocked_by_screening, so the Workflow
-- page's "Title Keyword Filter" node can count and roster these exactly,
-- distinct from postings the AI judge itself rejected.
alter table public.postings
  add column keyword_filtered boolean not null default false;
