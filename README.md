# Signal — Job Posting Notifier

Watches job-listing pages you choose and sends you a Telegram message whenever a
new posting appears. Known ATS platforms (Greenhouse, Lever, Ashby) and RSS/Atom
feeds are read straight from their public APIs — no LLM involved and immune to
anti-bot walls. Everything else goes through a generic fetch chain (real
browser headers, then a crawler UA, then a free keyless reader proxy) followed
by LLM extraction, so there are no per-site parsers to maintain.

**Qualification layer:** between extraction and notification sits an LLM
judge. On the **Profile** page you describe what you're looking for in one
sentence ("I'm good at design and I want to be a design engineer — remote,
no agencies") and Signal expands it into a structured job profile — including
the equivalent titles companies use for the same work ("UI/UX Designer" ≈
"UX Engineer" ≈ "User Experience Designer"), so postings never have to match
your wording. Anything you don't mention stays open; the generated profile is
shown as an editable preview you can fine-tune. Every new posting is then
judged against it the way a person would weigh it: role semantics rather than
title keywords, inferred seniority, location compatibility, hard requirements
versus soft preferences. Only postings that qualify reach Telegram; everything
else is kept, visible, and silent — with the judge's full reasoning stored so
no decision is a black box.

**Company background layer (optional):** before a match is delivered, Signal
can research the company behind it — one live web search (Tavily) synthesized
by the LLM into a cached dossier: what the company does, size, stage, recent
funding, and a legitimacy assessment with concrete flags (fake-looking
companies on job boards are a real thing). This layer **never blocks a
posting** — an unverifiable or preference-clashing company still notifies,
and the **Inbox** page shows every qualifying posting as a card with the
full company background and caution when there is one (the Telegram message
itself stays short — see below).

**Feedback loop:** mark a posting Interested / Not interested / Applied
(Inbox or Postings) and future screening calls see your recent decisions as
calibration examples — the judge leans on stated profile first, feedback only
sharpens genuinely borderline calls. Block a company outright (Profile page,
or the "Block company" action) and its postings are filtered before they ever
reach the LLM.

**Fixed polling:** every active page is checked on a fixed 15-minute interval (on every cron tick). There is no adaptive backoff or decay — this ensures that new postings are discovered as quickly as possible.

## How it works

```
pg_cron (every 15 min)
  └─> Edge Function: poll-pages
        for each active page:
          0. claim the page (atomic lock) so an overlapping run can't double-process it
          1. known ATS host (Greenhouse/Lever/Ashby) or RSS/Atom feed → structured fetch,
             no LLM; otherwise generic fetch chain (browser headers → crawler UA →
             free keyless reader proxy), each attempt screened for block/challenge pages
          2. hash content → skip extraction if unchanged; still flushes any backlog left
             by earlier judge/company/Telegram failures
          3. LLM extracts postings as JSON (structured-source path skips this)
          4. diff by normalized dedupe key (tracking params stripped, so a rotating
             click-token doesn't look like a new posting every poll) against `postings`
          5. blocked companies are filtered deterministically, no LLM call; otherwise the
             LLM judge screens new rows against your job profile (one batched call per
             page, with your recent feedback as calibration) → verdict + 0-100 score +
             per-dimension reasoning per posting
               matched  → company layer (if enabled), then queued for Telegram
               filtered → kept in the UI with its verdict, never notified
          6. company layer (optional): research each match's company (Tavily search
             + LLM dossier, cached 30 days) → ok, or warn with a caution — never blocked
          7. cross-source dedup: a job already notified recently under a different watched
             page (same normalized title+company) is linked as a duplicate, not re-sent
          8. matched rows → one short Telegram message each: title, judge score +
             one-line reason, company (+ type when researched), location, pay, link —
             the full judge reasoning and company dossier live on the Inbox page, not in
             the message itself
             (the first-ever crawl of a page is a silent baseline — no notification flood)
          9. persist state: update last content hash, check error, and failure count

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
4. Optional: to notify more than one account (e.g. while testing), enter multiple chat IDs
   comma-separated in Settings — each one needs its own Start step above.

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
Tavily key) is entered in the web UI → **Settings**.

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

1. **Sources** — paste the exact URLs that list postings (not a page that links to them).
2. **Profile** — describe what you're looking for in one sentence, hit
   **Generate profile**, review, save. (Optionally enable company background
   checks here too.)
3. **Settings** — LLM provider/model/key, Telegram bot token + chat ID.
4. **Check now** — trigger a poll immediately instead of waiting for cron.

## Troubleshooting

- **Telegram "chat not found"**: the bot can't see your chat. The chat ID must
  be the **numeric** ID from @userinfobot (not a @username), and you must open
  your bot's chat and press **Start** first (bots can't message you until you
  do). Use **Send test message** in Settings to verify instantly. Failed
  notifications aren't lost — they queue (`pending` in the postings list) and
  retry on the next poll once Telegram works.
- **"fetch failed: HTTP 403" / connection errors**: Signal already retries with
  a second header profile and a free keyless reader proxy before giving up —
  the Sources page shows which strategy last worked (`direct` / `direct-alt` /
  `proxy:pure`) and, on failure, the honest per-strategy errors plus the
  page's current backoff. A page that needs JavaScript to render its listing,
  or sits behind a genuine Cloudflare/DataDome challenge, will still fail
  honestly — nothing keyless beats that. Swap in a URL that serves the
  listing as static HTML or a known ATS/RSS source if one exists.

## How filtering works

- **One sentence in, full profile out.** The Profile page turns your
  description into the structured profile the judge reads (roles, equivalent
  titles, seniority, locations, skills, company preferences, compensation,
  must-haves, nice-to-haves, dealbreakers, context). Dimensions you didn't
  mention stay empty — empty means "no preference", never a guess. The
  derived profile is fully editable.
- **The profile is free text per dimension, not rules.** The judge reads it
  like a briefed assistant: "Solutions Engineer" won't match a profile asking
  for product engineering roles just because it contains "Engineer", and
  "Member of Technical Staff" can match one even though no word overlaps.
  Generated equivalent titles mean "User Experience Designer" matches a
  profile that said "UI/UX designer".
- **Missing information is neutral.** Many postings are just a title and a
  location; the judge only counts a dimension against a posting when the
  posting actively contradicts the profile, never because it's silent.
- **Must-haves vs. dealbreakers vs. nice-to-haves.** A posting that clearly
  violates a must-have can't be a match; a dealbreaker that clearly applies
  filters the posting outright (and is named in the verdict); nice-to-haves
  only ever boost.
- **Three modes** (Profile page): *Off* forwards everything, *Balanced*
  notifies for `match` and `borderline` verdicts, *Strict* for `match` only.
  An empty profile behaves like Off.
- **Min score threshold** (Profile page): layered on top of the mode — a
  posting must also score at or above this to notify, even if the verdict
  qualifies.
- **Blocked companies** (Profile page, or "Block company" in the Inbox):
  postings from a blocked company are filtered deterministically before ever
  reaching the LLM judge — an absolute, cost-free override.
- **Feedback loop.** Marking a posting Interested / Not interested / Applied
  feeds your most recent decisions back into the judge prompt as calibration
  examples on future screening calls. It only nudges genuinely borderline
  calls — a single data point never overrides a clear read of the profile.
- **Nothing is dropped.** Filtered postings stay in the Postings page with
  their verdict, 0-100 score, per-dimension breakdown, and a plain-English
  summary — click any screened row to see why it was (or wasn't) sent. The
  same summary is quoted in the Telegram message for matches.
- **Failures hold, they don't guess.** If the judge call fails, postings stay
  "screening" and are retried on the next run — they're never silently
  notified or silently discarded. Changing the profile affects future
  screenings; past verdicts are kept as they were made.

## How the company layer works

- **Opt-in, and needs a Tavily key** (Profile page toggle): research without
  live search evidence would just be the LLM guessing, so without a key the
  layer stays inactive and matches notify directly.
- **Matched postings only.** Companies are researched after a posting passes
  the job judge — mismatches never spend a search. One dossier per company
  (names are normalized: "Acme", "ACME Inc." and "acme, inc" are one row),
  cached for 30 days, shared across all pages and postings.
- **The dossier is evidence-bound.** Built strictly from the search results:
  what the company does, industry, size, stage, funding (with year), founding
  year, a legitimacy level (`verified` / `likely_real` / `uncertain` /
  `suspicious`), concrete flags, confidence, and the sources used. A company
  that only exists on job boards comes out `uncertain` — caution, not
  accusation.
- **Annotate, never block.** Every matched posting is still delivered — the
  Telegram message stays short (title, score + reason, company + type,
  location, pay, link); a company that can't be verified or clashes with
  your stated preferences (e.g. "no tiny 2–3 person firms") gets its caution
  on the **Inbox** page instead, with a badge and the full dossier. Research
  failures retry on later runs (up to 3 attempts), then the posting is
  delivered with a "couldn't verify" caution rather than being stuck.
- **Inbox page** — every posting that came out of the filter, as cards:
  judge score and summary, company badge (✓ verified / ? unverified /
  ⚠ suspicious), the dossier, source links, and action buttons (Interested /
  Not interested / Applied). This is where the full reasoning lives —
  Telegram is just the ping to go look.

## Behavior notes

- **First crawl of a page is a baseline**: postings are recorded but not
  notified (otherwise adding a page would flood you with every existing job).
  Postings that appear after that are screened and, if they qualify, notified.
- **No duplicate notifications**: per-source dedupe uses a normalized URL (or
  title+company+location when a posting has no link), immune to rotating
  tracking tokens; cross-source dedupe links the same job posted to a
  different watched page to whichever copy notified first. Notification
  sending is claimed atomically so an overlapping cron run, chained batch, or
  manual "Check now" can never send the same posting twice.
- **Max 20 notifications per page per run**; the rest stay queued and go out
  on the next run.
- **Most sites without JavaScript rendering are supported** via the fetch
  chain (browser headers → crawler UA → keyless reader proxy) or a structured
  ATS/RSS adapter. A page that truly requires JavaScript to render its
  postings, or sits behind a real anti-bot challenge, fails honestly with the
  block signature named rather than being silently treated as empty.
- **Failures don't stop the run**: a broken page records `last_error` and
  `failure_count` (visible in the Sources page) and retries on the next cron tick.
- Poll manually any time:
  `curl -X POST -H "x-admin-token: $ADMIN_TOKEN" https://<ref>.supabase.co/functions/v1/poll-pages`

## Repo layout

```
supabase/
  migrations/                       # schema: tables + RLS, pg_cron job, notify queue,
                                    # filter layer, dedup, fetch strategy, feedback
  functions/
    poll-pages/index.ts             # the poller (fetch → extract → dedupe → screen →
                                    # company → notify)
    api/index.ts                    # CRUD for the UI
    _shared/                        # fetcher (+ proxy fallback), ats (Greenhouse/Lever/
                                    # Ashby/RSS), dedupe, LLM adapters, judge, profile
                                    # expansion, company research, telegram, types
web/                                # React UI: Dashboard, Inbox, Sources,
                                    # Postings, Profile, Settings (vercel.json included)
```

## Out of scope (future phases)

- Re-screening existing postings when the profile changes
- Multi-user accounts and auth
- Telegram `/start` webhook onboarding (auto-capture chat ID)
- Notification digests, per-site tuning
- Email/SMS/Slack/push notification channels (schema keeps channels
  pluggable; Telegram is the only one wired up)
- Native mobile apps, resume/LinkedIn import
