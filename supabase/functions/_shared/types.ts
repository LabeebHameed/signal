export interface ExtractedPosting {
  title: string;
  /** Untrusted, model-emitted URL — only ever honored by resolvePostingLinks
   * (_shared/links.ts) when it canonicalizes to a real anchor href from the
   * same crawl. Prefer link_id: this field exists solely as backward
   * compatibility for a model that still emits a URL instead of citing one. */
  url?: string;
  /** Which numbered anchor marker (see _shared/fetcher.ts htmlToTextWithLinks)
   * the model cited as this posting's own link — an index into that crawl's
   * PageLink table, never a URL the model authored itself. Structured
   * (ATS/RSS) sources never set this; they carry a real url directly. */
  link_id?: number | null;
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
 * How postings.url was obtained, best-confidence first:
 *
 *   platform — straight from an ATS/RSS feed (Greenhouse absolute_url, etc.)
 *   card     — read off the page's own markup: the link belonging to the DOM
 *              card that displays this posting's title (_shared/cards.ts)
 *   cited    — the model cited a numbered anchor; reader-proxy (markdown)
 *              pages only, where there is no DOM to read cards from
 *   matched  — recovered by matching the title against anchor text
 *   none     — no defensible link was found (url is null)
 *   unknown  — predates link provenance; never set going forward
 */
export type LinkSource = "unknown" | "platform" | "card" | "cited" | "matched" | "none";

/** The currencies the compensation range can be expressed in. */
export const COMP_CURRENCIES = ["USD", "EUR", "GBP", "INR"] as const;
export type CompCurrency = (typeof COMP_CURRENCIES)[number];

/** Whether a compensation range is stated per year or per month. */
export const COMP_PERIODS = ["year", "month"] as const;
export type CompPeriod = (typeof COMP_PERIODS)[number];

/** The profile fields whose values are edited as discrete tags rather than
 * free text, and whose per-value AI/user provenance is therefore tracked. */
export const TAGGED_PROFILE_KEYS = ["role_synonyms", "title_keywords"] as const;
export type TaggedProfileKey = (typeof TAGGED_PROFILE_KEYS)[number];

/**
 * What the user is looking for — a title-screening profile. An entirely empty
 * profile disables filtering.
 *
 * The five string fields below are the canonical form the judge reads. The
 * structured fields after them are what the Profile page actually edits;
 * `locations` and `compensation` are DERIVED from those on every save (see the
 * settings PUT in functions/api), so the judge's view never drifts from the
 * UI's and profiles written before the structured fields existed keep working
 * untouched.
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
  /** Location / remote preference, DERIVED from locations_include/exclude.
   * User-entered, never LLM-generated. */
  locations?: string;
  /** Pay expectation, DERIVED from the compensation_* fields below.
   * User-entered, never LLM-generated. */
  compensation?: string;

  /** Places the seeker will work. Non-empty means a posting must state one of
   * them — or state no location at all — to survive the pre-filter. */
  locations_include?: string[];
  /** Places the seeker will not work. A posting stating any of them is
   * rejected outright, even when it also matches an include entry. */
  locations_exclude?: string[];
  /** Floor of the target pay range, as a raw number (e.g. 120000). */
  compensation_min?: number;
  /** Ceiling of the target pay range. Never rejects on its own — a posting
   * paying above the range is a good problem to have. */
  compensation_max?: number;
  compensation_period?: CompPeriod;
  compensation_currency?: CompCurrency;
  /** Which values in the tagged fields came from the LLM expansion rather
   * than the seeker's own typing — drives the Profile page's tag colouring.
   * A value edited by hand is dropped from here and becomes user-authored. */
  ai_generated?: Partial<Record<TaggedProfileKey, string[]>>;
}

/** The prose fields — the only ones the judge reads, and the only ones that
 * hold a plain string. Distinct from `keyof FilterProfile`, which now also
 * spans the structured arrays/numbers the Profile page edits. */
export type ProfileTextKey =
  | "roles"
  | "role_synonyms"
  | "title_keywords"
  | "locations"
  | "compensation";

/** Canonical profile field order — shared by the API sanitizer and the judge
 * prompt so both stay in sync. The judge only ever reads these five. */
export const FILTER_PROFILE_KEYS: ReadonlyArray<ProfileTextKey> = [
  "roles",
  "role_synonyms",
  "title_keywords",
  "locations",
  "compensation",
];

/** The subset of the profile the LLM expansion generates from the seeker's
 * one-sentence statement — locations/compensation are always user-entered. */
export type GeneratedProfileKey = Extract<ProfileTextKey, "roles" | "role_synonyms" | "title_keywords">;

export const GENERATED_PROFILE_KEYS: ReadonlyArray<GeneratedProfileKey> = [
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
  /** Suppresses the full strategy re-probe until this time. Set only when the
   * whole chain ran and still found nothing carrying a link, so a page that
   * genuinely renders without anchors doesn't pay for four fetches every
   * poll. Cleared as soon as a strategy returns links. */
  strategy_probe_after: string | null;
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
  /** Newline- or comma-separated words/phrases. Absolute pre-judge override,
   * independent of filter_profile: a posting whose title contains any of
   * these is rejected before the AI judge (and the title_keywords gate)
   * ever runs — see _shared/negativeKeywords.ts. */
  negative_keywords: string;
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
  negativeKeywords: string;
  companyFilterEnabled: boolean;
}
