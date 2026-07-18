// One-step profile: turn the user's single "what are you looking for"
// statement into the structured FilterProfile the judge screens against.
// The statement is treated as complete — dimensions it doesn't speak to are
// left empty (= open, no preference), never invented. The one deliberate
// expansion is role_synonyms: equivalent/adjacent job titles, because
// companies name the same work differently and the profile must not pin the
// judge to the user's exact wording.

import type { FilterProfile, RuntimeConfig } from "./types.ts";
import { FILTER_PROFILE_KEYS } from "./types.ts";
import { llmJson } from "./llm.ts";

// Every profile key as a required string; "" means "unstated". Required-all +
// additionalProperties:false keeps strict structured output happy on both
// provider paths.
const PROFILE_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(FILTER_PROFILE_KEYS.map((key) => [key, { type: "string" }])),
  required: [...FILTER_PROFILE_KEYS],
  additionalProperties: false,
} as const;

const EXPAND_SYSTEM_PROMPT = `You convert one short statement from a job seeker into a structured search profile used to screen job postings for them. The statement is everything they chose to say — treat it as complete.

Rules:
- Fill a dimension ONLY when the statement states it or clearly implies it. Every unstated dimension must be an empty string "". An empty dimension means "open — no preference"; the downstream judge simply ignores it. Never invent seniority, locations, compensation, company preferences, must-haves, or dealbreakers the seeker did not express.
- roles: the target role(s), close to the seeker's own words.
- role_synonyms: 6–12 job titles that describe the SAME or closely adjacent work, comma-separated. Companies name identical jobs differently ("UI/UX Designer" ≈ "UX Engineer" ≈ "Product Designer" ≈ "User Experience Designer" ≈ "Interaction Designer"), so include both equivalent and adjacent titles. This is the ONE field where you must expand beyond the statement's words. Always fill it when roles is filled; leave it "" when roles is "".
- skills: skills or strengths they claim ("I'm good at design" → design).
- dealbreakers: only explicit exclusions ("no X", "not willing to Y", "don't want Z").
- context: background facts from the statement worth telling the judge (experience, self-description) — not restatements of other fields.

Example — statement: "I'm good at design and I want to be a design engineer"
→ roles: "Design engineer"
→ role_synonyms: "Design Engineer, UX Engineer, Design Technologist, Creative Technologist, UI Engineer, Front-end Designer, Design Systems Engineer, Product Designer (technical)"
→ skills: "design"
→ context: "Strong design background"
→ every other field: ""

Respond with JSON only: an object with exactly these keys, all strings: ${FILTER_PROFILE_KEYS.join(", ")}.`;

/** Keep known keys with non-empty trimmed string values only (same tolerant
 * validation style as validatePostings / the settings PUT sanitizer). */
function validateProfile(parsed: unknown): FilterProfile {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("profile expansion response is not an object");
  }
  const raw = parsed as Record<string, unknown>;
  const profile: FilterProfile = {};
  for (const key of FILTER_PROFILE_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "") profile[key] = value.trim();
  }
  return profile;
}

/** Expand the seeker's one-sentence statement into a FilterProfile. Does not
 * persist anything — the caller previews/saves via the normal settings path. */
export async function expandProfile(statement: string, runtime: RuntimeConfig): Promise<FilterProfile> {
  const parsed = await llmJson(runtime, {
    system: EXPAND_SYSTEM_PROMPT,
    user: `THE SEEKER SAYS:\n${statement.trim()}`,
    schema: PROFILE_SCHEMA,
    schemaName: "profile",
  });
  return validateProfile(parsed);
}
