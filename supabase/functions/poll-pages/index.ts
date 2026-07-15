// poll-pages: check every active watched page for new job postings and
// forward each new one to Telegram.
//
// Auth: requires the x-admin-token header matching settings.admin_token (or
// the ADMIN_TOKEN env var if set — env always wins; see _shared/config.ts).
// Body {"background": true} → respond 202 immediately and poll in the background
// (used by the cron job so pg_net doesn't hold a long connection).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ExtractedPosting, RuntimeConfig, Settings, WatchedPage } from "../_shared/types.ts";
import { resolveConfig } from "../_shared/config.ts";
import { fetchPageContent, fetchViaJina, sha256 } from "../_shared/fetcher.ts";
import { extractPostings } from "../_shared/llm.ts";
import { formatPostingMessage, sendTelegramMessage } from "../_shared/telegram.ts";

// Supabase edge runtime global (lets a response return while work continues)
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const MAX_NOTIFICATIONS_PER_PAGE_RUN = 20;

interface PageResult {
  url: string;
  status: "ok" | "unchanged" | "error";
  newPostings: number;
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

async function pollPage(
  db: SupabaseClient,
  page: WatchedPage,
  cfg: RuntimeConfig,
): Promise<PageResult> {
  const result: PageResult = { url: page.url, status: "ok", newPostings: 0, notified: 0 };

  // 1. Fetch (preferring whichever source worked before)
  let fetched = await fetchPageContent(page.url, page.fetch_source, cfg.jinaApiKey);

  // 2. Hash short-circuit: nothing changed → no LLM call
  let hash = await sha256(fetched.content);
  if (hash === page.last_content_hash) {
    await db.from("watched_pages").update({
      last_checked_at: new Date().toISOString(),
      last_error: null,
      failure_count: 0,
    }).eq("id", page.id);
    result.status = "unchanged";
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
  // ignoreDuplicates makes this return only genuinely-new rows.
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
      raw: p,
    });
  }

  let newRows: Array<{ id: string; title: string; url: string | null; company: string | null; location: string | null }> = [];
  if (rows.length > 0) {
    const { data, error } = await db
      .from("postings")
      .upsert(rows, { onConflict: "page_id,dedupe_key", ignoreDuplicates: true })
      .select("id, title, url, company, location");
    if (error) throw new Error(`insert postings failed: ${error.message}`);
    newRows = data ?? [];
  }
  result.newPostings = newRows.length;

  // 5. Notify — except on the first-ever crawl of a page (baseline snapshot)
  if (page.first_crawl_done && newRows.length > 0 && cfg.telegramBotToken && cfg.telegramChatId) {
    const toNotify = newRows.slice(0, MAX_NOTIFICATIONS_PER_PAGE_RUN);
    for (const row of toNotify) {
      await sendTelegramMessage(
        cfg.telegramBotToken,
        cfg.telegramChatId,
        formatPostingMessage(row, page.label || page.url),
      );
      await db.from("postings").update({ notified_at: new Date().toISOString() }).eq("id", row.id);
      result.notified++;
    }
    if (newRows.length > toNotify.length) {
      await sendTelegramMessage(
        cfg.telegramBotToken,
        cfg.telegramChatId,
        `…and ${newRows.length - toNotify.length} more new postings on ${page.label || page.url}`,
      );
    }
  }

  // 6. Persist page state
  await db.from("watched_pages").update({
    last_content_hash: hash,
    last_checked_at: new Date().toISOString(),
    last_error: fetched.truncated ? "content truncated to 100k chars before extraction" : null,
    failure_count: 0,
    first_crawl_done: true,
    fetch_source: fetched.source,
  }).eq("id", page.id);

  return result;
}

async function runPoll(db: SupabaseClient, cfg: RuntimeConfig): Promise<{ pages: number; results: PageResult[] }> {
  const { data: pages, error: pagesError } = await db
    .from("watched_pages")
    .select("*")
    .eq("active", true)
    .order("created_at");
  if (pagesError) throw new Error(`load pages failed: ${pagesError.message}`);

  const results: PageResult[] = [];
  for (const page of (pages ?? []) as WatchedPage[]) {
    try {
      results.push(await pollPage(db, page, cfg));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await db.from("watched_pages").update({
        last_checked_at: new Date().toISOString(),
        last_error: message.slice(0, 500),
        failure_count: page.failure_count + 1,
      }).eq("id", page.id);
      results.push({ url: page.url, status: "error", newPostings: 0, notified: 0, error: message });
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
  try {
    const body = await req.json();
    background = body?.background === true;
  } catch {
    // no/invalid body → synchronous run
  }

  if (background && typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(
      runPoll(db, cfg).catch((e) => console.error("background poll failed:", e)),
    );
    return new Response(JSON.stringify({ started: true }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const summary = await runPoll(db, cfg);
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
