// LLM-based qualification: judge extracted postings against the user's job
// profile the way a person deciding "is this worth my time?" would — role
// semantics, seniority, location/remote compatibility, skills, company
// traits, compensation, must-haves and dealbreakers — not keyword matching.
//
// One call screens a whole batch of postings. Each verdict carries a full
// per-dimension breakdown plus a human-readable summary so every decision
// is auditable in the UI (and quoted in the Telegram message for matches).

import type { FilterProfile, PostingVerdict, RuntimeConfig, VerdictDimension } from "./types.ts";
import { FILTER_PROFILE_KEYS } from "./types.ts";
import { llmJson } from "./llm.ts";

/** The posting fields the judge sees (a subset of a postings row). */
export interface ScreenablePosting {
  title: string;
  url?: string | null;
  company?: string | null;
  location?: string | null;
  posted_at?: string | null;
  posted_text?: string | null;
}

const PROFILE_LABELS: Record<keyof FilterProfile, string> = {
  roles: "Target roles",
  role_synonyms: "Equivalent / adjacent titles (treat as the target role)",
  seniority: "Seniority",
  locations: "Locations / remote",
  skills: "Skills & stack",
  company_prefs: "Company preferences",
  compensation: "Compensation",
  must_haves: "Must-haves (hard requirements)",
  nice_to_haves: "Nice-to-haves",
  dealbreakers: "Dealbreakers (auto-reject)",
  context: "About the seeker (background / extra context)",
};

/** An entirely empty profile means there is nothing to judge against —
 * filtering is effectively off no matter what filter_mode says. */
export function profileHasContent(profile: FilterProfile): boolean {
  return FILTER_PROFILE_KEYS.some((key) => (profile[key] ?? "").trim() !== "");
}

const VERDICT_KINDS = ["match", "borderline", "mismatch"] as const;
const DIMENSION_FITS = ["strong", "partial", "mismatch", "unknown"] as const;
const DIMENSION_NAMES = [
  "role",
  "seniority",
  "location",
  "skills",
  "company",
  "compensation",
  "requirements",
  "other",
] as const;

