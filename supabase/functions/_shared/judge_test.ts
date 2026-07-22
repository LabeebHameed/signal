import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { asVerdict } from "./judge.ts";

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
