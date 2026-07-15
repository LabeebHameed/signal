// api: CRUD backend for the web UI. All routes require the x-admin-token
// header matching settings.admin_token (or the ADMIN_TOKEN env var if set).
//
//   GET    /pages                 list watched pages
//   POST   /pages                 { url, label? } add a page
//   PATCH  /pages/:id             { active?, label? } update a page
//   DELETE /pages/:id             remove a page (and its postings)
//   GET    /settings              read settings (secrets masked to has_* booleans)
//   PUT    /settings              update settings; secret fields only change
//                                 when sent as non-empty strings
//   GET    /postings              recent postings (?limit=50)
//   POST   /poll                  trigger a synchronous poll run, returns summary

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import type { Settings } from "../_shared/types.ts";
import { resolveConfig } from "../_shared/config.ts";

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
    job_description: s.job_description,
    telegram_chat_id: s.telegram_chat_id,
    llm_provider: s.llm_provider,
    llm_model: s.llm_model,
    llm_base_url: s.llm_base_url,
    has_llm_api_key: s.llm_api_key !== "",
    has_telegram_bot_token: s.telegram_bot_token !== "",
    has_jina_api_key: s.jina_api_key !== "",
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
      const { data, error } = await db.from("watched_pages").select("*").order("created_at");
      if (error) throw error;
      return json(data);
    }

    if (resource === "pages" && !resourceId && req.method === "POST") {
      const body = await req.json();
      const url = typeof body.url === "string" ? body.url.trim() : "";
      try {
        new URL(url);
      } catch {
        return json({ error: "invalid url" }, 400);
      }
      const label = typeof body.label === "string" ? body.label.trim() : "";
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
      for (const field of ["job_description", "telegram_chat_id", "llm_provider", "llm_model", "llm_base_url"]) {
        if (typeof body[field] === "string") patch[field] = body[field].trim();
      }
      // Secret fields: only overwrite when a non-empty value is sent
      // (the UI sends "" / omits them to mean "keep the current value").
      for (const field of ["llm_api_key", "telegram_bot_token", "jina_api_key"]) {
        if (typeof body[field] === "string" && body[field].trim() !== "") {
          patch[field] = body[field].trim();
        }
      }
      const { data, error } = await db.from("settings").update(patch).eq("id", 1).select().single();
      if (error) throw error;
      return json(maskSettings(data as Settings));
    }

    if (resource === "postings" && req.method === "GET") {
      const limit = Math.min(Number(new URL(req.url).searchParams.get("limit")) || 50, 200);
      const { data, error } = await db
        .from("postings")
        .select("id, title, url, company, location, first_seen_at, notified_at, watched_pages(label, url)")
        .order("first_seen_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return json(data);
    }

    if (resource === "poll" && req.method === "POST") {
      const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/poll-pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-token": cfg.adminToken },
        body: "{}",
      });
      return json(await res.json(), res.status);
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
