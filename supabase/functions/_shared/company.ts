// Company background layer: research the employer behind a matched posting
// (is it a real operating company? what does it do? size, stage, funding?)
// and judge the findings for legitimacy.
//
// Research = one Tavily web search call for live evidence + one LLM call to
// synthesize a structured dossier from that evidence only. Dossiers are
// cached per company (companies table) and refreshed after
// COMPANY_REFRESH_DAYS, so a repeat sighting of the same company is free —
// only genuinely new or stale companies spend a search. The layer never
// blocks a posting — the worst outcome is a "warn" verdict, delivered with
// the notification and shown in the UI, phrased as "couldn't verify", never
// "fake" as fact.

import type { CompanyDossier, CompanyRow, CompanyVerdict, RuntimeConfig } from "./types.ts";
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

/** The layer needs both the toggle and a Tavily key: research without live
 * search evidence would be the LLM guessing, which is worse than nothing. */
export function companyLayerActive(cfg: RuntimeConfig): boolean {
  return cfg.companyFilterEnabled && cfg.tavilyApiKey.trim() !== "";
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

async function tavilySearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: MAX_SEARCH_RESULTS,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `tavily search unauthorized (HTTP ${res.status}) — check the Tavily API key (free key at tavily.com)`,
    );
  }
  if (res.status === 429) {
    throw new Error("tavily search rate-limited (HTTP 429) — the free-tier monthly quota may be exhausted");
  }
  if (!res.ok) throw new Error(`tavily search failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const data = Array.isArray(body?.results) ? body.results : [];
  const out: SearchResult[] = [];
  for (const item of data.slice(0, MAX_SEARCH_RESULTS)) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title : "";
    const url = typeof r.url === "string" ? r.url : "";
    const text = typeof r.content === "string" ? r.content : "";
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
    product_breakdown: { type: "string" },
    industry: { type: ["string", "null"] },
    size_estimate: { type: ["string", "null"] },
    stage: { type: ["string", "null"] },
    funding: { type: ["string", "null"] },
    founded: { type: ["string", "null"] },
    company_type: { type: ["string", "null"] },
    founders: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          title: { type: ["string", "null"] },
          x_url: { type: ["string", "null"] },
          linkedin_url: { type: ["string", "null"] },
          bio: { type: ["string", "null"] },
        },
        required: ["name", "title", "x_url", "linkedin_url", "bio"],
        additionalProperties: false,
      },
    },
    socials: {
      type: "object",
      properties: {
        linkedin_url: { type: ["string", "null"] },
        x_url: { type: ["string", "null"] },
        github_url: { type: ["string", "null"] },
        crunchbase_url: { type: ["string", "null"] },
      },
      required: ["linkedin_url", "x_url", "github_url", "crunchbase_url"],
      additionalProperties: false,
    },
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
    "name", "website", "summary", "product_breakdown", "industry", "size_estimate", "stage",
    "funding", "founded", "company_type", "founders", "socials", "legitimacy", "flags", "confidence", "sources",
  ],
  additionalProperties: false,
} as const;

const DOSSIER_SYSTEM_PROMPT = `You research companies for a job seeker deciding whether a job posting is worth pursuing — including whether the company is real and who leads it. You get web search results about one company. Build a factual dossier STRICTLY from the evidence provided; never from prior knowledge alone, never invented.

- summary: 1–2 sentences on what the company actually does / has done.
- product_breakdown: 2–3 sentences on the company's products/services, target market, and business model, based on the evidence. Empty string if the evidence doesn't support it.
- website: the company's own site if the evidence shows it, else null.
- size_estimate, stage, funding, founded: only when the evidence states them, else null. For funding include the year ("$12M Series A, 2024").
- company_type: a short 1–3 word category the seeker would instantly recognize — e.g. "Startup", "Public company", "Non-profit", "B2B SaaS", "Agency", "Enterprise". Base it on the evidence (stage, structure, business model); null only when truly indeterminable.
- founders: array of { name, title, x_url, linkedin_url, bio } for founders, the CEO, or other C-level executives named in the evidence, with their X/LinkedIn profile URLs when present. Empty array if none are named in the evidence — never guess a name.
- socials: { linkedin_url, x_url, github_url, crunchbase_url } — the company's own official pages, only when the evidence shows them, else null.
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
 * Research one company: one Tavily search for live evidence, one LLM call to
 * synthesize the dossier. `hint` (posting title + source page) disambiguates
 * common names. Zero search results still go to the LLM — a low-confidence
 * "uncertain" dossier IS the signal the seeker needs.
 */
export async function researchCompany(
  displayName: string,
  hint: string,
  runtime: RuntimeConfig,
): Promise<CompanyDossier> {
  const results = await tavilySearch(
    `"${displayName}" company founder CEO linkedin twitter x.com funding employees`,
    runtime.tavilyApiKey,
  );
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
  const founders: CompanyDossier["founders"] = [];
  if (Array.isArray(d.founders)) {
    for (const item of d.founders) {
      if (typeof item !== "object" || item === null) continue;
      const f = item as Record<string, unknown>;
      const name = optString(f.name);
      if (!name) continue;
      founders.push({
        name,
        title: optString(f.title),
        x_url: optString(f.x_url),
        linkedin_url: optString(f.linkedin_url),
        bio: optString(f.bio),
      });
    }
  }

  const soc = typeof d.socials === "object" && d.socials !== null ? (d.socials as Record<string, unknown>) : {};
  const socials: CompanyDossier["socials"] = {
    linkedin_url: optString(soc.linkedin_url),
    x_url: optString(soc.x_url),
    github_url: optString(soc.github_url),
    crunchbase_url: optString(soc.crunchbase_url),
  };

  return {
    name: optString(d.name) ?? fallbackName,
    website: optString(d.website),
    summary: typeof d.summary === "string" ? d.summary.trim() : "",
    product_breakdown: typeof d.product_breakdown === "string" ? d.product_breakdown.trim() : "",
    industry: optString(d.industry),
    size_estimate: optString(d.size_estimate),
    stage: optString(d.stage),
    funding: optString(d.funding),
    founded: optString(d.founded),
    company_type: optString(d.company_type),
    founders,
    socials,
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

const COMPANY_JUDGE_SYSTEM_PROMPT = `You review, for a job seeker, the companies behind job postings that already matched their job profile. You get a researched dossier per company. Decide per company whether to clear it ("ok") or attach a caution ("warn") — nothing is ever hidden from the seeker; a warn is delivered with the notification and shown in the UI.

- "warn" when there is genuine cause for caution: the dossier's legitimacy is "suspicious" or "uncertain", or its confidence is low.
- "ok" otherwise.
- Missing information is neutral: warn about missing evidence only through the legitimacy/confidence rule above, never because an unrelated fact (size, funding, etc.) is unknown.
- reason: exactly one plain sentence the seeker will read, naming the decisive fact ("Only footprint found is job-board profiles — couldn't verify the company independently."). Phrase caution as unverified/couldn't-confirm, never as an accusation of fraud.

Respond with JSON only: {"verdicts": [{"id": 0, "decision": "ok", "reason": "..."}]}
Return exactly one entry per company, using each company's [id].`;

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
 * Judge a batch of researched companies for legitimacy in one LLM call.
 * Companies whose research permanently failed (dossier null) never reach
 * the LLM — they get a deterministic "couldn't verify" warn. Same contract
 * as judgePostings: verdicts keyed by input index; an id the model failed
 * to return a valid verdict for is absent from the map.
 */
export async function judgeCompanies(
  items: Array<{ name: string; dossier: CompanyDossier | null }>,
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

  const user = `COMPANIES:\n\n${
    judgeable.map((i) => `[${i}] ${items[i].name}\n${renderDossier(items[i].dossier!)}`).join("\n\n")
  }`;

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
