# Signal — Job Posting Notifier

Watches job-listing pages you choose and sends you a Telegram message whenever a
new posting appears. Known ATS platforms (Greenhouse, Lever, Ashby) and RSS/Atom
feeds are read straight from their public APIs — no LLM involved and immune to
anti-bot walls. Everything else goes through a generic fetch chain (real
browser headers, then a crawler UA, then a free keyless reader proxy) followed
by LLM extraction, so there are no per-site parsers to maintain.

**Qualification layer:** between extraction and notification sits an LLM
judge that screens by **title alone** — there's no job description anywhere
in this system. On the **Profile** page you describe what you're looking for
in one sentence ("I'm good at design and I want to be a design engineer")
and Signal generates the equivalent titles companies use for the same work
("UI/UX Designer" ≈ "UX Engineer" ≈ "User Experience Designer") plus a
handful of title keywords, so postings never have to match your wording.
You set your location/remote preference and pay expectation directly.
Changed your mind entirely (e.g. "Design Engineer" → "Designer")? Regenerating
fully replaces the target-role fields — or hit **Clear profile** for a clean
slate. Every new posting is then judged: does its title name the target role
(or a seniority-qualified variant of it), does its location fit, does its pay
(when shown) fit — a posting whose title names a different or broader role is
never a match, even if it shares a generic word like "Engineer". Two
deterministic layers backstop the LLM here, since it has repeatedly
misjudged title scope even with full context: a **title-keyword gate**
rejects an obviously off-topic title before the judge ever runs (no LLM call
spent), and a **thin-posting backstop** catches sources that hand the judge
almost nothing but a bare title. Only postings judged a **match** reach
Telegram; everything else is kept, visible, and silent — with the judge's
reasoning stored so no decision is a black box.

**Company background layer (optional):** before a match is delivered, Signal
can research the company behind it — one live web search (Tavily) synthesized
by the LLM into a cached dossier: what the company does, size, stage, recent
funding, and a legitimacy assessment with concrete flags (fake-looking
companies on job boards are a real thing). This layer **never blocks a
posting** — an unverifiable company still notifies, and the **Inbox** page
shows every qualifying posting as a card with the full company background and
caution when there is one (the Telegram message itself stays short — see
below).

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
          4. resolve each posting's link deterministically (no network): the link on the
             page's own DOM card that displays this posting's title — identified as the
             one anchor slot unique to each card, so a company/tag link sharing the card
             can never win. Reader-proxy pages (markdown, no DOM) fall back to the older
             numbered-citation mechanism, where the model returns a link id, never a URL
          5. diff by normalized dedupe key (tracking params stripped, so a rotating
             click-token doesn't look like a new posting every poll) against `postings`;
             re-crawl healing repairs a stored link's casing/provenance and merges a
             posting whose URL changed shape into its prior row, instead of re-notifying it
          6. deterministic title-keyword gate first (a title sharing none of the profile's
             declared title keywords is rejected outright, no LLM call spent), then the
             LLM judge screens the rest by title (plus location/compensation metadata)
             against your job profile, one batched call per page → verdict + one-line
             reason per posting; a thin-posting backstop catches sources that hand the
             judge almost nothing but a bare title
               matched  → company layer (if enabled), then Telegram
               filtered → kept in the UI with its verdict, never notified
          7. company layer (optional): research each match's company (Tavily search
             + LLM dossier, cached 30 days) → ok, or warn with a caution — never blocked
          8. cross-source dedup: a job already notified recently under a different watched
             page (same normalized title+company) is linked as a duplicate, not re-sent
          9. matched rows → one short Telegram message each: title, one-line reason,
             company (+ type when researched), location, pay, and the posting's link; the
             full judge reasoning and company dossier live on the Inbox page, not in the
             message itself (the first-ever crawl of a page is a silent baseline — no
             notification flood)
          10. persist state: update last content hash, check error, and failure count

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
   **Generate profile**, set your location and compensation preference, save.
3. **Settings** — LLM provider/model/key, Telegram bot token + chat ID, and
   (optionally) a Tavily key to enable company background checks.
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
- **Postings from one source have no link at all**: the
  strategy that fetched the page returned readable content but none of the
  page's links, so there was nothing for the extraction model to cite. Signal
  now treats a link-free result as a degraded render and keeps trying the
  other strategies, so this normally corrects itself on the next poll and the
  source switches strategy (visible on the Sources page). A page that has no
  links under *any* strategy is left on its best result and excused from
  re-probing for 12 hours (`watched_pages.strategy_probe_after`) rather than
  paying for the full chain every poll.

