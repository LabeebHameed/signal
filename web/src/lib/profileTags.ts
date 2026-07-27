// The Profile page edits lists as discrete tags, but the profile is stored —
// and screened — as delimited strings. These helpers are the single crossing
// point between those two shapes, plus the best-effort readers that turn a
// profile written before the structured fields existed into something the tag
// UI can show without losing anything the seeker typed.

import {
  COMP_CURRENCIES,
  COMP_PERIODS,
  CompCurrency,
  CompPeriod,
  FilterProfile,
  TAGGED_PROFILE_KEYS,
  TaggedProfileKey,
} from "../api";

/** The delimiters a stored profile string may use. Kept identical to the
 * backend's splitters (functions/_shared/judge.ts) — when the two disagree, a
 * value renders as two tags in the UI and gates as one keyword downstream. */
const TAG_DELIMITERS = /[,;\n]/;

export function splitToTags(str?: string): string[] {
  if (!str) return [];
  return str.split(TAG_DELIMITERS).map((s) => s.trim()).filter(Boolean);
}

/** Tags are stored comma-separated. A tag can therefore never contain a comma
 * — the tag input enforces that by treating "," as a commit key. */
export function joinTags(tags: string[]): string {
  return tags.join(", ");
}

/** Case- and whitespace-insensitive identity, so "UX Engineer" and
 * "ux  engineer" are the same tag for duplicate detection. */
export function tagKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Strip commas (the commit key) and collapse whitespace. Returns "" for a
 * value that was only punctuation. */
export function normalizeTag(value: string): string {
  return value.replace(/,/g, " ").trim().replace(/\s+/g, " ");
}

export function tagsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------- AI / user provenance ----------

/** The AI-authored values for one tagged field. */
export function aiValuesFor(profile: FilterProfile, key: TaggedProfileKey): string[] {
  return profile.ai_generated?.[key] ?? [];
}

/** True when this exact value is still one the LLM produced. Any hand-edit
 * changes the value, which drops it out of the set — that colour change is
 * how the seeker sees they now own it. */
export function isAiValue(aiValues: string[], value: string): boolean {
  const key = tagKey(value);
  return aiValues.some((v) => tagKey(v) === key);
}

/** Record a fresh expansion's output as AI-authored, replacing whatever the
 * previous generation claimed for those fields. */
export function markGenerated(
  profile: FilterProfile,
  generated: Partial<Record<TaggedProfileKey, string>>,
): FilterProfile["ai_generated"] {
  const next: NonNullable<FilterProfile["ai_generated"]> = { ...(profile.ai_generated ?? {}) };
  for (const key of TAGGED_PROFILE_KEYS) {
    const value = generated[key];
    if (value === undefined) continue;
    const tags = splitToTags(value);
    if (tags.length > 0) next[key] = tags;
    else delete next[key];
  }
  return next;
}

/** Drop provenance entries whose value is no longer in the field — otherwise
 * a deleted-then-retyped tag would silently come back coloured as AI's. */
export function pruneProvenance(profile: FilterProfile): FilterProfile["ai_generated"] | undefined {
  const source = profile.ai_generated;
  if (!source) return undefined;
  const next: NonNullable<FilterProfile["ai_generated"]> = {};
  for (const key of TAGGED_PROFILE_KEYS) {
    const claimed = source[key];
    if (!claimed || claimed.length === 0) continue;
    const present = new Set(splitToTags(profile[key]).map(tagKey));
    const kept = claimed.filter((v) => present.has(tagKey(v)));
    if (kept.length > 0) next[key] = kept;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Whether any tag on the profile is AI-authored — drives whether the view
 * card bothers showing a colour legend at all. */
export function hasAiTags(profile: FilterProfile): boolean {
  return TAGGED_PROFILE_KEYS.some((key) => {
    const claimed = aiValuesFor(profile, key);
    if (claimed.length === 0) return false;
    const present = new Set(splitToTags(profile[key]).map(tagKey));
    return claimed.some((v) => present.has(tagKey(v)));
  });
}

// ---------- Locations ----------

export interface LocationPrefs {
  include: string[];
  exclude: string[];
}

export function readLocations(profile: FilterProfile): LocationPrefs {
  const include = profile.locations_include;
  const exclude = profile.locations_exclude;
  // Structured fields win whenever either is present, even if one is empty —
  // an empty include list is a real choice, not missing data.
  if (Array.isArray(include) || Array.isArray(exclude)) {
    return { include: include ?? [], exclude: exclude ?? [] };
  }
  return { include: parseLegacyLocations(profile.locations), exclude: [] };
}

/**
 * Read a profile saved before include/exclude existed. Those values were one
 * sentence built by the old Work Model radio group — "Remote", "India",
 * "Remote or India" — so the readable pieces become include tags. Anything
 * this doesn't recognize is kept whole as a single tag rather than dropped:
 * a preference the seeker can see and fix beats one that silently vanished.
 */
export function parseLegacyLocations(value?: string): string[] {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return [];
  const both = trimmed.match(/^remote or (.+)$/i);
  if (both) return ["Remote", ...splitToTags(both[1])];
  return splitToTags(trimmed);
}

/** The prose form the judge reads, e.g. "Only: Remote, Germany. Never:
 * United States." Empty when no preference is set. */
export function serializeLocations(prefs: LocationPrefs): string {
  const parts: string[] = [];
  if (prefs.include.length > 0) parts.push(`Only: ${prefs.include.join(", ")}`);
  if (prefs.exclude.length > 0) parts.push(`Never: ${prefs.exclude.join(", ")}`);
  return parts.join(". ");
}

// ---------- Compensation ----------

export interface CompPrefs {
  min?: number;
  max?: number;
  currency: CompCurrency;
  period: CompPeriod;
}

export const DEFAULT_COMP: CompPrefs = { currency: "USD", period: "year" };

export function readCompensation(profile: FilterProfile): CompPrefs {
  const currency = COMP_CURRENCIES.includes(profile.compensation_currency as CompCurrency)
    ? (profile.compensation_currency as CompCurrency)
    : DEFAULT_COMP.currency;
  const period = COMP_PERIODS.includes(profile.compensation_period as CompPeriod)
    ? (profile.compensation_period as CompPeriod)
    : DEFAULT_COMP.period;
  if (typeof profile.compensation_min === "number" || typeof profile.compensation_max === "number") {
    return { min: profile.compensation_min, max: profile.compensation_max, currency, period };
  }
  return { ...parseLegacyCompensation(profile.compensation), currency, period };
}

/**
 * Pull numbers out of a profile's old free-text pay box ("≥ $120k / yr",
 * "$120,000 - $160,000"). Only the shapes we can read confidently produce a
 * range; anything else yields no bounds, and the seeker retypes it — which is
 * safer than guessing a floor that would start rejecting postings.
 */
export function parseLegacyCompensation(value?: string): { min?: number; max?: number } {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return {};
  const amounts: number[] = [];
  const pattern = /(\d[\d,.]*)\s*([kKmM])?/g;
  for (const match of trimmed.matchAll(pattern)) {
    const digits = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(digits) || digits === 0) continue;
    const suffix = match[2]?.toLowerCase();
    amounts.push(suffix === "k" ? digits * 1_000 : suffix === "m" ? digits * 1_000_000 : digits);
  }
  // A bare year ("2024 target") or a lone small number isn't a salary.
  const salaries = amounts.filter((n) => n >= 1_000);
  if (salaries.length === 0) return {};
  if (salaries.length === 1) return { min: salaries[0] };
  return { min: Math.min(...salaries), max: Math.max(...salaries) };
}
