// api: CRUD backend for the web UI. All routes require the x-admin-token
// header matching settings.admin_token (or the ADMIN_TOKEN env var if set).
//
//   GET    /pages                 list watched pages
//   POST   /pages                 { urls: string[] } bulk-add pages: already-watched
//                                 URLs are silently skipped, new ones get a label
//                                 auto-derived from the hostname (dribbble.com -> Dribbble).
//                                 Also accepts a single { url, label? } for a manual add
//                                 with a custom label.
//   PATCH  /pages/:id             { active?, label? } update a page
//   DELETE /pages/:id             remove a page (and its postings)
//   GET    /settings              read settings (secrets masked to has_* booleans)
//   PUT    /settings              update settings; secret fields only change
//                                 when sent as non-empty strings. filter_profile
//                                 is sanitized to the known profile fields (a PUT
//                                 replaces the whole profile). negative_keywords is
//                                 a plain string, independent of filter_profile.
//   POST   /profile/expand        { statement } → { profile }: expand the user's
//                                 one-sentence "what I'm looking for" into
//                                 roles/role_synonyms/title_keywords via the LLM.
//                                 Preview only — nothing is saved (use PUT /settings).
//   GET    /postings              postings with filter + sort + pagination:
//                                 ?limit=50&offset=0&sort=first_seen_at|title|company|notified_at
//                                 &order=asc|desc&status=pending|matched|filtered|skipped
//                                 &page_id=<uuid>&company_status=none|pending|ok|warned
//                                 &notified=true|false&pending_notify=true|false
//                                 &screened=true (matched+filtered, for a combined pass/fail view)
//                                 &duplicate=true (recognized as a repost of an already-notified
//                                 job from another source — suppressed rather than sent again)
//                                 &keyword_filtered=true|false (rejected by the deterministic
//                                 title-keyword gate ahead of the AI judge, vs by the judge itself)
//                                 &negative_keyword_filtered=true|false (rejected by the seeker's
//                                 negative-keywords override, ahead of every other gate)
//                                 → { items, total }
//                                 (the extra filters are for the Workflow page's per-stage
//                                 audit rosters — send at most one of status/screened per
//                                 request, they override rather than intersect; duplicate
//                                 combines with status:"matched")
//   DELETE /postings              wipe every posting (testing/reset) and reset each
//                                 watched page's crawl-state (content hash, error,
//                                 failure count, claim) so the next poll re-fetches
//                                 and re-extracts from scratch instead of short-
//                                 circuiting on an unchanged hash. first_crawl_done
//                                 is left as-is so re-discovered postings are
//                                 screened (and can notify) same as any other run.
//   POST   /poll                  trigger a poll run in the background, returns
//                                 { started: true } immediately — watch /pages
//                                 and /postings for results as they land
//   POST   /telegram-test         send a test message to the configured chat and
//                                 return Telegram's exact response (for debugging)
//   POST   /company-test          { name } → research one company synchronously and
//                                 return the raw dossier (for debugging the company
//                                 layer; requires a Tavily API key)
//   GET    /companies             list every researched/cached company (directory)
//   POST   /companies/:id/research  force a fresh re-research of one company,
//                                 overwriting its cached dossier

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import type { CompCurrency, CompPeriod, FilterProfile, Settings } from "../_shared/types.ts";
import {
  COMP_CURRENCIES,
  COMP_PERIODS,
  FILTER_PROFILE_KEYS,
  TAGGED_PROFILE_KEYS,
} from "../_shared/types.ts";
import { resolveConfig } from "../_shared/config.ts";
import { deriveLabel } from "../_shared/label.ts";
import { expandProfile } from "../_shared/profile.ts";
import { researchCompany } from "../_shared/company.ts";
import { chatIdIsBotItself, parseChatIds, sendTelegramMessageToAll } from "../_shared/telegram.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-admin-token",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/** Trim, drop blanks, and de-duplicate a tag list sent by the Profile page.
 * Commas are stripped because the derived prose fields join on them — a tag
 * containing one would re-split downstream into two the seeker never typed. */
function sanitizeTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const cleaned = entry.replace(/[,;\n]/g, " ").trim().replace(/\s+/g, " ");
    if (cleaned === "") continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/** A positive finite integer, or undefined — a 0/negative/NaN bound is not a
 * pay target, and storing it would switch the compensation gate on by
 * accident. */
function sanitizeAmount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

/** The prose form of the location preference, rebuilt server-side so the
 * judge's view can never drift from what the Profile page shows. */
