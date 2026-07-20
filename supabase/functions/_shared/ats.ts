// Structured extraction for pages backed by a known ATS platform, or that
// expose an RSS/Atom feed: skip HTML scraping and the LLM entirely and map
// the platform's own public data straight to ExtractedPosting. Cheaper, more
// reliable, and immune to the anti-bot walls in fetcher.ts — these are
// public read APIs/feeds, not the rendered page a browser sees.
//
// Tried before the generic fetch+LLM path; returns null when nothing here
// applies so the caller falls through to fetcher.ts as before.

import type { ExtractedPosting } from "./types.ts";

export type AtsStrategy = "greenhouse" | "lever" | "ashby" | "rss";

export interface AtsResult {
  strategy: AtsStrategy;
  postings: ExtractedPosting[];
}

async function fetchJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "Accept": "application/json" }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function firstPathSegment(url: URL): string | null {
  return url.pathname.split("/").filter(Boolean)[0] ?? null;
}

/** job-boards.greenhouse.io/<token> or boards.greenhouse.io/<token> → the
 * public boards API, no key required. */
async function fetchGreenhouse(pageUrl: string): Promise<AtsResult | null> {
  const url = new URL(pageUrl);
  if (!/(^|\.)greenhouse\.io$/.test(url.hostname)) return null;
  const token = firstPathSegment(url);
  if (!token) return null;
  const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=false`) as {
    jobs?: Array<{ title?: string; absolute_url?: string; location?: { name?: string }; updated_at?: string }>;
  };
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const postings: ExtractedPosting[] = jobs
    .map((j) => ({
      title: (j.title ?? "").trim(),
      url: j.absolute_url,
      location: j.location?.name,
      posted_text: j.updated_at,
    }))
    .filter((p): p is ExtractedPosting => p.title !== "");
  if (postings.length === 0) return null; // wrong/unknown token — let generic fetch try
  return { strategy: "greenhouse", postings };
}

/** jobs.lever.co/<company> → the public postings API. */
async function fetchLever(pageUrl: string): Promise<AtsResult | null> {
  const url = new URL(pageUrl);
  if (!/(^|\.)lever\.co$/.test(url.hostname)) return null;
  const company = firstPathSegment(url);
  if (!company) return null;
  const data = await fetchJson(`https://api.lever.co/v0/postings/${company}?mode=json`) as Array<{
    text?: string;
    hostedUrl?: string;
    categories?: { location?: string };
  }>;
  if (!Array.isArray(data)) return null;
  const postings: ExtractedPosting[] = data
    .map((j) => ({ title: (j.text ?? "").trim(), url: j.hostedUrl, location: j.categories?.location }))
    .filter((p): p is ExtractedPosting => p.title !== "");
  if (postings.length === 0) return null;
  return { strategy: "lever", postings };
}

/** jobs.ashbyhq.com/<org> → the public job-board API. */
async function fetchAshby(pageUrl: string): Promise<AtsResult | null> {
  const url = new URL(pageUrl);
  if (!/(^|\.)ashbyhq\.com$/.test(url.hostname)) return null;
  const org = firstPathSegment(url);
  if (!org) return null;
  const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${org}`) as {
    jobs?: Array<{ title?: string; jobUrl?: string; location?: string }>;
  };
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const postings: ExtractedPosting[] = jobs
    .map((j) => ({ title: (j.title ?? "").trim(), url: j.jobUrl, location: j.location }))
    .filter((p): p is ExtractedPosting => p.title !== "");
  if (postings.length === 0) return null;
  return { strategy: "ashby", postings };
}

function extractTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return null;
  const raw = m[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata ? cdata[1] : raw).trim();
}

function extractLink(item: string): string | null {
  // Atom uses <link href="..."/>; RSS uses <link>url</link>.
  const atom = item.match(/<link\b[^>]*href="([^"]+)"/i);
  if (atom) return atom[1];
  return extractTag(item, "link");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Best-effort RSS/Atom item extraction (title/link/date) without pulling in
 * a full XML parser dependency — enough for feed-based job listings. */
function parseFeedItems(xml: string): ExtractedPosting[] {
  const items = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const postings: ExtractedPosting[] = [];
  for (const item of items) {
    const title = extractTag(item, "title");
    if (!title) continue;
    const link = extractLink(item);
    const posted = extractTag(item, "pubDate") ?? extractTag(item, "updated") ?? extractTag(item, "published");
    postings.push({
      title: decodeEntities(title),
      url: link ?? undefined,
      posted_text: posted ?? undefined,
    });
  }
  return postings;
}

const ORIGIN_FEED_PATHS = ["/feed", "/feed.xml", "/rss", "/rss.xml", "/atom.xml", "/index.xml"];

/** Try the page's own URL as a feed, conventional feed paths on the origin,
 * and the page's own path with a ".rss"/".xml" or "/feed" suffix (a common
 * per-category convention — e.g. weworkremotely.com/categories/x publishes
 * weworkremotely.com/categories/x.rss). Only trusted when the response
 * actually parses as RSS/Atom with at least one item — never guessed from
 * the URL shape alone. */
async function fetchRss(pageUrl: string): Promise<AtsResult | null> {
  const url = new URL(pageUrl);
  url.hash = "";
  url.search = "";
  const origin = url.origin;
  const pathNoSlash = url.toString().replace(/\/$/, "");
  const candidates = [
    pageUrl,
    pathNoSlash + ".rss",
    pathNoSlash + "/feed",
    pathNoSlash + ".xml",
    ...ORIGIN_FEED_PATHS.map((p) => origin + p),
  ];
  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(candidate, {
        headers: { "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml" },
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const looksLikeFeed = contentType.includes("xml") || /<rss\b|<feed\b/i.test(body.slice(0, 500));
      if (!looksLikeFeed) continue;
      const postings = parseFeedItems(body);
      // Some feeds (seen in the wild: WeWorkRemotely's category RSS) carry a
      // title but no <link> and cram company+role into one string — a worse
      // source than the generic HTML+LLM path this would replace. Only trust
      // a feed that actually gives most postings a direct URL; otherwise
      // fall through and let the proven path handle this page.
      const withUrl = postings.filter((p) => p.url);
      if (postings.length === 0 || withUrl.length < postings.length * 0.8) continue;
      return { strategy: "rss", postings };
    } catch {
      continue; // this candidate path doesn't exist / isn't a feed — try the next
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Try every structured source in order: known ATS platforms first (a
 * hostname match is a strong, near-free signal — no network call unless it
 * matches), then RSS/Atom discovery (real network probing, so the caller
 * only asks for it occasionally — see poll-pages). Returns null when
 * nothing applies; the caller falls back to generic fetch + LLM extraction.
 */
export async function fetchStructured(pageUrl: string, tryRss: boolean): Promise<AtsResult | null> {
  for (const fetcher of [fetchGreenhouse, fetchLever, fetchAshby]) {
    try {
      const result = await fetcher(pageUrl);
      if (result) return result;
    } catch {
      // A broken ATS call isn't fatal — generic fetch + LLM covers it.
    }
  }
  if (!tryRss) return null;
  try {
    return await fetchRss(pageUrl);
  } catch {
    return null;
  }
}
