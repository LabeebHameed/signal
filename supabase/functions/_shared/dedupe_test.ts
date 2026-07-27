import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canonicalUrl, contentKeyFor, dedupeKeyFor, dedupeKeyFromUrl, titleFallbackKey } from "./dedupe.ts";

// --- canonicalUrl: case preservation --------------------------------------

Deno.test("canonicalUrl preserves path/query casing (the fix for case-sensitive job slugs)", () => {
  const url = canonicalUrl("/jobs/Senior-Design-Engineer-AbC123", "https://acme.io/careers");
  assertEquals(url, "https://acme.io/jobs/Senior-Design-Engineer-AbC123");
});

Deno.test("canonicalUrl preserves case on absolute URLs with mixed-case path and query", () => {
  const url = canonicalUrl("https://jobs.ashbyhq.com/Foo/9aB-CdE?utm_source=x", "https://jobs.ashbyhq.com/Foo");
  assertEquals(url, "https://jobs.ashbyhq.com/Foo/9aB-CdE");
});

Deno.test("canonicalUrl lowercases only scheme/host (URL's own behavior), not path", () => {
  const url = canonicalUrl("https://EX.com/Path/?b=2&a=1", "https://ex.com");
  assertEquals(url, "https://ex.com/Path/?a=1&b=2");
});

// --- canonicalUrl: stripping behavior (unchanged from old normalizeUrl) ---

Deno.test("canonicalUrl strips the fragment", () => {
  assertEquals(canonicalUrl("https://ex.com/a#frag", "https://ex.com"), "https://ex.com/a");
});

Deno.test("canonicalUrl strips tracking params but keeps real ones, sorted", () => {
  const url = canonicalUrl("https://ex.com/a?utm_source=x&z=1&a=2&gclid=y", "https://ex.com");
  assertEquals(url, "https://ex.com/a?a=2&z=1");
});

Deno.test("canonicalUrl strips a trailing slash", () => {
  assertEquals(canonicalUrl("https://ex.com/a/", "https://ex.com"), "https://ex.com/a");
});

Deno.test("canonicalUrl resolves a relative URL against the page URL", () => {
  assertEquals(canonicalUrl("/jobs/1", "https://ex.com/careers"), "https://ex.com/jobs/1");
});

Deno.test("canonicalUrl resolves a protocol-relative URL against the page's scheme", () => {
  assertEquals(canonicalUrl("//cdn.x.com/J/1", "https://ex.com/p"), "https://cdn.x.com/J/1");
});

Deno.test("canonicalUrl returns null for an unparseable URL", () => {
  assertEquals(canonicalUrl("not a url at all::::", ""), null);
});

Deno.test("canonicalUrl handles a query-only relative href", () => {
  assertEquals(canonicalUrl("?id=Ab9", "https://ex.com/jobs/list"), "https://ex.com/jobs/list?id=Ab9");
});

// --- dedupeKeyFromUrl -------------------------------------------------------

Deno.test("dedupeKeyFromUrl folds case", () => {
  assertEquals(dedupeKeyFromUrl("https://ex.com/Jobs/Foo-Bar"), "https://ex.com/jobs/foo-bar");
});

// --- Regression lock-in: the split must not change any dedupe key --------
// This is the guard against the launch risk in the plan: if the new key
// diverges from the old normalizeUrl()'s output for any existing URL shape,
// every affected posting gets a new dedupe_key on the next crawl, looks
// brand-new, and gets re-screened and re-notified. These pairs cover the
// shapes that actually appear in the wild across the sites this project has
// dealt with (mixed-case slugs, Ashby paths, protocol-relative hrefs,
// percent-encoded paths, tracking params, query-only hrefs).
function oldNormalizeUrl(rawUrl: string, pageUrl: string): string | null {
  const canonical = canonicalUrl(rawUrl, pageUrl);
  return canonical === null ? null : canonical.toLowerCase();
}

const REAL_WORLD_URL_SHAPES: Array<[string, string]> = [
  ["/jobs/Senior-Design-Engineer-AbC123", "https://acme.io/careers"],
  ["https://jobs.ashbyhq.com/Foo/9aB-CdE?utm_source=x", "https://jobs.ashbyhq.com/Foo"],
  ["https://ex.com", "https://ex.com/a"],
  ["https://EX.com/Path/?b=2&a=1&t=zz#frag", "https://ex.com"],
  ["//cdn.x.com/J/1", "https://ex.com/p"],
  ["/j/%C3%89t%C3%A9-Designer", "https://ex.com/careers/"],
  ["?id=Ab9", "https://ex.com/jobs/list"],
];

Deno.test("dedupeKeyFromUrl(canonicalUrl(x, p)) matches the pre-split algorithm for real-world URL shapes", () => {
  for (const [raw, page] of REAL_WORLD_URL_SHAPES) {
    const canonical = canonicalUrl(raw, page);
    const key = canonical === null ? null : dedupeKeyFromUrl(canonical);
    assertEquals(key, oldNormalizeUrl(raw, page), `mismatch for canonicalUrl(${JSON.stringify(raw)}, ${JSON.stringify(page)})`);
  }
});

// --- titleFallbackKey --------------------------------------------------

Deno.test("titleFallbackKey combines normalized title/company/location", () => {
  const key = titleFallbackKey({ title: "Senior Designer!", company: "Acme, Inc.", location: "NYC" });
  assertEquals(key, "t:senior designer|c:acme inc|l:nyc");
});

Deno.test("titleFallbackKey is stable across punctuation/case differences", () => {
  const a = titleFallbackKey({ title: "Senior Designer!", company: "Acme, Inc." });
  const b = titleFallbackKey({ title: "senior   designer", company: "ACME INC" });
  assertEquals(a, b);
});

Deno.test("titleFallbackKey differs when titles differ (guards the duplicate-title case)", () => {
  const a = titleFallbackKey({ title: "Senior Graphic Designer", company: "Acme" });
  const b = titleFallbackKey({ title: "Senior Graphic Designer II", company: "Acme" });
  assertEquals(a === b, false);
});

// --- dedupeKeyFor: end-to-end ----------------------------------------------

Deno.test("dedupeKeyFor uses the canonical URL's key and preserves its casing in absoluteUrl", () => {
  const { key, absoluteUrl } = dedupeKeyFor(
    { title: "Senior Designer", url: "/Jobs/Senior-Designer-A1" },
    "https://acme.io/careers",
  );
  assertEquals(absoluteUrl, "https://acme.io/Jobs/Senior-Designer-A1");
  assertEquals(key, "https://acme.io/jobs/senior-designer-a1");
});

Deno.test("dedupeKeyFor falls back to the title key when there's no URL", () => {
  const { key, absoluteUrl } = dedupeKeyFor({ title: "Senior Designer", company: "Acme" }, "https://acme.io/careers");
  assertEquals(absoluteUrl, null);
  assertEquals(key, titleFallbackKey({ title: "Senior Designer", company: "Acme" }));
});

Deno.test("dedupeKeyFor falls back to the title key when the URL can't be parsed", () => {
  const { key, absoluteUrl } = dedupeKeyFor({ title: "Senior Designer", url: "::::" }, "");
  assertEquals(absoluteUrl, null);
  assertEquals(key, titleFallbackKey({ title: "Senior Designer", url: "::::" }));
});

// --- contentKeyFor (unchanged, but shares normText — quick smoke test) ----

Deno.test("contentKeyFor requires both title and company", () => {
  assertEquals(contentKeyFor("Designer", null), null);
  assertEquals(contentKeyFor("Designer", "Acme"), "designer|acme");
});
