-- Company background layer. Each matched posting's employer is researched
-- once (Jina Search + LLM dossier synthesis), cached here, and refreshed
-- after 30 days. The layer never blocks a posting — it annotates: a company
-- verdict of 'warn' still notifies, carrying the caution, and everything is
-- visible in the UI with the full dossier.
--
-- postings.company_status is a second queue column, parallel to
-- filter_status: would-notify rows enter 'pending' when the layer is active,
-- the poller researches + judges their companies, then moves them to
-- 'ok'/'warned' and queues the notification.
--   'none'    = layer off, no company name, or row predates the layer
--   'pending' = awaiting company research + verdict
--   'ok'      = cleared; 'warned' = notified with a caution

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  norm_name text not null unique,        -- normalizeCompanyName() output
  display_name text not null,            -- name as first seen on a posting
  dossier jsonb,                          -- CompanyDossier (null until researched)
  legitimacy text not null default 'unknown'
    check (legitimacy in ('verified', 'likely_real', 'uncertain', 'suspicious', 'unknown')),
  research_status text not null default 'pending'
    check (research_status in ('pending', 'ok', 'failed')),
  research_error text,
  failure_count integer not null default 0,
  researched_at timestamptz,              -- last attempt, success or failure
  created_at timestamptz not null default now()
);

-- Service-role edge functions only, like every other table.
alter table public.companies enable row level security;

alter table public.settings
  add column company_filter_enabled boolean not null default false;

alter table public.postings
  add column company_id uuid references public.companies (id) on delete set null,
  add column company_status text not null default 'none'
    check (company_status in ('none', 'pending', 'ok', 'warned')),
  add column company_verdict jsonb;       -- { decision: ok|warn, reason }

create index postings_company_pending_idx on public.postings (page_id)
  where company_status = 'pending';
create index postings_company_id_idx on public.postings (company_id);
