// LLM-based qualification: judge extracted postings by their TITLE alone —
// there is no job description anywhere in this system — against the user's
// title-screening profile (target role, equivalent titles, title keywords,
// location/remote preference, compensation), the way a person deciding "is
// this worth my time?" would, not by keyword matching.
//
// Two deterministic layers backstop the LLM, which has repeatedly gotten
// title scope wrong even with full context in hand:
//   - titleMatchesKeywords / keywordFilterVerdict: run BEFORE the judge ever
//     sees a posting (see poll-pages screenPending) — a title sharing none
//     of the profile's declared title_keywords is rejected outright, no LLM
//     call spent.
//   - isThinPosting / titleWithinDeclaredScope / applyThinPostingBackstop:
//     run AFTER the judge's own verdict, only for postings with no company,
//     location, or compensation (a starved-context shape some sources
//     produce) — a textual scope check against roles/role_synonyms forces a
//     mismatch the model missed.
//
// One call screens a whole batch of postings. Each verdict carries a
// human-readable summary so every decision is auditable in the UI (and
// quoted in the Telegram message for matches).

import type { FilterProfile, PostingVerdict, ProfileTextKey, RuntimeConfig } from "./types.ts";
import { FILTER_PROFILE_KEYS } from "./types.ts";
import { llmJson } from "./llm.ts";

/** The posting fields the judge sees (a subset of a postings row). `company`
 * is never rendered into the LLM prompt (see renderPosting) — it exists only
 * for the deterministic isThinPosting check below. */
export interface ScreenablePosting {
  title: string;
  company?: string | null;
  location?: string | null;
  compensation?: string | null;
}

const PROFILE_LABELS: Record<ProfileTextKey, string> = {
  roles: "Target role",
  role_synonyms: "Equivalent titles (treat as the target role)",
  title_keywords: "Core discipline keywords (the actual domain of work)",
  locations: "Location / remote preference",
  compensation: "Compensation",
};

/** An entirely empty profile means there is nothing to judge against —
 * filtering is effectively off. */
export function profileHasContent(profile: FilterProfile): boolean {
  return FILTER_PROFILE_KEYS.some((key) => (profile[key] ?? "").trim() !== "");
}

