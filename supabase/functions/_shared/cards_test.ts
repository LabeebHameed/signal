import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractCardLinks, resolveByCard } from "./cards.ts";

// Fixtures are trimmed from the real markup of each site, keeping the exact
// nesting that matters: which element repeats, where the title sits, and
// which competing links share the card.

const NODESK_URL = "https://nodesk.co/remote-jobs/design/";

/** nodesk.co: anchor inside an <h2>, company in an <h3>, and — the case that
 * defeats a flat anchor list — tag links in the same card, one of which is
 * literally titled "Product Designer". Unquoted href attributes, as shipped. */
const NODESK = `<ul>
  <li class="dt-s bt bg-white pa3">
    <div><h2 class="f8"><a class="link" href=/remote-jobs/1password-senior-product-designer-epm/>Senior Product Designer, EPM</a></h2>
    <h3><a class="link" href=/remote-companies/1password/>1Password</a></h3>
    <h5><a href=/remote-jobs/uk/>UK</a></h5>
    <ul><li><a href=/remote-jobs/product/>Product</a></li>
        <li><a href=/remote-jobs/product-designer/>Product Designer</a></li></ul></div>
  </li>
  <li class="dt-s bt bg-white pa3">
    <div><h2 class="f8"><a class="link" href=/remote-jobs/6sense-creative-director/>Creative Director</a></h2>
    <h3><a class="link" href=/remote-companies/6sense/>6sense</a></h3>
    <ul><li><a href=/remote-jobs/product/>Product</a></li></ul></div>
  </li>
  <li class="dt-s bt bg-white pa3">
    <div><h2 class="f8"><a class="link" href=/remote-jobs/boulevard-creative-director/>Creative Director</a></h2>
    <h3><a class="link" href=/remote-companies/boulevard/>Boulevard</a></h3>
    <ul><li><a href=/remote-jobs/product/>Product</a></li></ul></div>
  </li>
</ul>`;

/** weworkremotely.com: the job anchor WRAPS the whole card body, with the
 * title in an <h3> inside it, and a company link sitting outside the wrap. */
const WWR = `<ul>
  <li class="new-listing-container">
    <div class="tooltip--flag-logo"><a href="/company/studyflix">View Company Profile</a></div>
    <a class="listing-link" href="/remote-jobs/studyflix-praktikum-grafik-design">
      <div class="new-listing"><h3 class="title"><span>Praktikum Grafik &amp; Design</span></h3>
      <p class="new-listing__company-name">Studyflix</p></div></a>
  </li>
  <li class="new-listing-container">
    <div class="tooltip--flag-logo"><a href="/company/smartsheet">View Company Profile</a></div>
    <a class="listing-link" href="/remote-jobs/smartsheet-director-product-design">
      <div class="new-listing"><h3 class="title"><span>Director, Product Design</span></h3>
      <p class="new-listing__company-name">Smartsheet</p></div></a>
  </li>
  <li class="new-listing-container">
    <div class="tooltip--flag-logo"><a href="/company/regex-seo">View Company Profile</a></div>
    <a class="listing-link" href="/remote-jobs/regex-seo-web-designer">
      <div class="new-listing"><h3 class="title"><span>Web Designer</span></h3>
      <p class="new-listing__company-name">Regex SEO</p></div></a>
  </li>
</ul>`;

/** ycombinator.com: no heading elements at all, and the company link
 * (/companies/x) sits in the same card as the job link (/companies/x/jobs/y). */
const YC = `<ul>
  <li class="my-2 flex w-full">
    <div><a href="/companies/cardboard" class="shrink-0">Cardboard (W26)</a>
    <a href="/companies/cardboard/jobs/zrMDlho-founding-designer" class="text-sm font-semibold">Founding Designer</a>
    <div class="whitespace-nowrap">Full-time</div></div>
  </li>
  <li class="my-2 flex w-full">
    <div><a href="/companies/finta" class="shrink-0">Finta (W21)</a>
    <a href="/companies/finta/jobs/awUE3Ik-founding-designer" class="text-sm font-semibold">Founding Designer</a>
    <div class="whitespace-nowrap">Full-time</div></div>
  </li>
  <li class="my-2 flex w-full">
    <div><a href="/companies/pocket" class="shrink-0">Pocket (W26)</a>
    <a href="/companies/pocket/jobs/kkQ11xa-product-designer" class="text-sm font-semibold">Product Designer</a>
    <div class="whitespace-nowrap">Full-time</div></div>
  </li>
</ul>`;

function hrefFor(cards: ReturnType<typeof extractCardLinks>, title: string, company: string | null = null) {
  return resolveByCard(title, company, cards)?.href ?? null;
}

Deno.test("extractCardLinks: anchor-inside-heading card yields the job link, not the company link", () => {
  const cards = extractCardLinks(NODESK, NODESK_URL);
  assertEquals(
    hrefFor(cards, "Senior Product Designer, EPM"),
    "https://nodesk.co/remote-jobs/1password-senior-product-designer-epm",
  );
});

