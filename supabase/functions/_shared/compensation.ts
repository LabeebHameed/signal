// Compensation gate: a CONDITIONAL hard filter, run in the same pre-filter
// stage as the title-keyword and location gates.
//
// The asymmetry matters. Most postings never disclose pay, so an
// unconditional floor would reject the majority of genuinely good matches —
// that is why this gate only ever fires on a posting that actually states a
// number we can read confidently. Everything else (no pay shown, an
// unparseable string, a different currency, an hourly rate) passes straight
// through to the AI judge untouched.
//
// The rule is therefore: reject only when we can prove the posting pays less
// than the seeker's floor. Ambiguity always resolves in the posting's favour,
// because a wrongly-dropped job is invisible to the seeker while a wrongly-
// kept one costs them five seconds.

import type { CompCurrency, CompPeriod, FilterProfile, PostingVerdict } from "./types.ts";

const SYMBOL_CURRENCY: Record<string, CompCurrency> = {
  "$": "USD",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
};

const CODE_CURRENCY: Record<string, CompCurrency> = {
  usd: "USD",
  eur: "EUR",
  gbp: "GBP",
  inr: "INR",
};

export interface PostingPay {
  /** HIGHEST figure the posting states, normalized to a yearly amount — the
   * most this job could pay. Comparing the top of an advertised band is what
   * makes a rejection provable: "$90K – $200K" against a $120K floor might
   * well pay $150K, so only a band whose ceiling misses the floor is a
   * certainty. Comparing the bottom would reject that job on a guess. */
  maxPerYear: number;
  /** The currency we could identify, or null when the posting states none. */
  currency: CompCurrency | null;
}

/** Detect an hourly/daily/weekly rate. Those are not reliably convertible to a
 * salary (hours per week vary, contracts differ), so we refuse to guess. */
const SUB_MONTHLY = /\b(per\s+hour|an\s+hour|hourly|\/\s*hr|\/\s*hour|per\s+day|daily|\/\s*day|per\s+week|weekly|\/\s*wk|\/\s*week)\b/i;
const MONTHLY = /\b(per\s+month|a\s+month|monthly|\/\s*mo|\/\s*month|pm)\b/i;

function detectCurrency(text: string): CompCurrency | null {
  for (const [symbol, currency] of Object.entries(SYMBOL_CURRENCY)) {
    if (text.includes(symbol)) return currency;
  }
  const code = text.toLowerCase().match(/\b(usd|eur|gbp|inr)\b/);
  if (code) return CODE_CURRENCY[code[1]];
  return null;
}

/**
 * Read a posting's verbatim compensation string into a comparable yearly
 * figure. Returns null whenever the string can't be read with confidence —
 * that is the safe answer, and the caller lets the posting through.
 *
 * Handles the shapes real sources produce: "$150K - $200K", "€60,000/yr",
 * "₹12,00,000 per annum", "$120k+". Refuses hourly/daily/weekly rates.
 */
export function parsePostingPay(raw: string | null | undefined): PostingPay | null {
  const text = (raw ?? "").trim();
  if (text === "") return null;
  if (SUB_MONTHLY.test(text)) return null;

  const amounts: number[] = [];
  for (const match of text.matchAll(/(\d[\d,.]*)\s*([kKmM])?/g)) {
    // Indian grouping ("12,00,000") and Western ("1,200,000") both reduce to
    // digits once separators are dropped; a decimal point only survives when
    // it precedes a K/M suffix ("1.2M").
    const cleaned = match[1].replace(/,/g, "");
    const suffix = match[2]?.toLowerCase();
    const base = Number(suffix ? cleaned : cleaned.replace(/\.\d*$/, ""));
    if (!Number.isFinite(base) || base === 0) continue;
    const value = suffix === "k" ? base * 1_000 : suffix === "m" ? base * 1_000_000 : base;
    amounts.push(value);
  }
  if (amounts.length === 0) return null;

  const perMonth = MONTHLY.test(text);
  // A pay figure below this is almost certainly not a salary — a headcount, a
  // year, a percentage that slipped into the field. Refuse rather than guess.
  const floor = perMonth ? 100 : 1_000;
  const salaries = amounts.filter((n) => n >= floor);
  if (salaries.length === 0) return null;

  const highest = Math.max(...salaries);
  return {
    maxPerYear: perMonth ? highest * 12 : highest,
    currency: detectCurrency(text),
  };
}

/** The seeker's floor, normalized to a yearly figure — or null when they
 * haven't set one. */
export function profileFloorPerYear(profile: FilterProfile): number | null {
  const min = profile.compensation_min;
  if (typeof min !== "number" || !Number.isFinite(min) || min <= 0) return null;
  const period: CompPeriod = profile.compensation_period === "month" ? "month" : "year";
  return period === "month" ? min * 12 : min;
}

export interface CompensationDecision {
  ok: boolean;
  /** Set on a rejection: the most the posting could pay, and the floor it
   * still missed. */
  reason?: { postingPerYear: number; floorPerYear: number };
}

/**
 * Whether a posting survives the seeker's pay floor. Passes unless the posting
 * states a figure, in a comparable currency, provably below the floor.
 */
export function checkCompensation(
  compensation: string | null | undefined,
  profile: FilterProfile,
): CompensationDecision {
  const floorPerYear = profileFloorPerYear(profile);
  if (floorPerYear === null) return { ok: true }; // gate off

  const pay = parsePostingPay(compensation);
  if (pay === null) return { ok: true }; // undisclosed or unreadable — never disqualifying

  // Cross-currency comparison would need live FX rates we don't have, so a
  // posting priced in another currency simply isn't screened on pay. A
  // posting stating no currency is assumed to be quoting the seeker's own.
  const profileCurrency: CompCurrency = profile.compensation_currency ?? "USD";
  if (pay.currency !== null && pay.currency !== profileCurrency) return { ok: true };

  // Only a posting whose CEILING misses the floor is provably too low.
  if (pay.maxPerYear >= floorPerYear) return { ok: true };
  return { ok: false, reason: { postingPerYear: pay.maxPerYear, floorPerYear } };
}

/** Deterministic verdict recorded for a posting the pay gate rejected. */
export function compensationFilterVerdict(
  title: string,
  compensation: string | null | undefined,
  profile: FilterProfile,
): PostingVerdict {
  const stated = (compensation ?? "").trim();
  const target = (profile.compensation ?? "").trim() || "your stated floor";
  return {
    verdict: "mismatch",
    summary:
      `Held back before the AI judge: "${title}" states pay of ${stated}, below your target of ${target}.`,
    title_mismatch: null,
  };
}

/** Whether the seeker has declared a pay floor at all. */
export function compensationGateActive(profile: FilterProfile): boolean {
  return profileFloorPerYear(profile) !== null;
}
