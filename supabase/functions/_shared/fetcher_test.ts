import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { htmlToTextWithLinks, markdownToTextWithLinks } from "./fetcher.ts";

const BASE = "https://acme.io/careers";

// --- HTML: all three href-quoting styles -----------------------------------

Deno.test("htmlToTextWithLinks: double-quoted href", () => {
  const { links } = htmlToTextWithLinks(`<a href="/jobs/1">Designer</a>`, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/1");
  assertEquals(links[0].text, "Designer");
});

Deno.test("htmlToTextWithLinks: single-quoted href", () => {
  const { links } = htmlToTextWithLinks(`<a href='/jobs/2'>Engineer</a>`, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/2");
  assertEquals(links[0].text, "Engineer");
});

Deno.test("htmlToTextWithLinks: unquoted href (valid HTML5, seen on cryptocurrencyjobs.co/nodesk.co)", () => {
  const { links } = htmlToTextWithLinks(`<a href=/jobs/3>Analyst</a>`, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/3");
  assertEquals(links[0].text, "Analyst");
});

Deno.test("htmlToTextWithLinks: unquoted href followed by another attribute", () => {
  const { links } = htmlToTextWithLinks(`<a href=/jobs/4 class="btn">Manager</a>`, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/4");
});

// --- The data-href / x-href bug fix ----------------------------------------

Deno.test("htmlToTextWithLinks: data-href does NOT produce a link (the old bug)", () => {
  const { links } = htmlToTextWithLinks(`<a data-href="/jobs/wrong" class="card">Designer</a>`, BASE);
  assertEquals(links.length, 0);
});

Deno.test("htmlToTextWithLinks: x-href does NOT produce a link", () => {
  const { links } = htmlToTextWithLinks(`<a x-href="/jobs/wrong">Designer</a>`, BASE);
  assertEquals(links.length, 0);
});

Deno.test("htmlToTextWithLinks: a real href alongside a data-href on the same tag still resolves correctly", () => {
  const { links } = htmlToTextWithLinks(`<a data-track="x" href="/jobs/real">Designer</a>`, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/real");
});

// --- Entity decoding in hrefs -----------------------------------------------

Deno.test("htmlToTextWithLinks: decodes &amp; in the href's query string", () => {
  const { links } = htmlToTextWithLinks(`<a href="/jobs/1?a=1&amp;b=2">Designer</a>`, BASE);
  assertEquals(links[0].href, "https://acme.io/jobs/1?a=1&b=2");
});

// --- Unusable hrefs burn no id ----------------------------------------------

for (const href of ["javascript:void(0)", "mailto:jobs@acme.io", "#", "", "tel:+15551234567"]) {
  Deno.test(`htmlToTextWithLinks: "${href}" produces no citation`, () => {
    const { links } = htmlToTextWithLinks(`<a href="${href}">Apply</a>`, BASE);
    assertEquals(links.length, 0);
  });
}

Deno.test("htmlToTextWithLinks: an anchor with no href attribute at all produces no citation", () => {
  const { links } = htmlToTextWithLinks(`<a class="card">Designer</a>`, BASE);
  assertEquals(links.length, 0);
});

// --- Relative / protocol-relative / absolute resolution, case preserved ---

Deno.test("htmlToTextWithLinks: relative href resolves against baseUrl with case intact", () => {
  const { links } = htmlToTextWithLinks(`<a href="/Jobs/Senior-Designer-AbC">X</a>`, BASE);
  assertEquals(links[0].href, "https://acme.io/Jobs/Senior-Designer-AbC");
});

Deno.test("htmlToTextWithLinks: protocol-relative href resolves against baseUrl's scheme", () => {
  const { links } = htmlToTextWithLinks(`<a href="//cdn.acme.io/J/1">X</a>`, BASE);
  assertEquals(links[0].href, "https://cdn.acme.io/J/1");
});

Deno.test("htmlToTextWithLinks: absolute href with mixed case is preserved verbatim", () => {
  const { links } = htmlToTextWithLinks(`<a href="https://Other.com/Jobs/AbC">X</a>`, BASE);
  assertEquals(links[0].href, "https://other.com/Jobs/AbC"); // URL lowercases host only
});

// --- Malformed markup -------------------------------------------------------

Deno.test("htmlToTextWithLinks: a stray closing </a> with nothing open is ignored, not crashing", () => {
  const { links, text } = htmlToTextWithLinks(`</a>Designer<a href="/jobs/1">Apply</a>`, BASE);
  assertEquals(links.length, 1);
  assertEquals(text.includes("Designer"), true);
});

Deno.test("htmlToTextWithLinks: an unclosed <a> still gets a bounded, best-effort text", () => {
  const { links } = htmlToTextWithLinks(`<a href="/jobs/1">Senior Designer without a closing tag`, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].text, "Senior Designer without a closing tag");
});

Deno.test("htmlToTextWithLinks: an unclosed <a> stops at the next marker, not swallowing the next link's text", () => {
  const html = `<a href="/jobs/1">First<a href="/jobs/2">Second</a>`;
  const { links } = htmlToTextWithLinks(html, BASE);
  assertEquals(links.length, 2);
  assertEquals(links[0].text, "First");
  assertEquals(links[1].text, "Second");
});

// --- Anchor text collapse and cap -------------------------------------------

Deno.test("htmlToTextWithLinks: anchor text whitespace is collapsed", () => {
  const { links } = htmlToTextWithLinks(`<a href="/jobs/1">  Senior   \n  Designer  </a>`, BASE);
  assertEquals(links[0].text, "Senior Designer");
});

Deno.test("htmlToTextWithLinks: nested markup inside an anchor is stripped from its text", () => {
  const { links } = htmlToTextWithLinks(`<a href="/jobs/1"><span>Senior</span> <b>Designer</b></a>`, BASE);
  assertEquals(links[0].text, "Senior Designer");
});

Deno.test("htmlToTextWithLinks: anchor text is capped", () => {
  const long = "x".repeat(500);
  const { links } = htmlToTextWithLinks(`<a href="/jobs/1">${long}</a>`, BASE);
  assertEquals(links[0].text.length <= 160, true);
});

// --- Counterfeit tokens can't forge a citation ------------------------------

Deno.test("htmlToTextWithLinks: literal [[3]] text in the page cannot forge a citation", () => {
  const html = `<p>Ref [[3]] see below [[/3]]</p><a href="/jobs/1">Designer</a>`;
  const { links, text } = htmlToTextWithLinks(html, BASE);
  // Exactly one real link (id 1, from the actual anchor) — the literal
  // [[3]]/[[/3]] text was sanitized before tokenization began.
  assertEquals(links.length, 1);
  assertEquals(links[0].id, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/1");
  // The literal bracket text should no longer contain a real link marker
  // shaped like [[3]] — it was blanked out.
  assertEquals(/\[\[3\]\]/.test(text), false);
});

// --- Truncation: dangling ids dropped, no dangling markers ------------------

Deno.test("htmlToTextWithLinks: a link whose markers are entirely truncated away is dropped from the table", () => {
  // Build content where the real content is short but padded past the cap
  // with plain filler text containing an anchor near the very end.
  const filler = "x".repeat(100_100);
  const html = `<a href="/jobs/1">Kept</a>${filler}<a href="/jobs/2">Dropped</a>`;
  const { links, text } = htmlToTextWithLinks(html, BASE);
  const ids = links.map((l) => l.id);
  assertEquals(ids.includes(1), true);
  assertEquals(ids.includes(2), false);
  // No dangling half-token at the very end of the returned text.
  assertEquals(/\[\[\/?\d*$/.test(text), false);
});

// --- Markdown link extraction -----------------------------------------------

Deno.test("markdownToTextWithLinks: inline link with a plain destination", () => {
  const { links, text } = markdownToTextWithLinks(`[Senior Designer](/jobs/1)`, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/1");
  assertEquals(links[0].text, "Senior Designer");
  assertEquals(text.includes("Senior Designer"), true);
});

Deno.test("markdownToTextWithLinks: inline link with an angle-bracket destination and a title", () => {
  const { links } = markdownToTextWithLinks(`[Designer](<https://acme.io/jobs/1> "Apply now")`, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/1");
});

Deno.test("markdownToTextWithLinks: autolink", () => {
  const { links } = markdownToTextWithLinks(`See <https://acme.io/jobs/1> for details.`, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/1");
});

Deno.test("markdownToTextWithLinks: image syntax does not consume a citation id", () => {
  const { links, text } = markdownToTextWithLinks(`![Company logo](/logo.png)\n\n[Designer](/jobs/1)`, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/1");
  assertEquals(text.includes("Company logo"), true);
});

Deno.test("markdownToTextWithLinks: reference-style links are an accepted gap — no citation, text preserved", () => {
  const { links, text } = markdownToTextWithLinks(`[Designer][ref]\n\n[ref]: /jobs/1`, BASE);
  assertEquals(links.length, 0);
  assertEquals(text.includes("Designer"), true);
});

Deno.test("markdownToTextWithLinks: a real URL is preserved even when relative resolution is needed", () => {
  const { links } = markdownToTextWithLinks(`[Designer](jobs/1)`, "https://acme.io/careers/");
  assertEquals(links[0].href, "https://acme.io/careers/jobs/1");
});
