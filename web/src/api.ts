const BASE_URL: string = import.meta.env.VITE_API_URL ?? "";

export interface WatchedPage {
  id: string;
  url: string;
  label: string;
  active: boolean;
  last_checked_at: string | null;
  last_error: string | null;
  failure_count: number;
  first_crawl_done: boolean;
  /** What last produced usable content: direct / direct-alt / proxy:pure / greenhouse / lever / ashby / rss. */
  fetch_strategy: string | null;
}

/** The currencies the compensation range can be expressed in. */
export const COMP_CURRENCIES = ["USD", "EUR", "GBP", "INR"] as const;
export type CompCurrency = (typeof COMP_CURRENCIES)[number];

/** Whether a compensation range is stated per year or per month. */
export const COMP_PERIODS = ["year", "month"] as const;
export type CompPeriod = (typeof COMP_PERIODS)[number];

/** The profile fields edited as discrete tags, and whose per-value AI/user
 * provenance is therefore tracked. */
export const TAGGED_PROFILE_KEYS = ["role_synonyms", "title_keywords"] as const;
export type TaggedProfileKey = (typeof TAGGED_PROFILE_KEYS)[number];

/** The title-screening profile the judge weighs postings against. Mirrors the
 * backend's FilterProfile (functions/_shared/types.ts).
 *
 * roles/role_synonyms/title_keywords can be LLM-generated (see
 * api.expandProfile); locations/compensation are always the user's own. The
 * five string fields are what the judge reads — `locations` and
 * `compensation` are derived server-side from the structured fields below, so
 * the UI edits structure and the judge still sees prose. */
export interface FilterProfile {
  /** The target role, close to the seeker's own words. */
  roles?: string;
  /** Equivalent/adjacent titles the judge treats as the target role. */
  role_synonyms?: string;
  /** Short discipline words (not full titles) — a deterministic pre-filter
   * rejects any posting whose title contains none of these before the AI
   * judge ever runs. */
  title_keywords?: string;
  /** Location / remote preference. Derived from locations_include/exclude. */
  locations?: string;
  /** Pay expectation. Derived from the compensation_* fields. */
  compensation?: string;

  /** Places the seeker will work — a posting must state one of them, or state
   * no location at all, to survive the pre-filter. */
  locations_include?: string[];
  /** Places the seeker will not work — stating any of them is an outright
   * rejection, even when an include entry also matches. */
  locations_exclude?: string[];
  /** Floor of the target pay range, raw (e.g. 120000). */
  compensation_min?: number;
  /** Ceiling of the target pay range. Never rejects on its own. */
  compensation_max?: number;
  compensation_period?: CompPeriod;
  compensation_currency?: CompCurrency;
  /** Which values in the tagged fields came from the LLM rather than the
   * user's own typing — drives tag colouring on the Profile page. */
  ai_generated?: Partial<Record<TaggedProfileKey, string[]>>;
}

/** The prose fields — the only ones the judge reads, and the only ones that
 * hold a plain string. Distinct from `keyof FilterProfile`, which also spans
 * the structured arrays and numbers the Profile page edits. */
export type ProfileTextKey =
  | "roles"
  | "role_synonyms"
  | "title_keywords"
  | "locations"
  | "compensation";

/** Canonical profile field order, mirrors the backend's FILTER_PROFILE_KEYS. */
export const FILTER_PROFILE_KEYS: ReadonlyArray<ProfileTextKey> = [
  "roles",
  "role_synonyms",
  "title_keywords",
  "locations",
  "compensation",
];

export function profileHasContent(profile: FilterProfile): boolean {
  return FILTER_PROFILE_KEYS.some((key) => (profile[key] ?? "").trim() !== "");
}

/** 'pending' = awaiting screening; 'skipped' = never screened (baseline or empty profile). */
export type FilterStatus = "pending" | "matched" | "filtered" | "skipped";

/** The judge's stored reasoning for one posting. */
export interface PostingVerdict {
  verdict: "match" | "borderline" | "mismatch";
  summary: string;
  /** Set when the posting's title is a different/broader role than the
   * target and its equivalents — forces a mismatch. */
  title_mismatch: string | null;
}

export type CompanyLegitimacy = "verified" | "likely_real" | "uncertain" | "suspicious";

