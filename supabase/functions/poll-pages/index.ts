// poll-pages: check every active watched page for new job postings, screen
// each new one against the user's job profile (LLM judge — see
// _shared/judge.ts), research the company behind each match (when the
// company layer is enabled — see _shared/company.ts), and forward the ones
// that qualify to Telegram with the company background attached.
// Non-qualifying postings are kept with their verdict but never notified.
// The company layer never blocks: its worst outcome is a caution attached
// to the notification.
//
// Auth: requires the x-admin-token header matching settings.admin_token (or
// the ADMIN_TOKEN env var if set — env always wins; see _shared/config.ts).
// Body {"background": true} → respond 202 immediately and poll in the background
// (used by the cron job so pg_net doesn't hold a long connection).
//
// A run processes active pages in small batches instead of all at once: with
// enough watched pages, fetch+LLM+retries for every one of them sequentially
// (or even all at once) can run long enough for the platform to kill the
// invocation mid-run — silently, with no error recorded for the pages it
// never reached. Each invocation here only handles one bounded batch, then
// fires the next batch as a fresh background invocation, so a run of any
// size eventually covers every page regardless of how long the whole thing
// takes end to end.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import type {
  CompanyRow,
  CompanyVerdict,
  ExtractedPosting,
  RuntimeConfig,
  Settings,
  WatchedPage,
} from "../_shared/types.ts";
import { resolveConfig } from "../_shared/config.ts";
import type { FetchStrategy } from "../_shared/fetcher.ts";
import { fetchPageContent, sha256 } from "../_shared/fetcher.ts";
import { fetchStructured } from "../_shared/ats.ts";
import { extractPostings } from "../_shared/llm.ts";
import { contentKeyFor, dedupeKeyFor } from "../_shared/dedupe.ts";
import { judgePostings, keywordFilterVerdict, profileHasContent, titleMatchesKeywords } from "../_shared/judge.ts";
import {
  companyLayerActive,
  dossierIsFresh,
  judgeCompanies,
  MAX_COMPANY_RESEARCH_FAILURES,
  normalizeCompanyName,
  researchCompany,
  researchRetryDue,
} from "../_shared/company.ts";
import { formatPostingMessage, parseChatIds, sendTelegramMessageToAll } from "../_shared/telegram.ts";

// Supabase edge runtime global (lets a response return while work continues)
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const MAX_NOTIFICATIONS_PER_PAGE_RUN = 20;
// A page claimed longer ago than this is treated as abandoned (the claiming
// invocation crashed or was killed mid-run) and can be reclaimed by the next
// poll — this is what stops an overlapping cron run and a manual "Check now"
// (or two chained batches) from ever processing the same page at once and
// sending the same notification twice.
const CLAIM_STALE_MS = 3 * 60_000;
// How long a notified posting "reserves" its content key against a
// duplicate showing up under a different source. Long enough to cover
// reposts across sibling boards within the same hiring window, short enough
// that a genuinely new opening months later still gets through.
const CONTENT_DEDUPE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// Postings screened per page per run, all in one LLM call. Leftovers stay
// filter_status='pending' and are picked up by the next run.
const SCREEN_BATCH = 20;
// Pages processed per invocation, all in parallel, before chaining to the
// next batch. Kept small and equal to the concurrency so each invocation
// does exactly one wave of work — bounded regardless of total page count.
const BATCH_SIZE = 4;
// Postings per page per run entering the company step; leftovers stay
// company_status='pending' and are picked up by the next run.
const COMPANY_BATCH = 10;
// Fresh company researches (search + LLM dossier) per page per run — the
// expensive part. Cached dossiers are free and don't count.
const COMPANY_RESEARCH_PER_RUN = 3;
// After this many consecutive fetch failures a page is treated as durably
// broken rather than briefly flaky, and drops to the slow retry cadence
// below instead of being refetched on every single poll. A page behind a
// browser challenge will never come back on its own, and hammering it just
// burns the invocation budget that healthy pages need.
const DURABLE_FAILURE_THRESHOLD = 5;
const DURABLE_FAILURE_RECHECK_MS = 3 * 60 * 60 * 1000;

/**
 * A fetch failure that means "this site refuses automated access", as
 * opposed to a transient network/server blip. Anti-bot walls answer with an
 * explicit challenge page (caught by fetcher's block-signature screen), a
 * 403, or a flat "access denied" — none of which a retry ever fixes.
 */
function isBlockedError(message: string): boolean {
  return /blocked by anti-bot check|access denied|HTTP 403/i.test(message);
}