## How filtering works

- **The profile has exactly five fields**, all on the Profile page: target
  role, equivalent titles, and title keywords (all generated from your
  one-sentence statement, then editable), plus location/remote preference and
  compensation (always entered directly — the statement never touches them).
  An empty profile disables filtering — every new posting notifies.
- **Switching categories entirely** (e.g. "Design Engineer" → "Designer")?
  Editing the statement and hitting Generate fully *replaces* the target-role
  fields, it never merges old and new text together. **Clear profile** wipes
  everything for a deliberate fresh start.
- **Judged by title, not keyword matching.** The judge reads titles like a
  briefed assistant: "Solutions Engineer" won't match a profile asking for
  product engineering roles just because it contains "Engineer", and "Member
  of Technical Staff" can match one even though no word overlaps. Equivalent
  titles and title keywords all count as the target role.
- **Title scope is a hard boundary.** When a target role is set, a posting
  whose title names a different or broader discipline (e.g. "Full Stack
  Engineer" against a target "Front-End Developer", or "Android Developer"
  against "Design Engineer") is always a mismatch — sharing a generic word
  like "Engineer" is never enough on its own. A seniority-qualified variant
  of the target role ("Senior Front-End Engineer") is still in scope.
- **Two deterministic backstops**, because the LLM has repeatedly gotten
  title scope wrong even with full context in hand: a **title-keyword gate**
  runs before the judge ever sees a posting — a title sharing none of the
  profile's declared title keywords is rejected outright, no LLM call spent
  (tracked separately in the Workflow page as its own pipeline step). A
  **thin-posting backstop** runs after the judge's own verdict, for postings
  whose source hands over almost nothing (no company/location/compensation,
  just a bare title) — a textual scope check against the target role forces
  a mismatch the model missed.
- **Location and compensation are metadata checks, not title checks.** The
  judge reads the posting's own location/pay fields against your stated
  preference — never the title. Missing information is neutral, never
  disqualifying: a posting with no pay shown simply isn't checked against
  your compensation preference.
- **Only "match" notifies.** Borderline and mismatch verdicts are kept in the
  Postings page, visible with the judge's one-line reasoning, but silent.
- **Failures hold, they don't guess.** If the judge call fails, postings stay
  "screening" and are retried on the next run — they're never silently
  notified or silently discarded. Changing the profile affects future
  screenings; past verdicts are kept as they were made.

## How the company layer works

- **Opt-in, and needs a Tavily key** (Settings page): research without live
  search evidence would just be the LLM guessing, so without a key the layer
  stays inactive and matches notify directly.
- **Matched postings only.** Companies are researched after a posting passes
  the job judge — mismatches never spend a search. One dossier per company
  (names are normalized: "Acme", "ACME Inc." and "acme, inc" are one row),
  cached for 30 days, shared across all pages and postings.
- **The dossier is evidence-bound.** Built strictly from the search results:
  what the company does, industry, size, stage, funding (with year), founding
  year, a legitimacy level (`verified` / `likely_real` / `uncertain` /
  `suspicious`), concrete flags, confidence, and the sources used. A company
  that only exists on job boards comes out `uncertain` — caution, not
  accusation. The judge here is a pure legitimacy check — it doesn't weigh
  the seeker's job preferences at all.
- **Annotate, never block.** Every matched posting is still delivered — the
  Telegram message stays short (title, reason, company + type, location,
  pay, link); a company that can't be verified gets its caution on the
  **Inbox** page instead, with a badge and the full dossier. Research
  failures retry on later runs (up to 3 attempts), then the posting is
  delivered with a "couldn't verify" caution rather than being stuck.
- **Inbox page** — every posting that came out of the filter, as cards:
  the judge's summary, company badge (✓ verified / ? unverified /
  ⚠ suspicious), the dossier, and source links. This is where the full
  reasoning lives — Telegram is just the ping to go look.

## How link accuracy works

Every posting carries a link, and that link has to be the exact posting shown
— not a different job, not some other link off the page, and never something
the model made up.

