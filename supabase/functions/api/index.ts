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
//                                 replaces the whole profile).
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
//                                 → { items, total }
//                                 (the extra filters are for the Workflow page's per-stage
//                                 audit rosters — send at most one of status/screened per
//                                 request, they override rather than intersect; duplicate
//                                 combines with status:"matched")
//   POST   /poll                  trigger a poll run in the background, returns
//                                 { started: true } immediately — watch /pages
//                                 and /postings for results as they land
//   POST   /telegram-test         send a test message to the configured chat and
//                                 return Telegram's exact response (for debugging)
//   POST   /company-test          { name } → research one company synchronously and
//                                 return the raw dossier (for debugging the company
//                                 layer; requires a Tavily API key)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import type { FilterProfile, Settings } from "../_shared/types.ts";
import { FILTER_PROFILE_KEYS } from "../_shared/types.ts";
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

/** The settings shape the UI sees: no secret values, only whether they're set. */
function maskSettings(s: Settings) {
  return {
    profile_input: s.profile_input ?? "",
    filter_profile: s.filter_profile ?? {},
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
  const [, resource, resourceId] = route.split("/");

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
        const profile: FilterProfile = {};
        for (const key of FILTER_PROFILE_KEYS) {
          const value = (body.filter_profile as Record<string, unknown>)[key];
          if (typeof value === "string" && value.trim() !== "") profile[key] = value.trim();
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
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let query = db
        .from("postings")
        .select(
          "id, title, url, company, location, compensation, posted_at, posted_text, first_seen_at, notified_at, pending_notify, filter_status, filter_verdict, company_status, company_verdict, duplicate_of, keyword_filtered, companies(display_name, legitimacy, dossier, researched_at), watched_pages(label, url)",
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
      const { data, error, count } = await query
        .order(sort, { ascending, nullsFirst: false })
        .order("id") // deterministic tiebreaker so pages don't overlap
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return json({ items: data, total: count ?? 0 });
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
