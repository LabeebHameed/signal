-- The Workflow page needs to tell apart postings rejected by the
-- deterministic blocked-company check ("Screening") from postings rejected
-- by the LLM judge ("AI Judge") — two different pipeline stages that both
-- happen to land on filter_status='filtered'. Rather than inferring this
-- from a JSON path inside filter_verdict, store it as a real column set at
-- write time, so counting and filtering are exact and index-friendly.
alter table public.postings
  add column blocked_by_screening boolean not null default false;
