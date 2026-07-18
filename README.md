# Signal — Job Posting Notifier (MVP)

Watches job-listing pages you choose and sends you a Telegram message whenever a
new posting appears. Pages can have any structure (Greenhouse, Lever, custom
career sites, JS-rendered SPAs) — an LLM extracts the postings, so there are no
per-site parsers.

**Qualification layer:** between extraction and notification sits an LLM
judge. You describe what you're looking for as a structured job profile in
Settings (target roles, seniority, locations/remote, skills, company
preferences, compensation, must-haves, nice-to-haves, dealbreakers, free-form
context — all optional free text), and every new posting is judged against it
the way a person would weigh it: role semantics rather than title keywords,
inferred seniority, location compatibility, hard requirements versus soft
preferences. Only postings that qualify reach Telegram; everything else is
kept, visible, and silent — with the judge's full reasoning stored so no
decision is a black box.

## How it works

```
pg_cron (every 15 min)
  └─> Edge Function: poll-pages
        for each active watched page:
          1. fetch page content (direct fetch; Jina Reader fallback for JS-rendered pages)
          2. hash content → skip if unchanged since last check (no LLM cost)
          3. LLM extracts postings as JSON  [{title, url, company, location}]
          4. diff against `postings` table (dedupe key = posting URL, or title+company hash)
          5. LLM judge screens new rows against your job profile (one batched call
             per page) → verdict + 0-100 score + per-dimension reasoning per posting
               matched  → queued for Telegram
               filtered → kept in the UI with its verdict, never notified
          6. matched rows → one Telegram message each, quoting the judge's summary
             (the first-ever crawl of a page is a silent baseline — no notification flood)

web UI (Vite + React, static)
  └─> Edge Function: api   (all requests carry the x-admin-token header)
```

The LLM is **provider-agnostic**: pick `anthropic` or `openai-compatible` in
the Settings UI — the latter covers OpenAI, Gemini (compat endpoint), Groq,
Mistral, OpenRouter, local Ollama, etc. via a configurable base URL.

**Configuration lives in the `settings` table** and is managed entirely through
the web UI (the table is service-role-only; the API never returns secret values,
only `has_*` booleans). Env vars with the matching names (`LLM_API_KEY`,
`TELEGRAM_BOT_TOKEN`, `ADMIN_TOKEN`, …) still take precedence if you prefer
dashboard-managed secrets.

## Setup (one time)

### 1. Telegram bot

1. Message **@BotFather** on Telegram → `/newbot` → follow prompts → copy the **bot token**.
2. Message **@userinfobot** → it replies with your **chat ID**.
3. Open a chat with your new bot and press **Start** (bots can only message people who started them).

### 2. Supabase project

```sh
# from the repo root, linked to your project
supabase db push                      # applies all migrations

# deploy the functions (custom x-admin-token auth, so no JWT verification)
supabase functions deploy poll-pages --no-verify-jwt
supabase functions deploy api --no-verify-jwt
```

Then two one-time SQL statements (SQL editor):

```sql
-- the cron job reads the poller URL from Vault
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/poll-pages', 'poll_function_url');
-- generate an admin token; this is what you type into the web UI
update settings set admin_token = '<random string, e.g. openssl rand -hex 24>';
```

Everything else (LLM provider/model/key, Telegram bot token + chat ID, optional
Jina key) is entered in the web UI → **Settings**.

### 3. Web UI

Run it locally, or deploy it to Vercel — both read the same `api` function URL.

**Locally:**

```sh
cd web
cp .env.example .env    # set VITE_API_URL to your api function URL
npm install
npm run dev
```

**On Vercel:**

1. [Import the repo](https://vercel.com/new) into Vercel.
2. In the import screen (or later under Project Settings → General), set
   **Root Directory** to `web`. Vercel auto-detects it as a Vite app
   (`web/vercel.json` pins the build command/output dir so this works even
   if auto-detection is skipped).
3. Add an environment variable **`VITE_API_URL`** = your `api` function URL
   (`https://<project-ref>.supabase.co/functions/v1/api`).
4. Deploy. Every push to the branch you deploy from redeploys automatically.

CLI equivalent, from the repo root: `npx vercel --cwd web`.

Either way, on first load the UI asks for the `ADMIN_TOKEN` value, then:

1. **Watched pages** — paste the exact URLs that list postings (not a page that links to them).
2. **Settings** — your job profile (what the filter judges postings against) and Telegram chat ID.
3. **Check now** — trigger a poll immediately instead of waiting for cron.

## Troubleshooting

- **Telegram "chat not found"**: the bot can't see your chat. The chat ID must
  be the **numeric** ID from @userinfobot (not a @username), and you must open
  your bot's chat and press **Start** first (bots can't message you until you
  do). Use **Send test message** in Settings to verify instantly. Failed
  notifications aren't lost — they queue (`pending` in the postings list) and
  retry on the next poll once Telegram works.
- **"direct fetch failed: HTTP 403" / connection errors**: the site blocks
  datacenter traffic (anti-bot). The poller automatically retries through Jina
  Reader, but anonymous Jina access is heavily rate-limited — set the **Jina
  Reader API key** in Settings (free at [jina.ai](https://jina.ai)) and these
  sites will work.

## How filtering works

- **The profile is free text per dimension, not rules.** The judge reads it
  like a briefed assistant: "Solutions Engineer" won't match a profile asking
  for product engineering roles just because it contains "Engineer", and
  "Member of Technical Staff" can match one even though no word overlaps.
- **Missing information is neutral.** Many postings are just a title and a
  location; the judge only counts a dimension against a posting when the
  posting actively contradicts the profile, never because it's silent.
- **Must-haves vs. dealbreakers vs. nice-to-haves.** A posting that clearly
  violates a must-have can't be a match; a dealbreaker that clearly applies
  filters the posting outright (and is named in the verdict); nice-to-haves
  only ever boost.
- **Three modes** (Settings → Job filter): *Off* forwards everything,
  *Balanced* notifies for `match` and `borderline` verdicts, *Strict* for
  `match` only. An empty profile behaves like Off.
- **Nothing is dropped.** Filtered postings stay in the Postings page with
  their verdict, 0-100 score, per-dimension breakdown, and a plain-English
  summary — click any screened row to see why it was (or wasn't) sent. The
  same summary is quoted in the Telegram message for matches.
- **Failures hold, they don't guess.** If the judge call fails, postings stay
  "screening" and are retried on the next run — they're never silently
  notified or silently discarded. Changing the profile affects future
  screenings; past verdicts are kept as they were made.

## Behavior notes

- **First crawl of a page is a baseline**: postings are recorded but not
  notified (otherwise adding a page would flood you with every existing job).
  Postings that appear after that are screened and, if they qualify, notified.
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
  migrations/                       # schema: tables + RLS, pg_cron job, notify
                                    # queue, filter layer
  functions/
    poll-pages/index.ts             # the poller (fetch → extract → screen → notify)
    api/index.ts                    # CRUD for the UI
    _shared/                        # fetcher, LLM adapters, judge, telegram, types
web/                                # minimal React UI (vercel.json included)
```

## Out of scope (future phases)

- Re-screening existing postings when the profile changes
- Multi-user accounts and auth
- Telegram `/start` webhook onboarding (auto-capture chat ID)
- Notification digests, per-site tuning
