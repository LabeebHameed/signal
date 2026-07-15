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

export interface Posting {
  id: string;
  title: string;
  url: string | null;
  company: string | null;
  location: string | null;
  first_seen_at: string;
  notified_at: string | null;
  watched_pages: { label: string; url: string } | null;
}

export interface Settings {
  job_description: string;
  telegram_chat_id: string;
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
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  listPages: () => request<WatchedPage[]>("/pages"),
  addPage: (url: string, label: string) =>
    request<WatchedPage>("/pages", { method: "POST", body: JSON.stringify({ url, label }) }),
  updatePage: (id: string, patch: { active?: boolean; label?: string }) =>
    request<WatchedPage>(`/pages/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deletePage: (id: string) => request<{ ok: boolean }>(`/pages/${id}`, { method: "DELETE" }),
  getSettings: () => request<Settings>("/settings"),
  saveSettings: (settings: Settings) =>
    request<Settings>("/settings", { method: "PUT", body: JSON.stringify(settings) }),
  listPostings: () => request<Posting[]>("/postings?limit=50"),
  poll: () => request<{ pages: number; results: unknown[] }>("/poll", { method: "POST" }),
};