function deriveLocations(include: string[], exclude: string[]): string {
  const parts: string[] = [];
  if (include.length > 0) parts.push(`Only: ${include.join(", ")}`);
  if (exclude.length > 0) parts.push(`Never: ${exclude.join(", ")}`);
  return parts.join(". ");
}

const CURRENCY_SYMBOLS: Record<CompCurrency, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
};

/** Mirrors the web app's formatCompact (web/src/lib/format.ts) — rupees use
 * the lakh/crore scale because that is how Indian pay is actually quoted. */
function compactAmount(amount: number, currency: CompCurrency): string {
  const symbol = CURRENCY_SYMBOLS[currency];
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (currency === "INR") {
    if (amount >= 10_000_000) return `${symbol}${trim(amount / 10_000_000)}Cr`;
    if (amount >= 100_000) return `${symbol}${trim(amount / 100_000)}L`;
    if (amount >= 1_000) return `${symbol}${trim(amount / 1_000)}K`;
    return `${symbol}${amount}`;
  }
  if (amount >= 1_000_000) return `${symbol}${trim(amount / 1_000_000)}M`;
  if (amount >= 1_000) return `${symbol}${trim(amount / 1_000)}K`;
  return `${symbol}${amount}`;
}

/** The prose form of the pay range, rebuilt server-side for the same reason
 * as deriveLocations. */
function deriveCompensation(
  min: number | undefined,
  max: number | undefined,
  currency: CompCurrency,
  period: CompPeriod,
): string {
  const unit = period === "month" ? "/ mo" : "/ yr";
  if (min !== undefined && max !== undefined) {
    return `${compactAmount(min, currency)} – ${compactAmount(max, currency)} ${unit}`;
  }
  if (min !== undefined) return `From ${compactAmount(min, currency)} ${unit}`;
  if (max !== undefined) return `Up to ${compactAmount(max, currency)} ${unit}`;
  return "";
}

