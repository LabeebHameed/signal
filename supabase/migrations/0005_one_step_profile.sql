-- One-step profile: the raw "what are you looking for" statement the user
-- types on the Profile page. The structured filter_profile stays canonical —
-- this is its editable source, kept so the UI can re-display the statement
-- and re-generate the profile from it. The generated profile also gains a
-- role_synonyms field (equivalent/adjacent job titles); that lives inside
-- the existing filter_profile jsonb, so no DDL is needed for it.

alter table public.settings
  add column profile_input text not null default '';