/** What the company researcher established from live web evidence. */
export interface CompanyDossier {
  name: string;
  website: string | null;
  summary: string;
  industry: string | null;
  size_estimate: string | null;
  stage: string | null;
  funding: string | null;
  founded: string | null;
  company_type: string | null;
  legitimacy: CompanyLegitimacy;
  flags: string[];
  confidence: "high" | "medium" | "low";
  sources: Array<{ title: string; url: string }>;
}

/** The company layer never blocks — "warn" attaches a caution, nothing more. */
export interface CompanyVerdict {
  decision: "ok" | "warn";
  reason: string;
}

/** 'pending' = awaiting company research; 'none' = layer off or no company name. */
export type CompanyStatus = "none" | "pending" | "ok" | "warned";

/** The researched company embedded on a posting. */
export interface PostingCompany {
  display_name: string;
  legitimacy: CompanyLegitimacy | "unknown";
  dossier: CompanyDossier | null;
  researched_at: string | null;
}

/** How postings.url was obtained. 'unknown' marks every row that predates
 * link provenance (see migration 0019) — never checked, never will be. */
export type LinkSource = "unknown" | "platform" | "cited" | "matched" | "none";

/** Outcome of the live per-posting link check. 'indeterminate' (a wall/
 * timeout on the job site) is deliberately distinct from 'mismatch'/'dead'
 * (positive evidence the link itself is wrong) — only those two ever fall
 * back to the source listing in the UI; see lib/parsePosting.ts. */
export type LinkVerification = "unverified" | "verified" | "indeterminate" | "mismatch" | "dead";

export interface Posting {
  id: string;
  title: string;
  url: string | null;
  company: string | null;
  location: string | null;
  compensation: string | null;
  posted_at: string | null;
  posted_text: string | null;
  first_seen_at: string;
  notified_at: string | null;
  pending_notify: boolean;
  filter_status: FilterStatus;
  filter_verdict: PostingVerdict | null;
  company_status: CompanyStatus;
  company_verdict: CompanyVerdict | null;
  /** Set when this posting was recognized as a repost of one already notified
   * from another source — the id of that earlier posting. */
  duplicate_of: string | null;
  /** True when this posting was rejected by the deterministic title-keyword
   * gate ahead of the AI judge, rather than by the judge itself. */
  keyword_filtered: boolean;
  /** True when this posting was rejected by the seeker's negative-keywords
   * override, ahead of every other gate. */
  negative_keyword_filtered: boolean;
  link_source: LinkSource;
  link_verification: LinkVerification;
  /** Post-redirect URL, when verification found one different from `url`. */
  link_final_url: string | null;
  link_checked_at: string | null;
  /** One human-readable sentence: why a link is unconfirmed, or how it was recovered. */
  link_note: string | null;
  companies: PostingCompany | null;
  watched_pages: { label: string; url: string } | null;
}

export type PostingSort = "first_seen_at" | "title" | "company" | "notified_at";

export interface PostingsPage {
  items: Posting[];
  total: number;
}

export interface Settings {
  /** The raw "what are you looking for" statement the profile was generated from. */
  profile_input: string;
  filter_profile: FilterProfile;
  /** Newline- or comma-separated words/phrases. Absolute pre-judge override,
   * independent of filter_profile: a posting whose title contains any of
   * these is rejected before the AI judge (and the title_keywords gate)
   * ever runs. */
  negative_keywords: string;
  company_filter_enabled: boolean;
  telegram_chat_id: string;
  llm_provider: string;
  llm_model: string;
  llm_base_url: string;
  has_llm_api_key: boolean;
  has_telegram_bot_token: boolean;
  has_tavily_api_key: boolean;
}

export interface BulkAddResult {
  added: WatchedPage[];
  addedCount: number;
  skippedCount: number;
  invalid: string[];
}

/** PUT payload: secret fields are only applied when sent non-empty. */
export interface SettingsUpdate {
  profile_input?: string;
  filter_profile?: FilterProfile;
  negative_keywords?: string;
  company_filter_enabled?: boolean;
  telegram_chat_id?: string;
  llm_provider?: string;
  llm_model?: string;
  llm_base_url?: string;
  llm_api_key?: string;
  telegram_bot_token?: string;
  tavily_api_key?: string;
}

