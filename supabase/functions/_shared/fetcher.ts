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
//
// Anchor tokenization: every hyperlink on the page is rewritten into a
// numbered citation marker (`[[7]]anchor text[[/7]]`) alongside a table of
// {id, href, text}. The extraction model (_shared/llm.ts) can then only ever
// refer to a link by citing one of these ids — never by writing a URL of its
// own — which is what makes a hallucinated posting link structurally
// impossible on this path, the same way judge.ts's `[id]` postings already
// work for the judge's own citations.

const MAX_CONTENT_CHARS = 100_000;

export type FetchStrategy = "direct" | "direct-alt" | "proxy:pure" | "proxy:jina";

/** One real hyperlink found on the fetched page — a closed citation set the
 * extraction model can index into but never fabricate an entry for. */
export interface PageLink {
  /** 1-based, assigned in document order, stable within one fetch. */
  id: number;
  /** Absolute, entity-decoded, ORIGINAL CASE — this is what ends up stored. */
  href: string;
  /** The anchor's visible text, whitespace-collapsed and capped. */
  text: string;
}

export interface FetchResult {
  content: string;
  truncated: boolean;
  strategy: FetchStrategy;
  /** The citation table for `content`'s `[[id]]` markers — see PageLink. */
  links: PageLink[];
  /** True when the chain settled for a lesser tier — a linkless page or a
   * shell — because nothing better was reachable. poll-pages uses this to
   * throttle how often it re-runs the full strategy probe. */
  degraded: boolean;
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

// A citation marker: `[[7]]` opens link id 7, `[[/7]]` closes it. ASCII and
// cheap in tokens, and — unlike the old one-sided `[link: href]` marker —
// paired, so the model (and attachAnchorText below) can see exactly which
// text an anchor wraps.
const MAX_ANCHOR_TEXT_CHARS = 160;
const LINK_TOKEN_RE = /\[\[(\/?)(\d+)\]\]/g;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/** Resolve+validate a possibly-relative href found in markup: absolute,
 * http(s) only (javascript:/mailto:/tel:/data: are all rejected here, so
 * they never burn a citation id). A fragment-only href (`#`, `#section`) is
 * rejected too — it resolves to a perfectly valid URL (same page, empty or
 * non-empty hash) but is never a distinct destination, so treating it as one
 * would let a "does nothing, just a JS hook" button masquerade as a posting
 * link. Returns null for anything unusable. */
function resolveHref(rawHref: string, baseUrl: string): string | null {
  const decoded = decodeHtmlEntities(rawHref).trim();
  if (decoded === "" || decoded.startsWith("#")) return null;
  try {
    const u = new URL(decoded, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Fill in each link's visible text from the (already capped) tokenized text,
 * in a single linear scan, and drop any link whose markers didn't survive
 * the 100k-char cap — the model can only cite what it can see, so the table
 * only ever holds what the model can see.
 *
 * An anchor whose closing marker was truncated away (or whose markup was
 * malformed) still gets a best-effort text: up to MAX_ANCHOR_TEXT_CHARS
 * after the opener, stopping at the next marker so it can never swallow a
 * neighboring link's text.
 */
function attachAnchorText(text: string, links: PageLink[]): PageLink[] {
  const byId = new Map(links.map((l) => [l.id, l] as const));
  const texts = new Map<number, string>();
  const stack: Array<{ id: number; start: number }> = [];
  const tokenRe = new RegExp(LINK_TOKEN_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    const isClose = match[1] === "/";
    const id = Number(match[2]);
    if (!isClose) {
      stack.push({ id, start: match.index + match[0].length });
      continue;
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].id !== id) continue;
      if (!texts.has(id)) texts.set(id, text.slice(stack[i].start, match.index));
      stack.length = i; // pop this entry and anything left open above it
      break;
    }
  }
  // Anything still open when the scan ends never saw its closing marker.
  for (const { id, start } of stack) {
    if (texts.has(id)) continue;
    const nextMarker = text.indexOf("[[", start);
    const end = nextMarker === -1 ? text.length : Math.min(nextMarker, start + MAX_ANCHOR_TEXT_CHARS);
    texts.set(id, text.slice(start, end));
  }

  const resolved: PageLink[] = [];
  for (const [id, raw] of texts) {
    const link = byId.get(id);
    if (!link) continue;
    resolved.push({ ...link, text: raw.replace(/\s+/g, " ").trim().slice(0, MAX_ANCHOR_TEXT_CHARS) });
  }
  resolved.sort((a, b) => a.id - b.id);
  return resolved;
}

function cap(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_CONTENT_CHARS) return { content, truncated: false };
  return { content: content.slice(0, MAX_CONTENT_CHARS), truncated: true };
}

/** Repair a link-token half-cut by cap(): a truncation that lands inside a
 * `[[` or `[[/123` marker must never be readable as a citation. */
function repairCutTokenEdge(text: string): string {
  return text.replace(/\[\[\/?\d*$/, "").replace(/\[$/, "");
}

/**
 * HTML → flat text, with every anchor rewritten as a numbered citation
 * marker pair instead of the old one-sided `[link: href]` text marker. See
 * the module comment above for why this exists.
 */
export function htmlToTextWithLinks(html: string, baseUrl: string): { text: string; links: PageLink[]; truncated: boolean } {
  // Sanitize any pre-existing `[[7]]`-shaped text FIRST — this is what makes
  // the citation set genuinely closed: page content can never forge a marker
  // for the model to "cite" as if it were a real link.
  let working = html
    .replace(LINK_TOKEN_RE, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  // One combined anchor pass covering all three href-quoting styles in a
  // single attribute regex (double-quoted, single-quoted, and unquoted —
  // unquoted values are valid HTML5 and used in the wild, confirmed on
  // cryptocurrencyjobs.co and nodesk.co). The (?:^|\s) before "href" is what
  // stops this from matching "data-href="/"x-href=" as if they were the
  // anchor's real destination, which the old three-regex version did.
  const links: PageLink[] = [];
  const openStack: number[] = [];
  let nextId = 1;
  const HREF_RE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
  working = working.replace(/<a\b([^>]*)>|<\/a\s*>/gi, (whole: string, attrs?: string) => {
    if (attrs === undefined) {
      const id = openStack.pop();
      return id === undefined ? "" : `[[/${id}]]`;
    }
    const hrefMatch = attrs.match(HREF_RE);
    const rawHref = hrefMatch ? hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] : undefined;
    const href = rawHref ? resolveHref(rawHref, baseUrl) : null;
    if (!href) return ""; // no usable href — burn no id, drop the tag itself
    const id = nextId++;
    openStack.push(id);
    links.push({ id, href, text: "" });
    return `[[${id}]]`;
  });

  let text = working
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

  const { content: capped, truncated } = cap(text);
  const finalText = repairCutTokenEdge(capped);
  return { text: finalText, links: attachAnchorText(finalText, links), truncated };
}

/**
 * Markdown → flat text with the same citation-marker guarantee, for the
 * reader-proxy strategies (proxy:pure/proxy:jina), which return markdown
 * rather than HTML. Covers inline links `[text](url "title")`, angle-bracket
 * destinations `[text](<url>)`, autolinks `<https://...>`, and excludes
 * image syntax `![alt](src)` from consuming a citation id. Reference-style
 * links (`[text][ref]`) are not supported — they simply produce no citation
 * and fall through to title-based matching downstream.
 */
export function markdownToTextWithLinks(md: string, baseUrl: string): { text: string; links: PageLink[]; truncated: boolean } {
  let working = md.replace(LINK_TOKEN_RE, " ");
  const links: PageLink[] = [];
  let nextId = 1;

  working = working.replace(
    /(!?)\[([^\]\n]*)\]\(\s*(?:<([^>]*)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g,
    (whole: string, bang: string, linkText: string, angleHref: string | undefined, plainHref: string | undefined) => {
      if (bang === "!") return linkText; // image — keep alt text, consume no id
      const href = resolveHref(angleHref ?? plainHref ?? "", baseUrl);
      if (!href) return linkText;
      const id = nextId++;
      links.push({ id, href, text: "" });
      return `[[${id}]]${linkText}[[/${id}]]`;
    },
  );

  working = working.replace(/<((?:https?:)\/\/[^>\s]+)>/gi, (whole: string, href: string) => {
    const resolved = resolveHref(href, baseUrl);
    if (!resolved) return href;
    const id = nextId++;
    links.push({ id, href: resolved, text: "" });
    return `[[${id}]]${href}[[/${id}]]`;
  });

  const { content: capped, truncated } = cap(working);
  const finalText = repairCutTokenEdge(capped);
  return { text: finalText, links: attachAnchorText(finalText, links), truncated };
}

/** Heuristic: page body so small it's almost certainly an empty JS shell —
 * ambiguous (some boards are honestly near-empty, "no open roles"), so this
 * is a soft signal: accepted as a last resort if nothing better turns up. */
function looksLikeShell(content: string): boolean {
  return content.length < 500;
}

/** What one strategy produced. `linkBearing` records whether the body was
 * parsed for anchors at all: an HTML page or proxy markdown always is, a
 * plain-text/JSON body never is. Without that distinction the zero-link rule
 * in selectAttempt() would punish a perfectly good text response for a
 * property it can't have. */
export interface AttemptOutcome {
  content: string;
  truncated: boolean;
  links: PageLink[];
  linkBearing: boolean;
}

/**
 * The reader proxies prepend their own YAML frontmatter (`url:`, `title:`,
 * `description:`, `access_date:`) to every response. On a page that renders
 * to nothing — contra.com is a live example, 415 bytes total — that block is
 * effectively the whole body, and it is pure marketing copy: a title and a
 * description. Handing it to the extraction model produced seven confidently
 * invented "postings" out of a sentence about connecting with next-gen
 * talent. Stripping it first means a content-free page measures as
 * content-free and fails the chain honestly instead.
 *
 * Only a leading fence is removed — a `---` rule further down is ordinary
 * markdown and must survive.
 */
export function stripReaderFrontmatter(body: string): string {
  return body.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trimStart();
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
): Promise<AttemptOutcome> {
  const res = await fetchWithTimeout(url, headers, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("html")) {
    const { text, links, truncated } = htmlToTextWithLinks(body, url);
    return { content: text, truncated, links, linkBearing: true };
  }
  const { content, truncated } = cap(body.trim());
  return { content, truncated, links: [], linkBearing: false };
}

/** pageUrl is the ORIGINAL page being crawled (not the proxy URL) — hrefs in
 * the proxy's markdown are relative to the real page, so absolutization must
 * use that, not pure.md/r.jina.ai's own URL. */
async function fetchViaProxy(
  proxyUrl: string,
  pageUrl: string,
): Promise<AttemptOutcome> {
  const res = await fetchWithTimeout(proxyUrl, { "Accept": "text/plain,text/markdown,text/html,*/*" }, 20_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = stripReaderFrontmatter((await res.text()).trim());
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("html")) {
    const { text, links, truncated } = htmlToTextWithLinks(body, pageUrl);
    return { content: text, truncated, links, linkBearing: true };
  }
  // Proxies return markdown already stripped of HTML markup — extract its
  // `[text](url)` links into the same citation-marker shape instead of
  // running the HTML stripper a second time, which would mangle them.
  const { text, links, truncated } = markdownToTextWithLinks(body, pageUrl);
  return { content: text, truncated, links, linkBearing: true };
}

/**
 * Walk a lazy list of fetch strategies and return the best result, stopping
 * at the first fully-good one so a healthy page still pays for exactly one
 * request.
 *
 * Acceptance is tiered, best to worst:
 *
 *   1. **usable**   — real content that carries at least one link
 *   2. **linkless** — real content, but not a single link on it
 *   3. **shell**    — content too small to be a real listing
 *   4. blocked / errored — never acceptable at any price
 *
 * Tier 2 is the tier this function exists for. A job *listing* page with no
 * anchors at all is a degraded render, not a page without jobs — and the
 * extraction model can only cite links it was shown, so a linkless fetch
 * yields postings that structurally cannot be given a URL. nodesk.co was
 * exactly this: pure.md returns its titles, companies and salaries but none
 * of its job links, while a plain direct fetch of the same page carries all
 * 66 of them. Because the winning strategy is remembered in
 * watched_pages.fetch_strategy and retried first forever, that one unlucky
 * pick stranded 199 postings with no link at all.
 *
 * Kept as a soft signal rather than a hard reject: some boards genuinely
 * render without anchors, and a linkless page still beats no page. It only
 * ever costs extra attempts, never content — hence the ordering below, where
 * a linkless result outranks a shell instead of being lumped in with it.
 *
 * Attempts are passed in as thunks so the whole decision is testable with no
 * network: see fetcher_test.ts.
 */
export async function selectAttempt(
  attempts: Array<{ name: FetchStrategy; run: () => Promise<AttemptOutcome> }>,
  opts: { enforceLinks?: boolean } = {},
): Promise<FetchResult> {
  const enforceLinks = opts.enforceLinks ?? true;
  const errors: string[] = [];
  let bestLinkless: FetchResult | null = null;
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
          bestShell = { ...result, strategy: attempt.name, degraded: true };
        }
        continue;
      }
      // Only content that was actually parsed for anchors can be judged on
      // link count — a plain-text or JSON body has none by construction.
      if (enforceLinks && result.linkBearing && result.links.length === 0) {
        if (!bestLinkless || result.content.length > bestLinkless.content.length) {
          bestLinkless = { ...result, strategy: attempt.name, degraded: true };
        }
        continue;
      }
      // Reported honestly whichever mode we're in: with enforceLinks off a
      // link-free result is returned rather than skipped, but it is still a
      // link-free result and the caller's throttle must not read it as a
      // reason to start probing again.
      return {
        ...result,
        strategy: attempt.name,
        degraded: result.linkBearing && result.links.length === 0,
      };
    } catch (e) {
      errors.push(`${attempt.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Nothing carried a link. Fall back in tier order: substantial-but-linkless
  // content is still worth extracting from (the postings just won't get URLs),
  // and a tiny-but-legitimate fetch is still valid (some boards are honestly
  // near-empty, "no open roles"). Both only when nothing was an outright block.
  if (bestLinkless) return bestLinkless;
  if (bestShell) return bestShell;
  throw new Error(errors.join(" | "));
}

/**
 * Fetch page content, preferring whichever strategy worked last time for
 * this page, then working through direct (two header profiles) and the
 * proxy chain in order until one returns real, unblocked content.
 *
 * `skipLinkProbe` restores the pre-tiering behaviour of taking the first
 * usable result even when it carries no links. poll-pages sets it for a page
 * that already ran the full chain recently and still found nothing better,
 * so a genuinely linkless page costs one request per poll rather than four.
 */
export async function fetchPageContent(
  url: string,
  preferredStrategy?: FetchStrategy | null,
  opts: { skipLinkProbe?: boolean } = {},
): Promise<FetchResult> {
  const attempts: Array<{ name: FetchStrategy; run: () => Promise<AttemptOutcome> }> = [
    { name: "direct", run: () => fetchDirect(url, BROWSER_HEADERS, 15_000) },
    { name: "direct-alt", run: () => fetchDirect(url, CRAWLER_HEADERS, 15_000) },
    ...PROXIES.map((p) => ({ name: p.name, run: () => fetchViaProxy(p.build(url), url) })),
  ];
  // Try the strategy that worked last time first, so a healthy page pays
  // for exactly one attempt instead of re-discovering the winner every poll.
  if (preferredStrategy) {
    const idx = attempts.findIndex((a) => a.name === preferredStrategy);
    if (idx > 0) attempts.unshift(...attempts.splice(idx, 1));
  }

  return await selectAttempt(attempts, { enforceLinks: !opts.skipLinkProbe });
}

// BROWSER_HEADERS and fetchWithTimeout are also reused by _shared/verify.ts's
// live posting-link check — same header profile and timeout/abort pattern,
// one direct request rather than the full proxy chain (which would multiply
// per-posting cost fourfold for no benefit here).
export { blockSignature, BROWSER_HEADERS, fetchWithTimeout, looksLikeShell };

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