The link is captured **at scrape time, from the page's own markup**. A job
listing renders each posting as a card holding both the title and its link, so
that association is structural: reading it needs no model judgement and no
extra HTTP request.

- **Card extraction is the primary path.** The page is parsed, repeated
  sibling containers (the cards) are detected, and within each one the job
  link is identified as the anchor slot whose destination is *unique per
  card*. That single rule is what separates it from the company, category and
  tag links sharing the same card — those repeat across cards, so they can
  never win. Titles come from the card's own heading, or from the anchor text
  when a site uses no headings.
- **Duplicate titles are split by company.** Two different companies really do
  post "Staff Product Designer" on the same page; the card's own text carries
  the employer, so the right one is picked. If it is still ambiguous, the
  posting gets **no** link rather than a guessed one.
- **Everything is screened.** A card link is still checked against unambiguous
  non-posting shapes (ad/tracking wrappers, bare company/category index pages,
  login/marketing pages, the listing page itself) before it is stored.
- **ATS and RSS sources skip all of this.** Greenhouse, Lever, Ashby and
  Himalayas hand over real platform URLs directly — those never go near an LLM.
- **Reader-proxy pages keep the citation fallback.** When a site can only be
  reached through a text proxy, the response is markdown with no DOM and
  therefore no cards. Those pages still use the older mechanism: every
  hyperlink is rewritten into a numbered marker (`[[7]]Senior Designer[[/7]]`)
  and the model returns a link **id**, never a URL, so a hallucinated link
  stays structurally impossible there too.
- **Never a dead end.** A posting with no defensible link of its own shows
  **Open source listing**, pointing at the watched page it was found on.

There is deliberately **no post-hoc link verification**, and no "unconfirmed"
badge. An earlier version re-fetched each matched posting to confirm its title
was on the page; it could not work, because the sites that would need checking
are exactly the ones that wall a server-side fetch. In production every single
failed check recorded the same cause — `HTTP 403` — from a datacenter-IP block
(dailyremote.com) or a Cloudflare challenge (himalayas.app, whose links come
straight from its API and were correct all along). The result was a warning
badge on most of the Inbox that told you nothing. A link read off the card that
displays the posting's title does not need re-proving, and costs nothing.

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
                                    # filter layer, dedup, fetch strategy, company layer,
                                    # link provenance
  functions/
    poll-pages/index.ts             # the poller (fetch → extract → resolve links → dedupe →
                                    # keyword gate → judge → company → notify)
    api/index.ts                    # CRUD for the UI
    _shared/                        # fetcher (+ proxy fallback, anchor citation markers),
                                    # ats (Greenhouse/Lever/Ashby/RSS), dom + cards (per-card
                                    # title→link extraction from page markup), links
                                    # (link resolution + re-crawl healing), dedupe, LLM
                                    # adapters, judge, profile expansion, company research,
                                    # telegram, types
    _shared/*_test.ts                # Deno.test unit tests — see Development below
web/                                # React UI: Dashboard, Inbox, Workflow, Sources,
                                    # Postings, Profile, Settings (vercel.json included)
```

## Development

Backend unit tests are plain `Deno.test` files next to the code they cover
(`supabase/functions/_shared/*_test.ts`) — no test framework, no mocks, no
network calls. Run them with the [Deno CLI](https://deno.com):

```sh
deno test supabase/functions/_shared/          # every backend unit test
deno test supabase/functions/_shared/links_test.ts   # a single file
```

Frontend typecheck + build: `cd web && npm run build` (`tsc && vite build`).
There's no CI configured — run both locally before pushing.

**Deploy note:** the anchor-citation change to how pages are converted to
text means every watched page's content hash changes once, so the first poll
after deploying it re-extracts every page in one run — expected, and it's
what applies the fix. Postings whose link only changed shape (not their
identity) are merged into their existing row rather than re-notified; see
"How link trust works" above.

## Out of scope (future phases)

- Re-screening existing postings when the profile changes (Clear profile +
  regenerate replaces the profile fields, but historical verdicts stand)
- Multi-user accounts and auth
- Telegram `/start` webhook onboarding (auto-capture chat ID)
- Notification digests, per-site tuning
- Email/SMS/Slack/push notification channels (schema keeps channels
  pluggable; Telegram is the only one wired up)
- Native mobile apps, resume/LinkedIn import
