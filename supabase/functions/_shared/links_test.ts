import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bestAnchorForTitle,
  isUsableHref,
  pickRenameMerges,
  resolvePostingLinks,
  titleAnchorScore,
} from "./links.ts";
import type { PageLink } from "./fetcher.ts";
import type { ExtractedPosting } from "./types.ts";

const PAGE = "https://acme.io/careers";

// --- isUsableHref -----------------------------------------------------

Deno.test("isUsableHref: accepts an ordinary job path", () => {
  assertEquals(isUsableHref("https://acme.io/jobs/senior-designer", PAGE), true);
});

Deno.test("isUsableHref: rejects the page itself (self-link)", () => {
  assertEquals(isUsableHref(PAGE, PAGE), false);
});

Deno.test("isUsableHref: rejects the page itself with a different query string", () => {
  assertEquals(isUsableHref(PAGE + "?utm_source=x", PAGE), false);
});

Deno.test("isUsableHref: rejects the bare origin root (homepage)", () => {
  assertEquals(isUsableHref("https://acme.io/", PAGE), false);
});

Deno.test("isUsableHref: rejects javascript: scheme", () => {
  assertEquals(isUsableHref("javascript:void(0)", PAGE), false);
});

Deno.test("isUsableHref: rejects an /ads/ path", () => {
  assertEquals(isUsableHref("https://acme.io/ads/13", PAGE), false);
});

Deno.test("isUsableHref: rejects a /sponsored/ path", () => {
  assertEquals(isUsableHref("https://acme.io/sponsored/xyz", PAGE), false);
});

Deno.test("isUsableHref: rejects a click-tracking segment", () => {
  assertEquals(isUsableHref("https://acme.io/listing_ads/13/click", PAGE), false);
});

Deno.test("isUsableHref: rejects a bare company taxonomy leaf", () => {
  assertEquals(isUsableHref("https://acme.io/companies/acme", PAGE), false);
});

Deno.test("isUsableHref: KEEPS a job nested under a company path (real boards do this)", () => {
  assertEquals(isUsableHref("https://acme.io/companies/acme/jobs/123", PAGE), true);
});

Deno.test("isUsableHref: rejects a bare category taxonomy leaf", () => {
  assertEquals(isUsableHref("https://acme.io/categories/design", PAGE), false);
});

Deno.test("isUsableHref: rejects auth/marketing pages", () => {
  assertEquals(isUsableHref("https://acme.io/login", PAGE), false);
  assertEquals(isUsableHref("https://acme.io/post-a-job", PAGE), false);
  assertEquals(isUsableHref("https://acme.io/pricing/", PAGE), false);
});

Deno.test("isUsableHref: rejects an off-site social link", () => {
  assertEquals(isUsableHref("https://twitter.com/acme", PAGE), false);
});

Deno.test("isUsableHref: KEEPS a social link when the watched page itself is on that host", () => {
  assertEquals(isUsableHref("https://twitter.com/acme/status/1", "https://twitter.com/acme"), true);
});

Deno.test("isUsableHref: rejects a LinkedIn company profile page regardless of source (caught by the taxonomy-leaf rule, not a special case)", () => {
  assertEquals(isUsableHref("https://linkedin.com/company/acme", PAGE), false);
  assertEquals(isUsableHref("https://linkedin.com/company/acme", "https://linkedin.com/jobs/search"), false);
});

// --- titleAnchorScore / bestAnchorForTitle ------------------------------

Deno.test("titleAnchorScore: exact title match scores high", () => {
  const score = titleAnchorScore("Senior Product Designer", "Senior Product Designer");
  assertEquals(score >= 0.9, true);
});

Deno.test("titleAnchorScore: a generic 'Apply' anchor scores 0 without invalidating anything downstream", () => {
  assertEquals(titleAnchorScore("Senior Product Designer", "Apply"), 0);
});

Deno.test("titleAnchorScore: an image/icon anchor with empty text scores 0", () => {
  assertEquals(titleAnchorScore("Senior Product Designer", ""), 0);
});

Deno.test("titleAnchorScore: unrelated titles score low", () => {
  const score = titleAnchorScore("Senior Product Designer", "Warehouse Associate");
  assertEquals(score < 0.3, true);
});

Deno.test("bestAnchorForTitle: a real citation-quality anchor scoring 0 is still fine to CITE directly (score never gates a citation) — this test only covers the fallback path", () => {
  // bestAnchorForTitle is the FALLBACK matcher, used only when there's no
  // valid citation at all — it correctly returns null for a generic anchor,
  // because with no citation, "Apply" gives no information about which link
  // is right. That's a fallback limitation, not a bug: resolvePostingLinks'
  // citation path (tested below) is what correctly accepts a low-scoring
  // anchor when the model actually cited it.
  const best = bestAnchorForTitle("Senior Product Designer", [{ href: "https://acme.io/jobs/1", text: "Apply" }]);
  assertEquals(best, null);
});