export function getToken(): string {
  return localStorage.getItem("admin_token") ?? "";
}

export function setToken(token: string) {
  localStorage.setItem("admin_token", token);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": getToken(),
      ...options.headers,
    },
  });
  // A misconfigured VITE_API_URL (empty, or pointing at the web app's own
  // domain) hits the SPA's rewrite instead of the api function: it "succeeds"
  // with a 200 and an HTML body. Treating that as JSON silently produces {}
  // and lets a shape mismatch crash deep in a component instead of here.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      `Expected JSON from the API but got "${contentType || "no content-type"}" (HTTP ${res.status}). ` +
        "VITE_API_URL is likely misconfigured or not pointing at a live api function.",
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  listPages: () => request<WatchedPage[]>("/pages"),
  addPages: (urls: string[]) =>
    request<BulkAddResult>("/pages", { method: "POST", body: JSON.stringify({ urls }) }),
  updatePage: (id: string, patch: { active?: boolean; label?: string }) =>
    request<WatchedPage>(`/pages/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deletePage: (id: string) => request<{ ok: boolean }>(`/pages/${id}`, { method: "DELETE" }),
  getSettings: () => request<Settings>("/settings"),
  saveSettings: (update: SettingsUpdate) =>
    request<Settings>("/settings", { method: "PUT", body: JSON.stringify(update) }),
  listPostings: (
    opts: {
      limit?: number;
      offset?: number;
      sort?: PostingSort;
      order?: "asc" | "desc";
      status?: FilterStatus | "";
      /** Restrict to postings pulled from one source page. */
      pageId?: string;
      companyStatus?: CompanyStatus | "";
      /** true = actually sent to Telegram; false = never sent. */
      notified?: boolean;
      /** true = currently queued for the next notify pass. */
      pendingNotify?: boolean;
      /** Combined matched+filtered view — send instead of, not with, status. */
      screened?: boolean;
      /** Recognized as a repost of an already-notified job from another
       * source — suppressed rather than sent again. Combines with status. */
      duplicate?: boolean;
      /** Rejected by the deterministic title-keyword gate ahead of the AI
       * judge (true), or reached/passed the judge (false). Combines with
       * status — e.g. status:"filtered" + keywordFiltered:false is "the AI
       * judge's own rejections", excluding what the keyword gate already
       * caught. */
      keywordFiltered?: boolean;
      /** Rejected by the seeker's negative-keywords override, ahead of every
       * other gate (true), or not (false). Combines with status the same way
       * keywordFiltered does. */
      negativeKeywordFiltered?: boolean;
    } = {},
  ) => {
    const params = new URLSearchParams({
      limit: String(opts.limit ?? 50),
      offset: String(opts.offset ?? 0),
      sort: opts.sort ?? "first_seen_at",
      order: opts.order ?? "desc",
    });
    if (opts.status) params.set("status", opts.status);
    if (opts.pageId) params.set("page_id", opts.pageId);
    if (opts.companyStatus) params.set("company_status", opts.companyStatus);
    if (opts.notified !== undefined) params.set("notified", String(opts.notified));
    if (opts.pendingNotify !== undefined) params.set("pending_notify", String(opts.pendingNotify));
    if (opts.screened) params.set("screened", "true");
    if (opts.duplicate) params.set("duplicate", "true");
    if (opts.keywordFiltered !== undefined) params.set("keyword_filtered", String(opts.keywordFiltered));
    if (opts.negativeKeywordFiltered !== undefined) {
      params.set("negative_keyword_filtered", String(opts.negativeKeywordFiltered));
    }
    return request<PostingsPage>(`/postings?${params}`);
  },
  clearPostings: () => request<{ ok: boolean; deleted: number }>("/postings", { method: "DELETE" }),
  poll: () => request<{ pages: number; results: unknown[] }>("/poll", { method: "POST" }),
  testTelegram: () => request<{ ok: boolean }>("/telegram-test", { method: "POST" }),
  expandProfile: (statement: string) =>
    request<{ profile: Pick<FilterProfile, "roles" | "role_synonyms" | "title_keywords"> }>("/profile/expand", {
      method: "POST",
      body: JSON.stringify({ statement }),
    }),
};