/** The settings shape the UI sees: no secret values, only whether they're set. */
function maskSettings(s: Settings) {
  return {
    profile_input: s.profile_input ?? "",
    filter_profile: s.filter_profile ?? {},
    negative_keywords: s.negative_keywords ?? "",
    company_filter_enabled: s.company_filter_enabled ?? false,
    telegram_chat_id: s.telegram_chat_id,
    llm_provider: s.llm_provider,
    llm_model: s.llm_model,
    llm_base_url: s.llm_base_url,
    has_llm_api_key: s.llm_api_key !== "",
    has_telegram_bot_token: s.telegram_bot_token !== "",
    has_tavily_api_key: s.tavily_api_key !== "",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: settingsRow, error: settingsError } = await db.from("settings").select("*").eq("id", 1).single();
  if (settingsError) return json({ error: `load settings failed: ${settingsError.message}` }, 500);
  const settings = settingsRow as Settings;
  const cfg = resolveConfig(settings);

  if (!cfg.adminToken || req.headers.get("x-admin-token") !== cfg.adminToken) {
    return json({ error: "unauthorized" }, 401);
  }

  // Function URLs look like /functions/v1/api/<route>; strip up to the function name.
  const pathname = new URL(req.url).pathname;
  const route = pathname.replace(/^.*?\/api/, "") || "/";
  const [, resource, resourceId, action] = route.split("/");

  try {
    if (resource === "pages" && !resourceId && req.method === "GET") {
      // url as a tiebreaker: bulk-added rows share one created_at, and without
      // a deterministic tiebreaker the list reshuffles on every fetch.
      const { data, error } = await db
        .from("watched_pages")
        .select("*")
        .order("created_at")
        .order("url");
      if (error) throw error;
      return json(data);
    }

    if (resource === "pages" && !resourceId && req.method === "POST") {
      const body = await req.json();

      // Bulk add: { urls: [...] }. Already-watched URLs are silently skipped
      // (not an error); each new one gets a label derived from its hostname.
      if (Array.isArray(body.urls)) {
        const seen = new Set<string>();
        const invalid: string[] = [];
        const rows: Array<{ url: string; label: string }> = [];
        for (const raw of body.urls) {
          const url = typeof raw === "string" ? raw.trim() : "";
          if (!url) continue;
          try {
            new URL(url);
          } catch {
            invalid.push(url);
            continue;
          }
          if (seen.has(url)) continue;
          seen.add(url);
          rows.push({ url, label: deriveLabel(url) });
        }

        let added: unknown[] = [];
        if (rows.length > 0) {
          const { data, error } = await db
            .from("watched_pages")
            .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
            .select();
          if (error) throw error;
          added = data ?? [];
        }

        return json({
          added,
          addedCount: added.length,
          skippedCount: rows.length - added.length,
          invalid,
        }, 201);
      }

      // Single add with an explicit label override.
      const url = typeof body.url === "string" ? body.url.trim() : "";
      try {
        new URL(url);
      } catch {
        return json({ error: "invalid url" }, 400);
      }
      const label = typeof body.label === "string" && body.label.trim() !== ""
        ? body.label.trim()
        : deriveLabel(url);
      const { data, error } = await db
        .from("watched_pages")
        .insert({ url, label })
        .select()
        .single();
      if (error) {
        if (error.code === "23505") return json({ error: "page already watched" }, 409);
        throw error;
      }
      return json(data, 201);
    }

    if (resource === "pages" && resourceId && req.method === "PATCH") {
      const body = await req.json();
      const patch: Record<string, unknown> = {};
      if (typeof body.active === "boolean") patch.active = body.active;
      if (typeof body.label === "string") patch.label = body.label.trim();
      const { data, error } = await db
        .from("watched_pages")
        .update(patch)
        .eq("id", resourceId)
        .select()
        .single();
      if (error) throw error;
      return json(data);
    }

    if (resource === "pages" && resourceId && req.method === "DELETE") {
      const { error } = await db.from("watched_pages").delete().eq("id", resourceId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (resource === "settings" && req.method === "GET") {
      return json(maskSettings(settings));
    }

    if (resource === "settings" && req.method === "PUT") {
      const body = await req.json();
      const patch: Record<string, unknown> = {};
      // Non-secret fields: any provided string is applied as-is.
      for (
        const field of [
          "telegram_chat_id",
          "llm_provider",
          "llm_model",
          "llm_base_url",
          "profile_input",
          "negative_keywords",
        ]
      ) {
        if (typeof body[field] === "string") patch[field] = body[field].trim();
      }
      if (typeof body.company_filter_enabled === "boolean") {
        patch.company_filter_enabled = body.company_filter_enabled;
      }
      // Job filter: the profile is rebuilt from the known fields only (a PUT
      // replaces the whole profile — empty/omitted fields clear).
      if (typeof body.filter_profile === "object" && body.filter_profile !== null) {
        const incoming = body.filter_profile as Record<string, unknown>;
        const profile: FilterProfile = {};
        for (const key of FILTER_PROFILE_KEYS) {
          const value = incoming[key];
          if (typeof value === "string" && value.trim() !== "") profile[key] = value.trim();
        }

        // Structured location/compensation preferences. `locations` and
        // `compensation` are then DERIVED from them and overwrite whatever
        // the client sent for those two keys, so the prose the judge reads is
        // always the server's own rendering of the structured truth — a
        // client that lags behind can't leave the two disagreeing.
        const include = sanitizeTagList(incoming.locations_include);
        const exclude = sanitizeTagList(incoming.locations_exclude);
        if (include.length > 0) profile.locations_include = include;
        if (exclude.length > 0) profile.locations_exclude = exclude;
        const derivedLocations = deriveLocations(include, exclude);
        if (derivedLocations !== "") profile.locations = derivedLocations;
        else delete profile.locations;

        const min = sanitizeAmount(incoming.compensation_min);
        const max = sanitizeAmount(incoming.compensation_max);
        const currency = COMP_CURRENCIES.includes(incoming.compensation_currency as CompCurrency)
          ? incoming.compensation_currency as CompCurrency
          : "USD";
        const period = COMP_PERIODS.includes(incoming.compensation_period as CompPeriod)
          ? incoming.compensation_period as CompPeriod
          : "year";
        if (min !== undefined) profile.compensation_min = min;
        if (max !== undefined) profile.compensation_max = max;
        if (min !== undefined || max !== undefined) {
          profile.compensation_currency = currency;
          profile.compensation_period = period;
          profile.compensation = deriveCompensation(min, max, currency, period);
        } else {
          delete profile.compensation;
        }

        // Per-value AI/user provenance, kept only for values the profile
        // still actually contains.
        const rawProvenance = incoming.ai_generated;
        if (typeof rawProvenance === "object" && rawProvenance !== null) {
          const source = rawProvenance as Record<string, unknown>;
          const provenance: NonNullable<FilterProfile["ai_generated"]> = {};
          for (const key of TAGGED_PROFILE_KEYS) {
            const claimed = sanitizeTagList(source[key]);
            if (claimed.length === 0) continue;
            const present = new Set(
              (profile[key] ?? "").split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
            );
            const kept = claimed.filter((v) => present.has(v.toLowerCase()));
            if (kept.length > 0) provenance[key] = kept;
          }
          if (Object.keys(provenance).length > 0) profile.ai_generated = provenance;
        }

        patch.filter_profile = profile;
      }
      // Secret fields: only overwrite when a non-empty value is sent
      // (the UI sends "" / omits them to mean "keep the current value").
      for (const field of ["llm_api_key", "telegram_bot_token", "tavily_api_key"]) {
        if (typeof body[field] === "string" && body[field].trim() !== "") {
          patch[field] = body[field].trim();
        }
      }

      // Guard against the #1 Telegram setup mistake: pasting the bot's own ID
      // (the numeric prefix of its token) into the chat-ID field. Telegram
      // will never let that combination send, so reject it before saving
      // rather than let it fail mysteriously later.
      const effectiveChatId = (patch.telegram_chat_id as string | undefined) ?? settings.telegram_chat_id;
      const effectiveBotToken = (patch.telegram_bot_token as string | undefined) ?? settings.telegram_bot_token;
      if (effectiveBotToken && effectiveChatId && chatIdIsBotItself(effectiveBotToken, effectiveChatId)) {
        return json({
          error:
            "That chat ID is your bot's own ID (the number before ':' in its token), not yours. " +
            "Message @userinfobot on Telegram to get your personal chat ID.",
        }, 400);
      }

      const { data, error } = await db.from("settings").update(patch).eq("id", 1).select().single();
      if (error) throw error;
      return json(maskSettings(data as Settings));
    }

    if (resource === "postings" && req.method === "GET") {
      const params = new URL(req.url).searchParams;
      const limit = Math.min(Number(params.get("limit")) || 50, 200);
      const offset = Math.max(Number(params.get("offset")) || 0, 0);
      const sortable = ["first_seen_at", "title", "company", "notified_at"];
      const sort = sortable.includes(params.get("sort") ?? "") ? params.get("sort")! : "first_seen_at";
      const ascending = params.get("order") === "asc";
      const status = params.get("status") ?? "";
      const pageId = params.get("page_id") ?? "";
      const companyStatus = params.get("company_status") ?? "";
      const notified = params.get("notified");
      const pendingNotify = params.get("pending_notify");
      const screened = params.get("screened") === "true";
      const duplicate = params.get("duplicate") === "true";
      const keywordFiltered = params.get("keyword_filtered");
      const negativeKeywordFiltered = params.get("negative_keyword_filtered");
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let query = db
        .from("postings")
        .select(
          "id, title, url, company, location, compensation, posted_at, posted_text, first_seen_at, notified_at, pending_notify, filter_status, filter_verdict, company_status, company_verdict, duplicate_of, keyword_filtered, negative_keyword_filtered, link_source, link_verification, link_final_url, link_checked_at, link_note, companies(display_name, legitimacy, dossier, researched_at), watched_pages(label, url)",
          { count: "exact" },
        );
      if (["pending", "matched", "filtered", "skipped"].includes(status)) {
        query = query.eq("filter_status", status);
      }
      if (pageId && UUID_RE.test(pageId)) query = query.eq("page_id", pageId);
      if (["none", "pending", "ok", "warned"].includes(companyStatus)) {
        query = query.eq("company_status", companyStatus);
      }
      if (notified === "true") query = query.not("notified_at", "is", null);
      else if (notified === "false") query = query.is("notified_at", null);
      if (pendingNotify === "true") query = query.eq("pending_notify", true);
      else if (pendingNotify === "false") query = query.eq("pending_notify", false);
      // screened is a combined view for the Workflow page's audit rosters —
      // it overrides the plain filter_status match above rather than
      // intersecting with it (a request should only send one).
      if (screened) query = query.in("filter_status", ["matched", "filtered"]);
      // duplicate combines with status (a duplicate is always filter_status
      // = 'matched' by construction — only matched postings ever reach the
      // notify step's dedupe check).
      if (duplicate) query = query.not("duplicate_of", "is", null);
      if (keywordFiltered === "true") query = query.eq("keyword_filtered", true);
      else if (keywordFiltered === "false") query = query.eq("keyword_filtered", false);
      if (negativeKeywordFiltered === "true") query = query.eq("negative_keyword_filtered", true);
      else if (negativeKeywordFiltered === "false") query = query.eq("negative_keyword_filtered", false);
      const { data, error, count } = await query
        .order(sort, { ascending, nullsFirst: false })
        .order("id") // deterministic tiebreaker so pages don't overlap
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return json({ items: data, total: count ?? 0 });
    }

    if (resource === "postings" && !resourceId && req.method === "DELETE") {
      const { error: deleteError, count } = await db
        .from("postings")
        .delete({ count: "exact" })
        .not("id", "is", null);
      if (deleteError) throw deleteError;

      // Reset crawl state so the next poll re-fetches and re-extracts every
      // page from scratch instead of skipping extraction on an unchanged
      // content hash. first_crawl_done is intentionally left alone: rows
      // discovered on the next poll should be screened (and can notify),
      // not silently treated as a fresh baseline.
      const { error: resetError } = await db
        .from("watched_pages")
        .update({
          last_content_hash: null,
          last_error: null,
          failure_count: 0,
          poll_claimed_at: null,
        })
        .not("id", "is", null);
      if (resetError) throw resetError;

      return json({ ok: true, deleted: count ?? 0 });
    }

    if (resource === "profile" && resourceId === "expand" && req.method === "POST") {
      const body = await req.json();
      const statement = typeof body.statement === "string" ? body.statement.trim() : "";
      if (statement === "") return json({ error: "statement is required" }, 400);
      const profile = await expandProfile(statement, cfg);
      return json({ profile });
    }

    if (resource === "telegram-test" && req.method === "POST") {
      if (!cfg.telegramBotToken) return json({ error: "no Telegram bot token set in Settings" }, 400);
      if (!cfg.telegramChatId) return json({ error: "no Telegram chat ID set in Settings" }, 400);
      if (chatIdIsBotItself(cfg.telegramBotToken, cfg.telegramChatId)) {
        return json({
          error:
            "The saved chat ID is your bot's own ID, not yours. Message @userinfobot on Telegram to get your " +
            "personal chat ID, then update it in Settings.",
        }, 400);
      }
      try {
        const chatIds = parseChatIds(cfg.telegramChatId);
        await sendTelegramMessageToAll(
          cfg.telegramBotToken,
          chatIds,
          "✅ Test message from Signal — your Telegram notifications are working.",
        );
        return json({ ok: true, sentTo: chatIds.length });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 502);
      }
    }

    if (resource === "company-test" && req.method === "POST") {
      if (!cfg.tavilyApiKey.trim()) {
        return json({ error: "company research needs a Tavily API key (free at tavily.com) — set it in Settings" }, 400);
      }
      const body = await req.json();
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name === "") return json({ error: "name is required" }, 400);
      const dossier = await researchCompany(name, "manual test from Settings", cfg);
      return json({ dossier });
    }

    if (resource === "companies" && !resourceId && req.method === "GET") {
      const { data, error } = await db.from("companies").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return json(data);
    }

    if (resource === "companies" && resourceId && action === "research" && req.method === "POST") {
      if (!cfg.tavilyApiKey.trim()) {
        return json({ error: "company research needs a Tavily API key (free at tavily.com) — set it in Settings" }, 400);
      }
      const { data: company, error: fetchErr } = await db.from("companies").select("*").eq("id", resourceId).single();
      if (fetchErr || !company) return json({ error: "company not found" }, 404);

      const dossier = await researchCompany(company.display_name, "manual directory research", cfg);
      const { data: updated, error: updateErr } = await db.from("companies").update({
        dossier,
        legitimacy: dossier.legitimacy,
        research_status: "ok",
        research_error: null,
        failure_count: 0,
        researched_at: new Date().toISOString(),
      }).eq("id", resourceId).select().single();
      if (updateErr) throw updateErr;
      return json(updated);
    }

    if (resource === "poll" && req.method === "POST") {
      // Background mode (same path the cron job uses): poll-pages returns 202
      // immediately and keeps running via EdgeRuntime.waitUntil. A synchronous
      // run here would block this whole request for as long as every active
      // page takes to fetch + extract + retry, which for more than a handful
      // of pages can exceed the edge function's execution ceiling and get
      // killed mid-run — silently skipping every page after the cutoff. The
      // web UI's live polling (see /pages, /postings) picks up progress as it
      // lands instead of waiting on this response.
      const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/poll-pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": cfg.adminToken },
        body: JSON.stringify({ background: true }),
      });
      return json(await res.json(), res.status);
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