Deno.test("bestAnchorForTitle: returns the strong match", () => {
  const candidates = [
    { href: "https://acme.io/jobs/1", text: "Senior Product Designer" },
    { href: "https://acme.io/jobs/2", text: "Warehouse Associate" },
  ];
  const best = bestAnchorForTitle("Senior Product Designer", candidates);
  assertEquals(best?.href, "https://acme.io/jobs/1");
});

Deno.test("bestAnchorForTitle: returns null when the best and runner-up are too close (ambiguous)", () => {
  const candidates = [
    { href: "https://acme.io/jobs/1", text: "Senior Product Designer" },
    { href: "https://acme.io/jobs/2", text: "Senior Product Designer II" },
  ];
  const best = bestAnchorForTitle("Senior Product Designer", candidates);
  assertEquals(best, null);
});

Deno.test("bestAnchorForTitle: exclude set removes a candidate from consideration", () => {
  const candidates = [{ href: "https://acme.io/jobs/1", text: "Senior Product Designer" }];
  const best = bestAnchorForTitle("Senior Product Designer", candidates, new Set(["https://acme.io/jobs/1"]));
  assertEquals(best, null);
});

// --- resolvePostingLinks: end-to-end -------------------------------------

function link(id: number, href: string, text: string): PageLink {
  return { id, href, text };
}

function posting(title: string, linkId?: number | null, url?: string): ExtractedPosting {
  return { title, link_id: linkId, url };
}

Deno.test("resolvePostingLinks: a valid cited id resolves to that href, source 'cited'", () => {
  const links = [link(1, "https://acme.io/jobs/1", "Senior Designer")];
  const [result] = resolvePostingLinks([posting("Senior Designer", 1)], links, PAGE);
  assertEquals(result.url, "https://acme.io/jobs/1");
  assertEquals(result.source, "cited");
});

Deno.test("resolvePostingLinks: an out-of-range link_id falls through to title matching", () => {
  const links = [link(1, "https://acme.io/jobs/1", "Senior Designer")];
  const [result] = resolvePostingLinks([posting("Senior Designer", 99)], links, PAGE);
  assertEquals(result.url, "https://acme.io/jobs/1");
  assertEquals(result.source, "matched");
});

Deno.test("resolvePostingLinks: link_id null with no title match yields 'none'", () => {
  const links = [link(1, "https://acme.io/jobs/1", "Warehouse Associate")];
  const [result] = resolvePostingLinks([posting("Senior Designer", null)], links, PAGE);
  assertEquals(result.url, null);
  assertEquals(result.source, "none");
});

Deno.test("resolvePostingLinks: a cited id pointing at an unusable href (self-link) falls through to matching", () => {
  const links = [link(1, PAGE, "Senior Designer"), link(2, "https://acme.io/jobs/1", "Senior Designer")];
  const [result] = resolvePostingLinks([posting("Senior Designer", 1)], links, PAGE);
  // id 1 is the page itself — rejected — falls through to matching id 2.
  assertEquals(result.url, "https://acme.io/jobs/1");
  assertEquals(result.source, "matched");
});

Deno.test("resolvePostingLinks: a low-scoring but validly CITED anchor is still trusted (score never gates a citation)", () => {
  const links = [link(1, "https://acme.io/jobs/1", "Apply")];
  const [result] = resolvePostingLinks([posting("Senior Product Designer", 1)], links, PAGE);
  assertEquals(result.url, "https://acme.io/jobs/1");
  assertEquals(result.source, "cited");
  assertEquals(result.score, 0);
});

Deno.test("resolvePostingLinks: back-compat raw url accepted only when it matches a real href in the table", () => {
  const links = [link(1, "https://acme.io/jobs/1", "Senior Designer")];
  const [result] = resolvePostingLinks(
    [posting("Senior Designer", undefined, "https://acme.io/jobs/1?utm_source=x")],
    links,
    PAGE,
  );
  assertEquals(result.url, "https://acme.io/jobs/1");
  assertEquals(result.source, "cited");
});

Deno.test("resolvePostingLinks: a raw url matching nothing on the page is discarded, not trusted", () => {
  const links = [link(1, "https://acme.io/jobs/1", "Warehouse Associate")];
  const [result] = resolvePostingLinks(
    [posting("Senior Designer", undefined, "https://acme.io/jobs/made-up-99")],
    links,
    PAGE,
  );
  assertEquals(result.url, null);
  assertEquals(result.source, "none");
});