/** What the user sees on a walled source, instead of a wall of raw fetch
 * errors: what happened, that it isn't transient, and what to do about it.
 * The leading phrase is also how the UI recognizes this state — keep the
 * two in sync (see isBlockedSourceError in web/src/lib/format.ts). */
const BLOCKED_SOURCE_MESSAGE =
  "Site blocks automated access (anti-bot challenge) and publishes no usable job feed. " +
  "This can't be fetched automatically, so it's now only retried every few hours — " +
  "remove this source if you don't want it checked.";

// Link extraction (the generic fetch+LLM path only — structured ATS/RSS
// sources get real URLs straight from the platform, never model-extracted)
// relies on the raw HTML actually containing a plain <a href> the model can
// see (see htmlToText in _shared/fetcher.ts). Sites that embed links some
// other way (an attribute style the stripper doesn't yet handle, or genuine
// client-side rendering) leave the model nothing to extract a URL from —
// discovered twice already (cryptocurrencyjobs.co, nodesk.co) by eyeballing
// production data. Rather than only ever catching the next one the same
// slow way, flag it here so a source with unreliable links is visible on
// the Sources page the first time it happens, for any site, without anyone
// having to notice a wrong link by hand first.
const LOW_LINK_QUALITY_PREFIX = "Most postings on this crawl have no direct link";
const LOW_LINK_QUALITY_MIN_ROWS = 3;
const LOW_LINK_QUALITY_THRESHOLD = 0.5;

interface PageResult {
  url: string;
  status: "ok" | "unchanged" | "error";
  newPostings: number;
  screened: number;
  filteredOut: number;
  companiesResearched: number;
  companyWarned: number;
  notified: number;
  error?: string;
}

/**
 * When a posting has no extracted company name, single-employer career pages
 * (the common case) can still be researched under the page's own label — but
 * only when NO posting on the page ever carried a company name. A page whose
 * extractor does find company names is aggregator-like, and a row missing
 * one there stays unresearched rather than being misattributed to the board.
 */
async function pageCompanyFallback(db: SupabaseClient, page: WatchedPage): Promise<string | null> {
  const { data, error } = await db
    .from("postings")
    .select("id")
    .eq("page_id", page.id)
    .not("company", "is", null)
    .limit(1);
  if (error || (data ?? []).length > 0) return null;
  return page.label.trim() !== "" ? page.label.trim() : null;
}

/** What a would-notify posting gets: when the company layer is active and a
 * researchable name exists, it detours through the company queue instead of
 * being queued for Telegram directly. Never suppresses — only sequences. */
function routeToNotify(companyName: string | null, layerActive: boolean): {
  pending_notify: boolean;
  company_status?: string;
} {
  if (layerActive && companyName) return { pending_notify: false, company_status: "pending" };
  return { pending_notify: true };
}

/**
 * Screen this page's unjudged (filter_status='pending') postings against the
 * user's job profile and decide which ones deserve a notification. Matches
 * are queued (pending_notify — or the company queue when the company layer
 * is active); misses are kept with their verdict but stay silent. Nothing is
 * ever deleted — every decision is auditable in the UI.
 *
 * A judge failure is returned as an error string and the rows simply stay
 * 'pending', retrying on the next poll run — same contract as notifyPending.
 * With an empty profile, rows pass straight through as 'skipped', which also
 * flushes any backlog left from when the profile had content — though still
 * via the company queue when that's active.
 */
