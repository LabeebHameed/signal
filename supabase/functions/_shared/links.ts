// Deterministic, network-free reconciliation of a posting's link: turns the
// page's own markup (or, for structured ATS/RSS sources, a real platform URL)
// into a stored `postings.url` plus provenance.
//
// The primary path is _shared/cards.ts: the link belonging to the DOM card
// that displays this posting's title. Nothing here makes a network request,
// and nothing is checked after the fact — a link read off the card that
// contains the title does not need to be re-proven, and trying to prove it
// could not work anyway (the sites needing proof are exactly the ones that
// wall or challenge a server-side fetch).
//
// Also hosts pickRenameMerges, the pure predicate poll-pages uses to decide
// whether a posting whose URL changed between crawls should be merged into
// its prior row (rather than treated as a brand-new posting, which would
// re-notify it) — kept here rather than in poll-pages/index.ts because that
// module runs Deno.serve() at load time and can't be imported by a test.

import type { ExtractedPosting, LinkSource } from "./types.ts";
import type { PageLink } from "./fetcher.ts";
import { type CardLink, resolveByCard } from "./cards.ts";
import { canonicalUrl, dedupeKeyFromUrl, normText } from "./dedupe.ts";

export interface LinkCandidate {
  href: string;
  text: string;
}

export interface ResolvedLink {
  /** Canonical, original-case URL — or null when nothing defensible was found. */
  url: string | null;
  source: LinkSource;
  /** Title <-> anchor-text agreement, 0..1. Never a gate on a valid citation
   * — real "Apply"/"View job"/icon anchors legitimately score 0. Used only
   * for duplicate-href tie-breaks, recovery, and auditing. */
  score: number | null;
  /** Why a candidate was rejected, or how a link was recovered — for the
   * audit trail (postings.link_note). */
  note: string | null;
}

// --- Rejection rules ---------------------------------------------------

// Deliberately narrow: a false rejection costs a good link (it falls through
// to title-matching, and worst case to the source-listing fallback), so each
// rule only fires on a genuinely unambiguous non-posting shape.
const AD_TELL_RE = /\/(ads|sponsored|promo)\//i;
const CLICK_TRACK_RE = /\/click(\/|$)/i;
// Exactly "/<taxonomy>/<one-slug>" and nothing after — a company/category
// *index* page, not a job. Deliberately does NOT match "/companies/acme/jobs/1"
// — plenty of boards nest real job URLs under a company path.
const TAXONOMY_LEAF_RE = /^\/(companies|company|employers|categories|category|tags|tag|locations|topics)\/[^/]+\/?$/i;
const AUTH_MARKETING_RE =
  /^\/(login|log-in|signin|sign-in|signup|sign-up|register|post-a-job|pricing|about|contact|privacy|terms|faq|newsletter|rss|feed)\/?$/i;
const SOCIAL_HOSTS = new Set(["twitter.com", "x.com", "facebook.com", "instagram.com", "youtube.com", "discord.gg", "t.me"]);

function bareHost(hostname: string): string {
  return hostname.replace(/^www\./, "").toLowerCase();
}

/**
 * Deterministic, no-network check for whether a candidate href could
 * possibly be a posting's own link — never a positive proof, only a filter
 * against unambiguous non-posting shapes: the page itself, an ad/tracking
 * wrapper, a taxonomy index page, an auth/marketing page, or an off-site
 * social link (unless the watched page itself lives on that host).
 */
export function isUsableHref(href: string, pageUrl: string): boolean {
  let hrefUrl: URL;
  let page: URL;
  try {
    hrefUrl = new URL(href, pageUrl);
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (hrefUrl.protocol !== "http:" && hrefUrl.protocol !== "https:") return false;

  // Self-link: the href canonicalizes to the same URL as the page itself
  // (with or without a different query string) — never a distinct posting.
  const hrefCanonical = canonicalUrl(hrefUrl.toString(), pageUrl) ?? hrefUrl.toString();
  const pageCanonical = canonicalUrl(pageUrl, pageUrl) ?? pageUrl;
  if (dedupeKeyFromUrl(hrefCanonical) === dedupeKeyFromUrl(pageCanonical)) return false;

  // Bare origin root (the site's homepage) wearing a different query string.
  if ((hrefUrl.pathname === "/" || hrefUrl.pathname === "") && hrefUrl.search === "") return false;

  const path = hrefUrl.pathname;
  if (AD_TELL_RE.test(path) || CLICK_TRACK_RE.test(path)) return false;
  if (TAXONOMY_LEAF_RE.test(path)) return false;
  if (AUTH_MARKETING_RE.test(path)) return false;

  // Off-site social links, unless the watched page itself lives on that
  // host (a source that IS twitter.com/etc. can legitimately link within
  // itself). A LinkedIn company-profile path ("/company/acme") needs no
  // special case here — TAXONOMY_LEAF_RE above already rejects it uniformly,
  // on any host, because it is never a job posting either way.
  const hrefHost = bareHost(hrefUrl.hostname);
  const pageHost = bareHost(page.hostname);
  if (SOCIAL_HOSTS.has(hrefHost) && hrefHost !== pageHost) return false;

  return true;
}

// --- Title <-> anchor-text agreement ------------------------------------

// Short words that carry no discipline/role signal — dropped before scoring
// so "Senior Product Designer" vs "View the Product Designer role" scores on
// its real content words, not generic surrounding chrome.
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "at",
  "in",
  "of",
  "for",
  "and",
  "job",
  "jobs",
  "role",
  "apply",
  "view",
  "remote",
]);

