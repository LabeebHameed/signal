-- The deterministic blocked-company "Screening" step was removed from the
-- pipeline: postings now go straight from Sources to the AI Judge. Nothing
-- sets or reads this column anymore.
alter table public.postings
  drop column blocked_by_screening;
