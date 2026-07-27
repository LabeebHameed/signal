import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyVerification, pageTitleCandidates } from "./verify.ts";

const URL_ = "https://acme.io/jobs/senior-designer";

function check(overrides: Partial<Parameters<typeof classifyVerification>[0]>) {
  return classifyVerification({
    status: 200,
    body: "",
    requestedUrl: URL_,
    finalUrl: URL_,
    title: "Senior Designer",
    ...overrides,
  });
}

// --- HTTP status classification ------------------------------------------

Deno.test("classifyVerification: 404 -> dead", () => {
  const r = check({ status: 404 });
  assertEquals(r.verification, "dead");
});

Deno.test("classifyVerification: 410 -> dead", () => {
  const r = check({ status: 410 });
  assertEquals(r.verification, "dead");
});

Deno.test("classifyVerification: 403 -> indeterminate (a wall, not evidence the link is wrong)", () => {
  const r = check({ status: 403 });
  assertEquals(r.verification, "indeterminate");
});

Deno.test("classifyVerification: 401 -> indeterminate", () => {
  assertEquals(check({ status: 401 }).verification, "indeterminate");
});

Deno.test("classifyVerification: 429 -> indeterminate", () => {
  assertEquals(check({ status: 429 }).verification, "indeterminate");
});

Deno.test("classifyVerification: 500 -> indeterminate", () => {
  assertEquals(check({ status: 503 }).verification, "indeterminate");
});

Deno.test("classifyVerification: network error (status null) -> indeterminate", () => {
  const r = check({ status: null });
  assertEquals(r.verification, "indeterminate");
});

// --- 2xx content classification --------------------------------------------

Deno.test("classifyVerification: matching <title> -> verified", () => {
  const r = check({ body: "<html><head><title>Senior Designer at Acme</title></head><body>apply now</body></html>" });
  assertEquals(r.verification, "verified");
});

Deno.test("classifyVerification: matching og:title only -> verified", () => {
  const r = check({
    body:
      `<html><head><title>Careers</title><meta property="og:title" content="Senior Designer"></head><body>x</body></html>`,
  });
  assertEquals(r.verification, "verified");
});

Deno.test("classifyVerification: matching <h1> only -> verified", () => {
  const r = check({
    body: `<html><head><title>Careers - Acme</title></head><body><h1>Senior Designer</h1><p>Apply below</p></body></html>`,
  });
  assertEquals(r.verification, "verified");
});

Deno.test("classifyVerification: title present in the body text (not just head candidates) -> verified", () => {
  const filler = "Great benefits. ".repeat(60);
  const r = check({
    body: `<html><head><title>Careers - Acme</title></head><body><p>${filler}Senior Designer role details here.</p></body></html>`,
  });
  assertEquals(r.verification, "verified");
});

Deno.test("classifyVerification: a completely different job title -> mismatch", () => {
  const r = check({
    body: "<html><head><title>Warehouse Associate at Acme</title></head><body>forklift required</body></html>",
  });
  assertEquals(r.verification, "mismatch");
});

Deno.test("classifyVerification: 2xx but redirected to the homepage -> mismatch (soft-404)", () => {
  const r = check({
    finalUrl: "https://acme.io/",
    body: "<html><head><title>Acme - Careers</title></head><body>welcome</body></html>",
  });
  assertEquals(r.verification, "mismatch");
});

Deno.test("classifyVerification: 2xx but redirected to login -> mismatch", () => {
  const r = check({
    finalUrl: "https://acme.io/login",
    body: "<html><head><title>Sign in</title></head><body>x</body></html>",
  });
  assertEquals(r.verification, "mismatch");
});

Deno.test("classifyVerification: 2xx with a Cloudflare challenge body -> indeterminate, not mismatch", () => {
  const r = check({
    body: "<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing acme.io</body></html>",
  });
  assertEquals(r.verification, "indeterminate");
});

Deno.test("classifyVerification: 2xx empty JS shell -> indeterminate", () => {
  const r = check({ body: `<html><head></head><body><div id="root"></div></body></html>` });
  assertEquals(r.verification, "indeterminate");
});

Deno.test("classifyVerification: finalUrl captured only when it differs from requestedUrl", () => {
  const same = check({ finalUrl: URL_, body: "<title>Senior Designer</title>" });
  assertEquals(same.finalUrl, null);
  const different = check({
    finalUrl: "https://acme.io/jobs/senior-designer-2",
    body: "<title>Senior Designer</title>",
  });
  assertEquals(different.finalUrl, "https://acme.io/jobs/senior-designer-2");
});

// --- pageTitleCandidates ----------------------------------------------------

Deno.test("pageTitleCandidates: extracts title, og:title, and h1", () => {
  const html =
    `<html><head><title>Careers</title><meta property="og:title" content="Senior Designer"></head><body><h1>Apply: Senior Designer</h1></body></html>`;
  const candidates = pageTitleCandidates(html);
  assertEquals(candidates.includes("Careers"), true);
  assertEquals(candidates.includes("Senior Designer"), true);
  assertEquals(candidates.includes("Apply: Senior Designer"), true);
});

Deno.test("pageTitleCandidates: og:title with attributes in the other order", () => {
  const html = `<meta content="Senior Designer" property="og:title">`;
  assertEquals(pageTitleCandidates(html), ["Senior Designer"]);
});

Deno.test("pageTitleCandidates: strips nested markup from h1", () => {
  const html = `<h1><span>Senior</span> Designer</h1>`;
  assertEquals(pageTitleCandidates(html), ["Senior Designer"]);
});

Deno.test("pageTitleCandidates: returns empty array when nothing is present", () => {
  assertEquals(pageTitleCandidates("<div>no title here</div>"), []);
});