async function screenPending(
  db: SupabaseClient,
  page: WatchedPage,
  cfg: RuntimeConfig,
  result: PageResult,
): Promise<string | null> {
  const { data: rows, error } = await db
    .from("postings")
    .select("id, title, company, location, compensation, content_key")
    .eq("page_id", page.id)
    .eq("filter_status", "pending")
    .order("first_seen_at")
    .limit(SCREEN_BATCH);
  if (error) return `load screening queue failed: ${error.message}`;
  if (!rows || rows.length === 0) return null;

  const layerActive = companyLayerActive(cfg);
  // Only worth a query when a nameless row could still be researched.
  const fallback = layerActive && rows.some((r) => !r.company)
    ? await pageCompanyFallback(db, page)
    : null;

  if (!profileHasContent(cfg.filterProfile)) {
    for (const row of rows) {
      const { error: skipError } = await db
        .from("postings")
        .update({ filter_status: "skipped", ...routeToNotify(row.company ?? fallback, layerActive) })
        .eq("id", row.id);
      if (skipError) return `queue unfiltered postings failed: ${skipError.message}`;
    }
    return null;
  }

  // Deterministic keyword gate, ahead of the LLM call: a title containing
  // none of the profile's declared title_keywords is rejected outright, no
  // LLM call spent — a hard backstop for cases the judge itself has gotten
  // wrong even with full posting context in hand (see titleMatchesKeywords).
  const forJudge: typeof rows = [];
  for (const row of rows) {
    if (titleMatchesKeywords(row.title, cfg.filterProfile)) {
      forJudge.push(row);
      continue;
    }
    const { error: keywordError } = await db.from("postings").update({
      filter_status: "filtered",
      filter_verdict: keywordFilterVerdict(row.title, cfg.filterProfile),
      keyword_filtered: true,
      pending_notify: false,
    }).eq("id", row.id);
    if (keywordError) return `save keyword-filter verdict failed: ${keywordError.message}`;
    result.screened++;
    result.filteredOut++;
  }
  if (forJudge.length === 0) return null;

  let verdicts;
  try {
    verdicts = await judgePostings(forJudge, cfg.filterProfile, page.label || page.url, cfg);
  } catch (e) {
    return `screening failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  for (let i = 0; i < forJudge.length; i++) {
    const verdict = verdicts.get(i);
    if (!verdict) continue; // no valid verdict returned — stays pending, retried next run
    const notify = verdict.verdict === "match";
    // Cross-source dedup runs right here, before company research — a
    // recognized repost is suppressed immediately instead of spending a
    // Tavily search + LLM dossier call researching a company for a posting
    // that's never going to be sent anyway.
    let duplicateOf: string | null = null;
    if (notify && forJudge[i].content_key) {
      const dup = await findDuplicateNotification(db, forJudge[i].id, forJudge[i].content_key!);
      if (dup.error) return dup.error;
      duplicateOf = dup.duplicateOf;
    }
    const { error: updateError } = await db.from("postings").update({
      filter_status: notify ? "matched" : "filtered",
      filter_verdict: verdict,
      ...(duplicateOf
        ? { duplicate_of: duplicateOf, pending_notify: false }
        : notify
        ? routeToNotify(forJudge[i].company ?? fallback, layerActive)
        : { pending_notify: false }),
    }).eq("id", forJudge[i].id);
    if (updateError) return `save verdict failed: ${updateError.message}`;
    result.screened++;
    if (!notify) result.filteredOut++;
  }
  return null;
}

/**
 * Cross-source dedup lookup: has an equivalent job (same content_key)
 * already been notified from a different posting within the dedupe window?
 * Read-only — the caller applies the result. Checked in two places: right
 * after the judge marks a posting "matched" (screenPending, so a recognized
 * repost skips company research entirely) and again right before sending
 * (notifyPending, a final safety net against postings from different
 * sources racing through the pipeline concurrently in the same run).
 */
async function findDuplicateNotification(
  db: SupabaseClient,
  postingId: string,
  contentKey: string,
): Promise<{ duplicateOf: string | null; error: string | null }> {
  const windowStart = new Date(Date.now() - CONTENT_DEDUPE_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("postings")
    .select("id")
    .eq("content_key", contentKey)
    .not("notified_at", "is", null)
    .neq("id", postingId)
    .gte("notified_at", windowStart)
    .limit(1)
    .maybeSingle();
  if (error) return { duplicateOf: null, error: `duplicate check failed: ${error.message}` };
  return { duplicateOf: data?.id ?? null, error: null };
}

async function loadCompany(db: SupabaseClient, normName: string): Promise<CompanyRow | null> {
  const { data, error } = await db.from("companies").select("*").eq("norm_name", normName).maybeSingle();
  if (error) throw new Error(`load company failed: ${error.message}`);
  return (data as CompanyRow | null) ?? null;
}

/**
 * Research + judge the companies behind this page's company-queued
 * (company_status='pending') postings, then release them to the notify
 * queue. The layer annotates, never blocks: every posting leaves this step
 * with pending_notify=true — 'warned' just carries a caution with it.
 *
 * Research failures are recorded on the company row (retried next run, up
 * to MAX_COMPANY_RESEARCH_FAILURES, then a deterministic "couldn't verify"
 * warn) and never stall the page. A company-judge failure is returned as
 * the page error and rows stay pending — same contract as screenPending.
 */
async function companyPending(
  db: SupabaseClient,
  page: WatchedPage,
  cfg: RuntimeConfig,
  result: PageResult,
): Promise<string | null> {
  const { data: rows, error } = await db
    .from("postings")
    .select("id, title, company")
    .eq("page_id", page.id)
    .eq("company_status", "pending")
    .order("first_seen_at")
    .limit(COMPANY_BATCH);
  if (error) return `load company queue failed: ${error.message}`;
  if (!rows || rows.length === 0) return null;

  // Layer switched off (toggle or Tavily key removed) since these rows were
  // queued — flush them straight to notification, like the filter-off flush.
  if (!companyLayerActive(cfg)) {
    const { error: flushError } = await db
      .from("postings")
      .update({ company_status: "none", pending_notify: true })
      .in("id", rows.map((r) => r.id));
    return flushError ? `flush company queue failed: ${flushError.message}` : null;
  }

  const fallback = rows.some((r) => !r.company) ? await pageCompanyFallback(db, page) : null;

  // Group waiting postings by normalized company name — one research +
  // one verdict per company, however many postings share it.
  const groups = new Map<string, { displayName: string; rowIds: string[]; firstTitle: string }>();
  const orphanIds: string[] = [];
  for (const row of rows) {
    const name = (row.company ?? fallback ?? "").trim();
    const norm = normalizeCompanyName(name);
    if (norm === "") {
      orphanIds.push(row.id); // nothing researchable — release as-is
      continue;
    }
    let group = groups.get(norm);
    if (!group) {
      group = { displayName: name, rowIds: [], firstTitle: row.title };
      groups.set(norm, group);
    }
    group.rowIds.push(row.id);
  }
  if (orphanIds.length > 0) {
    const { error: orphanError } = await db
      .from("postings")
      .update({ company_status: "none", pending_notify: true })
      .in("id", orphanIds);
    if (orphanError) return `release nameless postings failed: ${orphanError.message}`;
  }

  // Make sure each company has a cache row; research stale ones within the
  // per-run budget. Companies left unresearched keep their postings pending.
  let researchBudget = COMPANY_RESEARCH_PER_RUN;
  const ready: Array<{ norm: string; company: CompanyRow }> = [];
  for (const [norm, group] of groups) {
    let company: CompanyRow | null;
    try {
      company = await loadCompany(db, norm);
      if (!company) {
        // ignoreDuplicates + re-select: safe when two page batches hit the
        // same new company concurrently — exactly one row wins.
        await db
          .from("companies")
          .upsert({ norm_name: norm, display_name: group.displayName }, {
            onConflict: "norm_name",
            ignoreDuplicates: true,
          });
        company = await loadCompany(db, norm);
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    if (!company) return `create company row failed for "${group.displayName}"`;

    if (dossierIsFresh(company) || company.failure_count >= MAX_COMPANY_RESEARCH_FAILURES) {
      ready.push({ norm, company }); // cached — or unresearchable, which judges deterministically
      continue;
    }
    if (researchBudget <= 0 || !researchRetryDue(company)) continue;
    researchBudget--;
    try {
      const dossier = await researchCompany(
        company.display_name,
        `posting "${group.firstTitle}" on ${page.label || page.url}`,
        cfg,
      );
      const { error: saveError } = await db.from("companies").update({
        dossier,
        legitimacy: dossier.legitimacy,
        research_status: "ok",
        research_error: null,
        failure_count: 0,
        researched_at: new Date().toISOString(),
      }).eq("id", company.id);
      if (saveError) return `save dossier failed: ${saveError.message}`;
      result.companiesResearched++;
      ready.push({ norm, company: { ...company, dossier, legitimacy: dossier.legitimacy } });
    } catch (e) {
      // Recorded on the company row, not the page — one unresearchable
      // company must not stall the rest of the page's pipeline.
      const message = e instanceof Error ? e.message : String(e);
      await db.from("companies").update({
        research_status: "failed",
        research_error: message.slice(0, 500),
        failure_count: company.failure_count + 1,
        researched_at: new Date().toISOString(),
      }).eq("id", company.id);
    }
  }
  if (ready.length === 0) return null;

  let verdicts: Map<number, CompanyVerdict>;
  try {
    verdicts = await judgeCompanies(
      ready.map(({ company }) => ({ name: company.display_name, dossier: company.dossier })),
      cfg,
    );
  } catch (e) {
    return `company screening failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  for (let i = 0; i < ready.length; i++) {
    const verdict = verdicts.get(i);
    if (!verdict) continue; // no valid verdict — stays pending, retried next run
    const group = groups.get(ready[i].norm)!;
    const { error: updateError } = await db.from("postings").update({
      company_id: ready[i].company.id,
      company_status: verdict.decision === "warn" ? "warned" : "ok",
      company_verdict: verdict,
      pending_notify: true,
    }).in("id", group.rowIds);
    if (updateError) return `save company verdict failed: ${updateError.message}`;
    if (verdict.decision === "warn") result.companyWarned += group.rowIds.length;
  }
  return null;
}

/**
 * Send Telegram messages for this page's queued (pending_notify) postings.
 * A send failure stops the loop and is returned as an error string — the
 * remaining rows stay queued and retry on the next poll run, and the failure
 * never aborts the page's crawl-state bookkeeping.
 */
async function notifyPending(
  db: SupabaseClient,
  page: WatchedPage,
  cfg: RuntimeConfig,
  result: PageResult,
): Promise<string | null> {
  const chatIds = parseChatIds(cfg.telegramChatId);
  if (!cfg.telegramBotToken || chatIds.length === 0) return null; // not configured — rows stay queued
  const { data: pending, error } = await db
    .from("postings")
    .select(
      "id, title, url, company, location, compensation, filter_verdict, content_key, companies(display_name, dossier)",
    )
    .eq("page_id", page.id)
    .eq("pending_notify", true)
    .order("first_seen_at")
    .limit(MAX_NOTIFICATIONS_PER_PAGE_RUN);
  if (error) return `load pending notifications failed: ${error.message}`;
  for (const row of pending ?? []) {
    // Atomically claim this row before sending: only the invocation whose
    // UPDATE actually flips pending_notify proceeds. A concurrent run (an
    // overlapping cron tick, a manual "Check now", two chained batches) that
    // reads the same row loses the race here instead of sending twice.
    const { data: claimed, error: claimError } = await db
      .from("postings")
      .update({ pending_notify: false })
      .eq("id", row.id)
      .eq("pending_notify", true)
      .select("id");
    if (claimError) return `claim notification failed: ${claimError.message}`;
    if (!claimed || claimed.length === 0) continue; // another run already claimed it

    // Cross-source dedup safety net: screenPending already checks this right
    // after the judge marks a posting "matched", but two postings from
    // different sources can still race through the pipeline concurrently in
    // the same run — recheck right before send so neither slips through.
    if (row.content_key) {
      const dup = await findDuplicateNotification(db, row.id, row.content_key);
      if (dup.error) return dup.error;
      if (dup.duplicateOf) {
        await db.from("postings").update({ duplicate_of: dup.duplicateOf }).eq("id", row.id);
        continue; // already notified from another source recently — skip silently
      }
    }

    // PostgREST types the FK embed as an array even though company_id makes
    // it at most one row.
    const company = row.companies as unknown as { display_name: string; dossier: CompanyRow["dossier"] } | null;
    try {
      await sendTelegramMessageToAll(
        cfg.telegramBotToken,
        chatIds,
        formatPostingMessage(row, page.label || page.url, company),
      );
    } catch (e) {
      // Telegram is misconfigured or down — revert the claim so this posting
      // retries on the next poll run instead of being silently dropped, and
      // don't hammer Telegram for every remaining row this run.
      await db.from("postings").update({ pending_notify: true }).eq("id", row.id);
      return e instanceof Error ? e.message : String(e);
    }
    await db.from("postings").update({
      notified_at: new Date().toISOString(),
    }).eq("id", row.id);
    result.notified++;
  }
  return null;
}

/**
 * Everything about how this poll's postings were obtained: either a known
 * ATS platform or RSS/Atom feed (structured — postings straight from the
 * source, no LLM needed), or the generic fetch chain (raw text, still needs
 * extractPostings). Unified here so pollPage has one hash to compare and one
 * strategy to persist regardless of which path produced it.
 */
interface PageContent {
  postings: ExtractedPosting[] | null; // null → generic path, not yet extracted
  content: string | null; // present only for the generic path
  hashInput: string; // what changed-detection hashes
  strategy: string;
  truncated: boolean;
}

async function fetchPageForPolling(page: WatchedPage): Promise<PageContent> {
  // RSS discovery does real network probing (a handful of candidate paths),
  // so it's only worth it on the first-ever crawl or once it's already the
  // established winner — every other poll skips straight past it. ATS
  // hostname matching is next to free (no network call unless it matches)
  // and always worth trying.
  const tryRss = !page.first_crawl_done || page.fetch_strategy === "rss";
  const structured = await fetchStructured(page.url, tryRss);
  if (structured) return fromStructured(structured);

  try {
    const fetched = await fetchPageContent(page.url, page.fetch_strategy as FetchStrategy | null);
    return {
      postings: null,
      content: fetched.content,
      hashInput: fetched.content,
      strategy: fetched.strategy,
      truncated: fetched.truncated,
    };
  } catch (fetchError) {
    // Every fetch strategy failed — most often an anti-bot wall that no
    // amount of retrying will get past. Before giving up, probe for a feed
    // even if we skipped that above: a site that walls its HTML very often
    // still publishes a perfectly good RSS feed, and a page that fetched
    // fine for weeks can start getting walled at any time (which is exactly
    // when the first-crawl-only RSS probe is no longer any help).
    if (!tryRss) {
      const rescued = await fetchStructured(page.url, true);
      if (rescued) return fromStructured(rescued);
    }
    throw fetchError;
  }
}

function fromStructured(structured: { strategy: string; postings: ExtractedPosting[] }): PageContent {
  return {
    postings: structured.postings,
    content: null,
    hashInput: JSON.stringify(structured.postings),
    strategy: structured.strategy,
    truncated: false,
  };
}

async function pollPage(
  db: SupabaseClient,
  page: WatchedPage,
  cfg: RuntimeConfig,
): Promise<PageResult> {
  const result: PageResult = {
    url: page.url,
    status: "ok",
    newPostings: 0,
    screened: 0,
    filteredOut: 0,
    companiesResearched: 0,
    companyWarned: 0,
    notified: 0,
  };

  // 1. Fetch: a known ATS platform or RSS feed skips HTML+LLM entirely
  // (structured data straight from the source, immune to the anti-bot walls
  // generic fetching runs into); otherwise the generic fetch chain.
  let fetched: PageContent;
  try {
    fetched = await fetchPageForPolling(page);
  } catch (fetchError) {
    // A page can accumulate a screening/company/notify backlog (e.g. a
    // transient judge failure) and then start failing to fetch entirely (a
    // wall going up) — that backlog normally only clears once fetching
    // succeeds again (the hash-unchanged branch below), which would leave it
    // stuck for as long as the page keeps failing. Clear it here too, in the
    // same invocation, regardless of the fetch outcome.
    const screenError = await screenPending(db, page, cfg, result);
    const companyError = await companyPending(db, page, cfg, result);
    const notifyError = await notifyPending(db, page, cfg, result);

    const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
    const newFailureCount = page.failure_count + 1;
    const durablyBlocked = isBlockedError(message) && newFailureCount >= DURABLE_FAILURE_THRESHOLD;
    const backlogError = screenError ?? companyError ?? notifyError;
    await db.from("watched_pages").update({
      last_checked_at: new Date().toISOString(),
      last_error: durablyBlocked ? BLOCKED_SOURCE_MESSAGE : message.slice(0, 500),
      failure_count: newFailureCount,
      poll_claimed_at: null,
    }).eq("id", page.id);
    result.status = "error";
    result.error = backlogError ? `${message} | backlog: ${backlogError}` : message;
    return result;
  }

  // 2. Hash short-circuit: nothing changed → no extraction call. Still work
  // through any backlog left by earlier failures: unscreened postings (a
  // failed judge call) and queued notifications (a failed Telegram send).
  const hash = await sha256(fetched.hashInput);
  if (hash === page.last_content_hash) {
    const screenError = await screenPending(db, page, cfg, result);
    const companyError = await companyPending(db, page, cfg, result);
    const notifyError = await notifyPending(db, page, cfg, result);
    // A link-quality warning was set on the crawl that last actually
    // extracted content — nothing here re-extracts on an unchanged hash, so
    // preserve it instead of silently wiping it after a single poll cycle.
    const preservedWarning = page.last_error?.startsWith(LOW_LINK_QUALITY_PREFIX) ? page.last_error : null;
    await db.from("watched_pages").update({
      last_checked_at: new Date().toISOString(),
      last_error: screenError ?? companyError ?? notifyError ?? preservedWarning,
      failure_count: 0,
      fetch_strategy: fetched.strategy,
      poll_claimed_at: null,
    }).eq("id", page.id);
    result.status = "unchanged";
    if (screenError ?? companyError ?? notifyError) result.error = (screenError ?? companyError ?? notifyError)!;
    return result;
  }

  // 3. Extract postings — already done for the structured path.
  const postings = fetched.postings ?? await extractPostings(fetched.content!, page.url, cfg);

  // 4. Diff by dedupe key — the unique(page_id, dedupe_key) constraint plus
  // ignoreDuplicates makes this return only genuinely-new rows. New rows on
  // a non-baseline crawl enter the screening queue (filter_status='pending');
  // whether they get notified is the screening step's decision. Baseline
  // rows are never screened or notified.
  const seen = new Set<string>();
  const rows = [];
  for (const p of postings) {
    const { key, absoluteUrl } = dedupeKeyFor(p, page.url);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      page_id: page.id,
      dedupe_key: key,
      title: p.title,
      url: absoluteUrl,
      company: p.company ?? null,
      location: p.location ?? null,
      posted_at: p.posted_at ?? null,
      posted_text: p.posted_text ?? null,
      compensation: p.compensation ?? null,
      content_key: contentKeyFor(p.title, p.company),
      pending_notify: false,
      filter_status: page.first_crawl_done ? "pending" : "skipped",
      raw: p,
    });
  }

  // Link-extraction health signal — generic fetch+LLM path only (structured
  // ATS/RSS postings get real URLs straight from the platform, never
  // model-extracted, so this can't meaningfully fire there). See
  // LOW_LINK_QUALITY_PREFIX above for why this exists.
  let linkWarning: string | null = null;
  if (fetched.postings === null && rows.length >= LOW_LINK_QUALITY_MIN_ROWS) {
    const missing = rows.filter((r) => !r.url).length;
    if (missing / rows.length > LOW_LINK_QUALITY_THRESHOLD) {
      linkWarning = `${LOW_LINK_QUALITY_PREFIX} (${missing}/${rows.length} this crawl) — this page's markup ` +
        `may not expose per-posting links in a way the extractor recognizes. Postings are still tracked; ` +
        `treat the link as unverified until you check a few by hand.`;
    }
  }

  if (rows.length > 0) {
    const now = new Date().toISOString();
    // Refresh last_seen_at for postings still present on this crawl before
    // inserting: upsert's ignoreDuplicates below skips existing rows
    // entirely, so without this touch a posting that's been listed for
    // weeks would never show a recent last_seen_at.
    const { error: touchError } = await db
      .from("postings")
      .update({ last_seen_at: now })
      .eq("page_id", page.id)
      .in("dedupe_key", rows.map((r) => r.dedupe_key));
    if (touchError) throw new Error(`refresh last_seen_at failed: ${touchError.message}`);

    const { data, error } = await db
      .from("postings")
      .upsert(rows.map((r) => ({ ...r, last_seen_at: now })), {
        onConflict: "page_id,dedupe_key",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) throw new Error(`insert postings failed: ${error.message}`);
    result.newPostings = (data ?? []).length;
  }

  // 5. Screen the queue (this run's new postings plus any left unjudged by
  // an earlier failure) — matches come out queued for the company step or,
  // with the company layer off, directly for notification.
  const screenError = await screenPending(db, page, cfg, result);

  // 6. Research + judge the companies behind company-queued matches, then
  // release them to the notify queue (annotated, never suppressed).
  const companyError = await companyPending(db, page, cfg, result);

  // 7. Notify queued postings (this run's matches plus any earlier failures).
  // Baseline crawls queue nothing, so this is a no-op there.
  const notifyError = await notifyPending(db, page, cfg, result);

  // 8. Persist page state — always, even when screening or Telegram failed.
  const truncatedNote = fetched.truncated ? "content truncated to 100k chars before extraction" : null;
  const stepError = screenError ?? companyError ?? notifyError;
  const softNote = [truncatedNote, linkWarning].filter(Boolean).join(" | ") || null;
  await db.from("watched_pages").update({
    last_content_hash: hash,
    last_checked_at: new Date().toISOString(),
    last_error: stepError ?? softNote,
    failure_count: 0,
    first_crawl_done: true,
    fetch_strategy: fetched.strategy,
    poll_claimed_at: null,
  }).eq("id", page.id);

  if (stepError) result.error = stepError;
  else if (linkWarning) result.error = linkWarning;
  return result;
}

