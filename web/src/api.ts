const BASE_URL: string = import.meta.env.VITE_API_URL ?? "";

export interface WatchedPage {
  id: string;
  url: string;
  label: string;
  active: boolean;
  fetch_source: "direct" | "jina";
  last_checked_at: string | null;
  last_error: string | null;
  failure_count: number;
  first_crawl_done: boolean;
}

/** The job profile the filter judges postings against — all optional free text. */
export interface FilterProfile {
  roles?: string;
  /** Equivalent/adjacent titles the judge treats as the target role. */
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

export type FilterMode = "off" | "balanced" | "strict";

/** 'pending' = awaiting screening; 'skipped' = never screened (baseline or filter off). */
export type FilterStatus = "pending" | "matched" | "filtered" | "skipped";

export interface VerdictDimension {
  name: string;
  fit: "strong" | "partial" | "mismatch" | "unknown";
  note: string;
}

/** The judge's stored reasoning for one posting. */
export interface PostingVerdict {
  verdict: "match" | "borderline" | "mismatch";
  score: number;
  summary: string;
  dealbreaker: string | null;
  dimensions: VerdictDimension[];
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

export interface Posting {
  id: string;
  title: string;
  url: string | null;
  company: string | null;
  location: string | null;
  posted_at: string | null;
  posted_text: string | null;
  first_seen_at: string;
  notified_at: string | null;
  pending_notify: boolean;
  filter_status: FilterStatus;
  filter_score: number | null;
  filter_verdict: PostingVerdict | null;
  company_status: CompanyStatus;
  company_verdict: CompanyVerdict | null;
  companies: PostingCompany | null;
  watched_pages: { label: string; url: string } | null;
}

export type PostingSort = "first_seen_at" | "posted_at" | "title" | "company" | "filter_score";

export interface PostingsPage {
  items: Posting[];
  total: number;
}

export interface Settings {
  /** The raw "what are you looking for" statement the profile was generated from. */
  profile_input: string;
  filter_profile: FilterProfile;
  filter_mode: FilterMode;
  company_filter_enabled: boolean;
  telegram_chat_id: string;
  llm_provider: string;
  llm_model: string;
  llm_base_url: string;
  has_llm_api_key: boolean;
  has_telegram_bot_token: boolean;
  has_jina_api_key: boolean;
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
  filter_mode?: FilterMode;
  company_filter_enabled?: boolean;
  telegram_chat_id?: string;
  llm_provider?: string;
  llm_model?: string;
  llm_base_url?: string;
  llm_api_key?: string;
  telegram_bot_token?: string;
  jina_api_key?: string;
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
    opts: { limit?: number; offset?: number; sort?: PostingSort; order?: "asc" | "desc"; status?: FilterStatus | "" } = {},
  ) => {
    const params = new URLSearchParams({
      limit: String(opts.limit ?? 50),
      offset: String(opts.offset ?? 0),
      sort: opts.sort ?? "first_seen_at",
      order: opts.order ?? "desc",
    });
    if (opts.status) params.set("status", opts.status);
    return request<PostingsPage>(`/postings?${params}`);
  },
  poll: () => request<{ pages: number; results: unknown[] }>("/poll", { method: "POST" }),
  testTelegram: () => request<{ ok: boolean }>("/telegram-test", { method: "POST" }),
  expandProfile: (statement: string) =>
    request<{ profile: FilterProfile }>("/profile/expand", {
      method: "POST",
      body: JSON.stringify({ statement }),
    }),
};
