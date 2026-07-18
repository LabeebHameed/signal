export interface ExtractedPosting {
  title: string;
  url?: string;
  company?: string;
  location?: string;
  /** ISO date (YYYY-MM-DD) the job was posted, when the page shows one. */
  posted_at?: string;
  /** The posted-date text verbatim as shown on the page, e.g. "2 days ago". */
  posted_text?: string;
}

/**
 * What the user is looking for. Every field is optional free text — the
 * judge only weighs dimensions the profile actually says something about,
 * and an entirely empty profile disables filtering.
 */
export interface FilterProfile {
  roles?: string;
  /** Equivalent/adjacent job titles for the target roles — companies name the
   * same work differently ("UI/UX Designer" ≈ "UX Engineer" ≈ "User
   * Experience Designer"), so the judge treats any of these as the role. */
  role_synonyms?: string;
  seniority?: string;
  locations?: string;
  skills?: string;
  company_prefs?: string;
  compensation?: string;
  must_haves?: string;
  nice_to_haves?: string;
  dealbreakers?: string;
  context?: string;
}

/** Canonical profile field order — shared by the API sanitizer, the judge
 * prompt, and the settings UI so all three stay in sync. */
export const FILTER_PROFILE_KEYS: ReadonlyArray<keyof FilterProfile> = [
  "roles",
  "role_synonyms",
  "seniority",
  "locations",
  "skills",
  "company_prefs",
  "compensation",
  "must_haves",
  "nice_to_haves",
  "dealbreakers",
  "context",
];

export type FilterMode = "off" | "balanced" | "strict";

export interface VerdictDimension {
  /** role | seniority | location | skills | company | compensation | requirements | other */
  name: string;
  fit: "strong" | "partial" | "mismatch" | "unknown";
  note: string;
}

/** The judge's full reasoning for one posting (postings.filter_verdict). */
export interface PostingVerdict {
  verdict: "match" | "borderline" | "mismatch";
  /** 0–100 overall fit given the visible evidence. */
  score: number;
  /** 1–2 sentence human-readable rationale for the decision. */
  summary: string;
  /** Which stated dealbreaker applied, if any — forces a mismatch. */
  dealbreaker: string | null;
  dimensions: VerdictDimension[];
}

/**
 * Everything the researcher could establish about one company from live web
 * evidence (companies.dossier). Nullable fields mean "the evidence didn't
 * say" — never guessed.
 */
export interface CompanyDossier {
  name: string;
  website: string | null;
  /** 1–2 sentences: what the company actually does / has done. */
  summary: string;
  industry: string | null;
  /** e.g. "~120 employees" */
  size_estimate: string | null;
  /** e.g. "Series B", "bootstrapped", "public" */
  stage: string | null;
  /** Recent funding with year, e.g. "$12M Series A, 2024" */
  funding: string | null;
  founded: string | null;
  /** verified = multiple independent sources confirm a real operating company;
   * likely_real = credible footprint but thin; uncertain = almost no
   * independent footprint (caution, not accusation); suspicious = concrete
   * red flags (scam reports, template site, brand mimicry). */
  legitimacy: "verified" | "likely_real" | "uncertain" | "suspicious";
  /** Concrete red/caution observations, empty when none. */
  flags: string[];
  confidence: "high" | "medium" | "low";
  sources: Array<{ title: string; url: string }>;
}

/** The company layer never blocks — "warn" still notifies, carrying the reason. */
export type CompanyDecision = "ok" | "warn";

/** Per-posting company verdict (postings.company_verdict). */
export interface CompanyVerdict {
  decision: CompanyDecision;
  /** One user-facing sentence naming the decisive fact. */
  reason: string;
}

export type CompanyStatus = "none" | "pending" | "ok" | "warned";

/** A companies-table row (the per-company research cache). */
export interface CompanyRow {
  id: string;
  norm_name: string;
  display_name: string;
  dossier: CompanyDossier | null;
  legitimacy: CompanyDossier["legitimacy"] | "unknown";
  research_status: "pending" | "ok" | "failed";
  research_error: string | null;
  failure_count: number;
  researched_at: string | null;
}

export interface WatchedPage {
  id: string;
  url: string;
  label: string;
  active: boolean;
  fetch_source: "direct" | "jina";
  last_content_hash: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  failure_count: number;
  first_crawl_done: boolean;
}

// Full settings row, including secret columns. Only ever read via the
// service-role client; the api function returns a masked view of it.
export interface Settings {
  id: number;
  /** The raw "what are you looking for" statement the profile was generated from. */
  profile_input: string;
  filter_profile: FilterProfile;
  filter_mode: FilterMode;
  company_filter_enabled: boolean;
  telegram_chat_id: string;
  admin_token: string;
  llm_provider: string;
  llm_model: string;
  llm_api_key: string;
  llm_base_url: string;
  telegram_bot_token: string;
  jina_api_key: string;
}

export interface RuntimeConfig {
  adminToken: string;
  llmProvider: string;
  llmModel: string;
  llmApiKey: string;
  llmBaseUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  jinaApiKey: string;
  filterProfile: FilterProfile;
  filterMode: FilterMode;
  companyFilterEnabled: boolean;
}