/** Fetch pages by id, preserving the given order (Supabase doesn't guarantee row order for `.in()`). */
async function loadPagesByIds(db: SupabaseClient, ids: string[]): Promise<WatchedPage[]> {
  const { data, error } = await db.from("watched_pages").select("*").in("id", ids);
  if (error) throw new Error(`load pages failed: ${error.message}`);
  const byId = new Map((data ?? []).map((p) => [p.id, p as WatchedPage]));
  return ids.map((id) => byId.get(id)).filter((p): p is WatchedPage => Boolean(p));
}

/**
 * A page that has failed to fetch many times in a row and was checked
 * recently. Retrying it every poll is pure waste — the common cause is an
 * anti-bot wall, which never clears on its own — and each dead page's
 * timeouts eat time the healthy pages in the same batch need. Dropping to
 * a few-hour cadence keeps it recovering automatically (if the site
 * unblocks, or starts publishing a feed we can find) without the cost.
 */
function inFailureBackoff(page: WatchedPage): boolean {
  if (page.failure_count < DURABLE_FAILURE_THRESHOLD || !page.last_checked_at) return false;
  return Date.now() - new Date(page.last_checked_at).getTime() < DURABLE_FAILURE_RECHECK_MS;
}

/**
 * The initial call of a run (no explicit id list yet): every active,
 * currently-unclaimed page, stalest-checked first, so pages that have been
 * neglected longest — the ones most likely to have been skipped by a prior
 * truncated run — are always at the front of the queue. A page claimed by
 * another in-flight run is excluded unless that claim has gone stale
 * (crashed invocation), which claimBatch's atomic re-check also guards.
 * Durably-failing pages are held back to a slow cadence (inFailureBackoff).
 */