const VERDICTS_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          verdict: { type: "string", enum: VERDICT_KINDS },
          score: { type: "integer", minimum: 0, maximum: 100 },
          summary: { type: "string" },
          dealbreaker: { type: ["string", "null"] },
          dimensions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", enum: DIMENSION_NAMES },
                fit: { type: "string", enum: DIMENSION_FITS },
                note: { type: "string" },
              },
              required: ["name", "fit", "note"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "verdict", "score", "summary", "dealbreaker", "dimensions"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

const JUDGE_SYSTEM_PROMPT = `You screen job postings for one job seeker. For each posting, decide whether it deserves to interrupt them with a notification — the judgment a sharp human assistant who knows their preferences well would make, never keyword matching.

Weigh every dimension the profile speaks to:
- role: is the actual work behind the title what they want? Read titles the way an industry insider would ("Member of Technical Staff" is usually a software engineer; "Solutions Engineer" is usually pre-sales, not product engineering). Synonymous or adjacent titles can still be strong fits. When the profile lists equivalent/adjacent titles, a posting whose title matches any of them in meaning — not exact wording — is the target role; never require the profile's literal phrasing.
- seniority: infer the level from the title and any cues (junior/senior/staff/lead/intern, "5+ years") and compare with what they target.
- location: could they actually work this job given their location and remote constraints? "Remote" with a region restriction only counts if the restriction is compatible.
- skills: does the stated stack or domain line up with theirs?
- company: employer type, stage, and industry versus their stated preferences.
- compensation: only when the posting shows pay — compare against their expectation.
- requirements: their must-haves and nice-to-haves. A posting that clearly violates a must-have cannot be a "match".

Rules:
- Missing information is neutral, never disqualifying. Many postings are just a title and a location. Mark dimensions the posting says nothing about as "unknown" and judge on what is visible. Use "mismatch" only when the posting actively contradicts the profile.
- Dealbreakers are absolute: if one clearly applies, the verdict is "mismatch" no matter how good the rest looks, and "dealbreaker" names which one in a short phrase. Otherwise "dealbreaker" is null. Do not stretch dealbreakers to cover ambiguous cases — an unclear situation is not a dealbreaker.
- Verdicts: "match" — you would confidently interrupt them: the visible evidence fits and nothing contradicts. "borderline" — plausibly right but genuinely uncertain: thin information, partial fit, or a stretch on one dimension. "mismatch" — someone with this profile would not thank you for this notification.
- score: overall fit 0–100 given the evidence (100 = ideal, 50 = coin flip, 0 = unrelated). Score and verdict must agree.
- summary: one or two plain sentences naming the decisive factors. The seeker reads this to trust — or correct — the decision, so be concrete, not generic.
- dimensions: include an entry for each dimension the profile expresses a preference about; skip dimensions the profile never mentions. Keep notes short.

Judge each posting independently, using its [id]. Respond with JSON only:
{"verdicts": [{"id": 0, "verdict": "match", "score": 85, "summary": "...", "dealbreaker": null, "dimensions": [{"name": "role", "fit": "strong", "note": "..."}]}]}
Return exactly one entry per posting.`;

function renderProfile(profile: FilterProfile): string {
  const lines: string[] = [];
  for (const key of FILTER_PROFILE_KEYS) {
    const value = (profile[key] ?? "").trim();
    if (value !== "") lines.push(`${PROFILE_LABELS[key]}: ${value}`);
  }
  return lines.join("\n");
}

function renderPosting(p: ScreenablePosting, id: number): string {
  const lines = [`[${id}]`, `Title: ${p.title}`];
  if (p.company) lines.push(`Company: ${p.company}`);
  if (p.location) lines.push(`Location: ${p.location}`);
  if (p.url) lines.push(`URL: ${p.url}`);
  const posted = p.posted_text || p.posted_at;
  if (posted) lines.push(`Posted: ${posted}`);
  return lines.join("\n");
}

function asVerdict(item: unknown, count: number): { id: number; verdict: PostingVerdict } | null {
  if (typeof item !== "object" || item === null) return null;
  const v = item as Record<string, unknown>;
  if (typeof v.id !== "number" || !Number.isInteger(v.id) || v.id < 0 || v.id >= count) return null;
  if (typeof v.verdict !== "string" || !(VERDICT_KINDS as readonly string[]).includes(v.verdict)) return null;
  const score = typeof v.score === "number" && Number.isFinite(v.score)
    ? Math.min(100, Math.max(0, Math.round(v.score)))
    : 0;
  const dealbreakerRaw = typeof v.dealbreaker === "string" ? v.dealbreaker.trim() : "";
  const dealbreaker = dealbreakerRaw !== "" && !/^(null|none|n\/a)$/i.test(dealbreakerRaw) ? dealbreakerRaw : null;
  const dimensions: VerdictDimension[] = [];
  if (Array.isArray(v.dimensions)) {
    for (const d of v.dimensions) {
      if (typeof d !== "object" || d === null) continue;
      const dim = d as Record<string, unknown>;
      if (typeof dim.name !== "string" || dim.name.trim() === "") continue;
      if (typeof dim.fit !== "string" || !(DIMENSION_FITS as readonly string[]).includes(dim.fit)) continue;
      dimensions.push({
        name: dim.name.trim(),
        fit: dim.fit as VerdictDimension["fit"],
        note: typeof dim.note === "string" ? dim.note.trim() : "",
      });
    }
  }
  return {
    id: v.id,
    verdict: {
      // A named dealbreaker forces a mismatch even if the model's verdict
      // field disagrees — the two must never contradict in stored data.
      verdict: dealbreaker !== null ? "mismatch" : (v.verdict as PostingVerdict["verdict"]),
      score,
      summary: typeof v.summary === "string" ? v.summary.trim() : "",
      dealbreaker,
      dimensions,
    },
  };
}

/**
 * Judge a batch of postings against the profile in one LLM call.
 *
 * Returns verdicts keyed by each posting's index in the input array. A
 * posting the model failed to return a (valid) verdict for is simply absent
 * from the map — the caller leaves it queued for the next screening pass.
 */
export async function judgePostings(
  postings: ScreenablePosting[],
  profile: FilterProfile,
  pageLabel: string,
  runtime: RuntimeConfig,
): Promise<Map<number, PostingVerdict>> {
  const user = [
    `THE SEEKER'S PROFILE:\n${renderProfile(profile)}`,
    `POSTINGS (found on "${pageLabel}"):\n\n${postings.map(renderPosting).join("\n\n")}`,
  ].join("\n\n");

  const parsed = await llmJson(runtime, {
    system: JUDGE_SYSTEM_PROMPT,
    user,
    schema: VERDICTS_SCHEMA,
    schemaName: "verdicts",
  });

  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { verdicts?: unknown }).verdicts)) {
    throw new Error("judge response is not of shape {verdicts: [...]}");
  }
  const out = new Map<number, PostingVerdict>();
  for (const item of (parsed as { verdicts: unknown[] }).verdicts) {
    const entry = asVerdict(item, postings.length);
    if (entry && !out.has(entry.id)) out.set(entry.id, entry.verdict);
  }
  return out;
}
