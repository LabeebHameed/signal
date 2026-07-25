import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyThinPostingBackstop, asVerdict, isThinPosting, titleWithinDeclaredScope } from "./judge.ts";
import type { FilterProfile, PostingVerdict } from "./types.ts";

Deno.test("asVerdict forces mismatch when title_mismatch is set, even with a high score", () => {
  const result = asVerdict(
    {
      id: 0,
      verdict: "match",
      score: 85,
      summary: "Great stack fit.",
      dealbreaker: null,
      title_mismatch: "Full Stack Engineer is broader than the target Front-End Developer role",
      dimensions: [],
    },
    1,
  );
  assertEquals(result?.verdict.verdict, "mismatch");
  assertEquals(result?.verdict.title_mismatch, "Full Stack Engineer is broader than the target Front-End Developer role");
  // Score itself is left as the model reported it — only the verdict is forced.
  assertEquals(result?.verdict.score, 85);
});

Deno.test("asVerdict leaves the model's verdict untouched when title_mismatch is null", () => {
  const result = asVerdict(
    {
      id: 0,
      verdict: "borderline",
      score: 60,
      summary: "Partial fit.",
      dealbreaker: null,
      title_mismatch: null,
      dimensions: [],
    },
    1,
  );
  assertEquals(result?.verdict.verdict, "borderline");
  assertEquals(result?.verdict.title_mismatch, null);
});

Deno.test("asVerdict treats 'none'/'n/a' title_mismatch strings as null (tolerant parsing, same as dealbreaker)", () => {
  const result = asVerdict(
    {
      id: 0,
      verdict: "match",
      score: 90,
      summary: "Strong fit.",
      dealbreaker: null,
      title_mismatch: "none",
      dimensions: [],
    },
    1,
  );
  assertEquals(result?.verdict.verdict, "match");
  assertEquals(result?.verdict.title_mismatch, null);
});

Deno.test("asVerdict: dealbreaker still wins over title_mismatch precedence-wise (both force mismatch either way)", () => {
  const result = asVerdict(
    {
      id: 0,
      verdict: "match",
      score: 95,
      summary: "Looks great otherwise.",
      dealbreaker: "requires relocation",
      title_mismatch: "Backend Engineer is a different role than the target Front-End Developer role",
      dimensions: [],
    },
    1,
  );
  assertEquals(result?.verdict.verdict, "mismatch");
  assertEquals(result?.verdict.dealbreaker, "requires relocation");
  assertEquals(result?.verdict.title_mismatch, "Backend Engineer is a different role than the target Front-End Developer role");
});

const PROFILE: FilterProfile = {
  roles: "Design engineer",
  role_synonyms: "Design Engineer, UX Engineer, UI Engineer, Design Technologist",
};

function matchVerdict(): PostingVerdict {
  return {
    verdict: "match",
    score: 80,
    summary: "Looks great.",
    dealbreaker: null,
    title_mismatch: null,
    dimensions: [],
  };
}

Deno.test("isThinPosting: true only when company, location, and compensation are all absent", () => {
  assertEquals(isThinPosting({ title: "AI Data Engineer" }), true);
  assertEquals(isThinPosting({ title: "AI Data Engineer", company: "Acme" }), false);
  assertEquals(isThinPosting({ title: "AI Data Engineer", location: "Remote" }), false);
  assertEquals(isThinPosting({ title: "AI Data Engineer", compensation: "$100k" }), false);
});

Deno.test("titleWithinDeclaredScope: rejects a different discipline (reproduces the Himalayas RSS incident)", () => {
  assertEquals(titleWithinDeclaredScope("AI Data Engineer", PROFILE), false);
  assertEquals(titleWithinDeclaredScope("Salesforce Consultant - Remote", PROFILE), false);
  assertEquals(titleWithinDeclaredScope("Business Analyst (Product-Focused)", PROFILE), false);
});

Deno.test("titleWithinDeclaredScope: accepts the target role, an equivalent, and seniority-qualified variants", () => {
  assertEquals(titleWithinDeclaredScope("Design Engineer", PROFILE), true);
  assertEquals(titleWithinDeclaredScope("Senior UI Engineer", PROFILE), true);
  assertEquals(titleWithinDeclaredScope("UX Engineer II", PROFILE), true);
});

Deno.test("titleWithinDeclaredScope: an empty profile declares no scope, so nothing is rejected", () => {
  assertEquals(titleWithinDeclaredScope("AI Data Engineer", {}), true);
});

Deno.test("applyThinPostingBackstop: forces mismatch for a thin posting whose title is out of scope", () => {
  const result = applyThinPostingBackstop(matchVerdict(), { title: "AI Data Engineer" }, PROFILE);
  assertEquals(result.verdict, "mismatch");
  assertEquals(result.title_mismatch !== null, true);
});

Deno.test("applyThinPostingBackstop: leaves a thin posting alone when its title is in scope", () => {
  const result = applyThinPostingBackstop(matchVerdict(), { title: "Senior Design Engineer" }, PROFILE);
  assertEquals(result.verdict, "match");
  assertEquals(result.title_mismatch, null);
});

Deno.test("applyThinPostingBackstop: never touches a posting with company/location/compensation, even off-scope", () => {
  const result = applyThinPostingBackstop(
    matchVerdict(),
    { title: "AI Data Engineer", company: "Acme" },
    PROFILE,
  );
  assertEquals(result.verdict, "match");
  assertEquals(result.title_mismatch, null);
});

Deno.test("applyThinPostingBackstop: does not double-flag when the model already set title_mismatch", () => {
  const verdict = matchVerdict();
  verdict.title_mismatch = "already caught upstream";
  const result = applyThinPostingBackstop(verdict, { title: "AI Data Engineer" }, PROFILE);
  assertEquals(result, verdict);
});
