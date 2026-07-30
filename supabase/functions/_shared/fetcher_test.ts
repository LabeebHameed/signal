import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AttemptOutcome,
  type FetchStrategy,
  htmlToTextWithLinks,
  markdownToTextWithLinks,
  selectAttempt,
  stripReaderFrontmatter,
} from "./fetcher.ts";

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

// --- selectAttempt: strategy tiering ----------------------------------------
//
// These cover the nodesk.co failure directly: a reader proxy that returns
// readable content with none of the page's job links must not win over a
// plain fetch that has them. Attempts are thunks, so the whole decision is
// exercised with no network at all.

const LONG = "x".repeat(600); // clears the looksLikeShell threshold

function outcome(
  content: string,
  links: Array<{ id: number; href: string; text: string }>,
  linkBearing = true,
): AttemptOutcome {
  return { content, truncated: false, links, linkBearing, cards: [] };
}

const ONE_LINK = [{ id: 1, href: "https://acme.io/jobs/1", text: "Designer" }];

function attempt(name: FetchStrategy, out: AttemptOutcome | Error) {
  return {
    name,
    run: () => (out instanceof Error ? Promise.reject(out) : Promise.resolve(out)),
  };
}

Deno.test("selectAttempt: a link-bearing strategy beats an earlier link-free one", async () => {
  const res = await selectAttempt([
    attempt("proxy:pure", outcome(LONG, [])),
    attempt("direct", outcome(LONG, ONE_LINK)),
  ]);
  assertEquals(res.strategy, "direct");
  assertEquals(res.links.length, 1);
  assertEquals(res.degraded, false);
});

Deno.test("selectAttempt: stops at the first link-bearing result without running the rest", async () => {
  let ran = 0;
  const res = await selectAttempt([
    { name: "direct", run: () => Promise.resolve(outcome(LONG, ONE_LINK)) },
    { name: "proxy:pure", run: () => { ran++; return Promise.resolve(outcome(LONG, ONE_LINK)); } },
  ]);
  assertEquals(res.strategy, "direct");
  assertEquals(ran, 0);
});

Deno.test("selectAttempt: falls back to link-free content when nothing has links", async () => {
  const res = await selectAttempt([
    attempt("direct", outcome(LONG, [])),
    attempt("proxy:pure", outcome(LONG + "yy", [])),
  ]);
  // Longest link-free candidate wins, and says so.
  assertEquals(res.strategy, "proxy:pure");
  assertEquals(res.degraded, true);
});

Deno.test("selectAttempt: link-free content outranks a sub-500-char shell", async () => {
  const res = await selectAttempt([
    attempt("direct", outcome("tiny", ONE_LINK)),      // shell, despite a link
    attempt("proxy:pure", outcome(LONG, [])),          // real content, no links
  ]);
  assertEquals(res.strategy, "proxy:pure");
  assertEquals(res.degraded, true);
});

Deno.test("selectAttempt: plain-text content is not penalised for having no links", async () => {
  const res = await selectAttempt([
    attempt("direct", outcome(LONG, [], /* linkBearing */ false)),
    attempt("proxy:pure", outcome(LONG, ONE_LINK)),
  ]);
  // A text/JSON body cannot have anchors, so it is a first-class result.
  assertEquals(res.strategy, "direct");
  assertEquals(res.degraded, false);
});

Deno.test("selectAttempt: a blocked page is never accepted, even as a last resort", async () => {
  await assertRejects(() =>
    selectAttempt([attempt("direct", outcome("Just a moment... " + LONG, ONE_LINK))])
  );
});

Deno.test("selectAttempt: skipLinkProbe mode takes the first result but still reports it degraded", async () => {
  let ran = 0;
  const res = await selectAttempt([
    { name: "proxy:pure", run: () => Promise.resolve(outcome(LONG, [])) },
    { name: "direct", run: () => { ran++; return Promise.resolve(outcome(LONG, ONE_LINK)); } },
  ], { enforceLinks: false });
  assertEquals(res.strategy, "proxy:pure");
  assertEquals(ran, 0);          // cooldown honoured: only one fetch
  assertEquals(res.degraded, true); // but the caller must not reset the window
});

Deno.test("selectAttempt: every strategy failing surfaces the collected errors", async () => {
  await assertRejects(
    () => selectAttempt([attempt("direct", new Error("HTTP 403"))]),
    Error,
    "HTTP 403",
  );
});

// --- stripReaderFrontmatter -------------------------------------------------

Deno.test("stripReaderFrontmatter: removes a leading reader-proxy fence", () => {
  const body = "---\nurl: https://contra.com/x\ntitle: Contra\n---\n# Jobs\n\n[Designer](/jobs/1)";
  assertEquals(stripReaderFrontmatter(body), "# Jobs\n\n[Designer](/jobs/1)");
});

Deno.test("stripReaderFrontmatter: a body that is only frontmatter reduces to nothing (the contra.com case)", () => {
  const body = "---\nurl: https://contra.com/independent/opportunities\n" +
    "title: Contra - A professional network\ndescription: Connect with next-gen talent.\n---";
  assertEquals(stripReaderFrontmatter(body), "");
});

Deno.test("stripReaderFrontmatter: a --- rule further down the document is left alone", () => {
  const body = "# Jobs\n\n---\n\n[Designer](/jobs/1)";
  assertEquals(stripReaderFrontmatter(body), body);
});

Deno.test("stripReaderFrontmatter: content without frontmatter is untouched", () => {
  const body = "# Jobs\n\n[Designer](/jobs/1)";
  assertEquals(stripReaderFrontmatter(body), body);
});

Deno.test("extractScriptPayloads: parses JSON-LD JobPosting scripts", () => {
  const html = `<script type="application/ld+json">
    {
      "@type": "JobPosting",
      "title": "Lead UX Engineer",
      "url": "https://acme.io/jobs/101",
      "hiringOrganization": { "name": "Acme Corp" }
    }
  </script>`;
  const { links } = htmlToTextWithLinks(html, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/101");
});

Deno.test("extractScriptPayloads: parses Next.js App Router / framework script payloads", () => {
  const html = `<script>
    self.__next_f.push([1, "{\\"title\\":\\"Product Designer\\",\\"url\\":\\"https://acme.io/jobs/102\\",\\"company\\":\\"Acme\\"}"]);
  </script>`;
  const { links } = htmlToTextWithLinks(html, BASE);
  assertEquals(links.length, 1);
  assertEquals(links[0].href, "https://acme.io/jobs/102");
});
