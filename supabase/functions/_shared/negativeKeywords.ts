// Negative-keyword gate: an absolute override, independent of
// filter_profile/title_keywords — checked before anything else in
// screenPending, the same placement the old blocked-companies gate used to
// have. If any of the seeker's declared negative keywords appears anywhere
// in a posting's title, it's rejected outright, no LLM call spent.
//
// Case-insensitive substring match, not word-boundary — matches how the
// seeker is likely to think about it ("if the word appears in the title"),
// at the cost of catching a keyword inside a larger word (e.g. "AI" inside
// "Aiden"). Upgrade to word-boundary matching if that proves a real problem.

import type { PostingVerdict } from "./types.ts";

/** Parse the seeker's negative-keywords box (newline- or comma-separated
 * free text, mirroring the old blocked-companies textarea convention) into
 * lowercase, trimmed keywords. */
export function parseNegativeKeywords(raw: string): string[] {
  return raw.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
}

/** The first declared negative keyword found anywhere in the title, or null. */
export function matchesNegativeKeyword(title: string, negativeKeywords: string[]): string | null {
  if (negativeKeywords.length === 0) return null;
  const t = title.toLowerCase();
  return negativeKeywords.find((k) => t.includes(k)) ?? null;
}

/** Deterministic verdict recorded for a posting the negative-keyword gate
 * rejected — the caller stores this directly, no LLM call spent. */
export function negativeKeywordVerdict(title: string, keyword: string): PostingVerdict {
  return {
    verdict: "mismatch",
    summary: `Held back before the AI judge: "${title}" contains the blocked keyword "${keyword}".`,
    title_mismatch: `Title contains the blocked keyword "${keyword}".`,
  };
}
