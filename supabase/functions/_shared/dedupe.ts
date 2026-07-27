// Posting identity: normalizes posting URLs so a rotating tracking token
// doesn't make the same job look "new" on every poll, and derives a
// coarser cross-source content key so the same job cross-posted to several
// watched pages is recognized as one job, notified once.

/** Query params that vary per-impression/per-click but never identify a
 * different job: analytics/tracking params and ad-click wrappers. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_name",
  "ref",
  "referrer",
  "source",
  "src",
  "gh_src",
  "gh_jid",
  "lever-source",
  "lever_source",
  "fbclid",
  "gclid",
  "gclsrc",
  "mc_cid",
  "mc_eid",
  "igshid",
  "trk",
  "pk",
  "t",
  "click_id",
  "clickid",
  "target",
]);

/**
 * Resolve a (possibly relative) posting URL against the page it was found
 * on, then strip whatever varies per-impression but not per-job: the
 * fragment, tracking query params, and a trailing slash. Remaining params
 * are sorted so param-order alone never creates a distinct key. Returns
 * null when the URL can't be parsed at all.
 *
 * Case is deliberately PRESERVED here (only the scheme/host are lowercased,
 * which URL does on its own) — this is the value stored and displayed, and
 * many sites use case-sensitive job slugs/IDs (e.g. Ashby paths like
 * `/Foo/9aB-CdE`). Lowercasing it would 404 on those hosts, which is exactly
 * what happened before this split existed. For the dedupe *identity*, which
 * must be case-insensitive, use dedupeKeyFromUrl() on the result.
 */
export function canonicalUrl(rawUrl: string, pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl, pageUrl);
  } catch {
    return null;
  }
  url.hash = "";
  const kept: Array<[string, string]> = [];
  for (const [k, v] of url.searchParams) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
    kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [k, v] of kept) url.searchParams.append(k, v);
  return url.toString().replace(/\/$/, "");
}

/**
 * The dedupe identity of a canonical URL: case-folded, because a board that
 * serves /Jobs/Foo and /jobs/foo is serving one job. Never stored as
 * postings.url — only canonicalUrl()'s original-case output is.
 */
export function dedupeKeyFromUrl(canonical: string): string {
  return canonical.toLowerCase();
}

/** Loose text normalization shared by the title/company/location fallback
 * key: lowercase, strip punctuation, collapse whitespace. Exported so
 * anything computing a title identity elsewhere (poll-pages' rename-merge
 * repair) uses exactly the same normalization — a Postgres-side equivalent
 * would diverge from this on accented titles. */
export function normText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export interface PostingKeyInput {
  title: string;
  url?: string;
  company?: string;
  location?: string;
}

/**
 * The no-URL fallback identity: title+company+location, loosely normalized.
 * Extracted from dedupeKeyFor so poll-pages' rename-merge repair (matching a
 * posting whose URL changed against its prior row) can compute the same
 * value independently, without a URL in hand.
 */
export function titleFallbackKey(posting: PostingKeyInput): string {
  return `t:${normText(posting.title)}|c:${normText(posting.company ?? "")}|l:${normText(posting.location ?? "")}`;
}

/**
 * Per-source dedupe key (unique within one watched page): the normalized
 * absolute URL when the posting has one — stable across tracking-param
 * rotation, so an ad unit or listing whose click-through link changes every
 * poll no longer looks like a brand-new posting each time. Falls back to
 * title+company+location when there's no URL at all (some board tiles
 * render with no href).
 */
export function dedupeKeyFor(posting: PostingKeyInput, pageUrl: string): { key: string; absoluteUrl: string | null } {
  const canonical = posting.url ? canonicalUrl(posting.url, pageUrl) : null;
  if (canonical) return { key: dedupeKeyFromUrl(canonical), absoluteUrl: canonical };
  return { key: titleFallbackKey(posting), absoluteUrl: null };
}

/**
 * Cross-source content key: the same job posted verbatim to several watched
 * pages should be recognized as one job regardless of each board's own URL
 * or ad wrapper. Deliberately coarser than dedupeKeyFor (no location) since
 * the same role is often cross-posted with slightly different location
 * text. Requires both title and company — without a company name there's no
 * safe way to tell two same-titled roles apart, so those postings simply
 * don't participate in cross-source dedup.
 */
export function contentKeyFor(title: string, company: string | null | undefined): string | null {
  const t = normText(title);
  const c = company ? normText(company) : "";
  if (t === "" || c === "") return null;
  return `${t}|${c}`;
}
