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
  compensation?: string | null;
}

/** Recent seeker feedback (postings.user_status), most-recent first — used
 * to calibrate borderline judgment calls without overriding the profile. */
export interface JudgeCalibration {
  interested: string[];
  notInterested: string[];
}

const PROFILE_LABELS: Record<keyof FilterProfile, string> = {
  roles: "Target roles",
  role_synonyms: "Equivalent / adjacent titles (treat as the target role)",
  title_keywords: "Core discipline keywords (the actual domain of work)",
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
          title_mismatch: { type: ["string", "null"] },
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
        required: ["id", "verdict", "score", "summary", "dealbreaker", "title_mismatch", "dimensions"],
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
- title scope (separate from the role dimension above, and a hard boundary — see the "title_mismatch" field below): when the profile states a target role, a posting is IN scope only if its title is the target role itself, one of the profile's listed equivalent/adjacent titles (in meaning), or a seniority/level-qualified variant of either (e.g. Senior/Staff/Principal/Lead/Sr./Jr./II/III/Intern/Associate + the base title, or a team/product qualifier that doesn't change the discipline, like "Front-End Engineer, Growth"). A posting is OUT of scope when its title names a different or broader discipline than the target and its equivalents — a shared generic word like "Engineer" or "Developer" is never enough by itself to put it in scope. Worked example: target role "Front-End Developer" with equivalents like "UI Engineer"/"Design Engineer" — a posting titled "Full Stack Engineer" is OUT of scope (broader role) even though it contains "Engineer"; "Senior Front-End Engineer" or "UI Engineer II" ARE in scope (same role, just a seniority variant). The same logic applies to any other named-different-role trap: "Backend Engineer", "DevOps Engineer", "Mobile Engineer", "Data Engineer", "QA Engineer", "Solutions Engineer", "Engineering Manager" are all out of scope for a target IC engineering role unless explicitly listed as an equivalent. When a title is genuinely generic/bare (e.g. plain "Software Engineer" with no discipline named), you may use the job description only to decide whether the underlying work matches — but once a title already names a specific different or broader role, the description cannot pull it back in scope. A posting like "Android Developer" is a different discipline than "Design Engineer" and is OUT of scope even though both contain "Engineer"/"Developer"-shaped titles — never treat two engineering-flavored titles as equivalent just because they're both engineering.
- discipline check (only when "Core discipline keywords" are given below — read them as naming the actual domain of work, not just words to pattern-match): a posting can share a keyword with the target discipline by pure coincidence while doing fundamentally different work — e.g. an "Electrical Designer" or "DFT (Design-For-Test) Engineer" contains "design" but is not UI/UX or product design work; a "Data Engineer" contains "Engineer" but isn't the target engineering discipline. Before treating a title as in scope, check that the underlying work plausibly belongs to the stated domain, not merely that a keyword appears in the title. This is a stricter reading of the title-scope rule above, not a separate pass.
- location: could they actually work this job given their location and remote constraints? "Remote" with a region restriction only counts if the restriction is compatible.
- skills: does the stated stack or domain line up with theirs?
- company: employer type, stage, and industry versus their stated preferences.
- compensation: only when the posting shows pay — compare against their expectation.
- requirements: their must-haves and nice-to-haves. A posting that clearly violates a must-have cannot be a "match".

Rules:
- Missing information is neutral, never disqualifying. Many postings are just a title and a location. Mark dimensions the posting says nothing about as "unknown" and judge on what is visible. Use "mismatch" only when the posting actively contradicts the profile.
- Dealbreakers are absolute: if one clearly applies, the verdict is "mismatch" no matter how good the rest looks, and "dealbreaker" names which one in a short phrase. Otherwise "dealbreaker" is null. Do not stretch dealbreakers to cover ambiguous cases — an unclear situation is not a dealbreaker.
- Title scope is equally absolute: if the profile states a target role and the posting's title is out of scope per the rule above, the verdict is "mismatch" no matter how good the rest looks, and "title_mismatch" names the specific different/broader role in a short phrase (e.g. "Full Stack Engineer is broader than the target Front-End Developer role"). Otherwise "title_mismatch" is null — including whenever the profile states no target role.
- Verdicts: "match" — you would confidently interrupt them: the visible evidence fits and nothing contradicts. "borderline" — plausibly right but genuinely uncertain: thin information, partial fit, or a stretch on one dimension. "mismatch" — someone with this profile would not thank you for this notification.
- score: overall fit 0–100 given the evidence (100 = ideal, 50 = coin flip, 0 = unrelated). Score and verdict must agree.
- summary: one or two plain sentences naming the decisive factors. The seeker reads this to trust — or correct — the decision, so be concrete, not generic.
- dimensions: include an entry for each dimension the profile expresses a preference about; skip dimensions the profile never mentions. Keep notes short.
- If recent feedback from this seeker is provided below, use it only to calibrate genuinely borderline calls (e.g. several "not interested" marks on similar senior IC roles at large companies suggest leaning mismatch on a new one just like them) — it never overrides a clear, direct read of the stated profile, and a single data point is never enough to shift a verdict.

