// Location gate: the seeker's include/exclude lists, enforced deterministically
// in the same pre-filter stage as the title-keyword gate (see poll-pages
// screenPending) rather than left to the AI judge's prose reasoning.
//
// The two lists are not symmetric, and deliberately so:
//   - exclude is absolute. A posting stating an excluded place is rejected
//     even when it also matches an include entry ("Remote — US only" against
//     include:Remote / exclude:United States is a job the seeker cannot take).
//   - include tolerates silence. A posting with no location at all passes,
//     because most sources simply don't publish one and treating that as a
//     rejection would throw away the majority of real matches. This mirrors
//     the judge's own standing rule that missing information is never
//     disqualifying.
//
// Matching is case-insensitive normalized substring, the same shape as
// negativeKeywords.ts — "Germany" matches "Berlin, Germany" and "germany
// (remote)". It is not geographic reasoning: "EU" will not match "France".
// The seeker sees exactly the strings they typed, so a miss is legible and
// fixable rather than mysterious.

import type { FilterProfile, PostingVerdict } from "./types.ts";

/**
 * Lowercase and separator-collapsed, so "U.S.A." and "usa" compare equal
 * while "New York" stays two words.
 *
 * Periods and apostrophes are stripped rather than turned into spaces —
 * they're intra-word punctuation ("U.S.A." is one word, "Côte d'Ivoire" is
 * two), and treating them as separators would turn "U.S.A." into "u s a",
 * which no longer contains "usa". Everything else non-alphanumeric is a real
 * separator.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s !== "");
}

export interface LocationDecision {
  ok: boolean;
  /** The include/exclude entry that decided a rejection. */
  reason?: { kind: "excluded" | "not-included"; term?: string };
}

/**
 * Whether a posting's location survives the seeker's location preferences.
 * `location` is the posting's own field — null/empty means undisclosed.
 */
export function checkLocation(
  location: string | null | undefined,
  profile: FilterProfile,
): LocationDecision {
  const include = cleanList(profile.locations_include);
  const exclude = cleanList(profile.locations_exclude);
  if (include.length === 0 && exclude.length === 0) return { ok: true }; // gate off

  const raw = (location ?? "").trim();
  const normalized = normalize(raw);

  // Undisclosed location: nothing to exclude on, and include tolerates it.
  if (normalized === "") return { ok: true };

  const blocked = exclude.find((term) => normalized.includes(normalize(term)));
  if (blocked !== undefined) return { ok: false, reason: { kind: "excluded", term: blocked } };

  if (include.length === 0) return { ok: true };
  const allowed = include.some((term) => normalized.includes(normalize(term)));
  if (allowed) return { ok: true };
  return { ok: false, reason: { kind: "not-included" } };
}

/** Deterministic verdict recorded for a posting the location gate rejected —
 * stored directly by the caller, no LLM call spent. */
export function locationFilterVerdict(
  title: string,
  location: string | null | undefined,
  profile: FilterProfile,
  reason: NonNullable<LocationDecision["reason"]>,
): PostingVerdict {
  const shown = (location ?? "").trim() || "unstated";
  if (reason.kind === "excluded") {
    return {
      verdict: "mismatch",
      summary:
        `Held back before the AI judge: "${title}" is in ${shown}, which matches your excluded location ` +
        `"${reason.term}".`,
      title_mismatch: null,
    };
  }
  const include = cleanList(profile.locations_include).join(", ");
  return {
    verdict: "mismatch",
    summary:
      `Held back before the AI judge: "${title}" is in ${shown}, which isn't one of your included locations ` +
      `(${include}).`,
    title_mismatch: null,
  };
}

/** Whether the seeker has declared any location preference at all. */
export function locationGateActive(profile: FilterProfile): boolean {
  return cleanList(profile.locations_include).length > 0 ||
    cleanList(profile.locations_exclude).length > 0;
}
