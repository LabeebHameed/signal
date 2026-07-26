// Structured extraction for pages backed by a known ATS platform, or that
// expose an RSS/Atom feed: skip HTML scraping and the LLM entirely and map
// the platform's own public data straight to ExtractedPosting. Cheaper, more
// reliable, and immune to the anti-bot walls in fetcher.ts — these are
// public read APIs/feeds, not the rendered page a browser sees.
//
// Tried before the generic fetch+LLM path; returns null when nothing here
// applies so the caller falls through to fetcher.ts as before.

import type { ExtractedPosting } from "./types.ts";

export type AtsStrategy = "greenhouse" | "lever" | "ashby" | "himalayas" | "rss";

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
    .filter((p) => p.title !== "");
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
    .filter((p) => p.title !== "");
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
    .filter((p) => p.title !== "");
  if (postings.length === 0) return null;
  return { strategy: "ashby", postings };
}

/** himalayas.app/jobs/... → the free public JSON search API, no key required.
 * Completely bypasses the Cloudflare anti-bot wall on the website.
 * Strips the massive HTML description fields before JSON.parse to stay
 * within Deno's memory limit. */
async function fetchHimalayas(pageUrl: string): Promise<AtsResult | null> {
  const url = new URL(pageUrl);
  if (!/(^|\.)himalayas\.app$/.test(url.hostname)) return null;
  const keyword = url.searchParams.get("keyword") || url.searchParams.get("q") || "design";
  const apiUrl = `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(keyword)}&limit=20&offset=0`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let rawText: string;
  try {
    const res = await fetch(apiUrl, {
      headers: { "Accept": "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rawText = await res.text();
  } finally {
    clearTimeout(timer);
  }

  // Strip the heavy "description" fields (full HTML per job, several KB each)
  // before parsing — we never use them and they dominate the response size.
  rawText = rawText.replace(/"description"\s*:\s*"(?:[^"\\]|\\.)*"/g, '"description":""');

  const data = JSON.parse(rawText) as {
    jobs?: Array<{
      title?: string;
      companyName?: string;
      companySlug?: string;
      locationRestrictions?: string[];
      minSalary?: number | null;
      maxSalary?: number | null;
      currency?: string | null;
      salaryPeriod?: string;
    }>;
  };

  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const postings: ExtractedPosting[] = [];
  for (const j of jobs) {
    const title = (j.title ?? "").trim();
    if (!title) continue;
    const company = j.companyName ?? undefined;
    const companySlug = j.companySlug ?? "";
    const jobUrl = companySlug
      ? `https://himalayas.app/companies/${companySlug}/jobs/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")}`
      : undefined;
    const location = (j.locationRestrictions ?? []).length > 0
      ? j.locationRestrictions!.join(", ")
      : "Remote";
    let compensation: string | undefined;
    if (j.minSalary || j.maxSalary) {
      const cur = j.currency ?? "USD";
      const period = j.salaryPeriod ?? "annual";
      compensation = j.minSalary && j.maxSalary
        ? `${cur} ${j.minSalary.toLocaleString()}–${j.maxSalary.toLocaleString()} ${period}`
        : `${cur} ${(j.minSalary ?? j.maxSalary)!.toLocaleString()} ${period}`;
    }
    postings.push({ title, company, location, compensation, url: jobUrl });
  }
  if (postings.length === 0) return null;
  return { strategy: "himalayas", postings };
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
// Job boards very often publish a board-wide feed under /jobs even when the
// category page the user actually watches is behind an anti-bot wall
// (confirmed in the wild: himalayas.app walls /jobs/<category> with a
// Cloudflare challenge but serves /jobs/rss cleanly).
const ORIGIN_JOB_FEED_PATHS = ["/jobs/rss", "/jobs/feed", "/jobs.rss"];

const PROBE_TIMEOUT_MS = 8_000;
// Discovery runs as a rescue after a page has already failed every fetch
// strategy, so it must stay bounded: a walled site can leave many probes
// hanging until timeout, and one page must never eat the whole invocation.
const DISCOVERY_BUDGET_MS = 40_000;
const MAX_FEED_PROBES = 16;

/** Standards-based feed autodiscovery: `<link rel="alternate"
 * type="application/rss+xml" href="...">` in the origin's homepage. This is
 * how a site is *supposed* to advertise its feed, so it beats guessing —
 * but plenty of sites (himalayas.app among them) publish a feed without
 * advertising it, which is what the path guesses below are for. */
async function discoverAdvertisedFeeds(origin: string, signal: AbortSignal): Promise<string[]> {
  try {
    const res = await fetch(origin, { headers: { "Accept": "text/html" }, signal });
    if (!res.ok) return [];
    const html = (await res.text()).slice(0, 200_000);
    const out: string[] = [];
    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
      if (!/rel=["']?alternate/i.test(tag)) continue;
      if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
      const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
      if (!href) continue;
      try {
        out.push(new URL(href, origin).toString());
      } catch {
        // malformed href — ignore
      }
    }
    return out;
  } catch {
    return []; // origin unreachable or itself walled — fall through to guesses
  }
}

/** Fetch one candidate URL and return its postings only if it really is a
 * usable feed. Never guesses from URL shape: a soft-404 that returns the
 * site's HTML shell (himalayas.app/rss does exactly this) is rejected here. */
async function tryFeedCandidate(candidate: string, signal: AbortSignal): Promise<ExtractedPosting[] | null> {
  const res = await fetch(candidate, {
    headers: { "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    signal,
  });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const looksLikeFeed = contentType.includes("xml") || /<rss\b|<feed\b/i.test(body.slice(0, 500));
  if (!looksLikeFeed) return null;
  const postings = parseFeedItems(body);
  // Some feeds (seen in the wild: WeWorkRemotely's category RSS) carry a
  // title but no <link> and cram company+role into one string — a worse
  // source than the generic HTML+LLM path this would replace. Only trust
  // a feed that actually gives most postings a direct URL; otherwise
  // fall through and let the proven path handle this page.
  const withUrl = postings.filter((p) => p.url);
  if (postings.length === 0 || withUrl.length < postings.length * 0.8) return null;
  return postings;
}

/** Look for a usable RSS/Atom feed for this page: the page's own URL, then
 * whatever the origin advertises, then conventional feed paths (per-page
 * suffixes, then origin-wide, then job-board conventions). Only a response
 * that actually parses as a feed with linked items is accepted. */
async function fetchRss(pageUrl: string): Promise<AtsResult | null> {
  const url = new URL(pageUrl);
  url.hash = "";
  url.search = "";
  const origin = url.origin;
  const pathNoSlash = url.toString().replace(/\/$/, "");

  const deadline = Date.now() + DISCOVERY_BUDGET_MS;
  const advertised = await discoverAdvertisedFeeds(origin, AbortSignal.timeout(PROBE_TIMEOUT_MS));

  const candidates = [
    pageUrl,
    ...advertised,
    pathNoSlash + ".rss",
    pathNoSlash + "/rss",
    pathNoSlash + "/feed",
    pathNoSlash + ".xml",
    ...ORIGIN_FEED_PATHS.map((p) => origin + p),
    ...ORIGIN_JOB_FEED_PATHS.map((p) => origin + p),
  ];

  const seen = new Set<string>();
  let probes = 0;
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (++probes > MAX_FEED_PROBES || Date.now() > deadline) break;
    try {
      const postings = await tryFeedCandidate(candidate, AbortSignal.timeout(PROBE_TIMEOUT_MS));
      if (postings) return { strategy: "rss", postings };
    } catch {
      continue; // this candidate doesn't exist / isn't a feed — try the next
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
  for (const fetcher of [fetchGreenhouse, fetchLever, fetchAshby, fetchHimalayas]) {
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
