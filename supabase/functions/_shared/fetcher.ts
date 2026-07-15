// Page fetching that copes with heterogeneous sites:
// 1. plain fetch (works for server-rendered pages: Greenhouse, Lever, most boards)
// 2. Jina Reader fallback (renders JS, returns markdown) for SPA-style pages

const MAX_CONTENT_CHARS = 100_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface FetchResult {
  content: string;
  source: "direct" | "jina";
  truncated: boolean;
}

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
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function cap(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_CONTENT_CHARS) return { content, truncated: false };
  return { content: content.slice(0, MAX_CONTENT_CHARS), truncated: true };
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

export async function fetchDirect(url: string): Promise<FetchResult> {
  const res = await fetchWithTimeout(url, { "User-Agent": USER_AGENT, "Accept": "text/html,*/*" }, 20_000);
  if (!res.ok) throw new Error(`direct fetch failed: HTTP ${res.status}`);
  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  const text = contentType.includes("html") ? htmlToText(body) : body.trim();
  return { ...cap(text), source: "direct" };
}

export async function fetchViaJina(url: string): Promise<FetchResult> {
  const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, { "Accept": "text/plain" }, 45_000);
  if (!res.ok) throw new Error(`jina fetch failed: HTTP ${res.status}`);
  const text = (await res.text()).trim();
  return { ...cap(text), source: "jina" };
}

/** Heuristic: page body so small it's almost certainly an empty JS shell. */
export function looksLikeShell(content: string): boolean {
  return content.length < 500;
}

/**
 * Fetch page content, preferring the source that worked last time.
 * Falls back from direct → jina when the page looks like a JS shell.
 */
export async function fetchPageContent(
  url: string,
  preferredSource: "direct" | "jina",
): Promise<FetchResult> {
  if (preferredSource === "jina") return await fetchViaJina(url);
  const direct = await fetchDirect(url);
  if (!looksLikeShell(direct.content)) return direct;
  return await fetchViaJina(url);
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
