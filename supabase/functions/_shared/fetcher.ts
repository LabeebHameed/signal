// Page fetching: plain HTTP GET only. Sites that require JavaScript to
// render their content (SPA shells) aren't supported — they simply come back
// with little or no extractable content and the poller surfaces the fetch
// error (or, for a page that "succeeds" with an empty shell, yields zero
// postings) rather than silently guessing.

const MAX_CONTENT_CHARS = 100_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface FetchResult {
  content: string;
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

function cap(content: string): FetchResult {
  if (content.length <= MAX_CONTENT_CHARS) return { content, truncated: false };
  return { content: content.slice(0, MAX_CONTENT_CHARS), truncated: true };
}

export async function fetchPageContent(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  const text = contentType.includes("html") ? htmlToText(body) : body.trim();
  return cap(text);
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
