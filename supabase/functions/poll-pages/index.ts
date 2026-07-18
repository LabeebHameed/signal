// poll-pages: check every active watched page for new job postings, screen
// each new one against the user's job profile (LLM judge — see
// _shared/judge.ts), and forward the ones that qualify to Telegram.
// Non-qualifying postings are kept with their verdict but never notified.
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
import type { ExtractedPosting, RuntimeConfig, Settings, WatchedPage } from "../_shared/types.ts";
import { resolveConfig } from "../_shared/config.ts";
import { fetchPageContent, fetchViaJina, sha256 } from "../_shared/fetcher.ts";
import { extractPostings } from "../_shared/llm.ts";
import { judgePostings, profileHasContent } from "../_shared/judge.ts";
import { formatPostingMessage, sendTelegramMessage } from "../_shared/telegram.ts";

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

interface PageResult {
  url: string;
  status: "ok" | "unchanged" | "error";
  newPostings: number;
  screened: number;
  filteredOut: number;
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
 * Screen this page's unjudged (filter_status='pending') postings against the
 * user's job profile and decide which ones deserve a notification. Matches
 * are queued (pending_notify); misses are kept with their verdict but stay
 * silent. Nothing is ever deleted — every decision is auditable in the UI.
 *
 * A judge failure is returned as an error string and the rows simply stay
 * 'pending', retrying on the next poll run — same contract as notifyPending.
 * With filtering off (mode 'off' or an empty profile) rows pass straight
 * through as 'skipped', which also flushes any backlog left from when
 * filtering was on.
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

  if (cfg.filterMode === "off" || !profileHasContent(cfg.filterProfile)) {
    const { error: skipError } = await db
      .from("postings")
      .update({ filter_status: "skipped", pending_notify: true })
      .in("id", rows.map((r) => r.id));
    return skipError ? `queue unfiltered postings failed: ${skipError.message}` : null;
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
      pending_notify: notify,
      filter_score: verdict.score,
      filter_verdict: verdict,
    }).eq("id", rows[i].id);
    if (updateError) return `save verdict failed: ${updateError.message}`;
    result.screened++;
    if (!notify) result.filteredOut++;
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
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return null; // not configured — rows stay queued
  const { data: pending, error } = await db
    .from("postings")
    .select("id, title, url, company, location, posted_at, posted_text, filter_verdict")
    .eq("page_id", page.id)
    .eq("pending_notify", true)
    .order("first_seen_at")
    .limit(MAX_NOTIFICATIONS_PER_PAGE_RUN);
  if (error) return `load pending notifications failed: ${error.message}`;
  for (const row of pending ?? []) {
    try {
      await sendTelegramMessage(
        cfg.telegramBotToken,
        cfg.telegramChatId,
        formatPostingMessage(row, page.label || page.url, row.filter_verdict),
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
  const result: PageResult = { url: page.url, status: "ok", newPostings: 0, screened: 0, filteredOut: 0, notified: 0 };

  // 1. Fetch (preferring whichever source worked before)
  let fetched = await fetchPageContent(page.url, page.fetch_source, cfg.jinaApiKey);

  // 2. Hash short-circuit: nothing changed → no extraction call. Still work
  // through any backlog left by earlier failures: unscreened postings (a
  // failed judge call) and queued notifications (a failed Telegram send).
  let hash = await sha256(fetched.content);
  if (hash === page.last_content_hash) {
    const screenError = await screenPending(db, page, cfg, result);
    const notifyError = await notifyPending(db, page, cfg, result);
    await db.from("watched_pages").update({
      last_checked_at: new Date().toISOString(),
      last_error: screenError ?? notifyError,
      failure_count: 0,
    }).eq("id", page.id);
    result.status = "unchanged";
    if (screenError ?? notifyError) result.error = (screenError ?? notifyError)!;
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
  // an earlier failure) — matches come out queued for notification.
  const screenError = await screenPending(db, page, cfg, result);

  // 6. Notify queued postings (this run's matches plus any earlier failures).
  // Baseline crawls queue nothing, so this is a no-op there.
  const notifyError = await notifyPending(db, page, cfg, result);

  // 7. Persist page state — always, even when screening or Telegram failed.
  const truncatedNote = fetched.truncated ? "content truncated to 100k chars before extraction" : null;
  await db.from("watched_pages").update({
    last_content_hash: hash,
    last_checked_at: new Date().toISOString(),
    last_error: screenError ?? notifyError ?? truncatedNote,
    failure_count: 0,
    first_crawl_done: true,
    fetch_source: fetched.source,
  }).eq("id", page.id);

  if (screenError ?? notifyError) result.error = (screenError ?? notifyError)!;
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