Judge each posting independently, using its [id]. Respond with JSON only:
{"verdicts": [{"id": 0, "verdict": "match", "score": 85, "summary": "...", "dealbreaker": null, "title_mismatch": null, "dimensions": [{"name": "role", "fit": "strong", "note": "..."}]}]}
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
  if (p.compensation) lines.push(`Compensation: ${p.compensation}`);
  if (p.url) lines.push(`URL: ${p.url}`);
  const posted = p.posted_text || p.posted_at;
  if (posted) lines.push(`Posted: ${posted}`);
  return lines.join("\n");
}

function renderCalibration(calibration: JudgeCalibration): string | null {
  const lines: string[] = [];
  if (calibration.interested.length > 0) {
    lines.push(`Marked interested (good matches): ${calibration.interested.join("; ")}`);
  }
  if (calibration.notInterested.length > 0) {
    lines.push(`Marked not interested (bad matches): ${calibration.notInterested.join("; ")}`);
  }
  return lines.length > 0
    ? `RECENT FEEDBACK FROM THIS SEEKER (calibration only, see rules above):\n${lines.join("\n")}`
    : null;
}

/** Exported for testing the dealbreaker/title-scope hard-override logic without invoking the LLM. */
export function asVerdict(item: unknown, count: number): { id: number; verdict: PostingVerdict } | null {
  if (typeof item !== "object" || item === null) return null;
  const v = item as Record<string, unknown>;
  if (typeof v.id !== "number" || !Number.isInteger(v.id) || v.id < 0 || v.id >= count) return null;
  if (typeof v.verdict !== "string" || !(VERDICT_KINDS as readonly string[]).includes(v.verdict)) return null;
  const score = typeof v.score === "number" && Number.isFinite(v.score)
    ? Math.min(100, Math.max(0, Math.round(v.score)))
    : 0;
  const dealbreakerRaw = typeof v.dealbreaker === "string" ? v.dealbreaker.trim() : "";
  const dealbreaker = dealbreakerRaw !== "" && !/^(null|none|n\/a)$/i.test(dealbreakerRaw) ? dealbreakerRaw : null;
  const titleMismatchRaw = typeof v.title_mismatch === "string" ? v.title_mismatch.trim() : "";
  const titleMismatch = titleMismatchRaw !== "" && !/^(null|none|n\/a)$/i.test(titleMismatchRaw) ? titleMismatchRaw : null;
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
      // A named dealbreaker, or a title that's out of scope for the target
      // role, forces a mismatch even if the model's verdict field disagrees
      // — the two must never contradict in stored data. Title scope is
      // checked second: it must never be softened by an otherwise-strong
      // score on the other dimensions.
      verdict: dealbreaker !== null
        ? "mismatch"
        : titleMismatch !== null
        ? "mismatch"
        : (v.verdict as PostingVerdict["verdict"]),
      score,
      summary: typeof v.summary === "string" ? v.summary.trim() : "",
      dealbreaker,
      title_mismatch: titleMismatch,
      dimensions,
    },
  };
}

function normalizeRoleText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/** A posting with no company, location, or compensation gives the judge
 * almost nothing beyond the bare title to reason from. Confirmed against
 * real production data: Himalayas' RSS-feed fallback (used when its listing
 * page is walled) carries only title/url/date, and on that exact shape of
 * input the model stopped applying the title-scope rule — hallucinating
 * "fits" for postings like "AI Data Engineer" or "Salesforce Consultant"
 * against a "Design Engineer" target, scoring them 60-90 with
 * title_mismatch left null. The same feed's richer postings (company +
 * location populated, from before it got walled) screened correctly. This
 * doesn't replace the judge's semantic reasoning — it only kicks in for
 * that specific thin-data shape, as a deterministic textual check against
 * the profile's declared roles/equivalents. */
