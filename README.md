# Signal — Job Posting Notifier (MVP)

Watches job-listing pages you choose and sends you a Telegram message whenever a
new posting appears. Pages can have any structure (Greenhouse, Lever, custom
career sites, JS-rendered SPAs) — an LLM extracts the postings, so there are no
per-site parsers.

**MVP scope:** no filtering or qualification. Every new posting on a watched
page is forwarded. Filters (position match, company checks, custom rules) come
in a later phase — the "what job are you looking for" field is already collected
in Settings for that purpose.

## How it works

```
pg_cron (every 15 min)
  └─> Edge Function: poll-pages
        for each active watched page:
          1. fetch page content (direct fetch; Jina Reader fallback for JS-rendered pages)
          2. hash content → skip if unchanged since last check (no LLM cost)
          3. LLM extracts postings as JSON  [{title, url, company, location}]
          4. diff against `postings` table (dedupe key = posting URL, or title+company hash)
          5. new rows → one Telegram message each
             (the first-ever crawl of a page is a silent baseline — no notification flood)

web UI (Vite + React, static)
  └─> Edge Function: api   (all requests carry the x-admin-token header)
```

The LLM is **provider-agnostic** — configured entirely by env vars:

| Secret | Value |
|---|---|
| `LLM_PROVIDER` | `anthropic` or `openai-compatible` |
| `LLM_MODEL` | any model id for that provider |
| `LLM_API_KEY` | the provider's API key |
| `LLM_BASE_URL` | (openai-compatible only) e.g. Gemini compat endpoint, Groq, Mistral, OpenRouter, local Ollama. Defaults to `https://api.openai.com/v1` |
| `JINA_API_KEY` | optional — free key from [jina.ai](https://jina.ai/reader/); only needed if JS-rendered pages hit Jina Reader's anonymous rate limit |

## Setup (one time)

### 1. Telegram bot

1. Message **@BotFather** on Telegram → `/newbot` → follow prompts → copy the **bot token**.
2. Message **@userinfobot** → it replies with your **chat ID**.
3. Open a chat with your new bot and press **Start** (bots can only message people who started them).

### 2. Supabase project

```sh
# from the repo root, linked to your project
supabase db push                      # applies migrations 0001 + 0002

# secrets used by the edge functions
supabase secrets set \
  LLM_PROVIDER=anthropic \
  LLM_MODEL=claude-opus-4-8 \
  LLM_API_KEY=<your key> \
  TELEGRAM_BOT_TOKEN=<from BotFather> \
  ADMIN_TOKEN=$(openssl rand -hex 24)   # remember this value — the UI asks for it

# deploy the functions (custom auth via ADMIN_TOKEN, so no JWT verification)
supabase functions deploy poll-pages --no-verify-jwt
supabase functions deploy api --no-verify-jwt
```

The cron job (migration `0002`) reads the function URL and admin token from
Supabase Vault. Create the two secrets once (SQL editor):

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/poll-pages', 'poll_function_url');
select vault.create_secret('<ADMIN_TOKEN value>', 'admin_token');
```

### 3. Web UI

```sh
cd web
cp .env.example .env    # set VITE_API_URL to your api function URL
npm install
npm run dev             # or `npm run build` and host dist/ anywhere static
```

On first load the UI asks for the `ADMIN_TOKEN` value, then:

1. **Watched pages** — paste the exact URLs that list postings (not a page that links to them).
2. **Settings** — your job description (for future filters) and Telegram chat ID.
3. **Check now** — trigger a poll immediately instead of waiting for cron.

## Behavior notes

- **First crawl of a page is a baseline**: postings are recorded but not
  notified (otherwise adding a page would flood you with every existing job).
  Postings that appear after that are notified.
- **Max 20 notifications per page per run**, then a single "…and N more" message.
- **JS-rendered pages**: if a direct fetch returns an empty shell (or stops
  yielding postings), the poller retries through [Jina Reader](https://jina.ai/reader/)
  and remembers which method worked for next time (`fetch_source` column).
- **Failures don't stop the run**: a broken page records `last_error` and
  `failure_count` (visible in the UI) and the poller moves on.
- Poll manually any time:
  `curl -X POST -H "x-admin-token: $ADMIN_TOKEN" https://<ref>.supabase.co/functions/v1/poll-pages`

## Repo layout

```
supabase/
  migrations/0001_init.sql          # tables + RLS
  migrations/0002_schedule_poll.sql # pg_cron job (reads URL/token from Vault)
  functions/
    poll-pages/index.ts             # the poller
    api/index.ts                    # CRUD for the UI
    _shared/                        # fetcher, LLM adapters, telegram, types
web/                                # minimal React UI
```

## Out of scope (future phases)

- Qualification/filters (position, founder/company, origin, custom rules)
- Multi-user accounts and auth
- Telegram `/start` webhook onboarding (auto-capture chat ID)
- Notification digests, retry queues, per-site tuning
