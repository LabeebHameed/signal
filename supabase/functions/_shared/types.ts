export interface ExtractedPosting {
  title: string;
  url?: string;
  company?: string;
  location?: string;
  /** ISO date (YYYY-MM-DD) the job was posted, when the page shows one. */
  posted_at?: string;
  /** The posted-date text verbatim as shown on the page, e.g. "2 days ago". */
  posted_text?: string;
  /** Pay/compensation as shown on the page, verbatim (e.g. "$150K - $200K"). */
  compensation?: string;
}

/**
 * What the user is looking for — a title-screening profile. Every field is
 * optional free text; an entirely empty profile disables filtering.
 */
export interface FilterProfile {
  /** The target role, close to the seeker's own words. */
  roles?: string;
  /** Equivalent/adjacent job titles for the target roles — companies name the
   * same work differently ("UI/UX Designer" ≈ "UX Engineer" ≈ "User
   * Experience Designer"), so the judge treats any of these as the role. */
  role_synonyms?: string;
  /** Short discipline-defining WORDS (not full titles, unlike role_synonyms)
   * — e.g. "design, UI, UX, design systems" for a Design Engineer target.
   * A deterministic pre-filter (judge.ts titleMatchesKeywords) rejects any
   * posting whose title contains none of these before the AI judge ever
   * sees it — a hard backstop for cases the judge itself has gotten wrong
   * even with full context (e.g. scoring "Android Developer" as a match for
   * "Design Engineer"). Empty means the gate is off. */
  title_keywords?: string;
  /** Location / remote preference. User-entered, never LLM-generated. */
  locations?: string;
  /** Pay expectation. User-entered, never LLM-generated. */
  compensation?: string;
}

/** Canonical profile field order — shared by the API sanitizer and the judge
 * prompt so both stay in sync. */
export const FILTER_PROFILE_KEYS: ReadonlyArray<keyof FilterProfile> = [
  "roles",
  "role_synonyms",
  "title_keywords",
  "locations",
  "compensation",
];

/** The subset of the profile the LLM expansion generates from the seeker's
 * one-sentence statement — locations/compensation are always user-entered. */
export const GENERATED_PROFILE_KEYS: ReadonlyArray<keyof FilterProfile> = [
  "roles",
  "role_synonyms",
  "title_keywords",
];

/** The judge's stored reasoning for one posting (postings.filter_verdict). */
export interface PostingVerdict {
  verdict: "match" | "borderline" | "mismatch";
  /** 1–2 sentence human-readable rationale for the decision. */
  summary: string;
  /** Why the posting's title is a different/broader role than the target
   * and its equivalents, if it is — forces a mismatch. A shared generic
   * word (e.g. "Engineer") between the posting and target titles is never
   * enough on its own to avoid this. */
  title_mismatch: string | null;
}

export interface FounderInfo {
  name: string;
  title: string | null;
  x_url: string | null;
  linkedin_url: string | null;
  bio: string | null;
}

export interface CompanySocials {
  linkedin_url: string | null;
  x_url: string | null;
  github_url: string | null;
  crunchbase_url: string | null;
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
  /** 2–3 sentences on products/services, target market, and business model. */
  product_breakdown: string;
  industry: string | null;
  /** e.g. "~120 employees" */
  size_estimate: string | null;
  /** e.g. "Series B", "bootstrapped", "public" */
  stage: string | null;
  /** Recent funding with year, e.g. "$12M Series A, 2024" */
  funding: string | null;
  founded: string | null;
  /** Short recognizable category, e.g. "Startup", "Public company", "Non-profit", "B2B SaaS", "Agency". */
  company_type: string | null;
  /** Identified founders or C-level executives, with social links when evidence has them. */
  founders: FounderInfo[];
  /** Official company social pages. */
  socials: CompanySocials;
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
  last_content_hash: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  failure_count: number;
  first_crawl_done: boolean;
  /** Set while a poll run is actively processing this page; guards against
   * an overlapping run (cron + "Check now", or two chained batches)
   * double-processing — and double-notifying — the same page. Stale claims
   * (see CLAIM_STALE_MS in poll-pages) are reclaimable. */
  poll_claimed_at: string | null;
  /** Which fetch strategy last produced usable content for this page — see
   * FetchStrategy in _shared/fetcher.ts and AtsStrategy in _shared/ats.ts.
   * Tried first on the next poll instead of re-discovering the winner. */
  fetch_strategy: string | null;
  /** Current steady-state check interval in minutes — doubles on repeated
   * unchanged polls (cap 6h), resets to 15 on a real content change. */
  check_interval_minutes: number;
  /** When this page is next due for a scheduled (cron) check; null means
   * due now. A manual "Check now" ignores this and forces every page. */
  next_check_at: string | null;
}

// Full settings row, including secret columns. Only ever read via the
// service-role client; the api function returns a masked view of it.
export interface Settings {
  id: number;
  /** The raw "what are you looking for" statement the profile was generated from. */
  profile_input: string;
  filter_profile: FilterProfile;
  company_filter_enabled: boolean;
  telegram_chat_id: string;
  admin_token: string;
  llm_provider: string;
  llm_model: string;
  llm_api_key: string;
  llm_base_url: string;
  telegram_bot_token: string;
  tavily_api_key: string;
}

export interface RuntimeConfig {
  adminToken: string;
  llmProvider: string;
  llmModel: string;
  llmApiKey: string;
  llmBaseUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  tavilyApiKey: string;
  filterProfile: FilterProfile;
  companyFilterEnabled: boolean;
}