export function isThinPosting(p: ScreenablePosting): boolean {
  return !p.company && !p.location && !p.compensation;
}

/** Substring containment (either direction) after normalizing to
 * lowercase/whitespace-collapsed words — cheap enough to be reliable, and
 * seniority qualifiers ("Senior UI Engineer") fall out for free since the
 * bare equivalent ("ui engineer") is still a substring. */
export function titleWithinDeclaredScope(title: string, profile: FilterProfile): boolean {
  const equivalents = [profile.roles ?? "", profile.role_synonyms ?? ""]
    .flatMap((v) => v.split(","))
    .map(normalizeRoleText)
    .filter((s) => s !== "");
  if (equivalents.length === 0) return true; // no declared scope — nothing to check
  const t = normalizeRoleText(title);
  if (t === "") return true;
  return equivalents.some((eq) => t.includes(eq) || eq.includes(t));
}

/** Deterministic title-keyword gate, run BEFORE the AI judge ever sees a
 * posting (see poll-pages screenPending) — not a backstop on the judge's
 * output like applyThinPostingBackstop below, but a hard pre-filter on the
 * input. profile.title_keywords is a short list of discipline WORDS (not
 * full titles, unlike role_synonyms/roles): a posting whose title contains
 * none of them never reaches the LLM at all. This exists because the judge
 * has gotten title scope wrong even with full posting context in hand (e.g.
 * scoring "Android Developer" as a match for "Design Engineer") — a purely
 * textual gate ahead of the model closes that gap regardless of the model's
 * reliability. Empty title_keywords means the gate is off (unset profiles
 * behave exactly as before this field existed). */
export function titleMatchesKeywords(title: string, profile: FilterProfile): boolean {
  const keywords = (profile.title_keywords ?? "")
    .split(",")
    .map(normalizeRoleText)
    .filter((s) => s !== "");
  if (keywords.length === 0) return true; // no keyword gate declared
  const t = normalizeRoleText(title);
  if (t === "") return true;
  return keywords.some((k) => t.includes(k));
}

/** The deterministic verdict recorded for a posting the keyword gate
 * rejected — the caller stores this directly, no LLM call spent. */
export function keywordFilterVerdict(title: string, profile: FilterProfile): PostingVerdict {
  const keywords = profile.title_keywords ?? "";
  return {
    verdict: "mismatch",
    score: 0,
    summary: `Held back before the AI judge: "${title}" doesn't contain any of the profile's declared title keywords (${keywords}).`,
    dealbreaker: null,
    title_mismatch:
      `"${title}" doesn't contain any of the profile's declared title keywords (${keywords}) — rejected by the ` +
      `keyword filter ahead of the AI judge.`,
    dimensions: [],
  };
}

/** Exported for testing. Runs after the model's own title_mismatch field is
 * already applied (asVerdict) — this only fires when the model missed it. */
export function applyThinPostingBackstop(
  verdict: PostingVerdict,
  posting: ScreenablePosting,
  profile: FilterProfile,
): PostingVerdict {
  if (verdict.title_mismatch !== null) return verdict; // already caught upstream
  if (!isThinPosting(posting)) return verdict;
  if (titleWithinDeclaredScope(posting.title, profile)) return verdict;
  return {
    ...verdict,
    verdict: "mismatch",
    title_mismatch:
      `No company, location, or description was available to judge from, and "${posting.title}" ` +
      `doesn't textually match any declared target role/equivalent — held back rather than guessed.`,
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
  calibration?: JudgeCalibration,
): Promise<Map<number, PostingVerdict>> {
  const parts = [`THE SEEKER'S PROFILE:\n${renderProfile(profile)}`];
  const calibrationBlock = calibration ? renderCalibration(calibration) : null;
  if (calibrationBlock) parts.push(calibrationBlock);
  parts.push(`POSTINGS (found on "${pageLabel}"):\n\n${postings.map(renderPosting).join("\n\n")}`);
  const user = parts.join("\n\n");

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
  for (const [i, verdict] of out) {
    out.set(i, applyThinPostingBackstop(verdict, postings[i], profile));
  }
  return out;
}