function tokenize(s: string): string[] {
  return normText(s).split(" ").filter((t) => t !== "" && !STOPWORDS.has(t));
}

/**
 * 0..1 agreement between a posting title and an anchor's visible text.
 * NEVER a gate on an otherwise-valid citation — a real posting link is
 * routinely wrapped in "Apply", "View job", or an image with no alt text,
 * which legitimately scores 0 while being exactly the right link. This score
 * exists only for duplicate-href tie-breaks, title-matching recovery, and
 * the audit trail.
 */
export function titleAnchorScore(title: string, anchorText: string): number {
  const titleTokens = tokenize(title);
  if (titleTokens.length === 0) return 0;
  const anchorTokenSet = new Set(tokenize(anchorText));
  if (anchorTokenSet.size === 0) return 0;
  const overlap = titleTokens.filter((t) => anchorTokenSet.has(t)).length;
  let score = overlap / titleTokens.length;
  const normTitle = normText(title);
  const normAnchor = normText(anchorText);
  if (normTitle !== "" && normAnchor.includes(normTitle)) score = Math.min(1, score + 0.15);
  return score;
}

const STRONG_MATCH = 0.6;
const MATCH_MARGIN = 0.15;

/**
 * The best anchor for a title among candidates, or null when nothing is
 * confidently better than the runner-up — an ambiguous best match is worse
 * than no match, since accepting it risks pointing at the wrong posting.
 * `exclude` holds dedupe keys of hrefs already proven wrong (or already
 * claimed by a better-matching posting), so recovery never retries them.
 */