const VERDICT_KINDS = ["match", "borderline", "mismatch"] as const;

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
          summary: { type: "string" },
          title_mismatch: { type: ["string", "null"] },
        },
        required: ["id", "verdict", "summary", "title_mismatch"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

const JUDGE_SYSTEM_PROMPT =
  `You screen job postings for one job seeker, judging almost entirely by the posting's TITLE — there is no job description, just a title plus sometimes a location and a pay figure. Decide whether this posting deserves to interrupt the seeker with a notification, the way a sharp assistant who knows their target role well would.

Role fit — read the title the way an industry insider would ("Member of Technical Staff" is usually a software engineer; "Solutions Engineer" is usually pre-sales, not product engineering). The profile's target role, its equivalent titles, and its title keywords all count as the target role — a posting whose title matches any of them in MEANING, not exact wording, is in scope.

Title scope is a hard boundary: when the profile states a target role, a posting is IN scope only if its title is the target role itself, one of the equivalent/adjacent titles, a title-keyword match, or a seniority/level-qualified variant of one of those (e.g. Senior/Staff/Principal/Lead/Sr./Jr./II/III/Intern/Associate + the base title, or a team/product qualifier that doesn't change the discipline, like "Front-End Engineer, Growth"). A posting is OUT of scope when its title names a different or broader discipline than the target and its equivalents — a shared generic word like "Engineer" or "Developer" is never enough by itself. Worked example: target role "Front-End Developer" with equivalents like "UI Engineer"/"Design Engineer" — a posting titled "Full Stack Engineer" is OUT of scope (broader role) even though it contains "Engineer"; "Senior Front-End Engineer" or "UI Engineer II" ARE in scope. The same logic applies to any other named-different-role trap: "Backend Engineer", "DevOps Engineer", "Mobile Engineer", "Data Engineer", "QA Engineer", "Solutions Engineer", "Engineering Manager" are all out of scope for a target IC engineering role unless explicitly listed as an equivalent or matched by a title keyword. A posting like "Android Developer" is a different discipline than "Design Engineer" and is OUT of scope even though both are "Engineer"/"Developer"-shaped titles — never treat two engineering-flavored titles as equivalent just because they're both engineering. When the profile states no target role at all, title scope never applies.

Umbrella target roles get the same qualifier check in reverse. When the profile's target role is itself broad rather than a specific discipline (a bare "Designer", "Engineer", "Marketer", "Writer"), a qualifier in front of the base word can go two ways: one that's just seniority, team, or company stage and leaves the actual creative/technical output unchanged — IN scope — or one that swaps in a different medium or output the profile's equivalents and keywords never named — OUT of scope — even though the title still literally contains the base word and even a keyword still matches. Worked example: target role "Designer" with equivalents/keywords naming product, UI/UX, and branding work — "Senior Designer", "Staff Designer", "Founding Designer", "Lead Designer", "Product Designer", "UX Designer", and "Brand Designer" are all IN scope (the qualifier is seniority/stage, or names the very discipline the profile already declares). "Thumbnail Designer", "Packaging Designer", "Game Designer", "Motion Designer", "Interior Designer", and "Fashion Designer" are OUT of scope (the qualifier names a different creative medium or output — video thumbnails, product packaging, games, motion graphics, interiors, apparel — that the profile never claims, no matter how well "design" or even "graphics" matches as a keyword). Ask what the qualifier actually changes about the work, not whether the base word is present.

Discipline check (only when "Core discipline keywords" are given — read them as naming the actual domain of work, not just words to pattern-match): a posting can share a keyword with the target discipline by pure coincidence while doing fundamentally different work — e.g. an "Electrical Designer" or "DFT (Design-For-Test) Engineer" contains "design" but is not UI/UX or product design work. Before treating a title as in scope, check that the underlying work plausibly belongs to the stated domain, not merely that a keyword appears in the title. This is a stricter reading of the title-scope rule above, not a separate pass.

Location / remote: checked only against the posting's location field, never the title. The preference reads as "Only: <places>. Never: <places>" — places the seeker will and won't work. A deterministic gate has ALREADY rejected the obvious textual violations before you see this posting, so your job is the judgement it can't make: whether a location that passed on wording actually works in practice ("Remote" with a region restriction only counts if the restriction is compatible; "Remote — EMEA" is not workable from a country outside it even though neither list names it). Missing location info is neutral, never disqualifying.

Compensation: checked only when the posting's compensation field states pay — compare against the seeker's stated range. A deterministic gate has already rejected postings whose stated pay provably tops out below the seeker's floor in the same currency, so what's left for you is the rest: a different currency, an hourly rate, or an equity-heavy figure that reads as below target. A posting with no pay shown is neutral, never disqualifying.

Rules:
- Missing information is neutral, never disqualifying. Many postings are just a title. Use "mismatch" only when something actively contradicts the profile.
- Title scope is absolute: if the profile states a target role and the posting's title is out of scope per the rule above, the verdict is "mismatch" no matter how good the location/pay look, and "title_mismatch" names the specific different/broader role in a short phrase (e.g. "Full Stack Engineer is broader than the target Front-End Developer role"). Otherwise "title_mismatch" is null — including whenever the profile states no target role.
- Verdicts: "match" — you would confidently interrupt them: the title fits, and location/pay (when stated) don't contradict. "borderline" — plausibly right but genuinely uncertain (e.g. a bare, generic title with no clear signal either way). "mismatch" — the title is out of scope, or location/pay actively contradicts.
- summary: one or two plain sentences naming the decisive factor. The seeker reads this to trust — or correct — the decision, so be concrete, not generic.

Judge each posting independently, using its [id]. Respond with JSON only:
{"verdicts": [{"id": 0, "verdict": "match", "summary": "...", "title_mismatch": null}]}
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
  if (p.location) lines.push(`Location: ${p.location}`);
  if (p.compensation) lines.push(`Compensation: ${p.compensation}`);
  return lines.join("\n");
}

/** Exported for testing the title-scope hard-override logic without invoking the LLM. */
export function asVerdict(item: unknown, count: number): { id: number; verdict: PostingVerdict } | null {
  if (typeof item !== "object" || item === null) return null;
  const v = item as Record<string, unknown>;
  if (typeof v.id !== "number" || !Number.isInteger(v.id) || v.id < 0 || v.id >= count) return null;
  if (typeof v.verdict !== "string" || !(VERDICT_KINDS as readonly string[]).includes(v.verdict)) return null;
  const titleMismatchRaw = typeof v.title_mismatch === "string" ? v.title_mismatch.trim() : "";
  const titleMismatch = titleMismatchRaw !== "" && !/^(null|none|n\/a)$/i.test(titleMismatchRaw)
    ? titleMismatchRaw
    : null;
  return {
    id: v.id,
    verdict: {
      // A title that's out of scope for the target role forces a mismatch
      // even if the model's verdict field disagrees — the two must never
      // contradict in stored data.
      verdict: titleMismatch !== null ? "mismatch" : (v.verdict as PostingVerdict["verdict"]),
      summary: typeof v.summary === "string" ? v.summary.trim() : "",
      title_mismatch: titleMismatch,
    },
  };
}

function normalizeRoleText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/** The delimiters a stored profile list may use. The Profile page writes
 * comma-separated values, but hand-edited and legacy profiles also contain
 * semicolons and newlines — splitting on comma alone would treat "design;
 * UI" as one keyword the UI is simultaneously showing as two tags, so the
 * gate would silently disagree with what the seeker sees. Kept identical to
 * the web app's splitToTags (web/src/lib/profileTags.ts). */
const PROFILE_LIST_DELIMITERS = /[,;\n]/;

function profileList(value: string | undefined): string[] {
  return (value ?? "").split(PROFILE_LIST_DELIMITERS).map(normalizeRoleText).filter((s) => s !== "");
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
  const equivalents = [...profileList(profile.roles), ...profileList(profile.role_synonyms)];
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
  const keywords = profileList(profile.title_keywords);
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
    summary: `Held back before the AI judge: "${title}" doesn't contain any of the profile's declared title keywords (${keywords}).`,
    title_mismatch:
      `"${title}" doesn't contain any of the profile's declared title keywords (${keywords}) — rejected by the ` +
      `keyword filter ahead of the AI judge.`,
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
  for (const [i, verdict] of out) {
    out.set(i, applyThinPostingBackstop(verdict, postings[i], profile));
  }
  return out;
}