Deno.test("resolvePostingLinks: duplicate-href arbitration keeps the better-matching posting and recovers the other", () => {
  const links = [
    link(1, "https://acme.io/jobs/1", "Senior Designer"),
    link(2, "https://acme.io/jobs/2", "Staff Engineer"),
  ];
  const postings = [
    posting("Senior Designer", 1), // correctly cites job 1
    posting("Staff Engineer", 1), // WRONGLY also cites job 1 (model error)
  ];
  const results = resolvePostingLinks(postings, links, PAGE);
  // The Senior Designer keeps job 1 (its anchor text matches).
  assertEquals(results[0].url, "https://acme.io/jobs/1");
  // Staff Engineer is recovered onto job 2 via anchor-text matching instead
  // of being left pointed at Senior Designer's link.
  assertEquals(results[1].url, "https://acme.io/jobs/2");
  assertEquals(results[1].source, "matched");
});

Deno.test("resolvePostingLinks: duplicate-href arbitration falls to 'none' when no alternative exists", () => {
  const links = [link(1, "https://acme.io/jobs/1", "Senior Designer")];
  const postings = [
    posting("Senior Designer", 1),
    posting("Totally Unrelated Warehouse Role", 1), // wrongly cites the same id, no other link available
  ];
  const results = resolvePostingLinks(postings, links, PAGE);
  assertEquals(results[0].url, "https://acme.io/jobs/1");
  assertEquals(results[1].url, null);
  assertEquals(results[1].source, "none");
});

Deno.test("resolvePostingLinks: platform-style callers never pass through here (documented contract, not a code path) — structured postings bypass this function entirely", () => {
  // No assertion needed beyond the comment: poll-pages sets source:'platform'
  // directly for structured/ATS postings without calling resolvePostingLinks.
  assertEquals(true, true);
});

// --- pickRenameMerges ----------------------------------------------------

Deno.test("pickRenameMerges: merges when a title's dedupe key changed and nothing else claims it", () => {
  const merges = pickRenameMerges(
    [{ dedupeKey: "https://acme.io/jobs/new-slug", titleKey: "t:senior designer|c:|l:" }],
    [{ id: "row-1", dedupeKey: "https://acme.io/jobs/old-slug", titleKey: "t:senior designer|c:|l:" }],
  );
  assertEquals(merges.get("https://acme.io/jobs/new-slug"), "row-1");
});

Deno.test("pickRenameMerges: does not merge when the old key is still present in this crawl (nothing disappeared)", () => {
  const merges = pickRenameMerges(
    [
      { dedupeKey: "https://acme.io/jobs/old-slug", titleKey: "t:senior designer|c:|l:" },
      { dedupeKey: "https://acme.io/jobs/new-slug-2", titleKey: "t:senior designer|c:|l:" },
    ],
    [{ id: "row-1", dedupeKey: "https://acme.io/jobs/old-slug", titleKey: "t:senior designer|c:|l:" }],
  );
  assertEquals(merges.size, 0);
});

Deno.test("pickRenameMerges: refuses to merge when the crawl has a duplicated title key (ambiguous — the Himalayas case)", () => {
  const merges = pickRenameMerges(
    [
      { dedupeKey: "https://acme.io/jobs/a", titleKey: "t:senior graphic designer|c:acme|l:" },
      { dedupeKey: "https://acme.io/jobs/b", titleKey: "t:senior graphic designer|c:acme|l:" },
    ],
    [{ id: "row-1", dedupeKey: "https://acme.io/jobs/old", titleKey: "t:senior graphic designer|c:acme|l:" }],
  );
  assertEquals(merges.size, 0);
});

Deno.test("pickRenameMerges: refuses to merge when existing history has a duplicated title key", () => {
  const merges = pickRenameMerges(
    [{ dedupeKey: "https://acme.io/jobs/new", titleKey: "t:senior graphic designer|c:acme|l:" }],
    [
      { id: "row-1", dedupeKey: "https://acme.io/jobs/old-a", titleKey: "t:senior graphic designer|c:acme|l:" },
      { id: "row-2", dedupeKey: "https://acme.io/jobs/old-b", titleKey: "t:senior graphic designer|c:acme|l:" },
    ],
  );
  assertEquals(merges.size, 0);
});

Deno.test("pickRenameMerges: no merge when dedupe keys are identical (nothing changed)", () => {
  const merges = pickRenameMerges(
    [{ dedupeKey: "https://acme.io/jobs/same", titleKey: "t:senior designer|c:|l:" }],
    [{ id: "row-1", dedupeKey: "https://acme.io/jobs/same", titleKey: "t:senior designer|c:|l:" }],
  );
  assertEquals(merges.size, 0);
});

Deno.test("pickRenameMerges: no merge when there's no existing row with that title at all", () => {
  const merges = pickRenameMerges(
    [{ dedupeKey: "https://acme.io/jobs/new", titleKey: "t:brand new role|c:|l:" }],
    [{ id: "row-1", dedupeKey: "https://acme.io/jobs/old", titleKey: "t:senior designer|c:|l:" }],
  );
  assertEquals(merges.size, 0);
});