async function loadWorklist(db: SupabaseClient): Promise<WatchedPage[]> {
  const staleThreshold = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data, error } = await db
    .from("watched_pages")
    .select("*")
    .eq("active", true)
    .or(`poll_claimed_at.is.null,poll_claimed_at.lt.${staleThreshold}`)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .order("created_at");
  if (error) throw new Error(`load pages failed: ${error.message}`);
  return ((data ?? []) as WatchedPage[]).filter((p) => !inFailureBackoff(p));
}

/**
 * Atomically claim a candidate batch before processing it: the UPDATE only
 * touches rows that are still unclaimed (or staled-out), so when two runs
 * race for the same page exactly one of them wins it here — the loser drops
 * that page from its batch instead of processing (and notifying) it too.
 */
async function claimBatch(db: SupabaseClient, candidates: WatchedPage[]): Promise<WatchedPage[]> {
  if (candidates.length === 0) return [];
  const staleThreshold = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const ids = candidates.map((p) => p.id);
  const { data, error } = await db
    .from("watched_pages")
    .update({ poll_claimed_at: new Date().toISOString() })
    .in("id", ids)
    .or(`poll_claimed_at.is.null,poll_claimed_at.lt.${staleThreshold}`)
    .select("id");
  if (error) throw new Error(`claim pages failed: ${error.message}`);
  const claimed = new Set((data ?? []).map((r: { id: string }) => r.id));
  return candidates.filter((p) => claimed.has(p.id));
}

