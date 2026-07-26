// Page fetching that copes with heterogeneous sites and anti-bot walls:
// 1. direct fetch with browser-like headers, then a second attempt with a
//    search-crawler UA (some simpler WAFs allowlist it without verifying
//    the request actually came from one)
// 2. a free, keyless "reader" proxy fallback for the cases headers alone
//    can't fix — mainly datacenter-IP-reputation blocks, where a request
//    from a different network succeeds even with the exact same headers
//    (confirmed against a real 403 case: dailyremote.com returns the page
//    cleanly through the proxy while a direct Supabase-origin fetch is
//    blocked). This does NOT beat a genuine Cloudflare/DataDome JS
//    challenge — nothing keyless does, including Jina Reader — so those
//    cases are left to fail honestly rather than pretend to succeed.
//
// Every attempt is screened by looksBlocked() so a "200 OK" challenge page
// is never mistaken for real content: block pages get walked past just like
// a failed fetch, all the way through the chain, ending in an honest error
// with the block signature named.
//
// Structured ATS adapters (Greenhouse/Lever/Ashby/RSS) live in _shared/ats.ts
// and are tried first by the caller — they skip this module entirely when
// they apply, since they're public data APIs, not the rendered page.

const MAX_CONTENT_CHARS = 100_000;

export type FetchStrategy = "direct" | "direct-alt" | "proxy:pure" | "proxy:jina";

export interface FetchResult {
  content: string;
  truncated: boolean;
  strategy: FetchStrategy;
}

// Two header profiles for the direct attempt.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
};

const CRAWLER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Accept": "text/html,*/*",
};

// Free, keyless reader proxies tried in order after direct attempts fail or
// hit a block page — one line to add another. (jina.ai's Reader is
// deliberately not here: even its rendering infra gets stopped by the same
// Cloudflare/DataDome challenges these sites use, so it buys nothing extra
// over the proxy below while adding a paid/rate-limited dependency.)
const PROXIES: Array<{ name: FetchStrategy; build: (url: string) => string }> = [
  { name: "proxy:pure", build: (url) => `https://pure.md/${url}` },
  { name: "proxy:jina", build: (url) => `https://r.jina.ai/${url}` },
];

// Phrases that mean "this is a block/challenge page, not real content" even
// when the HTTP status was 200 — Cloudflare/DataDome/PerimeterX-style walls
// answer with a 200 (or, from a proxy, their own clean error) far more often
// than an honest 403.
const BLOCK_PAGE_SIGNS = [
  "just a moment",
  "checking your browser",
  "attention required",
  "access denied",
  "enable javascript and cookies",
  "please enable javascript",
  "verify you are human",
  "datadome",
  "perimeterx",
  "request unsuccessful. incapsula",
  "cf-browser-verification",
  "sorry, you have been blocked",
];

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // keep hrefs so the LLM can return posting URLs
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>/gi, ' [link: $1] ')
    .replace(/<a\b[^>]*href='([^']*)'[^>]*>/gi, " [link: $1] ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    // Rejoin numbers split by tag stripping, e.g. "$150 ,000" -> "$150,000"
    // (a <span> around the thousands group leaves a stray space+comma that
    // otherwise reaches the LLM as ",000" and gets misread as a separate value).
    .replace(/(\$?\b\d+)\s+,\s*(\d{3}\b)/g, "$1,$2")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function cap(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_CONTENT_CHARS) return { content, truncated: false };
  return { content: content.slice(0, MAX_CONTENT_CHARS), truncated: true };
}

/** Heuristic: page body so small it's almost certainly an empty JS shell —
 * ambiguous (some boards are honestly near-empty, "no open roles"), so this
 * is a soft signal: accepted as a last resort if nothing better turns up. */
function looksLikeShell(content: string): boolean {
  return content.length < 500;
}

/** An explicit anti-bot challenge page is never ambiguous and never worth
 * accepting even as a last resort — passing Cloudflare/DataDome challenge
 * markup to the LLM risks it hallucinating postings out of boilerplate.
 * Returns the matched phrase (for the error message) or null. */
function blockSignature(content: string): string | null {
  const head = content.slice(0, 2000).toLowerCase();
  return BLOCK_PAGE_SIGNS.find((sign) => head.includes(sign)) ?? null;
}

async function fetchWithTimeout(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDirect(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ content: string; truncated: boolean }> {
  const res = await fetchWithTimeout(url, headers, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  const text = contentType.includes("html") ? htmlToText(body) : body.trim();
  return cap(text);
}

async function fetchViaProxy(proxyUrl: string): Promise<{ content: string; truncated: boolean }> {
  // Proxies return plain text/markdown already stripped of markup — pass
  // through as-is (still capped) rather than running the HTML stripper a
  // second time, which would mangle markdown-style links and headings.
  const res = await fetchWithTimeout(proxyUrl, { "Accept": "text/plain,text/markdown,text/html,*/*" }, 20_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.text()).trim();
  const contentType = res.headers.get("content-type") ?? "";
  const text = contentType.includes("html") ? htmlToText(body) : body;
  return cap(text);
}

/**
 * Fetch page content, preferring whichever strategy worked last time for
 * this page, then working through direct (two header profiles) and the
 * proxy chain in order until one returns real, unblocked content.
 */
export async function fetchPageContent(
  url: string,
  preferredStrategy?: FetchStrategy | null,
): Promise<FetchResult> {
  const attempts: Array<{ name: FetchStrategy; run: () => Promise<{ content: string; truncated: boolean }> }> = [
    { name: "direct", run: () => fetchDirect(url, BROWSER_HEADERS, 15_000) },
    { name: "direct-alt", run: () => fetchDirect(url, CRAWLER_HEADERS, 15_000) },
    ...PROXIES.map((p) => ({ name: p.name, run: () => fetchViaProxy(p.build(url)) })),
  ];
  // Try the strategy that worked last time first, so a healthy page pays
  // for exactly one attempt instead of re-discovering the winner every poll.
  if (preferredStrategy) {
    const idx = attempts.findIndex((a) => a.name === preferredStrategy);
    if (idx > 0) attempts.unshift(...attempts.splice(idx, 1));
  }

  const errors: string[] = [];
  let bestShell: FetchResult | null = null;
  for (const attempt of attempts) {
    try {
      const result = await attempt.run();
      const sign = blockSignature(result.content);
      if (sign) {
        // Never accept a challenge page, even as a last resort — an honest
        // "blocked" error beats confidently hallucinated postings.
        errors.push(`${attempt.name}: blocked by anti-bot check (matched "${sign}")`);
        continue;
      }
      if (looksLikeShell(result.content)) {
        if (!bestShell || result.content.length > bestShell.content.length) {
          bestShell = { ...result, strategy: attempt.name };
        }
        continue;
      }
      return { ...result, strategy: attempt.name };
    } catch (e) {
      errors.push(`${attempt.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Nothing produced substantial, unblocked content. A tiny-but-legitimate
  // fetch is still valid (some boards are honestly near-empty, "no open
  // roles") — accepted only when nothing was an outright block, and only as
  // the least-bad option.
  if (bestShell) return bestShell;
  throw new Error(errors.join(" | "));
}

export { blockSignature, looksLikeShell };

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
