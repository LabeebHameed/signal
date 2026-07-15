-- Job Posting Notifier — MVP schema

create table public.watched_pages (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  label text not null default '',
  active boolean not null default true,
  -- 'direct' = plain fetch works; 'jina' = page is JS-rendered, fetch via Jina Reader
  fetch_source text not null default 'direct' check (fetch_source in ('direct', 'jina')),
  last_content_hash text,
  last_checked_at timestamptz,
  last_error text,
  failure_count integer not null default 0,
  first_crawl_done boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.postings (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.watched_pages(id) on delete cascade,
  dedupe_key text not null,
  title text not null,
  url text,
  company text,
  location text,
  raw jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  -- null = never notified (baseline crawl rows stay null)
  notified_at timestamptz,
  unique (page_id, dedupe_key)
);

create index postings_first_seen_idx on public.postings (first_seen_at desc);

-- Single-row settings table (MVP is single-user). Also holds runtime config:
-- secrets are entered through the web UI and only ever read by edge functions
-- via the service-role key (RLS has no public policies). Env vars with the
-- same names, if set on the functions, take precedence over these columns.
create table public.settings (
  id integer primary key default 1 check (id = 1),
  job_description text not null default '',
  telegram_chat_id text not null default '',
  admin_token text not null default '',
  llm_provider text not null default '',        -- 'anthropic' | 'openai-compatible'
  llm_model text not null default '',
  llm_api_key text not null default '',
  llm_base_url text not null default '',
  telegram_bot_token text not null default '',
  jina_api_key text not null default ''
);

insert into public.settings (id) values (1);

-- No public access: all reads/writes go through Edge Functions using the
-- service-role key, which bypasses RLS. No policies on purpose.
alter table public.watched_pages enable row level security;
alter table public.postings enable row level security;
alter table public.settings enable row level security;