async function runPoll(
  db: SupabaseClient,
  cfg: RuntimeConfig,
  pageIds?: string[],
): Promise<{ pages: number; results: PageResult[] }> {
  const worklist = pageIds ? await loadPagesByIds(db, pageIds) : await loadWorklist(db);
  const candidateBatch = worklist.slice(0, BATCH_SIZE);
  const remaining = worklist.slice(BATCH_SIZE);
  const batch = await claimBatch(db, candidateBatch);

  const results: PageResult[] = [];
  const settled = await Promise.allSettled(batch.map((page) => pollPage(db, page, cfg)));
  for (let i = 0; i < settled.length; i++) {
    const page = batch[i];
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      const newFailureCount = page.failure_count + 1;
      // Once a wall has proven durable, stop showing the raw per-strategy
      // fetch errors — they're noise the user can't act on. Say plainly what
      // happened and what their options are instead. Below the threshold the
      // real error still shows, since an early failure may well be transient.
      const durablyBlocked = isBlockedError(message) && newFailureCount >= DURABLE_FAILURE_THRESHOLD;
      await db.from("watched_pages").update({
        last_checked_at: new Date().toISOString(),
        last_error: durablyBlocked ? BLOCKED_SOURCE_MESSAGE : message.slice(0, 500),
        failure_count: newFailureCount,
        poll_claimed_at: null,
      }).eq("id", page.id);
      results.push({
        url: page.url,
        status: "error",
        newPostings: 0,
        screened: 0,
        filteredOut: 0,
        companiesResearched: 0,
        companyWarned: 0,
        notified: 0,
        error: message,
      });
    }
  }

  if (remaining.length > 0) {
    try {
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/poll-pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": cfg.adminToken },
        body: JSON.stringify({ background: true, pageIds: remaining.map((p) => p.id) }),
      });
    } catch (e) {
      console.error("failed to chain next poll batch:", e);
    }
  }

  return { pages: results.length, results };
}

Deno.serve(async (req: Request) => {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: settings, error: settingsError } = await db.from("settings").select("*").eq("id", 1).single();
  if (settingsError) {
    return new Response(JSON.stringify({ error: `load settings failed: ${settingsError.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const cfg = resolveConfig(settings as Settings);

  if (!cfg.adminToken || req.headers.get("x-admin-token") !== cfg.adminToken) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let background = false;
  let pageIds: string[] | undefined;
  try {
    const body = await req.json();
    background = body?.background === true;
    if (Array.isArray(body?.pageIds)) {
      pageIds = body.pageIds.filter((id: unknown): id is string => typeof id === "string");
    }
  } catch {
    // no/invalid body → synchronous run
  }

  if (background && typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(
      runPoll(db, cfg, pageIds).catch((e) => console.error("background poll failed:", e)),
    );
    return new Response(JSON.stringify({ started: true }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const summary = await runPoll(db, cfg, pageIds);
    return new Response(JSON.stringify(summary), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
