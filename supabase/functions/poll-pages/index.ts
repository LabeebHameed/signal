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
import { fetchPageContent, fetchViaJina, sha256 } from "../_shared/fetcher.ts";
import { extractPostings } from "../_shared/llm.ts";
import { judgePostings, profileHasContent } from "../_shared/judge.ts";
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

function dedupeKeyFor(posting: ExtractedPosting, pageUrl: string): { key: string; absoluteUrl: string | null } {
  let absoluteUrl: string | null = null;
  if (posting.url) {
    try {
      absoluteUrl = new URL(posting.url, pageUrl).href;
    } catch {
      absoluteUrl = null;
    }
  }
  if (absoluteUrl) return { key: absoluteUrl.toLowerCase(), absoluteUrl };
  return { key: `t:${posting.title.toLowerCase()}|c:${(posting.company ?? "").toLowerCase()}`, absoluteUrl };
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
 * With filtering off (mode 'off' or an empty profile) rows pass straight
 * through as 'skipped', which also flushes any backlog left from when
 * filtering was on — though still via the company queue when that's active.
 */
async function screenPending(
  db: SupabaseClient,
  page: WatchedPage,
  cfg: RuntimeConfig,
  result: PageResult,
): Promise<string | null> {
  const { data: rows, error } = await db
    .from("postings")
    .select("id, title, url, company, location, posted_at, posted_text")
    .eq("page_id", page.id)
    .eq("filter_status", "pending")
    .order("first_seen_at")
    .limit(SCREEN_BATCH);
  if (error) return `load screening queue failed: ${error.message}`;
  if (!rows || rows.length === 0) return null;

  const layerActive = companyLayerActive(cfg);
  // Only worth a query when a nameless row could still be researched.
  const fallback = layerActive && rows.some((r) => !r.company) ? await pageCompanyFallback(db, page) : null;

  if (cfg.filterMode === "off" || !profileHasContent(cfg.filterProfile)) {
    for (const row of rows) {
      const { error: skipError } = await db
        .from("postings")
        .update({ filter_status: "skipped", ...routeToNotify(row.company ?? fallback, layerActive) })
        .eq("id", row.id);
      if (skipError) return `queue unfiltered postings failed: ${skipError.message}`;
    }
    return null;
  }

  let verdicts;
  try {
    verdicts = await judgePostings(rows, cfg.filterProfile, page.label || page.url, cfg);
  } catch (e) {
    return `screening failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  for (let i = 0; i < rows.length; i++) {
    const verdict = verdicts.get(i);
    if (!verdict) continue; // no valid verdict returned — stays pending, retried next run
    const notify = verdict.verdict === "match" ||
      (verdict.verdict === "borderline" && cfg.filterMode === "balanced");
    const { error: updateError } = await db.from("postings").update({
      filter_status: notify ? "matched" : "filtered",
      filter_score: verdict.score,
      filter_verdict: verdict,
      ...(notify ? routeToNotify(rows[i].company ?? fallback, layerActive) : { pending_notify: false }),
    }).eq("id", rows[i].id);
    if (updateError) return `save verdict failed: ${updateError.message}`;
    result.screened++;
    if (!notify) result.filteredOut++;
  }
  return null;
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

  // Layer switched off (toggle or Jina key removed) since these rows were
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
      cfg.filterProfile,
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
      "id, title, url, company, location, companies(display_name, dossier)",
    )
    .eq("page_id", page.id)
    .eq("pending_notify", true)
    .order("first_seen_at")
    .limit(MAX_NOTIFICATIONS_PER_PAGE_RUN);
  if (error) return `load pending notifications failed: ${error.message}`;
  for (const row of pending ?? []) {
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
      // Telegram is misconfigured or down — don't hammer it for every row.
      return e instanceof Error ? e.message : String(e);
    }
    await db.from("postings").update({
      notified_at: new Date().toISOString(),
      pending_notify: false,
    }).eq("id", row.id);
    result.notified++;
  }
  return null;
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

  // 1. Fetch (preferring whichever source worked before)
  let fetched = await fetchPageContent(page.url, page.fetch_source, cfg.jinaApiKey);

  // 2. Hash short-circuit: nothing changed → no extraction call. Still work
  // through any backlog left by earlier failures: unscreened postings (a
  // failed judge call) and queued notifications (a failed Telegram send).
  let hash = await sha256(fetched.content);
  if (hash === page.last_content_hash) {
    const screenError = await screenPending(db, page, cfg, result);
    const companyError = await companyPending(db, page, cfg, result);
    const notifyError = await notifyPending(db, page, cfg, result);
    await db.from("watched_pages").update({
      last_checked_at: new Date().toISOString(),
      last_error: screenError ?? companyError ?? notifyError,
      failure_count: 0,
    }).eq("id", page.id);
    result.status = "unchanged";
    if (screenError ?? companyError ?? notifyError) result.error = (screenError ?? companyError ?? notifyError)!;
    return result;
  }

  // 3. Extract postings via LLM
  let postings = await extractPostings(fetched.content, page.url, cfg);

  // If a direct fetch that previously yielded postings now yields none, the page
  // may have switched to client-side rendering — retry once through Jina Reader.
  if (postings.length === 0 && fetched.source === "direct" && page.first_crawl_done) {
    const jina = await fetchViaJina(page.url, cfg.jinaApiKey);
    const jinaPostings = await extractPostings(jina.content, page.url, cfg);
    if (jinaPostings.length > 0) {
      fetched = jina;
      hash = await sha256(jina.content);
      postings = jinaPostings;
    }
  }

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
      pending_notify: false,
      filter_status: page.first_crawl_done ? "pending" : "skipped",
      raw: p,
    });
  }

  if (rows.length > 0) {
    const { data, error } = await db
      .from("postings")
      .upsert(rows, { onConflict: "page_id,dedupe_key", ignoreDuplicates: true })
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
  await db.from("watched_pages").update({
    last_content_hash: hash,
    last_checked_at: new Date().toISOString(),
    last_error: stepError ?? truncatedNote,
    failure_count: 0,
    first_crawl_done: true,
    fetch_source: fetched.source,
  }).eq("id", page.id);

  if (stepError) result.error = stepError;
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
 * The initial call of a run (no explicit id list yet): every active page,
 * stalest-checked first, so pages that have been neglected longest — the
 * ones most likely to have been skipped by a prior truncated run — are
 * always at the front of the queue.
 */
async function loadWorklist(db: SupabaseClient): Promise<WatchedPage[]> {
  const { data, error } = await db
    .from("watched_pages")
    .select("*")
    .eq("active", true)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .order("created_at");
  if (error) throw new Error(`load pages failed: ${error.message}`);
  return (data ?? []) as WatchedPage[];
}

async function runPoll(
  db: SupabaseClient,
  cfg: RuntimeConfig,
  pageIds?: string[],
): Promise<{ pages: number; results: PageResult[] }> {
  const worklist = pageIds ? await loadPagesByIds(db, pageIds) : await loadWorklist(db);
  const batch = worklist.slice(0, BATCH_SIZE);
  const remaining = worklist.slice(BATCH_SIZE);

  const results: PageResult[] = [];
  const settled = await Promise.allSettled(batch.map((page) => pollPage(db, page, cfg)));
  for (let i = 0; i < settled.length; i++) {
    const page = batch[i];
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      await db.from("watched_pages").update({
        last_checked_at: new Date().toISOString(),
        last_error: message.slice(0, 500),
        failure_count: page.failure_count + 1,
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