export function bestAnchorForTitle(
  title: string,
  candidates: LinkCandidate[],
  exclude?: Set<string>,
): { href: string; score: number } | null {
  const scored = candidates
    .filter((c) => !exclude || !exclude.has(dedupeKeyFromUrl(c.href)))
    .map((c) => ({ href: c.href, score: titleAnchorScore(title, c.text) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const best = scored[0];
  if (best.score < STRONG_MATCH) return null;
  const runnerUp = scored[1]?.score ?? 0;
  if (best.score - runnerUp < MATCH_MARGIN) return null;
  return { href: best.href, score: best.score };
}

// --- Whole-crawl resolution ----------------------------------------------

/**
 * Resolve every extracted posting's link for one crawl, deterministically
 * and with no network access. Only for the generic fetch+LLM path —
 * structured (ATS/RSS) postings never reach this function; the caller marks
 * them link_source='platform' directly since their url is already a real
 * platform-issued link.
 *
 * Order: (1) the posting's own card link, read from the page's markup — the
 * authoritative path whenever the page was fetched as HTML. (2) the model's
 * cited link_id, which only carries reader-proxy (markdown) pages, where
 * there is no DOM and therefore no cards. (3) back-compat: a raw url the
 * model wrote itself, honored only when it matches a real href from this
 * crawl's link table — anything else is discarded, never trusted.
 * (4) fallback: best anchor-text match for the title. (5) nothing → none.
 * (6) duplicate-href arbitration over the cited/matched results only (never
 * platform or card, both unique by construction, where a coincidence is not
 * evidence of a mistake).
 */
export function resolvePostingLinks(
  postings: ExtractedPosting[],
  links: PageLink[],
  pageUrl: string,
  cards: CardLink[] = [],
): ResolvedLink[] {
  const byId = new Map(links.map((l) => [l.id, l] as const));
  const allCandidates: LinkCandidate[] = links.map((l) => ({ href: l.href, text: l.text }));
  const usableCandidates = allCandidates.filter((c) => isUsableHref(c.href, pageUrl));
  // cards.ts leaves href screening to this module so its imports stay acyclic.
  const usableCards = cards.filter((c) => isUsableHref(c.href, pageUrl));

  const resolved: ResolvedLink[] = postings.map((p): ResolvedLink => {
    // 1. The card on the page that displays this posting's title. Structural,
    // so it outranks anything the model says about links.
    const card = resolveByCard(p.title, p.company ?? null, usableCards);
    if (card) {
      return { url: card.href, source: "card", score: card.score, note: null };
    }
    // 2. Cited id.
    if (typeof p.link_id === "number") {
      const link = byId.get(p.link_id);
      if (link && isUsableHref(link.href, pageUrl)) {
        const canonical = canonicalUrl(link.href, pageUrl) ?? link.href;
        return { url: canonical, source: "cited", score: titleAnchorScore(p.title, link.text), note: null };
      }
    }
    // 3. Back-compat: a raw url from the model, honored only if it
    // canonicalizes to a real href from this crawl's link table.
    if (p.url) {
      const rawCanonical = canonicalUrl(p.url, pageUrl);
      if (rawCanonical) {
        const rawKey = dedupeKeyFromUrl(rawCanonical);
        const match = links.find((l) => dedupeKeyFromUrl(canonicalUrl(l.href, pageUrl) ?? l.href) === rawKey);
        if (match && isUsableHref(match.href, pageUrl)) {
          return {
            url: rawCanonical,
            source: "cited",
            score: titleAnchorScore(p.title, match.text),
            note: "model returned a URL instead of a citation; matched to a real link on the page",
          };
        }
      }
      // A raw URL that matches nothing on the page is discarded outright —
      // it cannot be distinguished from a hallucination, so it's treated as
      // one. Falls through to title-matching below.
    }
    // 4. Fallback: best anchor-text match for the title.
    const best = bestAnchorForTitle(p.title, usableCandidates);
    if (best) {
      const canonical = canonicalUrl(best.href, pageUrl) ?? best.href;
      return {
        url: canonical,
        source: "matched",
        score: best.score,
        note: "no valid citation; recovered by matching the title against the page's links",
      };
    }
    // 5. Nothing defensible.
    return { url: null, source: "none", score: null, note: null };
  });

  // 6. Duplicate-href arbitration, cited/matched only: when two postings
  // claim the same href, at most one can be right. The higher-scoring one
  // keeps it; the other(s) retry title-matching with that href excluded.
  const groups = new Map<string, number[]>();
  resolved.forEach((r, i) => {
    if (r.url === null || (r.source !== "cited" && r.source !== "matched")) return;
    const key = dedupeKeyFromUrl(r.url);
    const arr = groups.get(key);
    if (arr) arr.push(i);
    else groups.set(key, [i]);
  });
  for (const [key, indices] of groups) {
    if (indices.length <= 1) continue;
    let winner = indices[0];
    for (const i of indices) {
      if ((resolved[i].score ?? 0) > (resolved[winner].score ?? 0)) winner = i;
    }
    for (const i of indices) {
      if (i === winner) continue;
      const alt = bestAnchorForTitle(postings[i].title, usableCandidates, new Set([key]));
      if (alt) {
        const canonical = canonicalUrl(alt.href, pageUrl) ?? alt.href;
        resolved[i] = {
          url: canonical,
          source: "matched",
          score: alt.score,
          note: "link was claimed by a better-matching posting; recovered a different match",
        };
      } else {
        resolved[i] = {
          url: null,
          source: "none",
          score: resolved[i].score,
          note: "link was claimed by a better-matching posting",
        };
      }
    }
  }

  return resolved;
}

// --- Re-crawl rename-merge -------------------------------------------------

export interface RenameCandidateRow {
  dedupeKey: string;
  titleKey: string;
}

export interface ExistingTitleRow {
  id: string;
  dedupeKey: string;
  titleKey: string;
}

/**
 * Which of this crawl's "new" dedupe keys are actually a prior posting whose
 * URL changed shape (a board renaming its slug/id scheme), rather than a
 * genuinely new posting — so poll-pages can update the existing row in place
 * instead of inserting a duplicate that would be screened and re-notified.
 *
 * A merge is proposed only when EVERY one of these holds, each guarding a
 * specific false-positive:
 *   - exactly one crawl row has this title key (two identical titles this
 *     crawl — e.g. Himalayas' duplicate "Senior Graphic Designer" listings —
 *     make the match ambiguous, so neither merges);
 *   - exactly one existing row on the page has this title key (same guard,
 *     applied to history);
 *   - that existing row's OLD dedupe key is absent from this crawl entirely
 *     (it really disappeared — if it's still present verbatim, there's
 *     nothing to merge, it's just still there).
 *
 * Returns a map from this crawl's new dedupe_key to the existing posting id
 * it should be merged into.
 */
export function pickRenameMerges(
  crawl: RenameCandidateRow[],
  existing: ExistingTitleRow[],
): Map<string, string> {
  const crawlByTitle = new Map<string, RenameCandidateRow[]>();
  for (const row of crawl) {
    const arr = crawlByTitle.get(row.titleKey);
    if (arr) arr.push(row);
    else crawlByTitle.set(row.titleKey, [row]);
  }
  const existingByTitle = new Map<string, ExistingTitleRow[]>();
  for (const row of existing) {
    const arr = existingByTitle.get(row.titleKey);
    if (arr) arr.push(row);
    else existingByTitle.set(row.titleKey, [row]);
  }
  const crawlKeys = new Set(crawl.map((r) => r.dedupeKey));

  const merges = new Map<string, string>();
  for (const [titleKey, crawlRows] of crawlByTitle) {
    if (crawlRows.length !== 1) continue; // ambiguous: duplicate title this crawl
    const existingRows = existingByTitle.get(titleKey);
    if (!existingRows || existingRows.length !== 1) continue; // none, or ambiguous history
    const existingRow = existingRows[0];
    if (crawlKeys.has(existingRow.dedupeKey)) continue; // still present verbatim — nothing to merge
    const crawlRow = crawlRows[0];
    if (crawlRow.dedupeKey === existingRow.dedupeKey) continue; // no rename happened
    merges.set(crawlRow.dedupeKey, existingRow.id);
  }
  return merges;
}
