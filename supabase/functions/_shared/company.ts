// Company background layer: research the employer behind a matched posting
// (is it a real operating company? what does it do? size, stage, funding?)
// and judge the findings against the seeker's company preferences.
//
// Research = one Jina Search call (s.jina.ai, same key as Jina Reader) for
// live web evidence + one LLM call to synthesize a structured dossier from
// that evidence only. Dossiers are cached per company (companies table) and
// refreshed after COMPANY_REFRESH_DAYS. The layer never blocks a posting —
// the worst outcome is a "warn" verdict, delivered with the notification and
// shown in the UI, phrased as "couldn't verify", never "fake" as fact.

import type { CompanyDossier, CompanyRow, CompanyVerdict, FilterProfile, RuntimeConfig } from "./types.ts";
import { llmJson } from "./llm.ts";

export const COMPANY_REFRESH_DAYS = 30;
export const MAX_COMPANY_RESEARCH_FAILURES = 3;
// Don't re-attempt a failed research within the same 15-min poll cadence
// (back-to-back manual "Check now" runs would otherwise hammer the APIs).
const RESEARCH_RETRY_MINUTES = 10;

const SEARCH_TIMEOUT_MS = 30_000;
const MAX_SEARCH_RESULTS = 5;
const MAX_RESULT_CHARS = 4_000;

/** Legal suffixes stripped (repeatedly) from the end of a normalized name.
 * Only legal forms — descriptive words like "labs"/"technologies" are part
 * of a company's identity and must survive normalization. */
const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "ltd", "limited", "corp", "corporation",
  "co", "company", "gmbh", "ag", "plc", "sa", "bv", "oy", "ab", "as", "aps",
  "pvt", "pte", "srl", "sarl", "kk", "pty",
]);