Deno.test("extractCardLinks: a tag link whose text collides with a real job title never wins", () => {
  // "/remote-jobs/product-designer/" is a TAG in the first card whose anchor
  // text is exactly "Product Designer" — the collision that makes choosing
  // from a flat list of the page's anchors unsafe. It repeats across cards,
  // so it can never be a card's primary (unique-per-card) link.
  const cards = extractCardLinks(NODESK, NODESK_URL);
  for (const card of cards) {
    assertEquals(card.href.endsWith("/remote-jobs/product-designer"), false);
    assertEquals(card.href.includes("/remote-companies/"), false);
  }
});

Deno.test("resolveByCard: duplicate titles are split by company", () => {
  const cards = extractCardLinks(NODESK, NODESK_URL);
  assertEquals(hrefFor(cards, "Creative Director", "6sense"), "https://nodesk.co/remote-jobs/6sense-creative-director");
  assertEquals(
    hrefFor(cards, "Creative Director", "Boulevard"),
    "https://nodesk.co/remote-jobs/boulevard-creative-director",
  );
});

Deno.test("resolveByCard: a duplicate title with no company is ambiguous — returns null, never a guess", () => {
  const cards = extractCardLinks(NODESK, NODESK_URL);
  assertEquals(resolveByCard("Creative Director", null, cards), null);
});

Deno.test("resolveByCard: an unknown company on a duplicate title stays ambiguous", () => {
  const cards = extractCardLinks(NODESK, NODESK_URL);
  assertEquals(resolveByCard("Creative Director", "Acme Corp", cards), null);
});

Deno.test("extractCardLinks: anchor-wrapping-card layout (weworkremotely)", () => {
  const url = "https://weworkremotely.com/categories/remote-design-jobs";
  const cards = extractCardLinks(WWR, url);
  assertEquals(hrefFor(cards, "Web Designer"), "https://weworkremotely.com/remote-jobs/regex-seo-web-designer");
  assertEquals(
    hrefFor(cards, "Director, Product Design"),
    "https://weworkremotely.com/remote-jobs/smartsheet-director-product-design",
  );
});

Deno.test("extractCardLinks: entity-decoded title still matches", () => {
  const cards = extractCardLinks(WWR, "https://weworkremotely.com/categories/remote-design-jobs");
  assertEquals(
    hrefFor(cards, "Praktikum Grafik & Design"),
    "https://weworkremotely.com/remote-jobs/studyflix-praktikum-grafik-design",
  );
});

Deno.test("extractCardLinks: card with no headings resolves via anchor text, and prefers the deep job link", () => {
  const url = "https://www.ycombinator.com/jobs/role/designer";
  const cards = extractCardLinks(YC, url);
  // Both /companies/cardboard and /companies/cardboard/jobs/... are unique per
  // card; the deeper, title-bearing one has to win.
  assertEquals(
    hrefFor(cards, "Founding Designer", "Cardboard"),
    "https://www.ycombinator.com/companies/cardboard/jobs/zrMDlho-founding-designer",
  );
  assertEquals(
    hrefFor(cards, "Product Designer", "Pocket"),
    "https://www.ycombinator.com/companies/pocket/jobs/kkQ11xa-product-designer",
  );
});

Deno.test("resolveByCard: a title that appears nowhere on the page returns null", () => {
  const cards = extractCardLinks(NODESK, NODESK_URL);
  assertEquals(resolveByCard("Staff Machine Learning Engineer", "Acme", cards), null);
});

Deno.test("extractCardLinks: a navigation-only group contributes nothing resolvable as a posting", () => {
  const nav = `<nav><ul>
    <li class="nav"><a href="/engineering/">Engineering</a></li>
    <li class="nav"><a href="/marketing/">Marketing</a></li>
    <li class="nav"><a href="/design/">Design</a></li>
  </ul></nav>`;
  const cards = extractCardLinks(nav, "https://example.com/jobs");
  // Nav entries may well be indexed — that is deliberate and harmless — but a
  // real posting title must never resolve to one.
  assertEquals(resolveByCard("Senior Product Designer", "Acme", cards), null);
});

Deno.test("extractCardLinks: markdown (a reader-proxy body) yields no cards", () => {
  const md = "# Jobs\n\n[Senior Product Designer](/jobs/1)\n\n[Brand Designer](/jobs/2)\n";
  assertEquals(extractCardLinks(md, "https://example.com/jobs").length, 0);
});

Deno.test("extractCardLinks: empty input is handled", () => {
  assertEquals(extractCardLinks("", "https://example.com/jobs").length, 0);
});

Deno.test("resolveByCard: an empty card index resolves nothing", () => {
  assertEquals(resolveByCard("Product Designer", "Acme", []), null);
});
