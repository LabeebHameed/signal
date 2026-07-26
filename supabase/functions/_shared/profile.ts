// One-step profile: turn the user's single "what are you looking for"
// statement into the three title-screening fields the judge reads (roles,
// role_synonyms, title_keywords). Locations and compensation are always
// user-entered directly on the Profile page — the statement never touches
// them. The one deliberate expansion is role_synonyms: equivalent/adjacent
// job titles, because companies name the same work differently and the
// profile must not pin the judge to the user's exact wording.

import type { FilterProfile, RuntimeConfig } from "./types.ts";
import { GENERATED_PROFILE_KEYS } from "./types.ts";
import { llmJson } from "./llm.ts";

type GeneratedProfile = Pick<FilterProfile, "roles" | "role_synonyms" | "title_keywords">;

// Every generated key as a required string; "" means "unstated". Required-all
// + additionalProperties:false keeps strict structured output happy on both
// provider paths.
const PROFILE_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(GENERATED_PROFILE_KEYS.map((key) => [key, { type: "string" }])),
  required: [...GENERATED_PROFILE_KEYS],
  additionalProperties: false,
} as const;

const EXPAND_SYSTEM_PROMPT =
  `You convert one short statement from a job seeker into a structured title-screening profile — postings are judged by their TITLE alone, there is no job description. The statement is everything they chose to say — treat it as complete.

Rules:
- Fill a field ONLY when the statement states it or clearly implies it. An unstated field must be an empty string "" — the downstream judge simply ignores it. Never invent anything the seeker did not express.
- roles: the target role, close to the seeker's own words.
- role_synonyms: 6–12 job titles that describe the SAME or closely adjacent work, comma-separated. Companies name identical jobs differently ("UI/UX Designer" ≈ "UX Engineer" ≈ "Product Designer" ≈ "User Experience Designer" ≈ "Interaction Designer"), so include both equivalent and adjacent titles. This is a field where you must expand beyond the statement's words. Always fill it when roles is filled; leave it "" when roles is "". This list is used downstream as a strict scope boundary — do NOT include a broader, multi-discipline role (e.g. "Full Stack Engineer" for a front-end-only statement) or a role from a different discipline, unless the statement itself signals openness to that breadth (e.g. "I'd also do full-stack work"). When in doubt, prefer a narrower, more precise list over a broader one.
- title_keywords: 4–8 short discipline WORDS or short phrases (not full job titles, unlike role_synonyms), comma-separated, naming the actual domain of work the target role sits in — e.g. for "Design engineer" that's "design, UI, UX, design systems, front-end" (never anything not implied by the statement). This is used as a hard pre-filter, before the AI judge ever runs: a posting whose title contains NONE of these words is rejected outright, no LLM call spent. Keep it precise but not so narrow it excludes real equivalents — every phrase in role_synonyms should contain at least one of these words. Always fill it when roles is filled; leave it "" when roles is "".
- Never output a location or compensation preference — those are set by the seeker directly, not derived from the statement.

Example — statement: "I'm good at design and I want to be a design engineer"
→ roles: "Design engineer"
→ role_synonyms: "Design Engineer, UX Engineer, Design Technologist, Creative Technologist, UI Engineer, Front-end Designer, Design Systems Engineer, Product Designer (technical)"
→ title_keywords: "design, UI, UX, design systems, front-end"

Respond with JSON only: an object with exactly these keys, all strings: ${GENERATED_PROFILE_KEYS.join(", ")}.`;

/** Keep known keys with non-empty trimmed string values only (same tolerant
 * validation style as validatePostings / the settings PUT sanitizer). */
function validateProfile(parsed: unknown): GeneratedProfile {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("profile expansion response is not an object");
  }
  const raw = parsed as Record<string, unknown>;
  const profile: GeneratedProfile = {};
  for (const key of GENERATED_PROFILE_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "") profile[key] = value.trim();
  }
  return profile;
}

/** Expand the seeker's one-sentence statement into roles/role_synonyms/
 * title_keywords. Does not persist anything — the caller merges the result
 * into the current profile (preserving locations/compensation) and saves via
 * the normal settings path. */
export async function expandProfile(statement: string, runtime: RuntimeConfig): Promise<GeneratedProfile> {
  const parsed = await llmJson(runtime, {
    system: EXPAND_SYSTEM_PROMPT,
    user: `THE SEEKER SAYS:\n${statement.trim()}`,
    schema: PROFILE_SCHEMA,
    schemaName: "profile",
  });
  return validateProfile(parsed);
}