/** "Acme, Inc." / "ACME" / "acme pvt. ltd." → "acme" — one cache row per company. */
export function normalizeCompanyName(name: string): string {
  const tokens = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.,'’"“”&()\-–—/]/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

/** The layer needs both the toggle and a Jina key: research without live
 * search evidence would be the LLM guessing, which is worse than nothing. */
export function companyLayerActive(cfg: RuntimeConfig): boolean {
  return cfg.companyFilterEnabled && cfg.jinaApiKey.trim() !== "";
}

export function dossierIsFresh(row: Pick<CompanyRow, "research_status" | "dossier" | "researched_at">): boolean {
  if (row.research_status !== "ok" || !row.dossier || !row.researched_at) return false;
  const age = Date.now() - new Date(row.researched_at).getTime();
  return age < COMPANY_REFRESH_DAYS * 24 * 60 * 60 * 1000;
}

/** A failed research row that may be attempted again this run. */
export function researchRetryDue(row: Pick<CompanyRow, "researched_at" | "failure_count">): boolean {
  if (row.failure_count >= MAX_COMPANY_RESEARCH_FAILURES) return false;
  if (!row.researched_at) return true;
  return Date.now() - new Date(row.researched_at).getTime() > RESEARCH_RETRY_MINUTES * 60 * 1000;
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

async function jinaSearch(query: string, jinaApiKey: string): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
      headers: {
        "Authorization": `Bearer ${jinaApiKey}`,
        "Accept": "application/json",
        "X-Retain-Images": "none",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 429) {
    throw new Error(
      `jina search rate-limited/unauthorized (HTTP ${res.status}) — check the Jina API key (free key at jina.ai)`,
    );
  }
  if (!res.ok) throw new Error(`jina search failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const data = Array.isArray(body?.data) ? body.data : [];
  const out: SearchResult[] = [];
  for (const item of data.slice(0, MAX_SEARCH_RESULTS)) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title : "";
    const url = typeof r.url === "string" ? r.url : "";
    const text = [r.description, r.content].filter((v) => typeof v === "string").join("\n");
    if (!title && !url && !text) continue;
    out.push({ title, url, content: text.slice(0, MAX_RESULT_CHARS) });
  }
  return out;
}

const LEGITIMACY_LEVELS = ["verified", "likely_real", "uncertain", "suspicious"] as const;
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

const DOSSIER_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    website: { type: ["string", "null"] },
    summary: { type: "string" },
    industry: { type: ["string", "null"] },
    size_estimate: { type: ["string", "null"] },
    stage: { type: ["string", "null"] },
    funding: { type: ["string", "null"] },
    founded: { type: ["string", "null"] },
    company_type: { type: ["string", "null"] },
    legitimacy: { type: "string", enum: LEGITIMACY_LEVELS },
    flags: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: CONFIDENCE_LEVELS },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, url: { type: "string" } },
        required: ["title", "url"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "name", "website", "summary", "industry", "size_estimate", "stage",
    "funding", "founded", "company_type", "legitimacy", "flags", "confidence", "sources",
  ],
  additionalProperties: false,
} as const;

const DOSSIER_SYSTEM_PROMPT = `You research companies for a job seeker deciding whether a job posting is worth pursuing — including whether the company is real at all. You get web search results about one company. Build a factual dossier STRICTLY from the evidence provided; never from prior knowledge alone, never invented.

- summary: 1–2 sentences on what the company actually does / has done.
- website: the company's own site if the evidence shows it, else null.
- size_estimate, stage, funding, founded: only when the evidence states them, else null. For funding include the year ("$12M Series A, 2024").
- company_type: a short 1–3 word category the seeker would instantly recognize — e.g. "Startup", "Public company", "Non-profit", "B2B SaaS", "Agency", "Enterprise". Base it on the evidence (stage, structure, business model); null only when truly indeterminable.
- legitimacy:
  - "verified" — multiple independent sources confirm a real operating company.
  - "likely_real" — credible footprint but thin (few sources, small company).
  - "uncertain" — almost no independent footprint beyond job boards. Absence of evidence is caution, not accusation: a small or new real company can look like this.
  - "suspicious" — concrete red flags: scam reports, a parked/template website, contradictory identities, a posting mimicking another brand, pay-to-apply schemes.
- flags: concrete red/caution observations from the evidence, empty array if none. Phrase as observations ("no website found beyond job-board profiles"), never as verdicts ("this is a fake company").
- confidence: how solid the evidence is overall.
- sources: only the search results you actually used, as {title, url}.

Respond with JSON only, matching the schema.`;

/**
 * Research one company: one Jina Search for live evidence, one LLM call to
 * synthesize the dossier. `hint` (posting title + source page) disambiguates
 * common names. Zero search results still go to the LLM — a low-confidence
 * "uncertain" dossier IS the signal the seeker needs.
 */
export async function researchCompany(
  displayName: string,
  hint: string,
  runtime: RuntimeConfig,
): Promise<CompanyDossier> {
  const results = await jinaSearch(`"${displayName}" company funding employees`, runtime.jinaApiKey);
  const rendered = results.length === 0
    ? "(the web search returned no results for this company)"
    : results
      .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`)
      .join("\n\n");
  const user = [
    `COMPANY: ${displayName}`,
    `SEEN ON: ${hint}`,
    `SEARCH RESULTS:\n\n${rendered}`,
  ].join("\n\n");

  const parsed = await llmJson(runtime, {
    system: DOSSIER_SYSTEM_PROMPT,
    user,
    schema: DOSSIER_SCHEMA,
    schemaName: "company_dossier",
  });
  return validateDossier(parsed, displayName);
}

function optString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function validateDossier(parsed: unknown, fallbackName: string): CompanyDossier {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("dossier response is not an object");
  }
  const d = parsed as Record<string, unknown>;
  const legitimacy = (LEGITIMACY_LEVELS as readonly string[]).includes(d.legitimacy as string)
    ? d.legitimacy as CompanyDossier["legitimacy"]
    : "uncertain";
  const confidence = (CONFIDENCE_LEVELS as readonly string[]).includes(d.confidence as string)
    ? d.confidence as CompanyDossier["confidence"]
    : "low";
  const flags = Array.isArray(d.flags)
    ? d.flags.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim())
    : [];
  const sources: CompanyDossier["sources"] = [];
  if (Array.isArray(d.sources)) {
    for (const s of d.sources) {
      if (typeof s !== "object" || s === null) continue;
      const src = s as Record<string, unknown>;
      if (typeof src.url !== "string" || src.url.trim() === "") continue;
      sources.push({ title: typeof src.title === "string" ? src.title.trim() : "", url: src.url.trim() });
    }
  }
  return {
    name: optString(d.name) ?? fallbackName,
    website: optString(d.website),
    summary: typeof d.summary === "string" ? d.summary.trim() : "",
    industry: optString(d.industry),
    size_estimate: optString(d.size_estimate),
    stage: optString(d.stage),
    funding: optString(d.funding),
    founded: optString(d.founded),
    company_type: optString(d.company_type),
    legitimacy,
    flags,
    confidence,
    sources,
  };
}

const COMPANY_VERDICTS_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          decision: { type: "string", enum: ["ok", "warn"] },
          reason: { type: "string" },
        },
        required: ["id", "decision", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

const COMPANY_JUDGE_SYSTEM_PROMPT = `You review, for one job seeker, the companies behind job postings that already matched their job profile. You get the seeker's company-related preferences plus a researched dossier per company. Decide per company whether to clear it ("ok") or attach a caution ("warn") — nothing is ever hidden from the seeker; a warn is delivered with the notification and shown in the UI.

- "warn" when there is genuine cause for caution: the dossier's legitimacy is "suspicious" or "uncertain", its confidence is low, or the dossier clearly conflicts with a stated company preference (e.g. the seeker says "no tiny 2–3 person firms" and the dossier shows a 3-person company).
- "ok" otherwise.
- Missing information is neutral: an unknown size does not conflict with a size preference. Warn about missing evidence only through the legitimacy/confidence rule above.
- Only company-related preferences apply here — the job itself already passed screening. Ignore role, location, skill, or compensation items that appear in the preference text.
- reason: exactly one plain sentence the seeker will read, naming the decisive fact ("Only footprint found is job-board profiles — couldn't verify the company independently."). Phrase caution as unverified/couldn't-confirm, never as an accusation of fraud.

Respond with JSON only: {"verdicts": [{"id": 0, "decision": "ok", "reason": "..."}]}
Return exactly one entry per company, using each company's [id].`;

function renderCompanyPrefs(profile: FilterProfile): string {
  const lines: string[] = [];
  if (profile.company_prefs) lines.push(`Company preferences: ${profile.company_prefs}`);
  if (profile.dealbreakers) lines.push(`Dealbreakers (only company-related ones apply): ${profile.dealbreakers}`);
  if (profile.context) lines.push(`About the seeker: ${profile.context}`);
  return lines.length > 0 ? lines.join("\n") : "(none stated — screen for legitimacy only)";
}

function renderDossier(dossier: CompanyDossier): string {
  const parts: string[] = [`legitimacy: ${dossier.legitimacy}`, `confidence: ${dossier.confidence}`];
  if (dossier.summary) parts.push(`summary: ${dossier.summary}`);
  if (dossier.industry) parts.push(`industry: ${dossier.industry}`);
  if (dossier.size_estimate) parts.push(`size: ${dossier.size_estimate}`);
  if (dossier.stage) parts.push(`stage: ${dossier.stage}`);
  if (dossier.funding) parts.push(`funding: ${dossier.funding}`);
  if (dossier.founded) parts.push(`founded: ${dossier.founded}`);
  if (dossier.flags.length > 0) parts.push(`flags: ${dossier.flags.join("; ")}`);
  return parts.join("\n");
}

/**
 * Judge a batch of researched companies against the seeker's preferences in
 * one LLM call. Companies whose research permanently failed (dossier null)
 * never reach the LLM — they get a deterministic "couldn't verify" warn.
 * Same contract as judgePostings: verdicts keyed by input index; an id the
 * model failed to return a valid verdict for is absent from the map.
 */
export async function judgeCompanies(
  items: Array<{ name: string; dossier: CompanyDossier | null }>,
  profile: FilterProfile,
  runtime: RuntimeConfig,
): Promise<Map<number, CompanyVerdict>> {
  const out = new Map<number, CompanyVerdict>();
  const judgeable: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].dossier === null) {
      out.set(i, {
        decision: "warn",
        reason: "Could not research this company after repeated attempts — treat with care.",
      });
    } else {
      judgeable.push(i);
    }
  }
  if (judgeable.length === 0) return out;

  const user = [
    `THE SEEKER'S COMPANY PREFERENCES:\n${renderCompanyPrefs(profile)}`,
    `COMPANIES:\n\n${
      judgeable.map((i) => `[${i}] ${items[i].name}\n${renderDossier(items[i].dossier!)}`).join("\n\n")
    }`,
  ].join("\n\n");

  const parsed = await llmJson(runtime, {
    system: COMPANY_JUDGE_SYSTEM_PROMPT,
    user,
    schema: COMPANY_VERDICTS_SCHEMA,
    schemaName: "company_verdicts",
  });
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { verdicts?: unknown }).verdicts)) {
    throw new Error("company judge response is not of shape {verdicts: [...]}");
  }
  const allowed = new Set(judgeable);
  for (const item of (parsed as { verdicts: unknown[] }).verdicts) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.id !== "number" || !Number.isInteger(v.id) || !allowed.has(v.id) || out.has(v.id)) continue;
    if (v.decision !== "ok" && v.decision !== "warn") continue;
    out.set(v.id, {
      decision: v.decision,
      reason: typeof v.reason === "string" ? v.reason.trim() : "",
    });
  }
  return out;
}

/** One plain-text line summarizing the dossier for notifications, e.g.
 * "Series B fintech, ~120 employees, $12M Series A, 2024". Empty when the
 * dossier has nothing concrete to say. */
export function companySummaryLine(dossier: CompanyDossier): string {
  const parts = [
    dossier.stage && dossier.industry
      ? `${dossier.stage} ${dossier.industry}`
      : dossier.stage ?? dossier.industry,
    dossier.size_estimate,
    dossier.funding,
  ].filter((p): p is string => Boolean(p));
  if (parts.length > 0) return parts.join(", ");
  return dossier.summary;
}
